# Low-level design

This page maps the HLD onto modules, sequences, and state. File paths are under `apps/gate` unless noted.

## 1. Module map

| Module | File | Role |
|--------|------|------|
| HTTP surface | `src/routes.ts`, `src/index.ts` | Fastify routes, `/v1` + legacy twins |
| Gate | `src/gate.ts` | Evaluate, commit, kick, approve/reject/abort, drain |
| Schema | `src/schemas.ts` | Zod Stage A |
| Rules | `src/rules.ts`, `rules/*.yaml` | YAML Stage B engine |
| Dedup | `src/dedup.ts` | Fingerprints + idempotency keys |
| Anomaly | `src/anomaly.ts` | Baseline, patterns, optional LLM |
| Fixes | `src/fixes.ts` | Deterministic proposed corrections |
| Incidents | `src/incidents.ts` | Quarantine CRUD + versioned decisions |
| Pause | `src/pause.ts` | Pipeline state, sequences, pending queue |
| Operations | `src/operations.ts` | `write_operations` + outbox publish |
| Notify | `src/notify.ts` | n8n payload contract |
| Alerts | `src/alerts.ts` | Slack/email for high/critical |
| Audit | `src/audit.ts` | Append-only events |
| Metrics | `src/metrics.ts` | In-process counters + SSE bus |
| Console | `apps/console` | Dashboard and incident review UI |

## 2. Write admission sequence

```text
Client
  │  POST /v1/writes { table, record, idempotencyKey?, pipelineId? }
  ▼
routes.writeHandler
  │  1. envelope check (table + record required)
  │  2. if idempotencyKey:
  │       hit + same hash  → replay previous durable result
  │       hit + other hash → 409
  │  3. createOperation  (write_operations RECEIVED + sequence_no)
  │  4. evaluateWrite
  │
  ├─ kick  → kickWrite (tx: incident, audit, pause, QUARANTINED, outbox)
  │            then routeAlert + publishPendingOutbox → 422
  │
  ├─ pass and pipeline PAUSED/ABORTED
  │            → enqueueWhilePaused + QUEUED + outbox → 202
  │
  └─ pass and RUNNING
               → commitWrite (tx: app_*, fingerprint, COMMITTED,
                              checkpoint, idempotency, outbox) → 201
```

`evaluateWrite` is pure verdict. It does not consult Redis for admission. Redis outage cannot change pass/kick except by skipping the D10 baseline.

## 3. Stage details

### A — Schema (`schemas.ts`)

- `users` and `orders` schemas are `.strict()`.
- First Zod issue maps to `A1_REQUIRED`, `A2_TYPE`, or `A3_EXTRA`.

### B — Rules (`rules.ts`)

Loaded from `rules_config` (YAML files copied in on first boot). Checks: `range`, `expression`, `exists`, `regex`, `each`, `not_future`. First failure kicks with the rule id (e.g. `B4_TOTAL_RANGE`).

### C — Exact duplicate (`dedup.ts`)

Fingerprint is recorded **at commit**, not at evaluation. A queued write cannot “duplicate itself” when drained.

### D — Anomaly (`anomaly.ts`)

- D10: z-score vs Redis rolling window (`orders.total`, `users.age`). Skips if Redis is down or the window is too small.
- D11: injection-shaped strings.
- D12: LLM JSON review, `LLM_ENABLED=false` by default. Circuit breaker falls back to rules-only.

## 4. Incident state machine

```text
                  kickWrite
                      │
                      ▼
           PAUSED_AWAITING_REVIEW
             │         │         │
     approve/edit   reject     abort
             │         │         │
             ▼         ▼         ▼
        FIX_APPLIED  REJECTED  ABORTED
             │
             │  revalidation failed
             └──▶ new incident (original unchanged)
```

`decideIncident` is a conditional `UPDATE ... WHERE version = $n`. Loser gets 409. Approve/edit always re-runs `evaluateWrite` on the candidate record.

**Reject:** pipeline stays paused unless there are no other open incidents **and** no pending writes.

**Approve last open incident:** resume + drain in sequence order.

## 5. Pipeline state machine

```text
RUNNING ──kick / operator pause──▶ PAUSED_AWAITING_REVIEW
   ▲                                      │
   └── resume (empty or drained) ─────────┤
                                          │
                                   operator abort
                                          ▼
                                       ABORTED
```

`next_sequence` is allocated when the operation is created. `last_completed_sequence` advances on durable commit. Held writes keep their original sequence.

## 6. Review concurrency

Two reviewers cannot both apply a decision: the version column increments on every successful decision. Clients should send the `version` they read. Legacy console calls that omit `version` fall back to the state check only.

Edit-approve may only change fields already on the original record or the proposed fix. New keys → 400.

## 7. Outbox publisher (`operations.ts`)

1. Select unpublished `outbox_events` oldest-first.
2. If `N8N_WEBHOOK_URL` is set and `payload.status` is in `N8N_NOTIFY_STATUSES`, POST the payload.
3. HTTP &lt; 500 (except 408/429) counts as delivered for this consumer (n8n uses 201/202/400/422 as classification).
4. Else bump `attempts`. After 8 failures, mark published so the table cannot grow forever. The write itself already succeeded.

## 8. Console (`apps/console`)

- `/` dashboard: metrics, pipelines, open incidents (SSE `/stream` + poll).
- `/incidents/[id]` original vs proposed diff, approve / edit-approve / reject / abort.

The console is a client of the gate. It does not open Postgres.

## 9. Failure matrix

| Failure | Write path | Review path |
|---------|------------|-------------|
| Postgres down | Gate will not start / health `ok: false` | Fail |
| Redis down | Writes continue; D10 and alert dedup skip | Unaffected |
| n8n down | Write succeeds; outbox retries | Unaffected |
| LLM down / disabled | D12 skipped | Unaffected |
| Crash after DB commit, before HTTP | Client retry + same idempotency key replays | — |
| Crash mid-pause | Pipeline state and queue survive in Postgres | Resume from console |

## 10. Key invariants

1. A kicked write never inserts into `app_users` / `app_orders`.
2. A 201 is returned only after the commit transaction succeeds.
3. Approval cannot skip Stage A–D or database constraints.
4. Abort never rolls back already-committed rows.
5. n8n payloads contain identifiers and explanations, not the original record.
