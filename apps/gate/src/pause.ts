import type { PoolClient } from "pg";
import { executor, pool } from "./db.ts";

// ---------------------------------------------------------------------------
// Pause Manager. Pausing is a persisted state, not a hung request.
// PRD v1.0 alignment: BOTH the pipeline state (table pipeline_state, with
// sequence + checkpoint numbers) AND the held queue (table pending_writes,
// ordered by sequence_no) live in PostgreSQL — so a pause survives a server
// restart mid-demo and a Redis outage changes nothing. The legacy
// `checkpoints` table from migration 001 is bridged into pipeline_state by
// migration 002 and is no longer read or written by code.
// ---------------------------------------------------------------------------

export type PipelineState =
  | "RUNNING"
  | "PAUSED_AWAITING_REVIEW"
  | "ESCALATED"
  | "ABORTED";

export interface QueuedWrite {
  table: string;
  record: Record<string, unknown>;
  idempotencyKey?: string;
  traceId: string;
  /** Durable identity from write_operations / pending_writes (002). */
  operationId?: string;
  sequenceNo?: number;
}

export interface PipelineInfo {
  state: PipelineState;
  queuedCount: number;
  pausedAt: string | null;
  nextSequence: number;
  lastCompletedSequence: number;
  heldOperationId: string | null;
  version: number;
}

/** Make sure a pipeline_state row exists (RUNNING, next_sequence = 1). */
export async function ensurePipeline(
  pipelineId: string,
  client?: PoolClient,
): Promise<void> {
  await executor(client).query(
    "INSERT INTO pipeline_state (pipeline_id) VALUES ($1) ON CONFLICT (pipeline_id) DO NOTHING",
    [pipelineId],
  );
}

/**
 * Allocate the next per-pipeline sequence number. Sequences define the
 * ordering guarantee (FR-09): pending writes resume in sequence order,
 * independent pipelines proceed independently.
 */
export async function allocateSequence(
  pipelineId: string,
  client?: PoolClient,
): Promise<number> {
  await ensurePipeline(pipelineId, client);
  const { rows } = await executor(client).query(
    `UPDATE pipeline_state
        SET next_sequence = next_sequence + 1, updated_at = now()
      WHERE pipeline_id = $1
      RETURNING next_sequence - 1 AS sequence_no`,
    [pipelineId],
  );
  return rows[0].sequence_no as number;
}

/** Checkpoint advance: record the last durably completed sequence. */
export async function setLastCompleted(
  pipelineId: string,
  sequenceNo: number,
  client?: PoolClient,
): Promise<void> {
  await executor(client).query(
    `UPDATE pipeline_state
        SET last_completed_sequence = GREATEST(last_completed_sequence, $2),
            updated_at = now()
      WHERE pipeline_id = $1`,
    [pipelineId, sequenceNo],
  );
}

export async function pendingCount(
  pipelineId: string,
  client?: PoolClient,
): Promise<number> {
  const { rows } = await executor(client).query(
    `SELECT COUNT(*)::int AS c FROM pending_writes
      WHERE pipeline_id = $1 AND status IN ('PENDING', 'PROCESSING')`,
    [pipelineId],
  );
  return rows[0].c as number;
}

export async function getPipeline(pipelineId: string): Promise<PipelineInfo> {
  await ensurePipeline(pipelineId);
  const { rows } = await pool.query(
    `SELECT state, paused_at, next_sequence, last_completed_sequence,
            held_operation_id, version
       FROM pipeline_state WHERE pipeline_id = $1`,
    [pipelineId],
  );
  const r = rows[0] as {
    state: PipelineState;
    paused_at: string | null;
    next_sequence: number;
    last_completed_sequence: number;
    held_operation_id: string | null;
    version: number;
  };
  return {
    state: r.state,
    queuedCount: await pendingCount(pipelineId),
    pausedAt: r.paused_at,
    nextSequence: Number(r.next_sequence),
    lastCompletedSequence: Number(r.last_completed_sequence),
    heldOperationId: r.held_operation_id,
    version: r.version,
  };
}

export async function listPipelines(): Promise<
  Array<{
    pipeline_id: string;
    state: PipelineState;
    queued_count: number;
    paused_at: string | null;
    updated_at: string;
    next_sequence: number;
    last_completed_sequence: number;
    held_operation_id: string | null;
    version: number;
  }>
> {
  const { rows } = await pool.query(
    `SELECT ps.pipeline_id, ps.state, ps.paused_at, ps.updated_at,
            ps.next_sequence, ps.last_completed_sequence,
            ps.held_operation_id, ps.version,
            (SELECT COUNT(*)::int FROM pending_writes pw
              WHERE pw.pipeline_id = ps.pipeline_id
                AND pw.status IN ('PENDING', 'PROCESSING')) AS queued_count
       FROM pipeline_state ps
      ORDER BY ps.updated_at DESC`,
  );
  return rows;
}

/** Flip to PAUSED on a kick. First kick wins paused_at (pause duration). */
export async function markPaused(
  pipelineId: string,
  heldOperationId?: string,
  client?: PoolClient,
): Promise<void> {
  const q = executor(client);
  await ensurePipeline(pipelineId, client);
  await q.query(
    `UPDATE pipeline_state
        SET state = 'PAUSED_AWAITING_REVIEW',
            paused_at = COALESCE(paused_at, now()),
            held_operation_id = COALESCE(held_operation_id, $2),
            version = version + 1,
            updated_at = now()
      WHERE pipeline_id = $1`,
    [pipelineId, heldOperationId ?? null],
  );
}

/** Generic persisted state transition (pause / abort / resume helpers). */
export async function setPipelineState(
  pipelineId: string,
  state: PipelineState,
  client?: PoolClient,
): Promise<void> {
  const q = executor(client);
  await ensurePipeline(pipelineId, client);
  await q.query(
    `UPDATE pipeline_state
        SET state = $2, version = version + 1, updated_at = now()
      WHERE pipeline_id = $1`,
    [pipelineId, state],
  );
}

/**
 * Hold a write that passed the gate while its pipeline is paused (or
 * aborted — processing is stopped, the write is durably kept, not lost).
 * Returns the write's sequence number, which is its position in the
 * pipeline's durable order.
 */
export async function enqueueWhilePaused(
  pipelineId: string,
  write: QueuedWrite,
): Promise<number> {
  if (!write.operationId) throw new Error("queued writes need an operationId");
  const sequenceNo = write.sequenceNo ?? (await allocateSequence(pipelineId));
  await pool.query(
    `INSERT INTO pending_writes
       (operation_id, pipeline_id, sequence_no, table_name, payload,
        idempotency_key, trace_id, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'PENDING')
     ON CONFLICT (operation_id) DO NOTHING`,
    [
      write.operationId,
      pipelineId,
      sequenceNo,
      write.table,
      JSON.stringify(write.record),
      write.idempotencyKey ?? null,
      write.traceId,
    ],
  );
  return sequenceNo;
}

interface PendingRow {
  operation_id: string;
  pipeline_id: string;
  sequence_no: number | string;
  table_name: string;
  payload: Record<string, unknown>;
  idempotency_key: string | null;
  trace_id: string | null;
}

function rowToWrite(r: PendingRow): QueuedWrite {
  return {
    table: r.table_name,
    record: r.payload,
    idempotencyKey: r.idempotency_key ?? undefined,
    traceId: r.trace_id ?? "",
    operationId: r.operation_id,
    sequenceNo: Number(r.sequence_no),
  };
}

/**
 * Pop the oldest held write (lowest sequence_no) and mark it PROCESSING.
 * A crash mid-drain leaves it PROCESSING, so the next drain picks it up
 * again — never silently lost (FR-08).
 */
async function popQueued(pipelineId: string): Promise<QueuedWrite | null> {
  const { rows } = await pool.query(
    `WITH next AS (
       SELECT operation_id FROM pending_writes
        WHERE pipeline_id = $1 AND status IN ('PENDING', 'PROCESSING')
        ORDER BY sequence_no ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
     )
     UPDATE pending_writes pw
        SET status = 'PROCESSING', updated_at = now()
       FROM next
      WHERE pw.operation_id = next.operation_id
      RETURNING pw.*`,
    [pipelineId],
  );
  return rows.length ? rowToWrite(rows[0] as PendingRow) : null;
}

export async function markPendingStatus(
  operationId: string,
  status: "COMMITTED" | "KICKED" | "DROPPED",
): Promise<void> {
  await pool.query(
    "UPDATE pending_writes SET status = $2, updated_at = now() WHERE operation_id = $1",
    [operationId, status],
  );
}

/** Drop every held write (abort). Returns the dropped writes for audit. */
export async function clearQueue(pipelineId: string): Promise<QueuedWrite[]> {
  const { rows } = await pool.query(
    `UPDATE pending_writes SET status = 'DROPPED', updated_at = now()
      WHERE pipeline_id = $1 AND status IN ('PENDING', 'PROCESSING')
      RETURNING *`,
    [pipelineId],
  );
  return (rows as PendingRow[])
    .sort((a, b) => Number(a.sequence_no) - Number(b.sequence_no))
    .map(rowToWrite);
}

/**
 * Drain the held queue in sequence order through the gate. Returns how many
 * writes committed vs kicked again (a re-kick re-pauses the pipeline; the
 * caller decides whether processing may continue).
 */
export async function drainQueue(
  pipelineId: string,
  handle: (w: QueuedWrite) => Promise<"committed" | "kicked">,
): Promise<{ committed: number; kicked: number }> {
  let committed = 0;
  let kicked = 0;
  for (;;) {
    const w = await popQueued(pipelineId);
    if (!w) break;
    const outcome = await handle(w);
    if (w.operationId)
      await markPendingStatus(w.operationId, outcome === "committed" ? "COMMITTED" : "KICKED");
    if (outcome === "committed") committed++;
    else kicked++;
  }
  return { committed, kicked };
}

/** Resume: returns the pause duration in ms (0 when it wasn't paused). */
export async function markRunning(pipelineId: string): Promise<number> {
  await ensurePipeline(pipelineId);
  const { rows } = await pool.query(
    "SELECT paused_at FROM pipeline_state WHERE pipeline_id = $1",
    [pipelineId],
  );
  const pausedAt = rows[0]?.paused_at as string | null | undefined;
  const ms = pausedAt ? Math.max(0, Date.now() - new Date(pausedAt).getTime()) : 0;
  await pool.query(
    `UPDATE pipeline_state
        SET state = 'RUNNING', paused_at = NULL, held_operation_id = NULL,
            version = version + 1, updated_at = now()
      WHERE pipeline_id = $1`,
    [pipelineId],
  );
  return Math.round(ms);
}
