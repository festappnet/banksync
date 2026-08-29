-- banksync Phase 1 schema (see PLAN.md for spec)

CREATE TABLE bank_accounts (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  account_number TEXT NOT NULL,
  account_type   TEXT NOT NULL DEFAULT 'FIO',
  pairing_code   TEXT NOT NULL UNIQUE,
  label          TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE transactions (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  bank_account_id     INTEGER NOT NULL REFERENCES bank_accounts(id),
  amount_cents        INTEGER NOT NULL CHECK (amount_cents > 0),
  currency            TEXT NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency)),
  counter_account     TEXT,
  bank_code           TEXT,
  bank_name           TEXT,
  vs                  TEXT,
  ks                  TEXT,
  ss                  TEXT,
  message             TEXT,
  sender_name         TEXT,
  user_identification TEXT,
  transaction_type    TEXT,
  performed_by        TEXT,
  comment             TEXT,
  command_id          TEXT,
  source              TEXT NOT NULL,
  date                TEXT NOT NULL,
  date_offset_min     INTEGER,
  transaction_id      TEXT,
  external_id         TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX idx_tx_ext ON transactions(external_id)
  WHERE external_id IS NOT NULL;

CREATE UNIQUE INDEX idx_tx_fio ON transactions(bank_account_id, transaction_id)
  WHERE transaction_id IS NOT NULL;

CREATE TABLE webhook_consumers (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id              TEXT NOT NULL UNIQUE,
  callback_url        TEXT NOT NULL,
  secret_cipher       TEXT NOT NULL,
  secret_hash         TEXT NOT NULL,
  secret_prefix       TEXT NOT NULL,
  prev_secret_cipher  TEXT,
  prev_expires_at     TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE webhook_subscriptions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  bank_account_id INTEGER NOT NULL REFERENCES bank_accounts(id),
  consumer_app_id TEXT NOT NULL REFERENCES webhook_consumers(app_id),
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(bank_account_id, consumer_app_id)
);

CREATE INDEX idx_ws_account ON webhook_subscriptions(bank_account_id);

CREATE TABLE parse_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  bank_account_id INTEGER,
  external_id     TEXT,
  raw_data        TEXT,
  error_message   TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE webhook_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  delivery_id     TEXT NOT NULL,
  consumer_app_id TEXT NOT NULL,
  bank_account_id INTEGER,
  transaction_id  INTEGER,
  attempt         INTEGER NOT NULL DEFAULT 1,
  http_status     INTEGER,
  error_message   TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_wl_consumer ON webhook_log(consumer_app_id, created_at);

CREATE INDEX idx_wl_delivery ON webhook_log(delivery_id);

CREATE TABLE webhook_dlq (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  delivery_id     TEXT NOT NULL UNIQUE,
  consumer_app_id TEXT NOT NULL,
  bank_account_id INTEGER,
  transaction_id  INTEGER,
  payload         TEXT NOT NULL,
  last_error      TEXT,
  attempts        INTEGER NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE event_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type      TEXT NOT NULL,
  bank_account_id INTEGER,
  detail          TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_el_type_time ON event_log(event_type, created_at);

CREATE TABLE schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT INTO schema_meta (key, value) VALUES ('version', '1');
