"use client";

import { clearSession, getSession } from "../lib/session";
import { useEffect, useState } from "react";

export function HeaderBar() {
  const [actor, setActor] = useState("");
  const [role, setRole] = useState("");
  useEffect(() => {
    const s = getSession();
    setActor(s.actor);
    setRole(s.role);
  }, []);
  return (
    <header className="border-b border-slate-800 px-6 py-4 flex items-center gap-3">
      <span className="text-2xl">🥋</span>
      <div>
        <h1 className="font-bold text-lg leading-none">ErrorKicker</h1>
        <p className="text-xs text-slate-400">data-integrity gateway</p>
      </div>
      <nav className="ml-8 flex gap-4 text-sm">
        <a href="/" className="text-slate-300 hover:text-white">Dashboard</a>
      </nav>
      <div className="ml-auto flex items-center gap-3 text-xs text-slate-400">
        {actor && <span>{actor} · {role}</span>}
        <a href="/login" className="hover:text-white">Switch key</a>
        <button
          type="button"
          className="hover:text-white"
          onClick={() => {
            clearSession();
            window.location.href = "/login";
          }}
        >
          Sign out
        </button>
      </div>
    </header>
  );
}
