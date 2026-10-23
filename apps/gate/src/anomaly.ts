import { config } from "./config.ts";
import { llmSafeRecord } from "./redact.ts";
import { redis } from "./redis.ts";

export { llmSafeRecord } from "./redact.ts";

// ---------------------------------------------------------------------------
// Stage D: anomaly + AI. Runs last — only records that survived the cheap,
// certain stages ever reach the expensive ones.
//   D10 statistical outlier vs a rolling baseline (Redis list per table.field)
//   D11 suspicious patterns (injection shapes, absurd lengths)
//   D12 LLM sanity review — OFF by default; strict-JSON, template fallback.
//
// PRD v1.0: the D10 baseline lives in Redis, a best-effort cache. If Redis
// is down the check SKIPS (returns null) and the write path continues on
// Postgres — it never throws into the write path and never blocks or
// passes a write based on state it could not actually read.
// ---------------------------------------------------------------------------

export interface Outlier {
  z: number;
  mean: number;
  samples: number;
}

/** Check a numeric value against the rolling baseline. Null = not an outlier. */
export async function checkOutlier(
  table: string,
  field: string,
  value: number,
): Promise<Outlier | null> {
  try {
    const key = `base:${table}:${field}`;
    const n = await redis.llen(key);
    if (n < config.baselineMinSamples) return null;
    const raw = await redis.lrange(key, 0, -1);
    const vals = raw.map(Number).filter((v) => Number.isFinite(v));
    if (vals.length < config.baselineMinSamples) return null;
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const variance = vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length;
    const sd = Math.sqrt(variance);
    if (sd === 0) return null;
    const z = (value - mean) / sd;
    return Math.abs(z) > config.outlierZ ? { z, mean, samples: vals.length } : null;
  } catch {
    // Redis down → baseline unavailable → skip D10 for this write.
    console.warn(`[anomaly] baseline unavailable (Redis?) — D10 skipped for ${table}.${field}`);
    return null;
  }
}

/** Feed a committed (clean) value into the rolling baseline. */
export async function observeBaseline(
  table: string,
  field: string,
  value: number,
): Promise<void> {
  if (!Number.isFinite(value)) return;
  try {
    const key = `base:${table}:${field}`;
    await redis.lpush(key, String(value));
    await redis.ltrim(key, 0, config.baselineSamples - 1);
  } catch {
    // Best-effort cache: a missed baseline sample is not a write failure.
  }
}

const SUSPICIOUS: RegExp[] = [
  /\b(union\s+select|select\s+.+\s+from|insert\s+into|drop\s+table|delete\s+from)\b/i,
  /<\s*script/i,
  /\beval\s*\(/i,
];

function* stringValues(value: unknown, depth: number): Generator<string> {
  if (depth < 0 || value == null) return;
  if (typeof value === "string") {
    yield value;
    return;
  }
  if (Array.isArray(value)) {
    for (const el of value) yield* stringValues(el, depth - 1);
    return;
  }
  if (typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>))
      yield* stringValues(v, depth - 1);
  }
}

/** D11: returns the offending snippet, or null when clean. */
export function findSuspiciousPattern(record: unknown): string | null {
  for (const s of stringValues(record, 2)) {
    if (s.length > 5000) return s.slice(0, 60) + "… (over 5000 chars)";
    for (const re of SUSPICIOUS) {
      const m = s.match(re);
      if (m) return m[0];
    }
  }
  return null;
}

// --- D12: LLM sanity review (optional, circuit-broken) -----------------------

let consecutiveFailures = 0;
let breakerUntil = 0;

export interface LlmReview {
  ok: boolean;
  reason?: string;
}

export interface AnomalyReport {
  score: number;
  reasons: string[];
}

function iqrOutlier(vals: number[], value: number): boolean {
  const s = [...vals].sort((a, b) => a - b);
  const q = (p: number) => {
    const i = (s.length - 1) * p;
    const lo = Math.floor(i);
    const hi = Math.ceil(i);
    return lo === hi ? s[lo] : s[lo] * (hi - i) + s[hi] * (i - lo);
  };
  const q1 = q(0.25);
  const q3 = q(0.75);
  const fence = 1.5 * (q3 - q1);
  return value < q1 - fence || value > q3 + fence;
}

/**
 * Composite 0–100 score. Review-first: a high score kicks, it never auto-fixes.
 * Redis down → score 0 (skip), same as D10.
 */
export async function scoreAnomaly(
  table: string,
  record: Record<string, unknown>,
): Promise<AnomalyReport> {
  const reasons: string[] = [];
  let score = 0;
  try {
    for (const field of table === "orders" ? ["total"] : table === "users" ? ["age"] : []) {
      const value = record[field];
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      const key = `base:${table}:${field}`;
      const raw = await redis.lrange(key, 0, -1);
      const vals = raw.map(Number).filter((v) => Number.isFinite(v));
      if (vals.length < config.baselineMinSamples) continue;
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length);
      if (sd > 0) {
        const z = Math.abs((value - mean) / sd);
        if (z >= 3) {
          score += Math.min(50, Math.round((z / config.outlierZ) * 40));
          reasons.push(`${field} |z|=${z.toFixed(2)} vs mean ${mean.toFixed(1)}`);
        }
      }
      if (iqrOutlier(vals, value)) {
        score += 25;
        reasons.push(`${field} outside 1.5 IQR fences`);
      }
    }
  } catch {
    return { score: 0, reasons: [] };
  }
  if (typeof record.name === "string" && record.name.trim().split(/\s+/).length === 1)
    score += 10;
  if (table === "users" && !record.phone && !record.age) {
    score += 8;
    reasons.push("user missing phone and age");
  }
  return { score: Math.min(100, score), reasons };
}

/** Optional explanation polish. Never invents a fix; templates stay authoritative. */
export async function llmExplain(opts: {
  table: string;
  checkFired: string;
  explanation: string;
  record: Record<string, unknown>;
}): Promise<string | null> {
  if (!config.llmEnabled || !config.openaiApiKey) return null;
  try {
    const res = await fetch(`${config.openaiBaseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.openaiApiKey}`,
      },
      body: JSON.stringify({
        model: config.llmModel,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              'Rewrite the gate explanation in one or two plain sentences. Reply JSON {"explanation": string}. Do not propose extra fields. Do not invent facts.',
          },
          {
            role: "user",
            content: JSON.stringify({
              table: opts.table,
              check: opts.checkFired,
              explanation: opts.explanation,
              record: llmSafeRecord(opts.record),
            }),
          },
        ],
      }),
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const parsed = JSON.parse(body.choices?.[0]?.message?.content ?? "{}") as {
      explanation?: unknown;
    };
    return typeof parsed.explanation === "string" && parsed.explanation.trim()
      ? parsed.explanation.trim()
      : null;
  } catch {
    return null;
  }
}

/**
 * Ask the LLM whether an otherwise-clean record looks fabricated.
 * Returns null when disabled, broken, or circuit-broken — the gate then
 * simply passes the record (templates already covered the known badness).
 */
export async function llmReview(
  table: string,
  record: unknown,
): Promise<LlmReview | null> {
  if (!config.llmEnabled || !config.openaiApiKey) return null;
  if (Date.now() < breakerUntil) return null;

  try {
    const res = await fetch(`${config.openaiBaseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.openaiApiKey}`,
      },
      body: JSON.stringify({
        model: config.llmModel,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "You review database records for fabrication or nonsense. Reply with strict JSON only: {\"ok\": boolean, \"reason\": string}. ok=true means the record looks genuine.",
          },
          {
            role: "user",
            content: `Table: ${table}\nRecord: ${JSON.stringify(llmSafeRecord(record as Record<string, unknown>))}`,
          },
        ],
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);
    const body = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const parsed = JSON.parse(body.choices?.[0]?.message?.content ?? "{}") as LlmReview;
    if (typeof parsed.ok !== "boolean") throw new Error("LLM returned invalid JSON shape");
    consecutiveFailures = 0;
    return parsed;
  } catch {
    consecutiveFailures++;
    if (consecutiveFailures >= 3) breakerUntil = Date.now() + 5 * 60 * 1000;
    return null; // circuit breaker: degrade to rules-only, honestly
  }
}
