import { authHeaders, clearSession, getSession } from "./session";

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
  proposed_fix: Record<string, unknown> | null;
  fix_source: string | null;
  fix_confidence: number | null;
  state: string;
  created_at: string;
  operation_id: string | null;
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
  if (res.status === 401 && typeof window !== "undefined" && !window.location.pathname.startsWith("/login")) {
    clearSession();
    window.location.href = "/login";
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

function actor(): string {
  return getSession().actor || "reviewer";
}

export async function whoami(): Promise<{ role: string; actor: string }> {
  return fetch(`${GATE}/v1/auth/whoami`, { headers: authHeaders() }).then((r) =>
    j<{ role: string; actor: string }>(r),
  );
}

export const api = {
  incidents: (state = "open") =>
    fetch(`${GATE}/incidents?state=${state}&limit=50`, { headers: authHeaders() }).then((r) =>
      j<Incident[]>(r),
    ),
  incident: (id: string) =>
    fetch(`${GATE}/incidents/${id}`, { headers: authHeaders() }).then((r) => j<Incident>(r)),
  approve: (id: string, fix?: Record<string, unknown>, _actor = actor(), version?: number) =>
    fetch(`${GATE}/incidents/${id}/approve`, {
      method: "POST",
      headers: authHeaders(true),
      body: JSON.stringify({ fix, actor: _actor, version }),
    }).then((r) => j(r)),
  editApprove: (id: string, fix: Record<string, unknown>, _actor = actor(), version?: number) =>
    fetch(`${GATE}/v1/incidents/${id}/edit-approve`, {
      method: "POST",
      headers: authHeaders(true),
      body: JSON.stringify({ fix, actor: _actor, version }),
    }).then((r) => j(r)),
  reject: (id: string, _actor = actor(), version?: number) =>
    fetch(`${GATE}/incidents/${id}/reject`, {
      method: "POST",
      headers: authHeaders(true),
      body: JSON.stringify({ actor: _actor, version }),
    }).then((r) => j(r)),
  abort: (id: string, _actor = actor()) =>
    fetch(`${GATE}/incidents/${id}/abort`, {
      method: "POST",
      headers: authHeaders(true),
      body: JSON.stringify({ actor: _actor }),
    }).then((r) => j(r)),
  resume: (pipelineId: string, _actor = actor()) =>
    fetch(`${GATE}/pipelines/${pipelineId}/resume`, {
      method: "POST",
      headers: authHeaders(true),
      body: JSON.stringify({ actor: _actor }),
    }).then((r) => j(r)),
  metrics: () => fetch(`${GATE}/metrics`, { headers: authHeaders() }).then((r) => j<Metrics>(r)),
  pipelines: () =>
    fetch(`${GATE}/pipelines`, { headers: authHeaders() }).then((r) => j<Pipeline[]>(r)),
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
