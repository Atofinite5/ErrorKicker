# Data model

PostgreSQL is the system of record. Migrations: `apps/gate/migrations/001_init.sql`, `002_prd_alignment.sql`. Redis holds only cache-shaped data.

## Application tables

| Table | Key | Contents |
|-------|-----|----------|
| `app_users` | `id` | Committed user JSON |
| `app_orders` | `id` | Committed order JSON |

Blocked writes never appear here.

## Control tables

| Table | Purpose |
|-------|---------|
| `write_operations` | One row per admitted request: pipeline, sequence, hash, payload, status |
| `incidents` | Quarantine: original record, check, explanation, proposed fix, version, state |
| `pipeline_state` | `RUNNING` / `PAUSED_AWAITING_REVIEW` / `ESCALATED` / `ABORTED`, sequence + checkpoint |
| `pending_writes` | Held passes, ordered by `(pipeline_id, sequence_no)` |
| `idempotency_keys` | 24h window: key → hash + durable result JSON |
| `dedup_fingerprints` | Exact-duplicate hashes of **committed** payloads |
| `outbox_events` | Transactional events for n8n (and future consumers) |
| `audit_log` | Append-only reviewer and pipeline actions |
| `rules_config` | Per-table YAML rules + version |
| `checkpoints` | Legacy table from 001; bridged into `pipeline_state` |

## Operation status

`RECEIVED` → `COMMITTED` | `QUARANTINED` | `QUEUED` | `REPLAYED` | `DROPPED`

## Incident status

`PAUSED_AWAITING_REVIEW` | `FIX_APPLIED` | `REJECTED` | `ABORTED`

`version` starts at 1 and increments on each decision.

## Redis keys (best-effort)

- Rolling numeric baseline for D10
- Alert fingerprint + count for high/critical Slack/email

If Redis is empty or down, those features skip. Postgres behaviour is unchanged.

## What is never stored in n8n

The original application record. Notify payloads are ids, status, table, pipeline, check, severity, and explanation.
