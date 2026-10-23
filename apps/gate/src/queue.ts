import { Queue, Worker, type ConnectionOptions, type Job } from "bullmq";
import { config } from "./config.ts";
import { isRedisUp } from "./redis.ts";
import { postNotifyEvent, type NotifyEvent } from "./notify.ts";
import { pool } from "./db.ts";

const OUTBOX = "errorkicker-outbox";
const DLQ = "errorkicker-outbox-dlq";
const MAX_ATTEMPTS = 5;

function connection(): ConnectionOptions {
  const u = new URL(config.redisUrl);
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    password: u.password ? decodeURIComponent(u.password) : undefined,
    maxRetriesPerRequest: null,
  };
}

let queue: Queue | null = null;
let dlq: Queue | null = null;
let worker: Worker | null = null;

function getQueue(): Queue {
  if (!queue) queue = new Queue(OUTBOX, { connection: connection() });
  return queue;
}

function getDlq(): Queue {
  if (!dlq) dlq = new Queue(DLQ, { connection: connection() });
  return dlq;
}

async function markPublished(eventId: string): Promise<void> {
  await pool.query(
    `UPDATE outbox_events SET published_at = now() WHERE event_id = $1 AND published_at IS NULL`,
    [eventId],
  );
}

async function bumpAttempt(eventId: string): Promise<void> {
  await pool.query(`UPDATE outbox_events SET attempts = attempts + 1 WHERE event_id = $1`, [
    eventId,
  ]);
}

export async function enqueueOutbox(
  eventId: string,
  payload: NotifyEvent,
): Promise<boolean> {
  if (!isRedisUp()) return false;
  try {
    await getQueue().add(
      "deliver",
      { eventId, payload },
      {
        jobId: eventId,
        attempts: MAX_ATTEMPTS,
        backoff: { type: "exponential", delay: 2000 },
        removeOnComplete: 200,
        removeOnFail: false,
      },
    );
    return true;
  } catch (err) {
    const msg = (err as Error).message;
    if (/already (exists|exists)/i.test(msg) || msg.includes("Job is already")) return true;
    console.warn("[outbox] enqueue failed:", msg);
    return false;
  }
}

async function deliver(job: Job<{ eventId: string; payload: NotifyEvent }>): Promise<void> {
  const { eventId, payload } = job.data;
  await bumpAttempt(eventId);
  if (!config.n8nWebhookUrl) {
    await markPublished(eventId);
    return;
  }
  const result = await postNotifyEvent(config.n8nWebhookUrl, payload);
  if (!result.delivered) {
    throw new Error(result.error ?? `http ${result.httpStatus ?? "unknown"}`);
  }
  await markPublished(eventId);
}

export async function startOutboxWorker(): Promise<void> {
  if (!isRedisUp()) {
    console.warn("⚠ outbox worker not started — Redis down; publisher will HTTP-fallback");
    return;
  }
  worker = new Worker(OUTBOX, deliver, { connection: connection(), concurrency: 4 });
  worker.on("failed", (job, err) => {
    console.error(`[outbox] job ${job?.id} failed:`, err.message);
    if (job && (job.attemptsMade ?? 0) >= MAX_ATTEMPTS) {
      void getDlq()
        .add("dead", job.data, { jobId: job.id })
        .then(() => markPublished(job.data.eventId))
        .catch((e) => console.error("[outbox] dlq failed:", (e as Error).message));
    }
  });
  console.log("   outbox worker: BullMQ ON (dlq: errorkicker-outbox-dlq)");
}

export async function stopOutboxWorker(): Promise<void> {
  await worker?.close().catch(() => undefined);
  await queue?.close().catch(() => undefined);
  await dlq?.close().catch(() => undefined);
}
