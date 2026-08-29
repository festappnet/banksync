-- BankSync canonical schema baseline (schema version 10).
-- Production already recorded the original 0001-0009 filenames. This file is
-- for fresh databases; the next additive migration MUST be 0011 or higher.

CREATE TABLE webhook_consumers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id TEXT NOT NULL UNIQUE,
  callback_url TEXT NOT NULL,
  secret_cipher TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  secret_prefix TEXT NOT NULL,
  prev_secret_cipher TEXT,
  prev_expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  admin_key_hash TEXT,
  admin_key_prefix TEXT
);
CREATE INDEX idx_consumers_admin_key_prefix ON webhook_consumers(admin_key_prefix) WHERE admin_key_prefix IS NOT NULL;

CREATE TABLE bank_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_number TEXT NOT NULL,
  account_type TEXT NOT NULL DEFAULT 'FIO',
  pairing_code TEXT NOT NULL UNIQUE,
  label TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  owner_app_id TEXT REFERENCES webhook_consumers(app_id),
  cf_rule_id TEXT,
  ingest_mode TEXT NOT NULL DEFAULT 'email' CHECK (ingest_mode IN ('email', 'api', 'both')),
  api_token_cipher TEXT,
  api_token_key_ver INTEGER,
  api_token_prefix TEXT,
  api_fetch_enabled INTEGER NOT NULL DEFAULT 0,
  api_last_fetch_at TEXT,
  api_last_success_at TEXT,
  api_last_error TEXT,
  api_backfill_done INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_ba_owner ON bank_accounts(owner_app_id) WHERE owner_app_id IS NOT NULL;
CREATE INDEX idx_ba_api_fetch ON bank_accounts(account_type, api_fetch_enabled, api_last_fetch_at) WHERE api_fetch_enabled = 1;

CREATE TABLE transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bank_account_id INTEGER NOT NULL REFERENCES bank_accounts(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  currency TEXT NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency)),
  counter_account TEXT,
  bank_code TEXT,
  bank_name TEXT,
  vs TEXT,
  ks TEXT,
  ss TEXT,
  message TEXT,
  sender_name TEXT,
  user_identification TEXT,
  transaction_type TEXT,
  performed_by TEXT,
  comment TEXT,
  command_id TEXT,
  source TEXT NOT NULL,
  date TEXT NOT NULL,
  date_offset_min INTEGER,
  transaction_id TEXT,
  external_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_tx_ext ON transactions(external_id) WHERE external_id IS NOT NULL;
CREATE UNIQUE INDEX idx_tx_fio ON transactions(bank_account_id, transaction_id) WHERE transaction_id IS NOT NULL;
CREATE INDEX idx_tx_fuzzy_lookup ON transactions(bank_account_id, vs, amount_cents, currency, date) WHERE vs IS NOT NULL;
CREATE UNIQUE INDEX idx_tx_fuzzy_same_day ON transactions(bank_account_id, vs, amount_cents, currency, substr(date, 1, 10)) WHERE vs IS NOT NULL;

CREATE TABLE webhook_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bank_account_id INTEGER NOT NULL REFERENCES bank_accounts(id),
  consumer_app_id TEXT NOT NULL REFERENCES webhook_consumers(app_id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT,
  UNIQUE(bank_account_id, consumer_app_id)
);
CREATE INDEX idx_ws_account ON webhook_subscriptions(bank_account_id);

CREATE TABLE parse_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bank_account_id INTEGER,
  external_id TEXT,
  raw_data TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE webhook_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  delivery_id TEXT NOT NULL,
  consumer_app_id TEXT NOT NULL,
  bank_account_id INTEGER,
  transaction_id INTEGER,
  attempt INTEGER NOT NULL DEFAULT 1,
  http_status INTEGER,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_wl_consumer ON webhook_log(consumer_app_id, created_at);
CREATE INDEX idx_wl_delivery ON webhook_log(delivery_id);

CREATE TABLE event_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  bank_account_id INTEGER,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_el_type_time ON event_log(event_type, created_at);

CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO schema_meta (key, value) VALUES ('version', '10');

CREATE TABLE idempotency_keys (
  key_hash TEXT PRIMARY KEY,
  auth_principal TEXT NOT NULL,
  request_path TEXT NOT NULL,
  request_method TEXT NOT NULL,
  request_body_hash TEXT,
  response_status INTEGER NOT NULL,
  response_body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_idem_created ON idempotency_keys(created_at);

CREATE TABLE admin_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  auth_principal TEXT NOT NULL,
  http_method TEXT NOT NULL,
  request_path TEXT NOT NULL,
  http_status INTEGER NOT NULL,
  request_body_summary TEXT,
  source_ip TEXT,
  user_agent TEXT,
  duration_ms INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_audit_principal_time ON admin_audit_log(auth_principal, created_at);
CREATE INDEX idx_audit_path_time ON admin_audit_log(request_path, created_at);

CREATE TABLE rate_limit_buckets (
  principal TEXT NOT NULL,
  window_start TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (principal, window_start)
);
CREATE INDEX idx_rl_principal_window ON rate_limit_buckets(principal, window_start);

CREATE TABLE cf_routing_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  op TEXT NOT NULL CHECK (op IN ('create', 'delete')),
  pairing_code TEXT,
  cf_rule_id TEXT,
  bank_account_id INTEGER,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  next_attempt_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);
CREATE INDEX idx_cfo_pending ON cf_routing_outbox(status, next_attempt_at) WHERE status = 'pending';
CREATE INDEX idx_cfo_bank_account ON cf_routing_outbox(bank_account_id) WHERE bank_account_id IS NOT NULL;

CREATE TABLE webhook_delivery_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_id INTEGER,
  consumer_app_id TEXT NOT NULL,
  event_kind TEXT NOT NULL DEFAULT 'transaction.received',
  delivery_id TEXT NOT NULL UNIQUE,
  payload TEXT NOT NULL,
  payload_sha256 TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'dispatching', 'queued', 'delivered', 'terminal')),
  generation INTEGER NOT NULL DEFAULT 1,
  dispatch_token TEXT,
  dispatch_count INTEGER NOT NULL DEFAULT 0,
  http_attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  lease_until TEXT,
  last_http_status INTEGER,
  last_error TEXT,
  business_outcome TEXT,
  business_outcome_version INTEGER,
  receipt_json TEXT,
  incident_version INTEGER NOT NULL DEFAULT 0,
  import_source TEXT,
  legacy_dlq_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  delivered_at TEXT,
  terminal_at TEXT,
  UNIQUE(transaction_id, consumer_app_id, event_kind),
  UNIQUE(legacy_dlq_id)
);
CREATE INDEX idx_webhook_delivery_jobs_due ON webhook_delivery_jobs(status, next_attempt_at, lease_until);
CREATE INDEX idx_webhook_delivery_jobs_txn ON webhook_delivery_jobs(transaction_id, consumer_app_id, event_kind);

CREATE TABLE alert_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE webhook_delivery_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  delivery_job_id INTEGER NOT NULL,
  incident_kind TEXT NOT NULL CHECK (incident_kind IN ('stalled', 'terminal', 'business', 'recovered')),
  incident_key TEXT NOT NULL UNIQUE,
  payload TEXT NOT NULL,
  post_attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL DEFAULT (datetime('now')),
  lease_until TEXT,
  dispatch_token TEXT,
  posted_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_webhook_delivery_alerts_due ON webhook_delivery_alerts(posted_at, next_attempt_at, lease_until);
