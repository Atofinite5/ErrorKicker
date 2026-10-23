import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { executor, pool } from "./db.ts";
import type { FixSource, FixSuggestion } from "./fixes.ts";
import type { Severity } from "./rules.ts";

export type IncidentState =
  | "PAUSED_AWAITING_REVIEW"
  | "FIX_APPLIED"
  | "REJECTED"
  | "ABORTED";

export interface Incident {
  id: string;
  trace_id: string;
  pipeline_id: string;
  table_name: string;
  record_json: Record<string, unknown>;
  check_fired: string;
  severity: Severity;
  explanation: string;
  suggested_fix: Record<string, unknown> | null;
  /** PRD name (Arch §6) for the proposed correction — mirrors suggested_fix. */
  proposed_fix: Record<string, unknown> | null;
  fix_source: FixSource | null;
  fix_confidence: number | null;
  state: IncidentState;
  created_at: string;
  /** Durable link to the write_operations row that produced this incident. */
  operation_id: string | null;
  /** Optimistic-concurrency version (FR-06): every decision increments it. */
  version: number;
}

export interface NewIncident {
  traceId: string;
  pipelineId: string;
  table: string;
  record: Record<string, unknown>;
  checkFired: string;
  severity: Severity;
  fix: FixSuggestion;
  operationId?: string;
}

export async function createIncident(
  n: NewIncident,
  client?: PoolClient,
): Promise<Incident> {
  const id = `inc_${randomUUID().slice(0, 8)}`;
  const { rows } = await executor(client).query(
    `INSERT INTO incidents
       (id, trace_id, pipeline_id, table_name, record_json, check_fired,
        severity, explanation, suggested_fix, proposed_fix, fix_source,
        fix_confidence, operation_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10,$11,$12)
     RETURNING *`,
    [
      id,
      n.traceId,
      n.pipelineId,
      n.table,
      JSON.stringify(n.record),
      n.checkFired,
      n.severity,
      n.fix.explanation,
      n.fix.fixedRecord ? JSON.stringify(n.fix.fixedRecord) : null,
      n.fix.fixSource,
      n.fix.fixConfidence,
      n.operationId ?? null,
    ],
  );
  return rows[0] as Incident;
}

export async function getIncident(id: string): Promise<Incident | null> {
  const { rows } = await pool.query("SELECT * FROM incidents WHERE id = $1", [id]);
  return (rows[0] as Incident) ?? null;
}

export async function listIncidents(opts: {
  state?: string;
  pipelineId?: string;
  limit?: number;
}): Promise<Incident[]> {
  const conds: string[] = [];
  const params: unknown[] = [];
  if (opts.state === "open") {
    conds.push("state = 'PAUSED_AWAITING_REVIEW'");
  } else if (opts.state) {
    params.push(opts.state);
    conds.push(`state = $${params.length}`);
  }
  if (opts.pipelineId) {
    params.push(opts.pipelineId);
    conds.push(`pipeline_id = $${params.length}`);
  }
  params.push(opts.limit ?? 50);
  const { rows } = await pool.query(
    `SELECT * FROM incidents ${conds.length ? "WHERE " + conds.join(" AND ") : ""}
     ORDER BY created_at DESC LIMIT $${params.length}`,
    params,
  );
  return rows as Incident[];
}

export async function setIncidentState(id: string, state: IncidentState): Promise<void> {
  await pool.query(
    "UPDATE incidents SET state = $1, version = version + 1 WHERE id = $2",
    [state, id],
  );
}

// --- optimistic concurrency (FR-06, PRD §8) ---------------------------------
// A stale incident version must produce a conflict, not silently overwrite
// another reviewer's decision. Decisions are applied with ONE conditional
// UPDATE (state still open AND, when the client sent a version, version
// still current) and increment the version.

/** Pure version check, unit-tested in smoke. */
export function versionConflict(currentVersion: number, providedVersion?: number): boolean {
  return providedVersion !== undefined && providedVersion !== currentVersion;
}

export type DecideOutcome =
  | { ok: true; incident: Incident }
  | { ok: false; reason: "not_found" | "not_open" | "version_conflict"; incident: Incident | null };

export async function decideIncident(
  id: string,
  newState: IncidentState,
  expectedVersion?: number,
): Promise<DecideOutcome> {
  const params: unknown[] = [newState, id];
  let versionClause = "";
  if (expectedVersion !== undefined) {
    params.push(expectedVersion);
    versionClause = ` AND version = $${params.length}`;
  }
  const { rows } = await pool.query(
    `UPDATE incidents SET state = $1, version = version + 1
      WHERE id = $2 AND state = 'PAUSED_AWAITING_REVIEW'${versionClause}
      RETURNING *`,
    params,
  );
  if (rows.length) return { ok: true, incident: rows[0] as Incident };
  const inc = await getIncident(id);
  if (!inc) return { ok: false, reason: "not_found", incident: null };
  if (inc.state !== "PAUSED_AWAITING_REVIEW")
    return { ok: false, reason: "not_open", incident: inc };
  return { ok: false, reason: "version_conflict", incident: inc };
}

export async function countOpenIncidents(pipelineId: string): Promise<number> {
  const { rows } = await pool.query(
    "SELECT COUNT(*)::int AS c FROM incidents WHERE pipeline_id = $1 AND state = 'PAUSED_AWAITING_REVIEW'",
    [pipelineId],
  );
  return rows[0].c as number;
}

export async function countIncidentsByState(
  pipelineId: string,
  states: IncidentState[],
): Promise<number> {
  const { rows } = await pool.query(
    "SELECT COUNT(*)::int AS c FROM incidents WHERE pipeline_id = $1 AND state = ANY($2)",
    [pipelineId, states],
  );
  return rows[0].c as number;
}

/** Context strip: similar past incidents + what the reviewer did then. */
export async function similarIncidents(
  incident: Incident,
  limit = 3,
): Promise<Array<{ id: string; created_at: string; action: string | null }>> {
  const { rows } = await pool.query(
    `SELECT i.id, i.created_at,
            (SELECT action FROM audit_log a
              WHERE a.incident_id = i.id AND a.action IN ('APPROVED','EDITED_APPROVED','REJECTED')
              ORDER BY a.id DESC LIMIT 1) AS action
     FROM incidents i
     WHERE i.check_fired = $1 AND i.id <> $2 AND i.state <> 'PAUSED_AWAITING_REVIEW'
     ORDER BY i.created_at DESC LIMIT $3`,
    [incident.check_fired, incident.id, limit],
  );
  return rows;
}
