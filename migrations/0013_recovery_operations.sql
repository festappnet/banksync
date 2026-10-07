-- Expand recovery storage before enabling the new writers. Existing facts and
-- immutable delivery payloads are deliberately untouched.
CREATE INDEX IF NOT EXISTS idx_bank_recovery_open
ON bank_recovery_batches(bank_account_id, created_at, id)
WHERE state <> 'completed';
CREATE INDEX idx_bank_recovery_completed ON bank_recovery_batches(completed_at, id)
WHERE state = 'completed';

ALTER TABLE bank_accounts ADD COLUMN api_credential_generation INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_bank_accounts_api_credential ON bank_accounts(api_token_hash,id) WHERE api_token_cipher IS NOT NULL;
ALTER TABLE bank_recovery_batches ADD COLUMN poll_kind TEXT NOT NULL DEFAULT 'periods' CHECK(poll_kind IN ('periods','last'));
ALTER TABLE bank_recovery_batches ADD COLUMN credential_hash TEXT;
ALTER TABLE bank_recovery_batches ADD COLUMN credential_generation TEXT;
ALTER TABLE bank_recovery_batches ADD COLUMN cursor_before TEXT;
ALTER TABLE bank_recovery_batches ADD COLUMN completion_token TEXT;
ALTER TABLE bank_recovery_batches ADD COLUMN recovery_stage TEXT NOT NULL DEFAULT 'ready';
CREATE INDEX idx_fio_recovery_open ON bank_recovery_batches(credential_hash, created_at, id)
WHERE state <> 'completed';
CREATE TABLE fio_poll_cursors (
  credential_hash TEXT PRIMARY KEY,
  receiving_account TEXT NOT NULL,
  generation TEXT NOT NULL,
  last_committed_movement_id TEXT,
  last_batch_ids TEXT NOT NULL DEFAULT '[]',
  last_reported_movement_id TEXT,
  bootstrap_from_date TEXT NOT NULL,
  initialized INTEGER NOT NULL DEFAULT 0 CHECK(initialized IN (0,1)),
  last_success_at TEXT
);

ALTER TABLE authenticated_email_spool RENAME TO authenticated_email_spool_previous;
CREATE TABLE authenticated_email_spool (
  id TEXT PRIMARY KEY,
  bank_account_id INTEGER REFERENCES bank_accounts(id),
  message_key TEXT NOT NULL,
  body_sha256 TEXT NOT NULL,
  cipher TEXT,
  key_version INTEGER,
  r2_key TEXT,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','completed','quarantined')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_attempt_at TEXT,
  last_error TEXT,
  claim_token TEXT,
  claim_until TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  CHECK(state='completed' OR (cipher IS NOT NULL AND key_version IS NOT NULL))
);
INSERT INTO authenticated_email_spool(id,bank_account_id,message_key,body_sha256,cipher,key_version,state,attempts,created_at,completed_at)
SELECT id,bank_account_id,id,body_sha256,cipher,key_version,state,attempts,created_at,completed_at
FROM authenticated_email_spool_previous;
DROP TABLE authenticated_email_spool_previous;
CREATE INDEX idx_email_spool_message ON authenticated_email_spool(message_key);
CREATE INDEX idx_email_spool_r2 ON authenticated_email_spool(r2_key) WHERE r2_key IS NOT NULL;
CREATE INDEX idx_email_spool_due ON authenticated_email_spool(next_attempt_at, created_at, id) WHERE state='pending';
CREATE INDEX idx_email_spool_completed ON authenticated_email_spool(completed_at,id) WHERE state='completed';
UPDATE schema_meta SET value='13' WHERE key='version';
