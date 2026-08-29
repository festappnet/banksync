-- Contract cleanup: remove the last legacy DLQ storage so the delivery model is
-- a single unified, forward-only schema (canonical webhook_delivery_jobs +
-- webhook_log + webhook_delivery_alerts; no webhook_dlq / webhook_dlq_archive).
--
-- Safety: this migration is NON-destructive of data. Every archive row is
-- canonically represented before the table is dropped:
--   * rows WITH a transaction_id were already imported into
--     webhook_delivery_jobs by 0006 (INSERT OR IGNORE ... WHERE transaction_id
--     IS NOT NULL);
--   * rows WITHOUT a transaction_id (historical orphans that could not be a
--     normal job) are imported HERE as terminal legacy jobs, tagged with
--     import_source='legacy_dlq' + legacy_dlq_id, and marked
--     last_error='legacy_missing_transaction' so they stay visible to an
--     operator. A replay of such a job is refused at the app layer.
--
-- Only after that preservation does the archive get dropped. Run a fresh D1
-- backup before applying (release precondition). No parked rollback SQL here.

INSERT OR IGNORE INTO webhook_delivery_jobs (
  transaction_id, consumer_app_id, event_kind, delivery_id, payload,
  status, http_attempt_count, next_attempt_at, last_error,
  import_source, legacy_dlq_id, created_at, terminal_at
)
SELECT
  NULL, consumer_app_id, 'transaction.received', delivery_id, payload,
  'terminal', attempts, datetime('now'), 'legacy_missing_transaction',
  'legacy_dlq', id, created_at, datetime('now')
FROM webhook_dlq_archive
WHERE transaction_id IS NULL;

DROP TABLE webhook_dlq_archive;

UPDATE schema_meta SET value = '9' WHERE key = 'version';
