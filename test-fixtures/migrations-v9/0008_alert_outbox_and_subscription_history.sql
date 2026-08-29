-- Additive expand, part 2. Splits out of 0007 the pieces that were authored
-- after 0007 had already been applied to production (prod reached schema
-- version 7 with the fencing columns but WITHOUT these two objects). Editing an
-- already-applied migration would silently never run — hard-won lesson — so
-- they live here and bump the version to 8.
--
-- Both objects are additive; the pre-0008 runtime keeps working. No destructive
-- change and no parked rollback SQL.

-- Per-job alert outbox. Replaces the global `alert_state('alerter_active')`
-- debounce that could hide a new terminal payment incident for 30 minutes. Each
-- incident is its own durable row keyed by a stable `incident_key`; a drainer
-- claims a due row with a lease + token so two cron ticks never post twice.
CREATE TABLE webhook_delivery_alerts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  delivery_job_id INTEGER NOT NULL,
  incident_kind   TEXT NOT NULL CHECK (incident_kind IN ('stalled', 'terminal', 'business', 'recovered')),
  incident_key    TEXT NOT NULL UNIQUE,
  payload         TEXT NOT NULL,
  post_attempts   INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL DEFAULT (datetime('now')),
  lease_until     TEXT,
  dispatch_token  TEXT,
  posted_at       TEXT,
  last_error      TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Drain scan: unposted alerts whose retry is due and lease is free.
CREATE INDEX idx_webhook_delivery_alerts_due
  ON webhook_delivery_alerts(posted_at, next_attempt_at, lease_until);

-- Temporal subscription history: soft-delete instead of hard-delete so the
-- delivery intent of an already-ingested transaction survives an unsubscribe.
-- The sweep derives intent from the [created_at, deleted_at) interval, never
-- from the current active-subscription view. (Additive nullable column.)
ALTER TABLE webhook_subscriptions ADD COLUMN deleted_at TEXT;

UPDATE schema_meta SET value = '8' WHERE key = 'version';
