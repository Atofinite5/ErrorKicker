# Documentation index

Start here. Each page is the source of truth for one concern.

| Document | What it covers |
|----------|----------------|
| [../README.md](../README.md) | Product overview, quick start, API cheat sheet |
| [architecture.md](architecture.md) | High-level design (HLD): components, data flow, NFRs |
| [lld.md](lld.md) | Low-level design (LLD): modules, sequences, state machines |
| [data-model.md](data-model.md) | PostgreSQL schema, Redis role, outbox |
| [api.md](api.md) | HTTP API contract, status codes, payloads |
| [operations.md](operations.md) | Run, configure, recover, what v1 does not do |

## Reading order

1. README — what the system is and how to run it.
2. Architecture — where a write goes and why Postgres is authoritative.
3. LLD — the gate stages, pause/resume, and review loop.
4. Data model and API — implement or integrate against them.
5. Operations — env vars, health, failure behaviour.
