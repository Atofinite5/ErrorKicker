"use client";

import { use, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, severityColor, type Incident } from "../../../lib/api";

function changedKeys(
  before: Record<string, unknown>,
  after: Record<string, unknown> | null,
): string[] {
  if (!after) return [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
}

export default function IncidentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const [inc, setInc] = useState<Incident | null>(null);
  const [fixText, setFixText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.incident(id).then((d) => {
      setInc(d);
      setFixText(JSON.stringify(d.suggested_fix ?? d.record_json, null, 2));
    }).catch((e) => setError((e as Error).message));
  }, [id]);

  const run = async (fn: () => Promise<unknown>, label: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = (await fn()) as { status?: string; incident?: { id: string } };
      if (res.status === "fix_kicked") {
        setError(
          `The fix was re-kicked by the gate (new incident ${res.incident?.id}). Fix the fix, or reject.`,
        );
        const d = await api.incident(id);
        setInc(d);
      } else {
        router.push("/");
      }
    } catch (e) {
      setError(`${label} failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  if (error && !inc) return <div className="text-red-400 text-sm">Error: {error}</div>;
  if (!inc) return <div className="text-slate-400 text-sm">Loading incident…</div>;

  const keys = changedKeys(inc.record_json, inc.suggested_fix);
  const resolved = inc.state !== "PAUSED_AWAITING_REVIEW";

  return (
    <div className="space-y-5">
      <a href="/" className="text-sm text-slate-400 hover:text-white">← back to dashboard</a>

      <div className="flex items-center gap-2 flex-wrap">
        <span className={`text-xs px-2 py-0.5 rounded border ${severityColor(inc.severity)}`}>
          {inc.severity}
        </span>
        <span className="font-mono text-sm">{inc.id}</span>
        <span className="font-mono text-xs bg-slate-800 rounded px-2 py-0.5">{inc.check_fired}</span>
        <span className="text-xs text-slate-500">
          {inc.table_name} · pipeline {inc.pipeline_id} · state {inc.state}
        </span>
      </div>

      {error && <div className="bg-red-900/40 border border-red-700 rounded p-3 text-sm">{error}</div>}

      <section className="bg-slate-900 border border-slate-800 rounded p-4">
        <h2 className="font-semibold mb-1">What broke, in plain words</h2>
        <p className="text-sm text-slate-300">{inc.explanation}</p>
        {inc.fix_confidence != null && inc.fix_confidence > 0 && (
          <p className="text-xs text-slate-500 mt-1">
            fix source: {inc.fix_source} · confidence {(inc.fix_confidence * 100).toFixed(0)}%
          </p>
        )}
      </section>

      <section className="bg-slate-900 border border-slate-800 rounded p-4">
        <h2 className="font-semibold mb-2">Diff — original vs suggested fix</h2>
        {keys.length === 0 ? (
          <p className="text-sm text-slate-400">
            No automatic fix available. Edit the record below by hand, or reject it.
          </p>
        ) : (
          <div className="grid md:grid-cols-2 gap-3 text-sm">
            {keys.map((k) => (
              <div key={k} className="col-span-2 grid md:grid-cols-2 gap-3">
                <div className="bg-red-950/40 border border-red-900 rounded p-2">
                  <div className="text-xs text-red-400 font-mono mb-1">− {k}</div>
                  <pre className="record font-mono text-xs">{JSON.stringify(inc.record_json[k], null, 2)}</pre>
                </div>
                <div className="bg-green-950/40 border border-green-900 rounded p-2">
                  <div className="text-xs text-green-400 font-mono mb-1">+ {k}</div>
                  <pre className="record font-mono text-xs">{JSON.stringify(inc.suggested_fix?.[k], null, 2)}</pre>
                </div>
              </div>
            ))}
          </div>
        )}
        <details className="mt-3">
          <summary className="text-xs text-slate-400 cursor-pointer">full original record</summary>
          <pre className="record font-mono text-xs mt-1 bg-slate-950 rounded p-2">
            {JSON.stringify(inc.record_json, null, 2)}
          </pre>
        </details>
      </section>

      {!resolved && (
        <section className="bg-slate-900 border border-slate-800 rounded p-4">
          <h2 className="font-semibold mb-2">Fix editor</h2>
          <textarea
            value={fixText}
            onChange={(e) => setFixText(e.target.value)}
            rows={10}
            spellCheck={false}
            className="w-full font-mono text-xs bg-slate-950 border border-slate-700 rounded p-2"
          />
          <div className="flex flex-wrap gap-2 mt-3">
            <button
              disabled={busy}
              onClick={() => run(() => api.approve(id, undefined, "reviewer", inc.version), "Approve")}
              className="bg-green-700 hover:bg-green-600 disabled:opacity-50 rounded px-4 py-2 text-sm font-semibold"
            >
              Approve fix
            </button>
            <button
              disabled={busy}
              onClick={() => {
                try {
                  const fix = JSON.parse(fixText) as Record<string, unknown>;
                  return run(() => api.editApprove(id, fix, "reviewer", inc.version), "Edit + approve");
                } catch {
                  setError("Fix editor is not valid JSON.");
                  return Promise.resolve();
                }
              }}
              className="bg-blue-700 hover:bg-blue-600 disabled:opacity-50 rounded px-4 py-2 text-sm font-semibold"
            >
              Edit + approve
            </button>
            <button
              disabled={busy}
              onClick={() => run(() => api.reject(id, "reviewer", inc.version), "Reject")}
              className="bg-slate-700 hover:bg-slate-600 disabled:opacity-50 rounded px-4 py-2 text-sm"
            >
              Reject record
            </button>
            <button
              disabled={busy}
              onClick={() => run(() => api.abort(id), "Abort")}
              className="bg-red-800 hover:bg-red-700 disabled:opacity-50 rounded px-4 py-2 text-sm"
            >
              Abort + drop queue
            </button>
          </div>
          <p className="text-xs text-slate-500 mt-2">
            Approving re-runs the fix through the full gate first — a bad fix gets kicked again, never committed silently.
            Abort drops only the held (uncommitted) queue — it never reverses records that already committed.
            After a reject the pipeline stays paused until an operator resumes it, unless nothing else is held or open.
          </p>
        </section>
      )}

      {inc.similar && inc.similar.length > 0 && (
        <section className="bg-slate-900 border border-slate-800 rounded p-4">
          <h2 className="font-semibold mb-2 text-sm">Similar past incidents</h2>
          {inc.similar.map((s) => (
            <div key={s.id} className="text-xs text-slate-400 font-mono">
              {s.id} · {new Date(s.created_at).toLocaleString()} · reviewer did: {s.action ?? "—"}
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
