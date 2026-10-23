-- ErrorKicker v1 data model: five tables carry the whole system.
-- Committed (clean) application records live in app_orders / app_users.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS app_users (
  id TEXT PRIMARY KEY,
  record JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app_orders (
  id TEXT PRIMARY KEY,
  record JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per kick: the quarantine store.
CREATE TABLE IF NOT EXISTS incidents (
  id TEXT PRIMARY KEY,
  trace_id TEXT NOT NULL,
  pipeline_id TEXT NOT NULL,
  table_name TEXT NOT NULL,
  record_json JSONB NOT NULL,
  check_fired TEXT NOT NULL,
  severity TEXT NOT NULL,
  explanation TEXT NOT NULL,
  suggested_fix JSONB,
  fix_source TEXT,
  fix_confidence DOUBLE PRECISION,
  state TEXT NOT NULL DEFAULT 'PAUSED_AWAITING_REVIEW',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS incidents_state_idx ON incidents (state, created_at DESC);
CREATE INDEX IF NOT EXISTS incidents_pipeline_idx ON incidents (pipeline_id);

-- Where each pipeline stopped and how it resumes. Survives restarts.
CREATE TABLE IF NOT EXISTS checkpoints (
  pipeline_id TEXT PRIMARY KEY,
  state TEXT NOT NULL DEFAULT 'RUNNING',
  paused_at TIMESTAMPTZ,
  queued_count INT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Every human decision, provable afterwards. Append-only by convention:
-- the gate never UPDATEs or DELETEs rows here.
CREATE TABLE IF NOT EXISTS audit_log (
  id BIGSERIAL PRIMARY KEY,
  incident_id TEXT,
  pipeline_id TEXT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  before_json JSONB,
  after_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_incident_idx ON audit_log (incident_id, id);

-- Retry safety across restarts (mirrored in Redis for speed).
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key TEXT PRIMARY KEY,
  record_hash TEXT NOT NULL,
  result TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);

-- Versioned rules: a bad rule rolls back like code.
CREATE TABLE IF NOT EXISTS rules_config (
  table_name TEXT PRIMARY KEY,
  rule_yaml TEXT NOT NULL,
  version INT NOT NULL DEFAULT 1,
  active BOOLEAN NOT NULL DEFAULT true,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
