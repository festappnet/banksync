-- Expand migration (additive, non-destructive). Builds on 0006's canonical
-- webhook_delivery_jobs by adding the fencing/lifecycle columns the delivery
-- coordinator needs to make dispatch monotonic and safe under Cloudflare
-- Queue's at-least-once transport:
--   * `dispatching` status  — claimed, Queue.send outcome not yet confirmed in D1
--   * generation            — bumped by audited replay/force-redrive
--   * dispatch_token        — per-claim fencing token; stale tokens are ack'd, not applied
--   * dispatch_count/http_attempt_count — separated producer vs consumer counters
--   * event_kind            — future refund/correction events cannot reuse this idempotency key
--   * payload_sha256        — payload integrity check before each send
--   * business_outcome      — transport `delivered` is not the same as a settled payment
--   * incident_version      — force-redrive / alert incident versioning
--   * import_source/legacy_dlq_id — canonical representation of historical DLQ rows
--
-- SQLite cannot alter a CHECK constraint in place, so this is the standard
-- table rebuild. It is a superset of 0006: every 0006 row is preserved with a
-- generation of 1 and http_attempt_count seeded from the old attempt_count.
--
-- NOTE: rollback SQL intentionally does NOT live in migrations/. A parked
-- rollback re-applies itself and silently reverts the feature (hard-won lesson).

PRAGMA foreign_keys=OFF;

CREATE TABLE webhook_delivery_jobs_v2 (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Nullable only for legacy_dlq orphan imports (import_source='legacy_dlq').
  -- A live job always has a transaction_id. No FK: a terminal record must stay
  -- visible after a consumer is removed or retention prunes the transaction.
  transaction_id      INTEGER,
  consumer_app_id     TEXT NOT NULL,
  event_kind          TEXT NOT NULL DEFAULT 'transaction.received',
  delivery_id         TEXT NOT NULL UNIQUE,
  payload             TEXT NOT NULL,
  payload_sha256      TEXT,
  status              TEXT NOT NULL CHECK (status IN ('pending', 'dispatching', 'queued', 'delivered', 'terminal')),
  generation          INTEGER NOT NULL DEFAULT 1,
  dispatch_token      TEXT,
  dispatch_count      INTEGER NOT NULL DEFAULT 0,
  http_attempt_count  INTEGER NOT NULL DEFAULT 0,
  next_attempt_at     TEXT NOT NULL,
  lease_until         TEXT,
  last_http_status    INTEGER,
  last_error          TEXT,
  -- Domain result carried alongside transport status. `delivered` transport
  -- does not by itself mean the money is reconciled.
  business_outcome    TEXT,
  business_outcome_version INTEGER,
  receipt_json        TEXT,
  incident_version    INTEGER NOT NULL DEFAULT 0,
  import_source       TEXT,
  legacy_dlq_id       INTEGER,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  delivered_at        TEXT,
  terminal_at         TEXT,
  UNIQUE(transaction_id, consumer_app_id, event_kind),
  UNIQUE(legacy_dlq_id)
);

INSERT INTO webhook_delivery_jobs_v2 (
  id, transaction_id, consumer_app_id, event_kind, delivery_id, payload,
  status, generation, dispatch_count, http_attempt_count, next_attempt_at,
  lease_until, last_http_status, last_error, created_at, delivered_at, terminal_at
)
SELECT
  id, transaction_id, consumer_app_id, 'transaction.received', delivery_id, payload,
  -- 0006 statuses are all valid under the widened CHECK.
  status, 1, 0, attempt_count, next_attempt_at,
  lease_until, last_http_status, last_error, created_at, delivered_at, terminal_at
FROM webhook_delivery_jobs;

DROP TABLE webhook_delivery_jobs;
ALTER TABLE webhook_delivery_jobs_v2 RENAME TO webhook_delivery_jobs;

-- Due-scan index: pending/queued/dispatching jobs whose lease has expired.
CREATE INDEX idx_webhook_delivery_jobs_due
  ON webhook_delivery_jobs(status, next_attempt_at, lease_until);

-- Fast lookups by transaction for immediate fan-out and by generation fencing.
CREATE INDEX idx_webhook_delivery_jobs_txn
  ON webhook_delivery_jobs(transaction_id, consumer_app_id, event_kind);

PRAGMA foreign_keys=ON;

UPDATE schema_meta SET value = '7' WHERE key = 'version';
