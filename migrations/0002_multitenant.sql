-- banksync Phase 1.5 — multitenant ownership + schema bump to v2
--
-- Adds owner_app_id to bank_accounts so each account has a clear
-- "owner" consumer. Subscriptions stay many-to-many: a bank account
-- can be visible to multiple consumers (shared accounts), but exactly
-- one consumer is the owner (who can mutate metadata, regenerate pairing
-- code, delete the account).
--
-- Existing rows get owner_app_id = NULL initially; admin endpoint
-- enforces NOT NULL on new rows. Backfill manually if any pre-existing
-- accounts need ownership assigned.

ALTER TABLE bank_accounts ADD COLUMN owner_app_id TEXT REFERENCES webhook_consumers(app_id);

CREATE INDEX idx_ba_owner ON bank_accounts(owner_app_id) WHERE owner_app_id IS NOT NULL;

UPDATE schema_meta SET value = '2' WHERE key = 'version';
