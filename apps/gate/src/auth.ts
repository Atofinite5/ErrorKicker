import { timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "./config.ts";

export type Role = "writer" | "reviewer" | "operator";
export type Scope = "write" | "review" | "operate" | "read";

const SCOPE_ROLES: Record<Scope, Role[]> = {
  write: ["writer", "operator"],
  read: ["writer", "reviewer", "operator"],
  review: ["reviewer", "operator"],
  operate: ["operator"],
};

function safeEq(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function bearer(req: FastifyRequest): string {
  const header = req.headers.authorization ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(header);
  if (m) return m[1].trim();
  const alt = req.headers["x-api-key"];
  if (typeof alt === "string" && alt.trim()) return alt.trim();
  try {
    const q = new URL(req.url, "http://local").searchParams.get("access_token");
    if (q) return q.trim();
  } catch {
    // ignore
  }
  return "";
}

function requestedRole(req: FastifyRequest): Role | undefined {
  const raw = (req.headers["x-role"] ?? "").toString().toLowerCase();
  if (raw === "writer" || raw === "reviewer" || raw === "operator") return raw;
  return undefined;
}

/** Infer the strongest role this token is allowed to claim. */
export function roleForToken(token: string, claimed?: Role): Role | null {
  if (!token) return null;
  const write = config.writeApiKey;
  const review = config.reviewApiKey || write;
  const isWrite = write.length > 0 && safeEq(token, write);
  const isReview = review.length > 0 && safeEq(token, review);

  let allowed: Role[];
  if (isWrite && isReview) allowed = ["writer", "reviewer", "operator"];
  else if (isWrite) allowed = ["writer"];
  else if (isReview) allowed = ["reviewer", "operator"];
  else return null;

  if (claimed) return allowed.includes(claimed) ? claimed : allowed[allowed.length - 1];
  return allowed[allowed.length - 1];
}

export function authEnabled(): boolean {
  if (config.authRequired) return true;
  return Boolean(config.writeApiKey || config.reviewApiKey);
}

export interface Principal {
  role: Role;
  actor: string;
}

export function principalFrom(req: FastifyRequest): Principal | null {
  if (!authEnabled()) {
    const actor =
      (typeof req.headers["x-actor"] === "string" && req.headers["x-actor"]) ||
      "anonymous";
    return { role: "operator", actor };
  }
  const token = bearer(req);
  const role = roleForToken(token, requestedRole(req));
  if (!role) return null;
  const actor =
    (typeof req.headers["x-actor"] === "string" && req.headers["x-actor"]) || role;
  return { role, actor };
}

export function assertScope(req: FastifyRequest, reply: FastifyReply, scope: Scope): Principal | null {
  const p = principalFrom(req);
  if (!p) {
    void reply.code(401).send({ error: "unauthorized: send Authorization: Bearer <api key>" });
    return null;
  }
  if (!SCOPE_ROLES[scope].includes(p.role)) {
    void reply.code(403).send({
      error: `forbidden: role ${p.role} cannot ${scope}`,
    });
    return null;
  }
  return p;
}

export function pathScope(method: string, url: string): Scope | "public" {
  const path = url.split("?")[0];
  if (path === "/health" || path === "/v1/health") return "public";
  if ((path === "/write" || path === "/v1/writes") && method === "POST") return "write";
  if (method === "POST" && /\/(pause|resume|abort|reload)$/.test(path)) return "operate";
  if (method === "POST" && /\/(approve|edit-approve|reject)$/.test(path)) return "review";
  if (method === "GET") return "read";
  return "review";
}
