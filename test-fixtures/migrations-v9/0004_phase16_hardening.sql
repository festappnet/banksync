-- banksync Phase 1.6 — industrial hardening
--
-- Adds: per-tenant API keys, idempotency-key cache, admin audit log,
-- rate-limit buckets, CF routing outbox.
--
-- All new tables use TEXT created_at with datetime('now') default.
-- Retention applied via existing pruneRetention cron (extended in scheduled()).

-- ─── Per-tenant API key on webhook_consumers ────────────────────────────────
-- Plain key returned ONCE on POST /consumers (and POST /consumers/:app_id/rotate-admin-key).
-- We store SHA-256 hash + 12-char prefix (for header identification + audit log).
ALTER TABLE webhook_consumers ADD COLUMN admin_key_hash   TEXT;
ALTER TABLE webhook_consumers ADD COLUMN admin_key_prefix TEXT;
CREATE INDEX idx_consumers_admin_key_prefix ON webhook_consumers(admin_key_prefix)
  WHERE admin_key_prefix IS NOT NULL;

-- ─── Idempotency keys (Stripe pattern) ──────────────────────────────────────
-- key_hash = SHA-256(X-Idempotency-Key + auth_principal). Caches successful responses.
-- request_body_hash mismatch on replay → 422 (client sent same key with different body — bug).
CREATE TABLE idempotency_keys (
  key_hash           TEXT PRIMARY KEY,
  auth_principal     TEXT NOT NULL,                 -- 'admin' or 'tenant:<app_id>'
  request_path       TEXT NOT NULL,
  request_method     TEXT NOT NULL,
  request_body_hash  TEXT,                          -- nullable for empty bodies
  response_status    INTEGER NOT NULL,
  response_body      TEXT NOT NULL,
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_idem_created ON idempotency_keys(created_at);
-- Retention: 24h via pruneRetention.

-- ─── Admin audit log ────────────────────────────────────────────────────────
-- Records every admin/tenant API mutation. Read-only ops are NOT logged here
-- (volume control). See parse_log/event_log/webhook_log for runtime activity.
CREATE TABLE admin_audit_log (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  auth_principal      TEXT NOT NULL,                -- 'admin' or 'tenant:<app_id>' or 'unauth'
  http_method         TEXT NOT NULL,
  request_path        TEXT NOT NULL,
  http_status         INTEGER NOT NULL,
  request_body_summary TEXT,                        -- redacted, truncated 4KB
  source_ip           TEXT,
  user_agent          TEXT,
  duration_ms         INTEGER,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_audit_principal_time ON admin_audit_log(auth_principal, created_at);
CREATE INDEX idx_audit_path_time      ON admin_audit_log(request_path, created_at);
-- Retention: 365 days for compliance (handled in pruneRetention).

-- ─── Rate-limit buckets ─────────────────────────────────────────────────────
-- Sliding-window via discrete minute buckets. principal = auth_principal or IP.
-- Worker checks (sum count over last 60s) before each admin call.
CREATE TABLE rate_limit_buckets (
  principal     TEXT NOT NULL,
  window_start  TEXT NOT NULL,                      -- ISO 8601 minute-truncated
  count         INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (principal, window_start)
);
CREATE INDEX idx_rl_principal_window ON rate_limit_buckets(principal, window_start);
-- Retention: 1 hour (anything older is irrelevant).

-- ─── CF Email Routing outbox ────────────────────────────────────────────────
-- ACID-style sync: every CF mutation has an outbox row written in the same D1
-- batch as the bank_account mutation. Synchronous CF call is best-effort fast
-- path; if it fails, scheduled() reconciler retries with exponential backoff.
-- Drift detection: rows where status='pending' and attempts > N indicate
-- ongoing CF API issues; status='failed' = manual intervention required.
CREATE TABLE cf_routing_outbox (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  op                TEXT NOT NULL CHECK (op IN ('create','delete')),
  pairing_code      TEXT,                           -- for op='create'
  cf_rule_id        TEXT,                           -- for op='delete' (preserved before bank_account row removed) OR populated post-create after CF returns
  bank_account_id   INTEGER,                        -- for op='create' — rule id is written back here
  status            TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','completed','failed')),
  attempts          INTEGER NOT NULL DEFAULT 0,
  last_error        TEXT,
  next_attempt_at   TEXT NOT NULL DEFAULT (datetime('now')),
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at      TEXT
);
CREATE INDEX idx_cfo_pending      ON cf_routing_outbox(status, next_attempt_at) WHERE status = 'pending';
CREATE INDEX idx_cfo_bank_account ON cf_routing_outbox(bank_account_id) WHERE bank_account_id IS NOT NULL;
-- Retention: completed/failed > 30 days → DELETE.

UPDATE schema_meta SET value = '4' WHERE key = 'version';
