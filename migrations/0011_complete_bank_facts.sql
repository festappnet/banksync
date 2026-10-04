-- Schema 11: preserve row IDs and immutable delivery payloads. No historical email ID reinterpretation.
CREATE TABLE bank_sync_upgrade_sequence AS SELECT seq FROM sqlite_sequence WHERE name='transactions';
CREATE TABLE transactions_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bank_account_id INTEGER NOT NULL REFERENCES bank_accounts(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents BETWEEN -9007199254740991 AND 9007199254740991),
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
  payer_reference TEXT,
  raw_vs TEXT,
  direction TEXT NOT NULL DEFAULT 'incoming' CHECK (direction IN ('incoming','outgoing','zero')),
  identity_kind TEXT NOT NULL DEFAULT 'historical_unverified',
  identity_provenance TEXT NOT NULL DEFAULT 'historical_unverified',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO transactions_v2 (id, bank_account_id, amount_cents, currency, counter_account, bank_code, bank_name, vs, ks, ss, message, sender_name, user_identification, transaction_type, performed_by, comment, command_id, source, date, date_offset_min, transaction_id, external_id, created_at, raw_vs, identity_kind, identity_provenance)
SELECT id, bank_account_id, amount_cents, currency, counter_account, bank_code, bank_name, vs, ks, ss, message, sender_name, user_identification, transaction_type, performed_by, comment, command_id, source, date, date_offset_min, transaction_id, external_id, created_at, vs, CASE WHEN source='fio_api' AND transaction_id IS NOT NULL THEN 'movement' ELSE 'historical_unverified' END,
CASE WHEN source='fio_api' AND transaction_id IS NOT NULL THEN 'fio_api_column22' ELSE 'historical_unverified' END FROM transactions;
DROP TABLE transactions;
ALTER TABLE transactions_v2 RENAME TO transactions;
INSERT INTO sqlite_sequence(name,seq) SELECT 'transactions',COALESCE((SELECT seq FROM bank_sync_upgrade_sequence),0) WHERE NOT EXISTS(SELECT 1 FROM sqlite_sequence WHERE name='transactions');
UPDATE sqlite_sequence SET seq=MAX(seq,COALESCE((SELECT seq FROM bank_sync_upgrade_sequence),0)) WHERE name='transactions';
DROP TABLE bank_sync_upgrade_sequence;
CREATE UNIQUE INDEX idx_tx_ext ON transactions(bank_account_id, external_id) WHERE external_id IS NOT NULL;
CREATE UNIQUE INDEX idx_tx_fio ON transactions(bank_account_id, transaction_id) WHERE transaction_id IS NOT NULL AND identity_kind='movement';
ALTER TABLE webhook_consumers ADD COLUMN event_version TEXT NOT NULL DEFAULT '1' CHECK(event_version IN ('1','2'));
CREATE TABLE bank_poll_leases (credential_hash TEXT PRIMARY KEY, token TEXT NOT NULL, lease_until TEXT NOT NULL, next_allowed_at TEXT NOT NULL);
CREATE TABLE bank_recovery_batches (id TEXT PRIMARY KEY, bank_account_id INTEGER NOT NULL REFERENCES bank_accounts(id), from_date TEXT NOT NULL, to_date TEXT NOT NULL, cipher TEXT, key_version INTEGER, state TEXT NOT NULL CHECK(state IN ('fetching','spooled','completed')), created_at TEXT NOT NULL DEFAULT (datetime('now')), completed_at TEXT);
ALTER TABLE bank_accounts ADD COLUMN ingest_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE bank_accounts ADD COLUMN api_token_hash TEXT;
ALTER TABLE bank_accounts ADD COLUMN api_pointer_initialized INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bank_accounts ADD COLUMN api_reconciled_through TEXT;
UPDATE bank_accounts SET api_pointer_initialized=1 WHERE api_last_success_at IS NOT NULL;
CREATE TABLE authenticated_email_spool (id TEXT PRIMARY KEY, bank_account_id INTEGER NOT NULL REFERENCES bank_accounts(id), body_sha256 TEXT NOT NULL, cipher TEXT NOT NULL, key_version INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','completed')), attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')), completed_at TEXT);
UPDATE schema_meta SET value='11' WHERE key='version';
