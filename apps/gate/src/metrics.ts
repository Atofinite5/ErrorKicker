import { EventEmitter } from "node:events";

// ---------------------------------------------------------------------------
// Metrics + the live event bus that feeds the dashboard (SSE) and the demo.
// ---------------------------------------------------------------------------

export const metrics = {
  writes: 0,
  passes: 0,
  kicks: 0,
  queued: 0,
  kicksByCheck: {} as Record<string, number>,
  pauseDurationsMs: [] as number[],
};

export function recordWrite(outcome: "pass" | "kick" | "queued", check?: string): void {
  metrics.writes++;
  if (outcome === "pass") metrics.passes++;
  if (outcome === "kick") {
    metrics.kicks++;
    if (check) metrics.kicksByCheck[check] = (metrics.kicksByCheck[check] ?? 0) + 1;
  }
  if (outcome === "queued") metrics.queued++;
}

export function recordPauseDuration(ms: number): void {
  if (ms > 0) {
    metrics.pauseDurationsMs.push(ms);
    if (metrics.pauseDurationsMs.length > 1000) metrics.pauseDurationsMs.shift();
  }
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function metricsSnapshot() {
  return {
    writes: metrics.writes,
    passes: metrics.passes,
    kicks: metrics.kicks,
    queued: metrics.queued,
    passRate: metrics.writes ? metrics.passes / metrics.writes : 1,
    kicksByCheck: metrics.kicksByCheck,
    medianPauseMs: Math.round(median(metrics.pauseDurationsMs)),
    at: new Date().toISOString(),
  };
}

export type GateEvent =
  | { type: "kick"; incidentId: string; pipelineId: string; check: string; severity: string }
  | { type: "pipeline"; pipelineId: string; state: string; queued: number }
  | { type: "metrics"; metrics: ReturnType<typeof metricsSnapshot> };

export const bus = new EventEmitter();
bus.setMaxListeners(50);

export function emitEvent(e: GateEvent): void {
  bus.emit("event", e);
}
