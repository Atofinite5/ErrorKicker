import { randomUUID } from "node:crypto";
import { checkOutlier, findSuspiciousPattern, llmReview, observeBaseline } from "./anomaly.ts";
import { audit } from "./audit.ts";
import { routeAlert } from "./alerts.ts";
import {
  isExactDuplicate,
  recordFingerprint,
  requestHash,
  storeIdempotency,
} from "./dedup.ts";
import { appTable, pool, withTx } from "./db.ts";
import { addedFields, suggestFix, type FixSuggestion } from "./fixes.ts";
import {
  countIncidentsByState,
  countOpenIncidents,
  createIncident,
  decideIncident,
  getIncident,
  setIncidentState,
  versionConflict,
  type Incident,
} from "./incidents.ts";
import {
  emitEvent,
  metricsSnapshot,
  recordPauseDuration,
  recordWrite,
} from "./metrics.ts";
import { buildNotifyEvent } from "./notify.ts";
import {
  countOperations,
  insertOutboxEvent,
  publishPendingOutbox,
  updateOperationStatus,
} from "./operations.ts";
import {
  clearQueue,
  drainQueue,
  getPipeline,
  markPaused,
  markRunning,
  pendingCount,
  setLastCompleted,
  setPipelineState,
  type QueuedWrite,
} from "./pause.ts";
import {
  evaluateRules,
  loadRules,
  type RuleDef,
  type Severity,
} from "./rules.ts";
import { knownFields, mapZodIssue, tableSchemas } from "./schemas.ts";

// ---------------------------------------------------------------------------
// The gate: every write flows Write → GATE → Pass | Kick (Postgres commits).
// Stages run cheapest-first; a record exits at the first stage that kicks it.
//
// PRD v1.0 alignment notes:
// - Idempotency is handled by the ROUTE (routes.ts) against PostgreSQL
//   before evaluation: same key + same hash replays the durable result,
//   same key + different hash is a 409 (FR-02). evaluateWrite itself is the
//   deterministic gate only — it never consults Redis for a decision, so a
//   Redis outage cannot change a verdict or stop writes (Arch §10 NFR).
// - Commits and blocks are single Postgres transactions together with the
//   write_operations outcome, idempotency outcome and an outbox event.
// ---------------------------------------------------------------------------

export type Verdict =
  | { kind: "pass"; record: Record<string, unknown> }
  | { kind: "noop"; detail: string }
  | {
      kind: "kick";
      checkFired: string;
      severity: Severity;
      fix: FixSuggestion;
      rule: RuleDef | null;
      value?: unknown;
      unknownKeys?: string[];
    };

export interface WriteInput {
  table: string;
  record: Record<string, unknown>;
  idempotencyKey?: string;
  traceId: string;
}

export interface OperationOpts {
  operationId?: string;
  sequenceNo?: number;
  pipelineId?: string;
  idempotencyKey?: string;
}

/** Numeric fields tracked for the D10 rolling baseline, per table. */
const BASELINE_FIELDS: Record<string, string[]> = {
  orders: ["total"],
  users: ["age"],
};

function httpError(statusCode: number, message: string): Error {
  const e = new Error(message) as Error & { statusCode: number };
  e.statusCode = statusCode;
  return e;
}

export async function evaluateWrite(input: WriteInput): Promise<Verdict> {
  const { table, record, traceId } = input;
  void traceId;

  const schema = tableSchemas[table];
  if (!schema) throw httpError(400, `unknown table: ${table}`);

  const kick = (
    checkFired: string,
    severity: Severity,
    partial: Partial<Parameters<typeof suggestFix>[0]> & {
      rule?: RuleDef | null;
      value?: unknown;
      unknownKeys?: string[];
    },
  ): Verdict => ({
    kind: "kick",
    checkFired,
    severity,
    fix: suggestFix({ table, record, checkFired, ...partial }),
    rule: partial.rule ?? null,
    value: partial.value,
    unknownKeys: partial.unknownKeys,
  });

  // Stage A — schema + types + unknown fields (Zod, <1ms).
  const parsed = schema.safeParse(record);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const mapped = mapZodIssue(issue);
    const unknownKeys =
      mapped.check === "A3_EXTRA"
        ? (issue as unknown as { keys?: string[] }).keys ?? []
        : [];
    return kick(mapped.check, mapped.check === "A3_EXTRA" ? "medium" : "high", {
      unknownKeys,
      knownFields: knownFields(table),
      value: undefined,
    });
  }
  const clean = parsed.data as Record<string, unknown>;

  // Stage B — YAML business rules.
  const rules = await loadRules(table);
  const failure = await evaluateRules(table, clean, rules);
  if (failure)
    return kick(failure.rule.id, failure.rule.severity, {
      rule: failure.rule,
      value: failure.value,
    });

  // Stage C — exact duplicate of an already-COMMITTED write (Postgres
  // fingerprints, recorded at commit time — see dedup.ts).
  if (await isExactDuplicate(table, clean))
    return kick("C7_EXACT_DUPLICATE", "medium", {});

  // Stage D — anomaly: statistical outlier, suspicious patterns, LLM review.
  for (const field of BASELINE_FIELDS[table] ?? []) {
    const v = clean[field];
    if (typeof v === "number") {
      const outlier = await checkOutlier(table, field, v);
      if (outlier)
        return kick("D10_OUTLIER", "critical", {
          value: v,
        });
    }
  }
  const suspicious = findSuspiciousPattern(clean);
  if (suspicious) return kick("D11_SUSPICIOUS_PATTERN", "critical", { value: suspicious });

  const review = await llmReview(table, clean);
  if (review && !review.ok)
    return kick("D12_LLM_REVIEW", "medium", { value: review.reason });

  return { kind: "pass", record: clean };
}

/**
 * Commit a clean record — ONE Postgres transaction: application row +
 * dedup fingerprint + operation outcome + checkpoint advance + idempotency
 * outcome + outbox event. The baseline feed (Redis) happens after commit
 * and is best-effort.
 */
export async function commitWrite(
  table: string,
  record: Record<string, unknown>,
  idempotencyKey?: string,
  opts: OperationOpts = {},
): Promise<void> {
  await withTx(async (client) => {
    await client.query(
      `INSERT INTO ${appTable(table)} (id, record) VALUES ($1, $2)
       ON CONFLICT (id) DO UPDATE SET record = EXCLUDED.record`,
      [String(record.id), JSON.stringify(record)],
    );
    await recordFingerprint(table, record, client);
    if (opts.operationId) {
      await updateOperationStatus(
        opts.operationId,
        "COMMITTED",
        { recordId: String(record.id) },
        client,
      );
      if (opts.pipelineId && opts.sequenceNo !== undefined)
        await setLastCompleted(opts.pipelineId, opts.sequenceNo, client);
    }
    if (idempotencyKey)
      await storeIdempotency(
        idempotencyKey,
        requestHash(table, record),
        "committed",
        undefined,
        {
          operationId: opts.operationId,
          resultJson: { status: "committed", recordId: String(record.id) },
          client,
        },
      );
    await insertOutboxEvent(
      opts.operationId ?? String(record.id),
      "write.committed",
      buildNotifyEvent({
        status: "committed",
        table,
        pipelineId: opts.pipelineId,
        operationId: opts.operationId,
        sequenceNo: opts.sequenceNo,
      }),
      client,
    );
  });
  for (const field of BASELINE_FIELDS[table] ?? []) {
    const v = record[field];
    if (typeof v === "number") await observeBaseline(table, field, v);
  }
  void publishPendingOutbox().catch(() => undefined);
}

/**
 * Quarantine a kicked record — ONE Postgres transaction: incident +
 * audit + pipeline pause + operation outcome + idempotency outcome +
 * outbox event. Alerting/metrics happen after the durable block exists.
 */
export async function kickWrite(
  pipelineId: string,
  traceId: string,
  table: string,
  record: Record<string, unknown>,
  verdict: Extract<Verdict, { kind: "kick" }>,
  opts: OperationOpts = {},
): Promise<Incident> {
  const incident = await withTx(async (client) => {
    const inc = await createIncident(
      {
        traceId,
        pipelineId,
        table,
        record,
        checkFired: verdict.checkFired,
        severity: verdict.severity,
        fix: verdict.fix,
        operationId: opts.operationId,
      },
      client,
    );
    await audit(
      {
        incidentId: inc.id,
        pipelineId,
        operationId: opts.operationId,
        actor: "system",
        action: "KICKED",
        before: record,
        after: { checkFired: verdict.checkFired, severity: verdict.severity },
      },
      client,
    );
    await markPaused(pipelineId, opts.operationId, client);
    if (opts.operationId)
      await updateOperationStatus(
        opts.operationId,
        "QUARANTINED",
        { incidentId: inc.id, checkFired: verdict.checkFired },
        client,
      );
    const idemKey = opts.idempotencyKey;
    if (idemKey)
      await storeIdempotency(idemKey, requestHash(table, record), "kicked", inc.id, {
        operationId: opts.operationId,
        resultJson: { status: "kicked", incidentId: inc.id },
        client,
      });
    await insertOutboxEvent(
      opts.operationId ?? inc.id,
      "write.kicked",
      buildNotifyEvent({
        status: "kicked",
        table,
        pipelineId,
        operationId: opts.operationId,
        sequenceNo: opts.sequenceNo,
        traceId,
        incidentId: inc.id,
        severity: verdict.severity,
        checkFired: verdict.checkFired,
        explanation: verdict.fix.explanation,
      }),
      client,
    );
    return inc;
  });
  void publishPendingOutbox().catch(() => undefined);
  await routeAlert({
    severity: verdict.severity,
    fingerprint: `${verdict.checkFired}:${table}`,
    title: `ErrorKicker kicked a ${table} write (${verdict.checkFired})`,
    body: `${verdict.fix.explanation}\nIncident: ${incident.id} · Pipeline: ${pipelineId}`,
  });
  recordWrite("kick", verdict.checkFired);
  emitEvent({
    type: "kick",
    incidentId: incident.id,
    pipelineId,
    check: verdict.checkFired,
    severity: verdict.severity,
  });
  const pipe = await getPipeline(pipelineId);
  emitEvent({
    type: "pipeline",
    pipelineId,
    state: pipe.state,
    queued: pipe.queuedCount,
  });
  emitEvent({ type: "metrics", metrics: metricsSnapshot() });
  return incident;
}

/** Drain the held queue through the gate, in sequence order. */
async function drainAndMaybeResume(pipelineId: string, actor: string) {
  const { committed, kicked } = await drainQueue(pipelineId, async (w: QueuedWrite) => {
    const verdict = await evaluateWrite({
      table: w.table,
      record: w.record,
      idempotencyKey: w.idempotencyKey,
      traceId: w.traceId,
    });
    if (verdict.kind === "kick") {
      await kickWrite(pipelineId, w.traceId, w.table, w.record, verdict, {
        operationId: w.operationId,
        sequenceNo: w.sequenceNo,
        pipelineId,
        idempotencyKey: w.idempotencyKey,
      });
      return "kicked";
    }
    // pass, or noop (defensive: the gate no longer returns noop without an
    // idempotency replay, which routes handle before evaluation)
    await commitWrite(
      w.table,
      verdict.kind === "pass" ? verdict.record : w.record,
      w.idempotencyKey,
      { operationId: w.operationId, sequenceNo: w.sequenceNo, pipelineId },
    );
    return "committed";
  });
  const pauseMs = await markRunning(pipelineId);
  recordPauseDuration(pauseMs);
  await audit({ pipelineId, actor, action: "RESUMED", after: { committed, kicked, pauseMs } });
  const pipe = await getPipeline(pipelineId);
  emitEvent({ type: "pipeline", pipelineId, state: pipe.state, queued: pipe.queuedCount });
  emitEvent({ type: "metrics", metrics: metricsSnapshot() });
  return { committed, kicked, pauseMs };
}

function assertReviewable(inc: Incident, version?: number): void {
  if (inc.state !== "PAUSED_AWAITING_REVIEW")
    throw httpError(409, `incident ${inc.id} is already ${inc.state}`);
  if (versionConflict(inc.version, version))
    throw httpError(
      409,
      `stale incident version: you sent ${version}, current is ${inc.version} — refresh and retry`,
    );
}

/**
 * Shared approve path. The fix is re-run through the FULL gate before
 * committing — a fix that introduces a new error gets kicked again. No back
 * door (FR-07). The decision itself is applied with a conditional UPDATE
 * (decideIncident) BEFORE the commit, so two reviewers cannot both apply
 * conflicting decisions: the loser gets a 409 and nothing is committed.
 */
async function applyApprovedFix(
  inc: Incident,
  candidate: Record<string, unknown>,
  actor: string,
  version: number | undefined,
  edited: boolean,
) {
  const verdict = await evaluateWrite({
    table: inc.table_name,
    record: candidate,
    traceId: randomUUID(),
  });
  if (verdict.kind === "kick") {
    // The human's fix is itself bad: kick it visibly, stay paused. The
    // original incident is untouched (state and version unchanged).
    const newIncident = await kickWrite(
      inc.pipeline_id,
      randomUUID(),
      inc.table_name,
      candidate,
      verdict,
    );
    return { status: "fix_kicked", incident: newIncident };
  }

  const decided = await decideIncident(inc.id, "FIX_APPLIED", version);
  if (!decided.ok) {
    if (decided.reason === "version_conflict")
      throw httpError(
        409,
        `stale incident version: you sent ${version}, current is ${decided.incident?.version} — refresh and retry`,
      );
    throw httpError(409, `incident ${inc.id} is already ${decided.incident?.state}`);
  }

  // pass, or noop (defensive — see drainAndMaybeResume)
  const finalRecord = verdict.kind === "pass" ? verdict.record : candidate;
  await commitWrite(inc.table_name, finalRecord, undefined, {
    pipelineId: inc.pipeline_id,
  });
  await audit({
    incidentId: inc.id,
    pipelineId: inc.pipeline_id,
    operationId: inc.operation_id ?? undefined,
    actor,
    action: edited ? "EDITED_APPROVED" : "APPROVED",
    before: inc.record_json,
    after: finalRecord,
  });

  // Ordering (FR-09): queued writes are LATER writes. If another incident
  // for this pipeline is still open, they must not jump past it — stay
  // paused and let the remaining review (or an explicit resume) proceed.
  const openRemaining = await countOpenIncidents(inc.pipeline_id);
  if (openRemaining > 0) {
    return {
      status: "fix_committed",
      incidentId: inc.id,
      version: decided.incident.version,
      openIncidents: openRemaining,
      note: "Fix committed. Pipeline stays paused — other open incidents are still awaiting review.",
    };
  }
  const drain = await drainAndMaybeResume(inc.pipeline_id, actor);
  return {
    status: "resumed",
    incidentId: inc.id,
    version: decided.incident.version,
    ...drain,
  };
}

/**
 * Approve a fix (FR-06). `version` is the incident version the client saw;
 * when sent, a stale version is a 409 with no state change. Legacy console
 * calls send no version and fall back to the state check only (documented
 * compromise in README — /v1 clients should always send it).
 */
export async function approveIncident(
  id: string,
  fix: Record<string, unknown> | undefined,
  actor: string,
  version?: number,
) {
  const inc = await getIncident(id);
  if (!inc) throw httpError(404, `incident not found: ${id}`);
  assertReviewable(inc, version);

  const candidate = fix ?? inc.suggested_fix ?? inc.proposed_fix;
  if (!candidate)
    throw httpError(400, "no fix to apply — edit the record by hand or reject it");
  const edited =
    fix != null && JSON.stringify(fix) !== JSON.stringify(inc.suggested_fix ?? inc.proposed_fix);
  return applyApprovedFix(inc, candidate, actor, version, edited);
}

/**
 * Edit + approve (FR-06): the reviewer supplies edited values — either a
 * full corrected record (`fix`) or a partial patch (`editedFields`) merged
 * onto the proposed fix / original record. PRD §15 default: edits may only
 * touch fields already present in the original record or the proposed
 * fix — no brand-new fields.
 */
export async function editApproveIncident(
  id: string,
  body: {
    fix?: Record<string, unknown>;
    record?: Record<string, unknown>;
    editedFields?: Record<string, unknown>;
  },
  actor: string,
  version?: number,
) {
  const inc = await getIncident(id);
  if (!inc) throw httpError(404, `incident not found: ${id}`);
  assertReviewable(inc, version);

  const base = inc.suggested_fix ?? inc.proposed_fix ?? inc.record_json;
  const candidate = body.fix ?? body.record ?? { ...base, ...(body.editedFields ?? {}) };
  if (!body.fix && !body.record && !body.editedFields)
    throw httpError(400, "edit-approve needs fix, record, or editedFields");

  const added = addedFields(candidate, inc.record_json, inc.suggested_fix, inc.proposed_fix);
  if (added.length)
    throw httpError(
      400,
      `edit adds new field(s) not present in the original record or proposed fix: ${added.join(", ")}`,
    );
  return applyApprovedFix(inc, candidate, actor, version, true);
}

/**
 * Reject (FR-06 + PRD §15 default): the pipeline does NOT auto-resume and
 * held writes are NOT drained. It releases only in the safe case — no other
 * open incidents AND no pending writes for the pipeline — where there is
 * literally nothing left to hold. Otherwise an operator must resume
 * explicitly via POST /v1/pipelines/:id/resume.
 */
export async function rejectIncident(id: string, actor: string, version?: number) {
  const inc = await getIncident(id);
  if (!inc) throw httpError(404, `incident not found: ${id}`);
  assertReviewable(inc, version);

  const decided = await decideIncident(id, "REJECTED", version);
  if (!decided.ok) {
    if (decided.reason === "version_conflict")
      throw httpError(
        409,
        `stale incident version: you sent ${version}, current is ${decided.incident?.version} — refresh and retry`,
      );
    throw httpError(409, `incident ${id} is already ${decided.incident?.state}`);
  }
  await audit({
    incidentId: id,
    pipelineId: inc.pipeline_id,
    operationId: inc.operation_id ?? undefined,
    actor,
    action: "REJECTED",
    before: inc.record_json,
    after: { version: decided.incident.version },
  });

  const openRemaining = await countOpenIncidents(inc.pipeline_id);
  const pending = await pendingCount(inc.pipeline_id);
  if (openRemaining === 0 && pending === 0) {
    // Safe release: nothing held, nothing else under review.
    const pauseMs = await markRunning(inc.pipeline_id);
    recordPauseDuration(pauseMs);
    await audit({
      pipelineId: inc.pipeline_id,
      actor,
      action: "RESUMED",
      after: { reason: "reject_release_no_pending", pauseMs },
    });
    const pipe = await getPipeline(inc.pipeline_id);
    emitEvent({ type: "pipeline", pipelineId: inc.pipeline_id, state: pipe.state, queued: 0 });
    emitEvent({ type: "metrics", metrics: metricsSnapshot() });
    return {
      status: "rejected",
      incidentId: id,
      version: decided.incident.version,
      pipelineState: "RUNNING" as const,
      released: true,
      pauseMs,
    };
  }
  return {
    status: "rejected",
    incidentId: id,
    version: decided.incident.version,
    pipelineState: "PAUSED_AWAITING_REVIEW" as const,
    released: false,
    openIncidents: openRemaining,
    pendingWrites: pending,
    note: "Pipeline stays paused after a reject — an operator must resume it explicitly (POST /v1/pipelines/:id/resume).",
  };
}

/** Legacy per-incident abort (console): drop the held queue, close the incident. */
export async function abortIncident(id: string, actor: string) {
  const inc = await getIncident(id);
  if (!inc) throw httpError(404, `incident not found: ${id}`);
  if (inc.state !== "PAUSED_AWAITING_REVIEW")
    throw httpError(409, `incident ${id} is already ${inc.state}`);
  const dropped = await clearQueue(inc.pipeline_id);
  for (const w of dropped) {
    await audit({
      pipelineId: inc.pipeline_id,
      operationId: w.operationId,
      actor,
      action: "QUEUED_DROPPED",
      before: w.record,
    });
    if (w.operationId)
      await updateOperationStatus(w.operationId, "DROPPED", {
        droppedByIncidentAbort: id,
      }).catch(() => undefined);
  }
  await setIncidentState(id, "ABORTED");
  await audit({
    incidentId: id,
    pipelineId: inc.pipeline_id,
    operationId: inc.operation_id ?? undefined,
    actor,
    action: "ABORTED",
    after: { droppedQueued: dropped.length },
  });
  const pauseMs = await markRunning(inc.pipeline_id);
  recordPauseDuration(pauseMs);
  const pipe = await getPipeline(inc.pipeline_id);
  emitEvent({ type: "pipeline", pipelineId: inc.pipeline_id, state: pipe.state, queued: 0 });
  return { status: "aborted", droppedQueued: dropped.length, pauseMs };
}

export async function resumePipeline(pipelineId: string, actor: string) {
  const drain = await drainAndMaybeResume(pipelineId, actor);
  return { status: "resumed", pipelineId, ...drain };
}

/** Explicit operator pause (Arch §10): idempotent persisted transition. */
export async function pausePipeline(pipelineId: string, actor: string) {
  await markPaused(pipelineId);
  await audit({ pipelineId, actor, action: "PAUSED", after: { by: "operator" } });
  const pipe = await getPipeline(pipelineId);
  emitEvent({ type: "pipeline", pipelineId, state: pipe.state, queued: pipe.queuedCount });
  return {
    status: "paused",
    pipelineId,
    state: pipe.state,
    queued: pipe.queuedCount,
    nextSequence: pipe.nextSequence,
    lastCompletedSequence: pipe.lastCompletedSequence,
  };
}

/**
 * Pipeline-level abort (Arch §10, PRD §9): stops future processing and
 * reports the real counts. Previously committed rows REMAIN committed —
 * abort never reverses committed data; reversing a committed row would
 * need a separate, explicit compensation workflow (out of scope for v1).
 */
export async function abortPipeline(pipelineId: string, actor: string) {
  const pipe = await getPipeline(pipelineId);
  const counts = await countOperations(pipelineId);
  const rejectedCount = await countIncidentsByState(pipelineId, ["REJECTED", "ABORTED"]);
  const dropped = await clearQueue(pipelineId);
  for (const w of dropped)
    await audit({
      pipelineId,
      operationId: w.operationId,
      actor,
      action: "QUEUED_DROPPED",
      before: w.record,
    });
  await setPipelineState(pipelineId, "ABORTED");
  const report = {
    status: "aborted",
    pipelineId,
    state: "ABORTED" as const,
    committedCount: counts.committed,
    rejectedCount,
    droppedPendingCount: dropped.length,
    pendingRemaining: 0,
    note: "Abort stops future processing for this pipeline. Previously committed rows remain committed — abort does not reverse committed data.",
  };
  await audit({ pipelineId, actor, action: "PIPELINE_ABORTED", after: report });
  emitEvent({ type: "pipeline", pipelineId, state: "ABORTED", queued: 0 });
  emitEvent({ type: "metrics", metrics: metricsSnapshot() });
  void pipe;
  return report;
}

/** Full pipeline status (Arch §10): state + sequences + queue depth. */
export async function pipelineStatus(pipelineId: string) {
  const pipe = await getPipeline(pipelineId);
  const counts = await countOperations(pipelineId);
  return {
    pipelineId,
    state: pipe.state,
    nextSequence: pipe.nextSequence,
    lastCompletedSequence: pipe.lastCompletedSequence,
    heldOperationId: pipe.heldOperationId,
    version: pipe.version,
    pausedAt: pipe.pausedAt,
    queueDepth: pipe.queuedCount,
    openIncidents: await countOpenIncidents(pipelineId),
    operations: counts,
  };
}
