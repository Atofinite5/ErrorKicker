# High-level design

ErrorKicker is a **data-integrity gateway**. Application writes that are routed through it are validated, then either committed to application tables or quarantined for a human decision. n8n is an optional outbound sink. It is not the core runtime.

## 1. Purpose

Prevent invalid, duplicate, or suspicious records from landing in application data. When a write is blocked, persist the original payload, the check that fired, a proposed correction, and enough state to recover after a process restart.

## 2. Context

```text
  Client / backend service
           |
           |  POST /v1/writes
           v
     ┌─────────────┐     Zod + YAML rules      ┌──────────────┐
     │  Gate API   │──────────────────────────▶│  PostgreSQL  │
     │  Fastify    │  commit OR quarantine     │  (source of  │
     │  :3001      │◀──────────────────────────│   truth)     │
     └──────┬──────┘                           └──────┬───────┘
            │                                         │
            │  SSE / REST                             │
            v                                         │
     ┌─────────────┐                                  │
     │  Console    │                                  │
     │  Next.js    │                                  │
     │  :3000      │                                  │
     └─────────────┘                                  │
            │                                         │
            │  optional POST (kicked / queued)        │
            v                                         v
     ┌─────────────┐                           ┌──────────────┐
     │  n8n Cloud  │◀── outbox publisher ──────│ Redis        │
     │  (optional) │                           │ cache only   │
     └─────────────┘                           └──────────────┘
```

n8n Cloud cannot reach `localhost`. The gate therefore **pushes** events out. Redis never decides a write.

## 3. Logical components

| Component | Responsibility | Authority |
|-----------|----------------|-----------|
| Gate (`apps/gate`) | Admit writes, run checks, persist outcomes, review actions | Yes — only path that mutates protected tables |
| Console (`apps/console`) | Incident queue, diff, approve / edit / reject | No — talks to the gate over HTTP |
| PostgreSQL | Application rows, incidents, operations, pipeline state, pending writes, idempotency, outbox, audit | Authoritative |
| Redis | Anomaly baseline, alert fingerprint dedup | Best-effort. Outage must not fail a write |
| n8n (optional) | Route kicked/queued outcomes to operators | Downstream consumer, at-least-once |

v1 entities: `users` and `orders` only.

## 4. Write outcomes

| Outcome | HTTP | Durable effect |
|---------|------|----------------|
| Committed | 201 | Row in `app_*`, operation `COMMITTED` |
| Queued | 202 | Held in `pending_writes` because the pipeline is paused or aborted |
| Kicked | 422 | Incident + pipeline `PAUSED_AWAITING_REVIEW`; no application row |
| Idempotent replay | 200 | Previous durable result returned |
| Idempotency conflict | 409 | Same key, different payload hash |

The HTTP response never waits for a human.

## 5. Check pipeline (cheapest first)

1. **A — Schema** (Zod, strict): required fields, types, unknown keys.
2. **B — Rules** (YAML in Postgres): range, expression, exists, regex, per-item.
3. **C — Exact duplicate** of an already-committed payload (Postgres fingerprint).
4. **D — Anomaly**: statistical outlier (Redis baseline), suspicious patterns, optional LLM.

The first failing check kicks. A proposed fix is generated from templates; LLM is off by default.

## 6. Human loop

A kicked write becomes an incident. An authorized caller (v1: self-declared `actor`) may:

- **Approve** the proposed fix
- **Edit and approve** (only fields already present on the original or the proposal)
- **Reject** (does not auto-resume unless nothing remains to hold)

Every approval/edit is **revalidated through the full gate**. There is no bypass. A stale incident `version` is a 409.

## 7. Pipelines and ordering

Writes are sequenced per `pipelineId`. Independent pipelines do not block each other. While paused:

- New **kicks** still create incidents.
- New **passes** are enqueued in sequence order.
- Resume drains `pending_writes` in sequence order and re-runs the gate.

State lives in `pipeline_state`. A restart does not lose the pause.

## 8. Outbox and n8n

Commit, kick, and queued paths insert an `outbox_events` row in the same Postgres transaction as the effect. The publisher POSTs matching events to `N8N_WEBHOOK_URL` (default: `kicked` and `queued` only). The original record is never sent. Delivery is at-least-once; n8n being down does not fail the write.

## 9. Non-functional rules

| Concern | Rule |
|---------|------|
| Durability | In-memory state is not authoritative. Critical outcomes are in PostgreSQL. |
| Consistency | Unique constraints, transactions, and incident version checks. |
| Reliability | Idempotent retries; outbox consumers must tolerate duplicates. |
| Security | Parameterized SQL, payload size at the API, secrets in env, no original record to n8n. v1 has no real auth (`actor` is attribution). |
| Availability | Redis or LLM outage must not report a false commit. |
| Honesty | Only writes routed through the gate are protected. |

## 10. What v1 does not do

- Universal DB proxy or automatic rollback of committed rows
- Multi-tenant SaaS, billing, or a full APM platform
- Autonomous production fixes without a human
- BullMQ / exactly-once consumers (outbox HTTP publish is the v1 delivery)
- Guarantee that every semantic error is detected
