-- Durable registry survives account/consumer deletion. Starts locked until cutover.
CREATE TABLE physical_accounts (
 id TEXT PRIMARY KEY, iban TEXT NOT NULL UNIQUE, allocation_enabled INTEGER NOT NULL DEFAULT 0 CHECK(allocation_enabled IN (0,1)),
 next_vs INTEGER NOT NULL DEFAULT 1 CHECK(next_vs BETWEEN 1 AND 10000000000)
);
CREATE TABLE account_aliases (bank_account_id INTEGER PRIMARY KEY, physical_account_id TEXT NOT NULL REFERENCES physical_accounts(id));
CREATE TABLE payment_reference_grants (physical_account_id TEXT NOT NULL REFERENCES physical_accounts(id),app_id TEXT NOT NULL, PRIMARY KEY(physical_account_id,app_id));
CREATE TABLE payment_references (
 reservation_id TEXT PRIMARY KEY,physical_account_id TEXT NOT NULL REFERENCES physical_accounts(id),app_id TEXT NOT NULL,source_ref TEXT NOT NULL,
 normalized_vs TEXT NOT NULL CHECK(length(normalized_vs) BETWEEN 1 AND 10 AND normalized_vs NOT GLOB '*[^0-9]*'),payload_hash TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT (datetime('now')),
 UNIQUE(physical_account_id,normalized_vs),UNIQUE(physical_account_id,app_id,source_ref)
);
CREATE TABLE payment_reference_conflicts (id TEXT PRIMARY KEY,physical_account_id TEXT NOT NULL REFERENCES physical_accounts(id),normalized_vs TEXT NOT NULL,app_id TEXT NOT NULL,source_ref TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TRIGGER reference_identity_immutable BEFORE UPDATE OF account_number ON bank_accounts WHEN EXISTS(SELECT 1 FROM account_aliases WHERE bank_account_id=OLD.id) AND NEW.account_number<>OLD.account_number BEGIN SELECT RAISE(ABORT,'account_identity_immutable'); END;
CREATE TRIGGER reference_no_delete BEFORE DELETE ON payment_references BEGIN SELECT RAISE(ABORT,'reference_permanent'); END;
CREATE TRIGGER reference_no_update BEFORE UPDATE ON payment_references BEGIN SELECT RAISE(ABORT,'reference_immutable'); END;
UPDATE schema_meta SET value='12' WHERE key='version';
