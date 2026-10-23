// Outbound write-outcome events. Postgres is the source of truth; this
// module only shapes the payload and POSTs it. A failed delivery must
// never change a write verdict or block the HTTP response.

export type NotifyStatus = "kicked" | "committed" | "queued";

export interface NotifyIncident {
  id: string;
  severity: string;
  check: string;
  explanation: string;
}

export interface NotifyEvent {
  status: NotifyStatus;
  table: string;
  pipelineId: string;
  operationId?: string;
  sequenceNo?: number;
  traceId?: string;
  incident?: NotifyIncident;
}

const STATUSES = new Set<NotifyStatus>(["kicked", "committed", "queued"]);

export function parseNotifyStatuses(raw: string | undefined): NotifyStatus[] {
  const parts = (raw ?? "kicked,queued")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const out: NotifyStatus[] = [];
  for (const p of parts) {
    if (STATUSES.has(p as NotifyStatus) && !out.includes(p as NotifyStatus))
      out.push(p as NotifyStatus);
  }
  return out.length ? out : ["kicked", "queued"];
}

export function shouldNotify(status: unknown, allowed: NotifyStatus[]): boolean {
  return typeof status === "string" && allowed.includes(status as NotifyStatus);
}

/** Contract the n8n Incident Router webhook already accepts. No original record. */
export function buildNotifyEvent(input: {
  status: NotifyStatus;
  table: string;
  pipelineId?: string;
  operationId?: string;
  sequenceNo?: number;
  traceId?: string;
  incidentId?: string;
  severity?: string;
  checkFired?: string;
  explanation?: string;
}): NotifyEvent {
  const event: NotifyEvent = {
    status: input.status,
    table: input.table,
    pipelineId: input.pipelineId ?? "default",
  };
  if (input.operationId) event.operationId = input.operationId;
  if (input.sequenceNo !== undefined) event.sequenceNo = input.sequenceNo;
  if (input.traceId) event.traceId = input.traceId;
  if (input.status === "kicked") {
    event.incident = {
      id: input.incidentId ?? "",
      severity: input.severity ?? "medium",
      check: input.checkFired ?? "",
      explanation: input.explanation ?? "No explanation provided",
    };
  }
  return event;
}

export async function postNotifyEvent(
  url: string,
  event: NotifyEvent,
): Promise<{ delivered: boolean; httpStatus?: number; error?: string }> {
  if (!url) return { delivered: false, error: "no webhook url" };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(5000),
    });
    // The router uses 201/202/400/422 as successful classification, not failure.
    const delivered = res.status < 500 && res.status !== 429 && res.status !== 408;
    return { delivered, httpStatus: res.status };
  } catch (err) {
    return { delivered: false, error: (err as Error).message };
  }
}
