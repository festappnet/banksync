-- banksync Phase 2 — bank API sync
--
-- Adds write-only encrypted bank API token storage and polling state.
-- The first adapter is Fio, but the table columns stay provider-neutral
-- so another bank API can reuse the same lifecycle fields later.
-- Email and API transactions continue to use the same transactions table
-- and the same exact/fuzzy duplicate guards.

ALTER TABLE bank_accounts ADD COLUMN ingest_mode TEXT NOT NULL DEFAULT 'email'
  CHECK (ingest_mode IN ('email', 'api', 'both'));
ALTER TABLE bank_accounts ADD COLUMN api_token_cipher TEXT;
ALTER TABLE bank_accounts ADD COLUMN api_token_key_ver INTEGER;
ALTER TABLE bank_accounts ADD COLUMN api_token_prefix TEXT;
ALTER TABLE bank_accounts ADD COLUMN api_fetch_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bank_accounts ADD COLUMN api_last_fetch_at TEXT;
ALTER TABLE bank_accounts ADD COLUMN api_last_success_at TEXT;
ALTER TABLE bank_accounts ADD COLUMN api_last_error TEXT;
ALTER TABLE bank_accounts ADD COLUMN api_backfill_done INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_ba_api_fetch
  ON bank_accounts(account_type, api_fetch_enabled, api_last_fetch_at)
  WHERE api_fetch_enabled = 1;

CREATE INDEX idx_tx_fuzzy_lookup
  ON transactions(bank_account_id, vs, amount_cents, currency, date)
  WHERE vs IS NOT NULL;

CREATE UNIQUE INDEX idx_tx_fuzzy_same_day
  ON transactions(bank_account_id, vs, amount_cents, currency, substr(date, 1, 10))
  WHERE vs IS NOT NULL;

UPDATE schema_meta SET value = '5' WHERE key = 'version';
