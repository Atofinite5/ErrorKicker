// Pure-logic smoke test — no Postgres, no Redis, no network.
// Run: npm run smoke
import assert from "node:assert";
import { findSuspiciousPattern, llmSafeRecord } from "./anomaly.ts";
import { pathScope } from "./auth.ts";
import { contentHash, decideIdempotency, requestHash } from "./dedup.ts";
import { addedFields, suggestFix, nearestField } from "./fixes.ts";
import { versionConflict } from "./incidents.ts";
import { evalExpression, getPath } from "./rules.ts";
import { mapZodIssue, orderSchema, userSchema } from "./schemas.ts";
import { buildNotifyEvent, parseNotifyStatuses, shouldNotify } from "./notify.ts";
import { redis } from "./redis.ts";

let passed = 0;
function t(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    console.error(`  ❌ ${name}: ${(e as Error).message}`);
    process.exitCode = 1;
  }
}

console.log("expression evaluator");
t("total matches lines → true", () => {
  const r = { total: 998, items: [{ qty: 2, price: 499 }] };
  assert.strictEqual(evalExpression("abs(total - sum(items, qty * price)) < 0.01", r), true);
});
t("total mismatch → false", () => {
  const r = { total: 100, items: [{ qty: 2, price: 499 }] };
  assert.strictEqual(evalExpression("abs(total - sum(items, qty * price)) < 0.01", r), false);
});
t("comparison + arithmetic", () => {
  assert.strictEqual(evalExpression("1 + 2 * 3 == 7", {}), true);
  assert.strictEqual(evalExpression("total >= 0", { total: -1 }), false);
});
t("bad expression fails closed (throws)", () => {
  assert.throws(() => evalExpression("total +", { total: 1 }));
});

console.log("getPath");
t("dotted path", () => {
  assert.strictEqual(getPath({ a: { b: [{ c: 42 }] } }, "a.b.0.c"), 42);
  assert.strictEqual(getPath({ a: 1 }, "a.b"), undefined);
});

console.log("Stage A mapping");
t("missing email → A1_REQUIRED", () => {
  const r = userSchema.safeParse({ id: "u1", name: "X", signupAt: "2026-01-01" });
  assert.ok(!r.success);
  if (!r.success) assert.strictEqual(mapZodIssue(r.error.issues[0]).check, "A1_REQUIRED");
});
t("bad email → A2_TYPE", () => {
  const r = userSchema.safeParse({ id: "u1", name: "X", email: "nope", signupAt: "2026-01-01" });
  assert.ok(!r.success);
  if (!r.success) assert.strictEqual(mapZodIssue(r.error.issues[0]).check, "A2_TYPE");
});
t("unknown key → A3_EXTRA", () => {
  const r = orderSchema.safeParse({
    id: "o1", userId: "u1", items: [{ sku: "S", qty: 1, price: 5 }],
    total: 5, currency: "INR", createdAt: "2026-01-01", emial: "x@y.z",
  });
  assert.ok(!r.success);
  if (!r.success) {
    const m = mapZodIssue(r.error.issues[0]);
    assert.strictEqual(m.check, "A3_EXTRA");
    assert.ok(m.message.includes("emial"));
  }
});

console.log("fix templates");
t("B4 negative → sign flip to 499", () => {
  const f = suggestFix({
    table: "orders",
    record: { total: -499 },
    checkFired: "B4_TOTAL_RANGE",
    rule: { id: "B4_TOTAL_RANGE", severity: "critical", message: "", check: "range", field: "total", min: 0, max: 1000000 },
    value: -499,
  });
  assert.strictEqual(f.fixedRecord?.total, 499);
  assert.strictEqual(f.fixSource, "rule-template");
});
t("B5 mismatch → recomputed total", () => {
  const f = suggestFix({
    table: "orders",
    record: { total: 100, items: [{ qty: 2, price: 499 }] },
    checkFired: "B5_TOTAL_MATCHES_LINES",
  });
  assert.strictEqual(f.fixedRecord?.total, 998);
});
t("A3 typo → renamed field", () => {
  const f = suggestFix({
    table: "orders",
    record: { id: "o1", emial: "x@y.z" },
    checkFired: "A3_EXTRA",
    unknownKeys: ["emial"],
    knownFields: ["id", "userId", "email", "total"],
  });
  assert.strictEqual((f.fixedRecord as Record<string, unknown>).email, "x@y.z");
  assert.ok(!("emial" in (f.fixedRecord as Record<string, unknown>)));
});
t("nearestField emial → email", () => {
  assert.strictEqual(nearestField("emial", ["email", "total"]), "email");
});
t("C7 duplicate → no auto-fix", () => {
  const f = suggestFix({ table: "orders", record: {}, checkFired: "C7_EXACT_DUPLICATE" });
  assert.strictEqual(f.fixedRecord, null);
  assert.strictEqual(f.fixSource, "none");
});

console.log("dedup hashing");
t("hash ignores key order + volatile fields", () => {
  const a = { id: "1", total: 5, createdAt: "t", items: [{ qty: 1 }] };
  const b = { items: [{ qty: 1 }], total: 5, id: "2", createdAt: "t2" };
  assert.strictEqual(contentHash(a), contentHash(b));
});
t("different payload → different hash", () => {
  assert.notStrictEqual(contentHash({ total: 5 }), contentHash({ total: 6 }));
});

console.log("D11 patterns");
t("script tag detected", () => {
  assert.ok(findSuspiciousPattern({ name: "x <script>alert(1)</script>" }));
});
t("clean record passes", () => {
  assert.strictEqual(findSuspiciousPattern({ name: "Aarav", total: 5 }), null);
});

console.log("PRD idempotency decision (FR-02)");
t("no stored key → miss", () => {
  assert.strictEqual(decideIdempotency(null, "h1"), "miss");
  assert.strictEqual(decideIdempotency(undefined, "h1"), "miss");
});
t("same key + same hash → replay", () => {
  assert.strictEqual(decideIdempotency("h1", "h1"), "replay");
});
t("same key + different hash → conflict (409)", () => {
  assert.strictEqual(decideIdempotency("h1", "h2"), "conflict");
});
t("requestHash binds table + payload (key order free)", () => {
  const a = requestHash("orders", { total: 5, items: [] });
  const b = requestHash("orders", { items: [], total: 5 });
  const c = requestHash("users", { total: 5, items: [] });
  assert.strictEqual(a, b);
  assert.notStrictEqual(a, c);
});

console.log("PRD incident version check (FR-06)");
t("matching version → no conflict", () => {
  assert.strictEqual(versionConflict(3, 3), false);
});
t("stale version → conflict", () => {
  assert.strictEqual(versionConflict(3, 2), true);
});
t("no version sent (legacy console) → no conflict", () => {
  assert.strictEqual(versionConflict(3, undefined), false);
});

console.log("PRD edit-approve field rule (§15)");
t("editing existing fields only → allowed", () => {
  assert.deepStrictEqual(
    addedFields({ total: 499, id: "o1" }, { id: "o1", total: -499, currency: "INR" }, null),
    [],
  );
});
t("adding a brand-new field → reported", () => {
  assert.deepStrictEqual(
    addedFields({ total: 499, hacker: 1 }, { total: -499 }, { total: 499 }),
    ["hacker"],
  );
});
t("field present in proposed fix counts as allowed", () => {
  assert.deepStrictEqual(addedFields({ email: "a@b.c" }, { id: "o1" }, { email: "x@y.z" }), []);
});

console.log("n8n outbound contract");
t("default statuses are kicked + queued only", () => {
  assert.deepStrictEqual(parseNotifyStatuses(undefined), ["kicked", "queued"]);
  assert.deepStrictEqual(parseNotifyStatuses("kicked, queued, committed"), [
    "kicked",
    "queued",
    "committed",
  ]);
  assert.strictEqual(shouldNotify("committed", ["kicked", "queued"]), false);
  assert.strictEqual(shouldNotify("kicked", ["kicked", "queued"]), true);
});
t("kicked payload matches the n8n webhook contract, no original record", () => {
  const ev = buildNotifyEvent({
    status: "kicked",
    table: "orders",
    pipelineId: "default",
    operationId: "op_1",
    sequenceNo: 12,
    traceId: "tr_1",
    incidentId: "inc_1",
    severity: "high",
    checkFired: "B4_TOTAL_RANGE",
    explanation: "Order amount must be positive",
  });
  assert.deepStrictEqual(ev, {
    status: "kicked",
    table: "orders",
    pipelineId: "default",
    operationId: "op_1",
    sequenceNo: 12,
    traceId: "tr_1",
    incident: {
      id: "inc_1",
      severity: "high",
      check: "B4_TOTAL_RANGE",
      explanation: "Order amount must be positive",
    },
  });
  assert.ok(!("record" in ev));
});
t("committed and queued payloads stay ids-only", () => {
  const committed = buildNotifyEvent({
    status: "committed",
    table: "users",
    operationId: "op_ok",
  });
  assert.strictEqual(committed.status, "committed");
  assert.strictEqual(committed.incident, undefined);
  const queued = buildNotifyEvent({ status: "queued", table: "orders", pipelineId: "default" });
  assert.strictEqual(queued.status, "queued");
  assert.strictEqual(queued.pipelineId, "default");
});

console.log("auth scopes");
t("write / review / operate / health", () => {
  assert.strictEqual(pathScope("POST", "/v1/writes"), "write");
  assert.strictEqual(pathScope("GET", "/health"), "public");
  assert.strictEqual(pathScope("POST", "/v1/incidents/x/approve"), "review");
  assert.strictEqual(pathScope("POST", "/v1/pipelines/x/abort"), "operate");
  assert.strictEqual(pathScope("GET", "/v1/incidents"), "read");
});

console.log("PRD LLM payload policy (§15)");
t("llmSafeRecord strips id + *Id fields, keeps the rest", () => {
  const safe = llmSafeRecord({ id: "o1", userId: "u1", total: 499, currency: "INR" });
  assert.deepStrictEqual(safe, { total: 499, currency: "INR" });
});
t("llmSafeRecord drops secrets and redacts emails", () => {
  const safe = llmSafeRecord({
    total: 10,
    email: "ada@example.com",
    password: "hunter2",
    note: "contact bob@x.com",
  });
  assert.strictEqual(safe.password, undefined);
  assert.strictEqual(safe.email, undefined);
  assert.strictEqual(safe.note, "contact [redacted]");
  assert.strictEqual(safe.total, 10);
});

console.log(`\n${passed} logic checks passed.`);
await redis.disconnect();
process.exit(process.exitCode ?? 0);
