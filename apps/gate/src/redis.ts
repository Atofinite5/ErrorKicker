import { Redis } from "ioredis";
import { config } from "./config.ts";

// PRD v1.0 (Arch §1/§9): PostgreSQL is authoritative. Redis is a
// best-effort cache / async helper ONLY (anomaly baseline, alert dedup).
// If Redis is unreachable the gate keeps accepting writes via Postgres and
// those helpers degrade gracefully — Redis state is never the only copy of
// an accepted write, an incident, a queue entry or an idempotency outcome.
export const redis = new Redis(config.redisUrl, {
  maxRetriesPerRequest: 2,
  enableOfflineQueue: false,
  retryStrategy: (times) => Math.min(times * 200, 2000),
});

let redisOk = false;
redis.on("ready", () => {
  redisOk = true;
});
redis.on("end", () => {
  redisOk = false;
});
// Never let a dropped connection crash the process with an unhandled
// 'error' event — degraded state is reported via isRedisUp() + /health.
redis.on("error", () => undefined);

export function isRedisUp(): boolean {
  return redisOk;
}
