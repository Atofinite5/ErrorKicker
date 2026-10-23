# ErrorKicker

A data-integrity gateway: intercept application writes before they commit, quarantine failures as reviewable incidents, require a human decision, revalidate corrections, and recover after restart.

PostgreSQL is authoritative. Redis is cache. n8n is an optional outbound router. n8n is not the runtime.

## Contents

1. [What it does](#what-it-does)
2. [What it is not](#what-it-is-not)
3. [Documentation index](#documentation-index)
4. [Architecture](#architecture)
5. [Run](#run)
6. [Write contract](#write-contract)
7. [Review loop](#review-loop)
8. [API](#api)
9. [Configuration](#configuration)
10. [Verify](#verify)
11. [Repository layout](#repository-layout)
12. [v1 limits](#v1-limits)

## What it does

- Block configured invalid writes before they hit `app_users` / `app_orders`.
- Persist the original record, the check that fired, an explanation, and a proposed fix.
- Pause the **pipeline** (not the HTTP request) until a reviewer approves, edits, or rejects.
- Re-run the full gate on every approval. No bypass.
- Keep sequence order for later valid writes while paused.
- Survive process restart: pause, queue, and incidents live in Postgres.
- Optionally POST kicked/queued outcomes to n8n (ids and explanation only).

## What it is not

- A proxy in front of every database.
- An APM or log platform.
- Autonomous production “AI fixes”.
- Automatic rollback of already-committed rows.
- A guarantee that every semantic error is caught.

## Documentation index

| Doc | Audience |
|-----|----------|
| [docs/README.md](docs/README.md) | Index of all design docs |
| [docs/architecture.md](docs/architecture.md) | HLD: components, data flow, NFRs |
| [docs/lld.md](docs/lld.md) | LLD: modules, sequences, state machines |
| [docs/data-model.md](docs/data-model.md) | Tables, statuses, Redis vs Postgres |
| [docs/api.md](docs/api.md) | HTTP contract |
| [docs/operations.md](docs/operations.md) | Run, env, recovery |

## Architecture

```text
App ──POST /v1/writes──▶ Gate (Fastify :3001)
                            │
              ┌─────────────┼─────────────┐
              │ A Zod  B YAML  C dedup  D anomaly
              └─────────────┬─────────────┘
                     pass / kick
                            │
              ┌─────────────▼─────────────┐
              │ PostgreSQL                │
              │ app_* · incidents · ops   │
              │ pipeline_state · outbox   │
              └─────────────┬─────────────┘
                            │
         Console :3000      │ optional POST
         (review UI)        ▼
                         n8n Cloud
```

Checks run cheapest-first. First failure quarantines the record. Independent `pipelineId`s do not block each other.

**HLD:** [docs/architecture.md](docs/architecture.md)  
**LLD:** [docs/lld.md](docs/lld.md)

## Run

```bash
cp .env.example .env
docker compose up -d
npm install
npm run gate       # terminal 1 — :3001
npm run console    # terminal 2 — :3000
```

The database starts empty. There is no seed dataset.

Valid write:

```bash
curl -sS -X POST http://localhost:3001/v1/writes \
  -H 'content-type: application/json' \
  -H "Authorization: Bearer $WRITE_API_KEY" \
  -d '{"table":"users","record":{"id":"u_1","name":"Ada","email":"ada@example.com","signupAt":"2026-10-23T00:00:00.000Z"},"idempotencyKey":"write-1"}'
```

Expect **201**. An invalid record returns **422**, creates an incident, pauses that pipeline, and (if configured) notifies n8n.

## Write contract

| Result | HTTP | Meaning |
|--------|------|---------|
| committed | 201 | Application row written |
| queued | 202 | Valid, held because the pipeline is paused |
| kicked | 422 | Incident created; application row not written |
| duplicate | 200 | Same idempotency key + same payload replayed |
| conflict | 409 | Same key, different payload |

Idempotency window: 24 hours in Postgres.

Supported entities: `users`, `orders`.

## Review loop

1. Open the console at http://localhost:3000.
2. Open the incident. Original payload and proposed fix are separate.
3. **Approve**, **edit + approve**, or **Reject**.
4. Approved data runs through Stages A–D again.
5. Last open incident for a pipeline resumes held writes in sequence order.

Reject does **not** auto-resume unless there is nothing left to hold.

## API

Full contract: [docs/api.md](docs/api.md).

| Method | Path | Role |
|--------|------|------|
| POST | `/v1/writes` | Admit a write |
| GET | `/v1/incidents` | Queue |
| POST | `/v1/incidents/:id/approve` | Apply fix |
| POST | `/v1/incidents/:id/edit-approve` | Edit then apply |
| POST | `/v1/incidents/:id/reject` | Reject |
| POST | `/v1/pipelines/:id/resume` | Drain + resume |
| GET | `/health` | Postgres health |
| GET | `/v1/stream` | SSE for the dashboard |

Auth: `WRITE_API_KEY` / `REVIEW_API_KEY` as `Authorization: Bearer`. Roles:
`reviewer` (approve/reject) and `operator` (plus pause/resume/abort). Console
login is `/login`. `actor` is still the audit display name (`x-actor`).

## Configuration

See `.env.example` and [docs/operations.md](docs/operations.md).

Outbound n8n (gate pushes; n8n cannot pull localhost):

```bash
N8N_WEBHOOK_URL=https://<instance>/webhook/errorkicker-incident
N8N_NOTIFY_STATUSES=kicked,queued
```

Leave empty to skip network calls. Writes still succeed.

## Verify

```bash
npm run smoke
npm run typecheck
```

Smoke tests are pure logic (no Docker). Live path needs Postgres + Redis.

## Repository layout

```text
apps/gate      Fastify gate, rules, migrations
apps/console   Next.js review console
docs/          HLD, LLD, data model, API, operations
docker-compose.yml
```

## v1 limits

- Protection applies only to writes sent to this gate.
- Redis/LLM outage must not produce a false commit (it does not).
- Outbox is at-least-once (BullMQ, HTTP fallback, DLQ), not exactly-once.
- Abort never rolls back committed rows.
- No OAuth/SSO, no multi-tenant billing, no autonomous unattended fixes.
