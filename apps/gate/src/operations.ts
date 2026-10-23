import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { config } from "./config.ts";
import { executor, pool } from "./db.ts";
import { postNotifyEvent, shouldNotify, type NotifyEvent } from "./notify.ts";
import { allocateSequence } from "./pause.ts";
import { enqueueOutbox } from "./queue.ts";

// ---------------------------------------------------------------------------
// Durable write operations + transactional outbox (PRD Arch §4/§6/§9).
// Every accepted write request gets a write_operations row with a
// per-pipeline sequence number BEFORE the gate verdict is acted on, and its
// outcome (COMMITTED / QUARANTINED / QUEUED) is recorded in the same
// Postgres transaction as the effect itself. Outbox rows are written in
// that same transaction; the v1 publisher below is a stub that marks rows
// published after BullMQ delivery (or HTTP fallback). Delivery is at-least-once
// and consumers must be idempotent, Arch §9).
// ---------------------------------------------------------------------------

export type OperationStatus =
  | "RECEIVED"
  | "COMMITTED"
  | "QUARANTINED"
  | "QUEUED"
  | "DROPPED"
  | "REPLAYED";

export interface WriteOperation {
  operation_id: string;
  pipeline_id: string;
  sequence_no: number;
  table_name: string;
  request_hash: string;
  idempotency_key: string | null;
  payload: Record<string, unknown>;
  status: OperationStatus;
  result_json: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export async function createOperation(opts: {
  pipelineId: string;
  table: string;
  record: Record<string, unknown>;
  requestHash: string;
  idempotencyKey?: string;
}): Promise<{ operationId: string; sequenceNo: number }> {
  const operationId = `op_${randomUUID().slice(0, 12)}`;
  const sequenceNo = await allocateSequence(opts.pipelineId);
  await pool.query(
    `INSERT INTO write_operations
       (operation_id, pipeline_id, sequence_no, table_name, request_hash,
        idempotency_key, payload, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'RECEIVED')`,
    [
      operationId,
      opts.pipelineId,
      sequenceNo,
      opts.table,
      opts.requestHash,
      opts.idempotencyKey ?? null,
      JSON.stringify(opts.record),
    ],
  );
  return { operationId, sequenceNo };
}

export async function updateOperationStatus(
  operationId: string,
  status: OperationStatus,
  resultJson?: Record<string, unknown>,
  client?: PoolClient,
): Promise<void> {
  await executor(client).query(
    `UPDATE write_operations
        SET status = $2,
            result_json = COALESCE($3, result_json),
            updated_at = now()
      WHERE operation_id = $1`,
    [operationId, status, resultJson ? JSON.stringify(resultJson) : null],
  );
}

export async function getOperation(operationId: string): Promise<WriteOperation | null> {
  const { rows } = await pool.query(
    "SELECT * FROM write_operations WHERE operation_id = $1",
    [operationId],
  );
  if (!rows.length) return null;
  const r = rows[0] as WriteOperation & { sequence_no: number | string };
  return { ...r, sequence_no: Number(r.sequence_no) };
}

export async function countOperations(pipelineId: string): Promise<{
  committed: number;
  quarantined: number;
  queued: number;
  received: number;
}> {
  const { rows } = await pool.query(
    `SELECT status, COUNT(*)::int AS c FROM write_operations
      WHERE pipeline_id = $1 GROUP BY status`,
    [pipelineId],
  );
  const out = { committed: 0, quarantined: 0, queued: 0, received: 0 };
  for (const r of rows as Array<{ status: string; c: number }>) {
    if (r.status === "COMMITTED") out.committed = r.c;
    else if (r.status === "QUARANTINED") out.quarantined = r.c;
    else if (r.status === "QUEUED") out.queued = r.c;
    else if (r.status === "RECEIVED") out.received = r.c;
  }
  return out;
}

// --- transactional outbox ---------------------------------------------------

/** Insert an outbox event — call inside the commit/block transaction. */
export async function insertOutboxEvent(
  aggregateId: string,
  eventType: string,
  payload: object,
  client?: PoolClient,
): Promise<string> {
  const eventId = `evt_${randomUUID().slice(0, 12)}`;
  await executor(client).query(
    `INSERT INTO outbox_events (event_id, aggregate_id, event_type, payload)
     VALUES ($1, $2, $3, $4)`,
    [eventId, aggregateId, eventType, JSON.stringify(payload)],
  );
  return eventId;
}

const OUTBOX_GIVE_UP_AFTER = 8;

async function markOutboxPublished(eventId: string): Promise<void> {
  await pool.query(
    `UPDATE outbox_events
        SET published_at = now()
      WHERE event_id = $1 AND published_at IS NULL`,
    [eventId],
  );
}

async function bumpOutboxAttempt(eventId: string): Promise<number> {
  const { rows } = await pool.query(
    `UPDATE outbox_events
        SET attempts = attempts + 1
      WHERE event_id = $1
      RETURNING attempts`,
    [eventId],
  );
  return Number(rows[0]?.attempts ?? 0);
}

/**
 * Deliver unpublished outbox rows, then mark them published.
 * When N8N_WEBHOOK_URL is set, kicked/queued (and committed if opted in)
 * POSTs go to n8n. Other rows, or a missing URL, are marked done locally
 * so the table does not grow forever. Delivery is at-least-once; n8n must
 * tolerate duplicates. A failed POST leaves the row unpublished unless
 * attempts are exhausted. Never throws into the write path.
 */
export async function publishPendingOutbox(limit = 100): Promise<number> {
  const { rows } = await pool.query(
    `SELECT event_id, event_type, payload, attempts
       FROM outbox_events
      WHERE published_at IS NULL
      ORDER BY created_at ASC
      LIMIT $1`,
    [limit],
  );
  let done = 0;
  for (const row of rows as Array<{
    event_id: string;
    event_type: string;
    payload: NotifyEvent;
    attempts: number;
  }>) {
    const payload = row.payload;
    const wantsN8n =
      Boolean(config.n8nWebhookUrl) && shouldNotify(payload?.status, config.n8nNotifyStatuses);
    if (!wantsN8n) {
      await markOutboxPublished(row.event_id);
      done++;
      continue;
    }
    const queued = await enqueueOutbox(row.event_id, payload);
    if (queued) {
      done++;
      continue;
    }
    const result = await postNotifyEvent(config.n8nWebhookUrl, payload);
    if (result.delivered) {
      await markOutboxPublished(row.event_id);
      done++;
      continue;
    }
    const attempts = await bumpOutboxAttempt(row.event_id);
    console.error(
      `[outbox] n8n delivery failed for ${row.event_id}` +
        ` (attempt ${attempts}/${OUTBOX_GIVE_UP_AFTER}` +
        `${result.httpStatus ? ` http ${result.httpStatus}` : ""}` +
        `${result.error ? `: ${result.error}` : ""})`,
    );
    if (attempts >= OUTBOX_GIVE_UP_AFTER) {
      await markOutboxPublished(row.event_id);
      done++;
    }
  }
  return done;
}
