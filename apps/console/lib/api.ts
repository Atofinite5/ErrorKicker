export const GATE =
  process.env.NEXT_PUBLIC_GATE_URL ?? "http://localhost:3001";

export interface Incident {
  id: string;
  trace_id: string;
  pipeline_id: string;
  table_name: string;
  record_json: Record<string, unknown>;
  check_fired: string;
  severity: "critical" | "high" | "medium" | "info";
  explanation: string;
  suggested_fix: Record<string, unknown> | null;
  /** PRD name for the proposed correction — mirrors suggested_fix. */
  proposed_fix: Record<string, unknown> | null;
  fix_source: string | null;
  fix_confidence: number | null;
  state: string;
  created_at: string;
  /** Durable write operation that produced this incident (may be null for pre-002 rows). */
  operation_id: string | null;
  /** Optimistic-concurrency version — send it back on every decision. */
  version: number;
  similar?: Array<{ id: string; created_at: string; action: string | null }>;
}

export interface Metrics {
  writes: number;
  passes: number;
  kicks: number;
  queued: number;
  passRate: number;
  kicksByCheck: Record<string, number>;
  medianPauseMs: number;
}

export interface Pipeline {
  pipeline_id: string;
  state: string;
  queued_count: number;
  paused_at: string | null;
  next_sequence: number;
  last_completed_sequence: number;
  openIncidents: number;
}

async function j<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

export const api = {
  incidents: (state = "open") =>
    fetch(`${GATE}/incidents?state=${state}&limit=50`).then((r) => j<Incident[]>(r)),
  incident: (id: string) =>
    fetch(`${GATE}/incidents/${id}`).then((r) => j<Incident>(r)),
  approve: (id: string, fix?: Record<string, unknown>, actor = "reviewer", version?: number) =>
    fetch(`${GATE}/incidents/${id}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fix, actor, version }),
    }).then((r) => j(r)),
  // PRD /v1 edit-approve: edited record + approve, full revalidation,
  // version-checked, edits may not add brand-new fields.
  editApprove: (id: string, fix: Record<string, unknown>, actor = "reviewer", version?: number) =>
    fetch(`${GATE}/v1/incidents/${id}/edit-approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fix, actor, version }),
    }).then((r) => j(r)),
  reject: (id: string, actor = "reviewer", version?: number) =>
    fetch(`${GATE}/incidents/${id}/reject`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actor, version }),
    }).then((r) => j(r)),
  abort: (id: string, actor = "reviewer") =>
    fetch(`${GATE}/incidents/${id}/abort`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actor }),
    }).then((r) => j(r)),
  resume: (pipelineId: string, actor = "reviewer") =>
    fetch(`${GATE}/pipelines/${pipelineId}/resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actor }),
    }).then((r) => j(r)),
  metrics: () => fetch(`${GATE}/metrics`).then((r) => j<Metrics>(r)),
  pipelines: () => fetch(`${GATE}/pipelines`).then((r) => j<Pipeline[]>(r)),
};

export function severityColor(s: string): string {
  switch (s) {
    case "critical":
      return "bg-red-100 text-red-800 border-red-300";
    case "high":
      return "bg-orange-100 text-orange-800 border-orange-300";
    case "medium":
      return "bg-yellow-100 text-yellow-800 border-yellow-300";
    default:
      return "bg-slate-100 text-slate-700 border-slate-300";
  }
}
