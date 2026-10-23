"use client";

import { useEffect, useState } from "react";
import { api, severityColor, type Incident, type Metrics, type Pipeline, GATE } from "../lib/api";

function useLiveData() {
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const [i, m, p] = await Promise.all([api.incidents(), api.metrics(), api.pipelines()]);
      setIncidents(i);
      setMetrics(m);
      setPipelines(p);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  useEffect(() => {
    refresh();
    const es = new EventSource(`${GATE}/stream`);
    es.onmessage = () => refresh();
    es.onerror = () => es.close();
    const t = setInterval(refresh, 10000);
    return () => {
      es.close();
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { incidents, metrics, pipelines, error, refresh };
}

function pausedFor(pausedAt: string | null): string {
  if (!pausedAt) return "—";
  const s = Math.floor((Date.now() - new Date(pausedAt).getTime()) / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

export default function Dashboard() {
  const { incidents, metrics, pipelines, error } = useLiveData();

  return (
    <div className="space-y-6">
      {error && (
        <div className="bg-red-900/40 border border-red-700 rounded p-3 text-sm">
          Gate unreachable: {error} — is <code>docker compose up</code> + <code>npm run dev</code> running in <code>apps/gate</code>?
        </div>
      )}

      <section className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {[
          ["Writes", metrics?.writes ?? "—"],
          ["Pass rate", metrics ? `${(metrics.passRate * 100).toFixed(1)}%` : "—"],
          ["Kicks", metrics?.kicks ?? "—"],
          ["Queued", metrics?.queued ?? "—"],
          ["Median pause", metrics ? `${(metrics.medianPauseMs / 1000).toFixed(1)}s` : "—"],
        ].map(([label, v]) => (
          <div key={label} className="bg-slate-900 border border-slate-800 rounded p-4">
            <div className="text-2xl font-bold">{v}</div>
            <div className="text-xs text-slate-400">{label}</div>
          </div>
        ))}
      </section>

      <section>
        <h2 className="font-semibold mb-2">Pipelines</h2>
        <div className="grid md:grid-cols-3 gap-3">
          {pipelines.map((p) => (
            <div key={p.pipeline_id} className="bg-slate-900 border border-slate-800 rounded p-4">
              <div className="flex items-center justify-between">
                <span className="font-mono text-sm">{p.pipeline_id}</span>
                <span
                  className={`text-xs px-2 py-0.5 rounded border ${
                    p.state === "RUNNING"
                      ? "bg-green-100 text-green-800 border-green-300"
                      : "bg-red-100 text-red-800 border-red-300 animate-pulse"
                  }`}
                >
                  {p.state === "RUNNING" ? "● RUNNING" : "⏸ PAUSED"}
                </span>
              </div>
              <div className="text-xs text-slate-400 mt-2">
                queued: {p.queued_count} · open incidents: {p.openIncidents}
                {p.state !== "RUNNING" && <> · paused for {pausedFor(p.paused_at)}</>}
              </div>
              {p.state !== "RUNNING" && (
                <button
                  onClick={() => api.resume(p.pipeline_id).then(() => window.location.reload())}
                  className="mt-2 text-xs bg-slate-700 hover:bg-slate-600 rounded px-3 py-1"
                >
                  Resume pipeline
                </button>
              )}
            </div>
          ))}
          {pipelines.length === 0 && (
            <div className="text-sm text-slate-500">No pipelines yet — fire a write at the gate.</div>
          )}
        </div>
      </section>

      <section>
        <h2 className="font-semibold mb-2">
          Incident queue <span className="text-slate-400 font-normal">({incidents.length} open)</span>
        </h2>
        <div className="space-y-2">
          {incidents.map((i) => (
            <a
              key={i.id}
              href={`/incidents/${i.id}`}
              className="block bg-slate-900 border border-slate-800 rounded p-3 hover:border-slate-600"
            >
              <div className="flex items-center gap-2 flex-wrap">
                <span className={`text-xs px-2 py-0.5 rounded border ${severityColor(i.severity)}`}>
                  {i.severity}
                </span>
                <span className="font-mono text-xs text-slate-400">{i.id}</span>
                <span className="font-mono text-xs bg-slate-800 rounded px-2 py-0.5">{i.check_fired}</span>
                <span className="text-xs text-slate-500">{i.table_name} · {i.pipeline_id}</span>
              </div>
              <p className="text-sm mt-1 text-slate-300">{i.explanation}</p>
            </a>
          ))}
          {incidents.length === 0 && (
            <div className="text-sm text-slate-500">No open incidents.</div>
          )}
        </div>
      </section>

      {metrics && Object.keys(metrics.kicksByCheck).length > 0 && (
        <section>
          <h2 className="font-semibold mb-2">Kicks by check</h2>
          <div className="flex flex-wrap gap-2">
            {Object.entries(metrics.kicksByCheck).map(([check, c]) => (
              <span key={check} className="text-xs font-mono bg-slate-900 border border-slate-800 rounded px-2 py-1">
                {check}: {c}
              </span>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
