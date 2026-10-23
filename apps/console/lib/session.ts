const TOKEN = "ek_review_key";
const ROLE = "ek_role";
const ACTOR = "ek_actor";

export function getSession(): { token: string; role: string; actor: string } {
  if (typeof window === "undefined") return { token: "", role: "reviewer", actor: "reviewer" };
  return {
    token: sessionStorage.getItem(TOKEN) ?? "",
    role: sessionStorage.getItem(ROLE) ?? "reviewer",
    actor: sessionStorage.getItem(ACTOR) ?? "reviewer",
  };
}

export function setSession(token: string, role: string, actor: string): void {
  sessionStorage.setItem(TOKEN, token);
  sessionStorage.setItem(ROLE, role);
  sessionStorage.setItem(ACTOR, actor);
}

export function clearSession(): void {
  sessionStorage.removeItem(TOKEN);
  sessionStorage.removeItem(ROLE);
  sessionStorage.removeItem(ACTOR);
}

export function authHeaders(json = false): Record<string, string> {
  const h: Record<string, string> = {};
  if (json) h["content-type"] = "application/json";
  if (typeof window === "undefined") return h;
  const s = getSession();
  if (s.token) h.authorization = `Bearer ${s.token}`;
  if (s.role) h["x-role"] = s.role;
  if (s.actor) h["x-actor"] = s.actor;
  return h;
}
