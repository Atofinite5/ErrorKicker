import type { PoolClient } from "pg";
import { executor } from "./db.ts";

// Append-only by convention: the gate never UPDATEs or DELETEs audit rows
// (FR-10). Pass a transaction client to record the event atomically with
// the decision it describes.
export async function audit(
  entry: {
    incidentId?: string | null;
    pipelineId?: string | null;
    operationId?: string | null;
    actor: string;
    action:
      | "KICKED"
      | "APPROVED"
      | "EDITED_APPROVED"
      | "REJECTED"
      | "ABORTED"
      | "RESUMED"
      | "PAUSED"
      | "PIPELINE_ABORTED"
      | "QUEUED_DROPPED";
    before?: unknown;
    after?: unknown;
  },
  client?: PoolClient,
): Promise<void> {
  await executor(client).query(
    `INSERT INTO audit_log
       (incident_id, pipeline_id, operation_id, actor, action, before_json, after_json)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      entry.incidentId ?? null,
      entry.pipelineId ?? null,
      entry.operationId ?? null,
      entry.actor,
      entry.action,
      entry.before === undefined ? null : JSON.stringify(entry.before),
      entry.after === undefined ? null : JSON.stringify(entry.after),
    ],
  );
}
