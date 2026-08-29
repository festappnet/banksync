-- Production upgrade from the recorded 0001-0009 history to schema v10.
-- Cached mutation responses are intentionally ephemeral and may contain
-- credentials produced before credential routes rejected idempotency.
DELETE FROM idempotency_keys;

INSERT INTO schema_meta (key, value) VALUES ('version', '10')
ON CONFLICT(key) DO UPDATE SET value = excluded.value;
