-- Canonical durable delivery state. Cloudflare Queue is an at-least-once
-- transport accelerator; this table is the recovery source of truth.
CREATE TABLE webhook_delivery_jobs (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  -- No FK: a terminal record must remain visible after a consumer is removed
  -- or retention prunes the original transaction.
  transaction_id      INTEGER NOT NULL,
  consumer_app_id     TEXT NOT NULL,
  delivery_id         TEXT NOT NULL UNIQUE,
  payload             TEXT NOT NULL,
  status              TEXT NOT NULL CHECK (status IN ('pending', 'queued', 'delivered', 'terminal')),
  attempt_count       INTEGER NOT NULL DEFAULT 0,
  next_attempt_at     TEXT NOT NULL,
  lease_until         TEXT,
  last_http_status    INTEGER,
  last_error          TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  delivered_at        TEXT,
  terminal_at         TEXT,
  UNIQUE(transaction_id, consumer_app_id)
);

CREATE INDEX idx_webhook_delivery_jobs_due
  ON webhook_delivery_jobs(status, next_attempt_at, lease_until);

-- Preserve existing dead-letter payloads as their original delivery lineage.
INSERT OR IGNORE INTO webhook_delivery_jobs (
  transaction_id, consumer_app_id, delivery_id, payload, status,
  attempt_count, next_attempt_at, last_error, created_at
)
SELECT transaction_id, consumer_app_id, delivery_id, payload, 'pending', attempts,
  datetime('now'), last_error, created_at
FROM webhook_dlq
WHERE transaction_id IS NOT NULL;

-- The runtime sweep derives any remaining transaction/subscription pairs.
-- Preserve rows that cannot be represented as a job (notably historical NULL
-- transaction_id rows) for a later retention-reviewed archival cleanup. No
-- runtime path reads this table after this migration.
ALTER TABLE webhook_dlq RENAME TO webhook_dlq_archive;

CREATE TABLE alert_state (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

UPDATE schema_meta SET value = '6' WHERE key = 'version';
