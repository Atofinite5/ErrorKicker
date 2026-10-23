import Fastify from "fastify";
import { config } from "./config.ts";
import { initDb } from "./db.ts";
import { isRedisUp, redis } from "./redis.ts";
import { registerRoutes } from "./routes.ts";

async function main(): Promise<void> {
  // PostgreSQL is authoritative (PRD Arch §1) — wait for it, retrying while
  // docker compose brings it up. Redis is a best-effort cache/async helper
  // ONLY: if it is unreachable the gate still starts and keeps accepting
  // writes via Postgres; the anomaly baseline and alert dedup degrade
  // gracefully (see anomaly.ts / alerts.ts). The gate NEVER exits or
  // refuses writes because Redis is down.
  let dbReady = false;
  for (let i = 0; i < 30 && !dbReady; i++) {
    try {
      await initDb();
      dbReady = true;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  if (!dbReady) {
    console.error("postgres unreachable after 30s — the gate cannot run without its authoritative store. Exiting.");
    process.exit(1);
  }
  if (!isRedisUp())
    console.warn(
      "⚠ redis unreachable at boot — continuing on Postgres only: anomaly baseline + alert dedup are degraded, writes are unaffected.",
    );

  const app = Fastify({ logger: true });
  app.setErrorHandler((err, _req, reply) => {
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    reply.code(status).send({ error: (err as Error).message });
  });
  await registerRoutes(app);

  await app.listen({ port: config.port, host: "0.0.0.0" });
  console.log(`⚡ ErrorKicker gate listening on :${config.port}`);
  console.log(`   LLM explanations: ${config.llmEnabled ? "ON" : "OFF (rule templates only)"}`);
  console.log(
    config.n8nWebhookUrl
      ? `   n8n outbound: ON (${config.n8nNotifyStatuses.join(", ")})`
      : "   n8n outbound: OFF",
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

process.on("SIGTERM", async () => {
  await redis.quit().catch(() => undefined);
  process.exit(0);
});
