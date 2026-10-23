import { config } from "./config.ts";
import { redis } from "./redis.ts";
import type { Severity } from "./rules.ts";

// ---------------------------------------------------------------------------
// Alert router: the right person, once.
// Deduped by incident fingerprint (check + table + field): 50 identical bad
// records from one broken form produce ONE alert saying "x50", not 50 pings.
//
// PRD §15 defaults: external alerts (Slack/email) fire for severity HIGH
// and CRITICAL only. The fingerprint dedup lives in Redis (best-effort
// cache): if Redis is down, dedup is skipped and the alert is sent —
// an alert must never throw into, or block, the write path.
// ---------------------------------------------------------------------------

export async function routeAlert(opts: {
  severity: Severity;
  fingerprint: string;
  title: string;
  body: string;
}): Promise<{ sent: boolean; suppressedAsDuplicate: boolean }> {
  const { severity, fingerprint, title, body } = opts;

  // Storm guard: count first, then decide — best-effort only.
  try {
    const count = await redis.incr(`alertcount:${fingerprint}`);
    if (count === 1) await redis.expire(`alertcount:${fingerprint}`, 3600);
    const first = await redis.set(
      `alertfp:${fingerprint}`,
      "1",
      "EX",
      config.alertDedupTtlSec,
      "NX",
    );
    if (first === null) {
      console.log(`[alert suppressed x${count}] ${title}`);
      return { sent: false, suppressedAsDuplicate: true };
    }
  } catch {
    console.warn(`[alert] dedup unavailable (Redis?) — sending without dedup: ${title}`);
  }

  const text = `🚨 [${severity.toUpperCase()}] ${title}\n${body}`;
  console.log(text);

  if (severity === "critical" || severity === "high") {
    if (config.slackWebhookUrl) {
      try {
        await fetch(config.slackWebhookUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text }),
          signal: AbortSignal.timeout(5000),
        });
      } catch (err) {
        console.error("[alert] slack webhook failed:", (err as Error).message);
      }
    }
    // Email is intentionally a console line in v1 — wire Resend/SMTP here.
    if (config.alertEmailTo) console.log(`[alert] email → ${config.alertEmailTo}: ${title}`);
  }
  return { sent: true, suppressedAsDuplicate: false };
}
