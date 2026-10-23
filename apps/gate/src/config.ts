import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseNotifyStatuses } from "./notify.ts";

// Load a repo-root or cwd .env without adding a dependency. Existing
// process.env values win, so Docker / shell exports stay authoritative.
function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const here = dirname(fileURLToPath(import.meta.url));
loadEnvFile(resolve(process.cwd(), ".env"));
loadEnvFile(resolve(here, "../../../.env"));

// Centralised environment config. Everything has a sane local default so
// `docker compose up` + `npm run dev` works with zero configuration.
export const config = {
  port: Number(process.env.GATE_PORT ?? 3001),
  databaseUrl:
    process.env.DATABASE_URL ??
    "postgres://kicker:kicker@localhost:5432/errorkicker",
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",

  llmEnabled: process.env.LLM_ENABLED === "true",
  openaiBaseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
  openaiApiKey: process.env.OPENAI_API_KEY ?? "",
  llmModel: process.env.LLM_MODEL ?? "gpt-6-luna",

  slackWebhookUrl: process.env.SLACK_WEBHOOK_URL ?? "",
  alertEmailTo: process.env.ALERT_EMAIL_TO ?? "",

  // Optional outbound sink. n8n Cloud cannot reach localhost, so the gate
  // POSTs out. Empty = no network call; outbox rows are still marked done.
  n8nWebhookUrl: process.env.N8N_WEBHOOK_URL ?? "",
  n8nNotifyStatuses: parseNotifyStatuses(process.env.N8N_NOTIFY_STATUSES),

  // Fingerprint TTLs / thresholds
  fingerprintTtlSec: 600, // exact-dedup window per table (Postgres fingerprints)
  idempotencyTtlSec: 24 * 3600, // PRD §15 default: 24h idempotency window
  baselineSamples: 200, // rolling window for anomaly detection
  baselineMinSamples: 20, // need this many before outlier checks fire
  outlierZ: 4, // |z| above this kicks D10
  alertDedupTtlSec: 15 * 60, // one alert per fingerprint per 15 min
};
