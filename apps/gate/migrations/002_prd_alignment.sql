-- ErrorKicker PRD v1.0 alignment (Arch §6).
-- PostgreSQL is authoritative for operations, idempotency outcomes, pipeline
-- state (sequence + checkpoint), pending writes and the transactional outbox.
-- Redis is a best-effort cache / async helper only — nothing critical lives
-- only in Redis. Run AFTER 001_init.sql (initDb runs them in order); this
-- migration is additive and safe to re-run.

-- --- incidents: operation link, optimistic-concurrency version, proposed fix
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS operation_id TEXT;
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS version INT NOT NULL DEFAULT 1;
-- proposed_fix is the PRD name for what 001 called suggested_fix. Keep ONE
-- source of truth: proposed_fix mirrors suggested_fix (backfilled here, and
-- written together by the gate from now on).
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS proposed_fix JSONB;
UPDATE incidents
   SET proposed_fix = suggested_fix
 WHERE proposed_fix IS NULL AND suggested_fix IS NOT NULL;
CREATE INDEX IF NOT EXISTS incidents_operation_idx ON incidents (operation_id);

-- --- idempotency: link the outcome to its operation / incident / response
ALTER TABLE idempotency_keys ADD COLUMN IF NOT EXISTS operation_id TEXT;
ALTER TABLE idempotency_keys ADD COLUMN IF NOT EXISTS incident_id TEXT;
ALTER TABLE idempotency_keys ADD COLUMN IF NOT EXISTS result_json JSONB;

-- --- audit: PRD audit events carry the operation id too
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS operation_id TEXT;

-- --- write_operations: one durable row per accepted write request (Arch §6)
CREATE TABLE IF NOT EXISTS write_operations (
  operation_id   TEXT PRIMARY KEY,
  pipeline_id    TEXT NOT NULL,
  sequence_no    BIGINT NOT NULL,
  table_name     TEXT NOT NULL,
  request_hash   TEXT NOT NULL,
  idempotency_key TEXT,
  payload        JSONB NOT NULL,
  status         TEXT NOT NULL DEFAULT 'RECEIVED',
  -- RECEIVED | COMMITTED | QUARANTINED | QUEUED | REPLAYED
  result_json    JSONB,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (pipeline_id, sequence_no)
);
CREATE INDEX IF NOT EXISTS write_operations_pipeline_idx
  ON write_operations (pipeline_id, sequence_no);
CREATE INDEX IF NOT EXISTS write_operations_status_idx
  ON write_operations (pipeline_id, status);

-- --- pipeline_state: authoritative per-pipeline state + sequence/checkpoint
CREATE TABLE IF NOT EXISTS pipeline_state (
  pipeline_id              TEXT PRIMARY KEY,
  state                    TEXT NOT NULL DEFAULT 'RUNNING',
  -- RUNNING | PAUSED_AWAITING_REVIEW | ESCALATED | ABORTED
  next_sequence            BIGINT NOT NULL DEFAULT 1,
  last_completed_sequence  BIGINT NOT NULL DEFAULT 0,
  held_operation_id        TEXT,
  paused_at                TIMESTAMPTZ,
  version                  INT NOT NULL DEFAULT 1,
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Bridge existing installs: copy any pipeline known only to the legacy
-- `checkpoints` table (001) into pipeline_state. checkpoints stays as a
-- legacy/compat table; code reads and writes pipeline_state from now on.
INSERT INTO pipeline_state (pipeline_id, state, paused_at, updated_at)
SELECT pipeline_id, state, paused_at, updated_at FROM checkpoints
ON CONFLICT (pipeline_id) DO NOTHING;

-- --- pending_writes: the held queue, in Postgres, ordered by sequence_no
CREATE TABLE IF NOT EXISTS pending_writes (
  operation_id    TEXT PRIMARY KEY,
  pipeline_id     TEXT NOT NULL,
  sequence_no     BIGINT NOT NULL,
  table_name      TEXT NOT NULL,
  payload         JSONB NOT NULL,
  idempotency_key TEXT,
  trace_id        TEXT,
  status          TEXT NOT NULL DEFAULT 'PENDING',
  -- PENDING | PROCESSING | COMMITTED | KICKED | DROPPED
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (pipeline_id, sequence_no)
);
CREATE INDEX IF NOT EXISTS pending_writes_queue_idx
  ON pending_writes (pipeline_id, status, sequence_no);

-- --- outbox_events: transactional outbox (Arch §6/§9). Rows are written in
-- the same Postgres transaction as the commit/block they describe. Delivery
-- is at-least-once; the v1 publisher is a stub that marks rows published.
CREATE TABLE IF NOT EXISTS outbox_events (
  event_id     TEXT PRIMARY KEY,
  aggregate_id TEXT NOT NULL,
  event_type   TEXT NOT NULL,
  payload      JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ,
  attempts     INT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS outbox_unpublished_idx
  ON outbox_events (created_at) WHERE published_at IS NULL;

-- --- dedup fingerprints: exact-duplicate detection moves from Redis to
-- Postgres so Stage C survives a Redis outage. A fingerprint is recorded
-- when a write COMMITS (not at evaluation time), so a queued write never
-- "duplicates" itself when it is re-evaluated on drain.
CREATE TABLE IF NOT EXISTS dedup_fingerprints (
  fingerprint TEXT PRIMARY KEY,
  table_name  TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS dedup_fingerprints_expiry_idx
  ON dedup_fingerprints (expires_at);
