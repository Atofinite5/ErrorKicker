import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool, type PoolClient } from "pg";
import { parse as parseYaml } from "yaml";
import { config } from "./config.ts";

const here = dirname(fileURLToPath(import.meta.url));

export const pool = new Pool({ connectionString: config.databaseUrl });

/**
 * Run a function inside a single Postgres transaction. Used so a commit (or
 * a block) lands together with its write_operations update, idempotency
 * outcome and outbox event — Arch §4/§9: never report durable acceptance
 * for something that is not durably recorded.
 */
export async function withTx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

/** Use the transaction client when one is passed, else the pool. */
export function executor(client?: PoolClient): Pool {
  return (client ?? pool) as unknown as Pool;
}

/** Run migrations (001 base, then 002 PRD alignment) and seed rules. */
export async function initDb(): Promise<void> {
  for (const file of ["001_init.sql", "002_prd_alignment.sql"]) {
    const sql = readFileSync(join(here, "..", "migrations", file), "utf8");
    await pool.query(sql);
  }

  const tables = ["orders", "users"] as const;
  for (const table of tables) {
    const { rowCount } = await pool.query(
      "SELECT 1 FROM rules_config WHERE table_name = $1",
      [table],
    );
    if (rowCount === 0) {
      const yamlText = readFileSync(join(here, "..", "rules", `${table}.yaml`), "utf8");
      const parsed = parseYaml(yamlText) as { version?: number };
      await pool.query(
        "INSERT INTO rules_config (table_name, rule_yaml, version) VALUES ($1, $2, $3)",
        [table, yamlText, parsed.version ?? 1],
      );
    }
  }
}

/** App-table name for committed records of a logical table. */
export function appTable(table: string): string {
  if (table === "orders" || table === "users") return `app_${table}`;
  throw new Error(`unknown table: ${table}`);
}
