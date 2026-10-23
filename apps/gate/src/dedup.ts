import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { config } from "./config.ts";
import { appTable, executor, pool } from "./db.ts";
import { redis } from "./redis.ts";

// ---------------------------------------------------------------------------
// Stage C: dedup — exact content hash + idempotency keys.
// Volatile fields (ids, timestamps) are excluded so a double-submitted
// *payload* is caught even when the client minted a fresh id.
//
// PRD v1.0 alignment: PostgreSQL is the source of truth for BOTH the dedup
// fingerprints (table dedup_fingerprints) and idempotency outcomes (table
// idempotency_keys). Redis keeps only a best-effort write-through mirror of
// idempotency results; it is never read as truth and its absence changes
// nothing. A fingerprint is recorded when a write COMMITS (recordFingerprint,
// called from commitWrite) — not at evaluation time — so a write queued
// behind a pause never "duplicates" itself when re-evaluated on drain.
// ---------------------------------------------------------------------------

const VOLATILE = new Set(["id", "createdAt", "signupAt", "traceId", "idempotencyKey"]);

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>)
      .filter((k) => !VOLATILE.has(k))
      .sort()) {
      out[k] = canonicalize((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

export function contentHash(record: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(record)))
    .digest("hex");
}

/**
 * The hash an idempotency key is bound to: the table + the record payload.
 * Same key + same request hash → replay the durable result (FR-02).
 * Same key + different request hash → 409 conflict (FR-02).
 */
export function requestHash(table: string, record: unknown): string {
  return contentHash({ table, record });
}

export type IdempotencyDecision = "miss" | "replay" | "conflict";

/** Pure decision used by the write path (and unit-tested in smoke). */
export function decideIdempotency(
  existingHash: string | null | undefined,
  incomingHash: string,
): IdempotencyDecision {
  if (!existingHash) return "miss";
  return existingHash === incomingHash ? "replay" : "conflict";
}

function fingerprintOf(table: string, record: unknown): string {
  return `${table}:${contentHash(record)}`;
}

export interface FuzzyHit {
  id: string;
  field: string;
  score: number;
}

/**
 * Review-first near-duplicate against committed application rows (pg_trgm).
 * Never merges. Null when nothing similar enough is found.
 */
export async function findFuzzyDuplicate(
  table: string,
  record: Record<string, unknown>,
): Promise<FuzzyHit | null> {
  const fields =
    table === "users"
      ? [
          { field: "email", min: config.fuzzyEmailMin },
          { field: "name", min: config.fuzzyNameMin },
        ]
      : table === "orders"
        ? [{ field: "userId", min: 0.95 }]
        : [];
  const rel = appTable(table);
  for (const { field, min } of fields) {
    const value = record[field];
    if (typeof value !== "string" || value.trim().length < 3) continue;
    try {
      const { rows } = await pool.query(
        `SELECT id, similarity(lower(record->>$1), lower($2)) AS score
           FROM ${rel}
          WHERE record->>$1 IS NOT NULL
            AND similarity(lower(record->>$1), lower($2)) >= $3
          ORDER BY score DESC
          LIMIT 1`,
        [field, value, min],
      );
      if (rows[0] && Number(rows[0].score) >= min) {
        return { id: String(rows[0].id), field, score: Number(rows[0].score) };
      }
    } catch (err) {
      console.warn(`[dedup] fuzzy skipped for ${table}.${field}:`, (err as Error).message);
    }
  }
  return null;
}

/** True when this exact payload was already COMMITTED within the window. */
export async function isExactDuplicate(table: string, record: unknown): Promise<boolean> {
  const { rows } = await pool.query(
    "SELECT 1 FROM dedup_fingerprints WHERE fingerprint = $1 AND expires_at > now()",
    [fingerprintOf(table, record)],
  );
  return rows.length > 0;
}

/** Record the fingerprint of a committed write (inside the commit tx). */
export async function recordFingerprint(
  table: string,
  record: unknown,
  client?: PoolClient,
): Promise<void> {
  await executor(client).query(
    `INSERT INTO dedup_fingerprints (fingerprint, table_name, expires_at)
     VALUES ($1, $2, now() + make_interval(secs => $3))
     ON CONFLICT (fingerprint) DO UPDATE
       SET expires_at = EXCLUDED.expires_at`,
    [fingerprintOf(table, record), table, config.fingerprintTtlSec],
  );
}

export interface IdempotencyHit {
  hit: true;
  result: string;
  recordHash: string;
  incidentId?: string;
  operationId?: string;
  resultJson?: Record<string, unknown> | null;
}

/** PostgreSQL lookup — the only authoritative idempotency read. */
export async function checkIdempotency(key: string): Promise<IdempotencyHit | null> {
  const { rows } = await pool.query(
    `SELECT result, record_hash, incident_id, operation_id, result_json
       FROM idempotency_keys
      WHERE key = $1 AND expires_at > now()`,
    [key],
  );
  if (rows.length === 0) return null;
  const r = rows[0] as {
    result: string;
    record_hash: string;
    incident_id: string | null;
    operation_id: string | null;
    result_json: Record<string, unknown> | null;
  };
  return {
    hit: true,
    result: r.result,
    recordHash: r.record_hash,
    incidentId: r.incident_id ?? undefined,
    operationId: r.operation_id ?? undefined,
    resultJson: r.result_json ?? null,
  };
}

/**
 * Persist the durable idempotency outcome (24h window — PRD §15 default).
 * `hash` must be requestHash(table, record) so retries compare like-for-like.
 * Runs inside the caller's transaction when a client is passed.
 */
export async function storeIdempotency(
  key: string,
  hash: string,
  result: string,
  incidentId?: string,
  opts: { operationId?: string; resultJson?: Record<string, unknown>; client?: PoolClient } = {},
): Promise<void> {
  await executor(opts.client).query(
    `INSERT INTO idempotency_keys
       (key, record_hash, result, incident_id, operation_id, result_json, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(secs => $7))
     ON CONFLICT (key) DO UPDATE SET
       result = EXCLUDED.result,
       incident_id = EXCLUDED.incident_id,
       operation_id = EXCLUDED.operation_id,
       result_json = EXCLUDED.result_json,
       expires_at = EXCLUDED.expires_at`,
    [
      key,
      hash,
      result,
      incidentId ?? null,
      opts.operationId ?? null,
      opts.resultJson ? JSON.stringify(opts.resultJson) : null,
      config.idempotencyTtlSec,
    ],
  );
  // Best-effort Redis write-through mirror. Never read as truth; a failure
  // here must not affect the write path (PRD: Redis outage ≠ false failure).
  try {
    await redis.set(
      `idem:${key}`,
      JSON.stringify({ result, incidentId, operationId: opts.operationId }),
      "EX",
      config.idempotencyTtlSec,
    );
  } catch {
    // degraded cache — Postgres already holds the outcome.
  }
}
