"use client";

import { useState } from "react";
import { GATE, whoami } from "../../lib/api";
import { setSession } from "../../lib/session";

export default function LoginPage() {
  const [token, setToken] = useState("");
  const [role, setRole] = useState("reviewer");
  const [actor, setActor] = useState("reviewer");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setSession(token.trim(), role, actor.trim() || role);
      await whoami();
      window.location.href = "/";
    } catch (err) {
      setError((err as Error).message + ` — gate ${GATE}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="max-w-md space-y-4 bg-slate-900 border border-slate-800 rounded p-6">
      <h2 className="font-semibold text-lg">Sign in to the review console</h2>
      <p className="text-sm text-slate-400">
        Use the review API key from the gate env (<code>REVIEW_API_KEY</code>). Role
        <code className="ml-1">operator</code> can pause, resume, and abort.
      </p>
      {error && <div className="text-sm text-red-300">{error}</div>}
      <label className="block text-sm">
        API key
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          className="mt-1 w-full bg-slate-950 border border-slate-700 rounded px-3 py-2"
          required
        />
      </label>
      <label className="block text-sm">
        Role
        <select
          value={role}
          onChange={(e) => setRole(e.target.value)}
          className="mt-1 w-full bg-slate-950 border border-slate-700 rounded px-3 py-2"
        >
          <option value="reviewer">reviewer — approve / reject</option>
          <option value="operator">operator — review + pipeline control</option>
        </select>
      </label>
      <label className="block text-sm">
        Display name (audit actor)
        <input
          value={actor}
          onChange={(e) => setActor(e.target.value)}
          className="mt-1 w-full bg-slate-950 border border-slate-700 rounded px-3 py-2"
        />
      </label>
      <button
        type="submit"
        disabled={busy}
        className="bg-slate-100 text-slate-900 rounded px-4 py-2 text-sm font-medium disabled:opacity-50"
      >
        {busy ? "Checking…" : "Continue"}
      </button>
    </form>
  );
}
