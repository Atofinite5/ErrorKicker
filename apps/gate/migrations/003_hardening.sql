-- Trigram indexes for review-first fuzzy duplicate (C8). Extension is
-- created in 001_init.sql. Safe to re-run.
CREATE INDEX IF NOT EXISTS app_users_email_trgm
  ON app_users USING gin ((lower(record->>'email')) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS app_users_name_trgm
  ON app_users USING gin ((lower(record->>'name')) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS app_orders_userid_trgm
  ON app_orders USING gin ((lower(record->>'userId')) gin_trgm_ops);
