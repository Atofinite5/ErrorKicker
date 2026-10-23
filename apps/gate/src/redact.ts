// Redact secrets and PII before a record is sent to an LLM or any other
// untrusted network. IDs are dropped; remaining sensitive keys/values are
// replaced with "[redacted]". Deterministic — no network.

const ID_KEY = /^(id|.*id|.*_id)$/i;
const PII_KEY = /^(email|e-mail|phone|mobile|tel)$/i;
const SECRET_KEY =
  /^(password|passwd|secret|token|authorization|auth|api[_-]?key|access[_-]?key|refresh[_-]?token|private[_-]?key|ssn|pan|aadhaar|credit[_-]?card|card[_-]?number|cvv|otp|pin)$/i;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const PHONE = /\+?[0-9][0-9\s().-]{8,18}[0-9]/;
const JWT = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/;
const AWS = /\bAKIA[0-9A-Z]{16}\b/;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/i;

function redactString(value: string): string {
  return value
    .replace(JWT, "[redacted]")
    .replace(AWS, "[redacted]")
    .replace(BEARER, "Bearer [redacted]")
    .replace(EMAIL, "[redacted]")
    .replace(PHONE, "[redacted]");
}

function walk(value: unknown, key?: string): unknown {
  if (key && (ID_KEY.test(key) || SECRET_KEY.test(key) || PII_KEY.test(key))) return "[redacted]";
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map((v) => walk(v));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>))
      out[k] = walk(v, k);
    return out;
  }
  return value;
}

/** Record safe to send off-box. Never include the original. */
export function llmSafeRecord(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record)) {
    if (ID_KEY.test(k) || SECRET_KEY.test(k) || PII_KEY.test(k)) continue;
    out[k] = walk(v, k);
  }
  return out;
}

export function containsRedacted(value: unknown): boolean {
  return JSON.stringify(value).includes("[redacted]");
}
