import type { D1Database } from '@cloudflare/workers-types';
import type { ApiFetchAccount, BankAccount, InsertResult, Transaction, WebhookConsumer, WebhookSubscription } from './types';
import { log } from './logger';
import { resolveVariableSymbol } from './referenceCandidates';

// ---- schema version guard ----

// Compatibility RANGE covering the current rollout: the previous stable schema
// (8) and the contract-cleanup schema (9). Two adjacent versions so neither
// deploy order (code-before-migration or migration-before-code) causes a global
// 503. Older expand versions (6, 7) are gone from every environment.
const SUPPORTED_SCHEMA_VERSIONS = ['8', '9'] as const;
type SupportedSchemaVersion = (typeof SUPPORTED_SCHEMA_VERSIONS)[number];

const _checkedDbs = new Set<D1Database>();

export function resetSchemaCheckCache(): void {
  _checkedDbs.clear();
}

export async function assertSchemaVersion(db: D1Database): Promise<void> {
  if (_checkedDbs.has(db)) return;
  const row = await db.prepare(`SELECT value FROM schema_meta WHERE key = 'version'`).first<{ value: string }>();
  if (!row || !SUPPORTED_SCHEMA_VERSIONS.includes(row.value as SupportedSchemaVersion)) {
    throw new Error(`schema_version_mismatch: got ${row?.value ?? 'null'}, expected one of ${SUPPORTED_SCHEMA_VERSIONS.join(', ')}`);
  }
  _checkedDbs.add(db);
}

// ---- bank accounts ----

type BankAccountRow = Omit<BankAccount, 'api_token_set' | 'api_fetch_enabled' | 'api_backfill_done'> & {
  api_token_set: number;
  api_fetch_enabled: number;
  api_backfill_done: number;
};

type ApiFetchAccountRow = BankAccountRow & {
  api_token_cipher: string;
  api_token_key_ver: number;
};

const BANK_ACCOUNT_PUBLIC_COLS = `
  id, account_number, account_type, ingest_mode, pairing_code, label, owner_app_id, cf_rule_id,
  (api_token_cipher IS NOT NULL) AS api_token_set,
  api_token_prefix, api_fetch_enabled, api_last_fetch_at, api_last_success_at, api_last_error, api_backfill_done,
  created_at
`;

function mapBankAccount(row: BankAccountRow): BankAccount {
  return {
    ...row,
    api_token_set: Boolean(row.api_token_set),
    api_fetch_enabled: Boolean(row.api_fetch_enabled),
    api_backfill_done: Boolean(row.api_backfill_done),
  };
}

function mapApiFetchAccount(row: ApiFetchAccountRow): ApiFetchAccount {
  return {
    ...mapBankAccount(row),
    api_token_cipher: row.api_token_cipher,
    api_token_key_ver: row.api_token_key_ver,
  };
}

const SQL_FIND_BANK_ACCOUNT_BY_PAIRING_CODE = `SELECT ${BANK_ACCOUNT_PUBLIC_COLS} FROM bank_accounts WHERE pairing_code = ?`;

export async function findBankAccountByPairingCode(db: D1Database, pairingCode: string): Promise<BankAccount | null> {
  const row = await db.prepare(SQL_FIND_BANK_ACCOUNT_BY_PAIRING_CODE).bind(pairingCode).first<BankAccountRow>();
  return row ? mapBankAccount(row) : null;
}

const SQL_PAIRING_EXISTS = `SELECT 1 FROM bank_accounts WHERE pairing_code = ? LIMIT 1`;

/**
 * Returns true if the pairing_code is already used in bank_accounts.
 * Used by the pairing-collision-retry loop in admin POST /bank-accounts and POST /:id/regenerate-pairing.
 */
export async function pairingCodeExists(db: D1Database, pairingCode: string): Promise<boolean> {
  const r = await db.prepare(SQL_PAIRING_EXISTS).bind(pairingCode).first();
  return r !== null;
}

const SQL_FIND_BANK_ACCOUNT_BY_ID = `SELECT ${BANK_ACCOUNT_PUBLIC_COLS} FROM bank_accounts WHERE id = ?`;

export async function findBankAccountById(db: D1Database, id: number): Promise<BankAccount | null> {
  const row = await db.prepare(SQL_FIND_BANK_ACCOUNT_BY_ID).bind(id).first<BankAccountRow>();
  return row ? mapBankAccount(row) : null;
}

const SQL_CREATE_BANK_ACCOUNT = `
INSERT INTO bank_accounts (
  account_number, account_type, ingest_mode, pairing_code, label, owner_app_id, cf_rule_id,
  api_token_cipher, api_token_key_ver, api_token_prefix, api_fetch_enabled
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
RETURNING ${BANK_ACCOUNT_PUBLIC_COLS}
`;

export async function createBankAccount(db: D1Database, args: {
  account_number: string;
  account_type?: 'FIO' | 'AIRBANK';
  ingest_mode?: 'email' | 'api' | 'both';
  pairing_code: string;
  label?: string;
  /** Owner consumer app_id. Required by admin API; nullable at DB level for migration backfill of pre-Phase-1.5 rows. */
  owner_app_id?: string;
  /** CF Email Routing rule id. Null when CF auto-sync is disabled (CF_API_TOKEN unset). */
  cf_rule_id?: string | null;
  api_token_cipher?: string | null;
  api_token_key_ver?: number | null;
  api_token_prefix?: string | null;
  api_fetch_enabled?: boolean;
}): Promise<BankAccount> {
  const row = await db
    .prepare(SQL_CREATE_BANK_ACCOUNT)
    .bind(
      args.account_number,
      args.account_type ?? 'FIO',
      args.ingest_mode ?? 'email',
      args.pairing_code,
      args.label ?? null,
      args.owner_app_id ?? null,
      args.cf_rule_id ?? null,
      args.api_token_cipher ?? null,
      args.api_token_key_ver ?? null,
      args.api_token_prefix ?? null,
      args.api_fetch_enabled ? 1 : 0,
    )
    .first<BankAccountRow>();
  if (!row) throw new Error('createBankAccount: no row returned');
  return mapBankAccount(row);
}

const SQL_LIST_BANK_ACCOUNTS = `SELECT ${BANK_ACCOUNT_PUBLIC_COLS} FROM bank_accounts ORDER BY id`;
const SQL_LIST_BANK_ACCOUNTS_BY_OWNER = `SELECT ${BANK_ACCOUNT_PUBLIC_COLS} FROM bank_accounts WHERE owner_app_id = ? ORDER BY id`;

export async function listBankAccounts(db: D1Database, ownerAppId?: string): Promise<BankAccount[]> {
  if (ownerAppId !== undefined) {
    const r = await db.prepare(SQL_LIST_BANK_ACCOUNTS_BY_OWNER).bind(ownerAppId).all<BankAccountRow>();
    return r.results.map(mapBankAccount);
  }
  const result = await db.prepare(SQL_LIST_BANK_ACCOUNTS).all<BankAccountRow>();
  return result.results.map(mapBankAccount);
}

// PATCH: mutable fields are label, account_type, account_number, and ingest_mode. owner_app_id and pairing_code are mutated through dedicated endpoints.
const SQL_UPDATE_BANK_ACCOUNT = `
UPDATE bank_accounts
SET account_number = COALESCE(?, account_number),
    account_type = COALESCE(?, account_type),
    label = COALESCE(?, label),
    ingest_mode = COALESCE(?, ingest_mode)
WHERE id = ?
RETURNING ${BANK_ACCOUNT_PUBLIC_COLS}
`;

export async function updateBankAccount(db: D1Database, id: number, patch: {
  account_number?: string | undefined;
  account_type?: 'FIO' | 'AIRBANK' | undefined;
  label?: string | null | undefined;
  ingest_mode?: 'email' | 'api' | 'both' | undefined;
}): Promise<BankAccount | null> {
  const row = await db
    .prepare(SQL_UPDATE_BANK_ACCOUNT)
    .bind(patch.account_number ?? null, patch.account_type ?? null, patch.label === undefined ? null : patch.label, patch.ingest_mode ?? null, id)
    .first<BankAccountRow>();
  return row ? mapBankAccount(row) : null;
}

const SQL_UPDATE_BANK_ACCOUNT_OWNER = `
UPDATE bank_accounts
SET owner_app_id = ?
WHERE id = ?
RETURNING ${BANK_ACCOUNT_PUBLIC_COLS}
`;

export async function updateBankAccountOwner(db: D1Database, id: number, ownerAppId: string): Promise<BankAccount | null> {
  const row = await db.prepare(SQL_UPDATE_BANK_ACCOUNT_OWNER).bind(ownerAppId, id).first<BankAccountRow>();
  return row ? mapBankAccount(row) : null;
}

const SQL_REGENERATE_PAIRING = `UPDATE bank_accounts SET pairing_code = ?, cf_rule_id = ? WHERE id = ? RETURNING ${BANK_ACCOUNT_PUBLIC_COLS}`;

export async function regenerateBankAccountPairing(
  db: D1Database,
  id: number,
  newPairing: string,
  newCfRuleId: string | null,
): Promise<BankAccount | null> {
  const row = await db.prepare(SQL_REGENERATE_PAIRING).bind(newPairing, newCfRuleId, id).first<BankAccountRow>();
  return row ? mapBankAccount(row) : null;
}

const SQL_SET_BANK_ACCOUNT_API_TOKEN = `
UPDATE bank_accounts
SET api_token_cipher = ?,
    api_token_key_ver = ?,
    api_token_prefix = ?,
    api_fetch_enabled = ?,
    ingest_mode = COALESCE(?, ingest_mode),
    api_last_error = NULL
WHERE id = ?
RETURNING ${BANK_ACCOUNT_PUBLIC_COLS}
`;

export async function setBankAccountApiToken(db: D1Database, id: number, args: {
  token_cipher: string;
  token_key_ver: number;
  token_prefix: string;
  fetch_enabled: boolean;
  ingest_mode?: 'email' | 'api' | 'both';
}): Promise<BankAccount | null> {
  const row = await db
    .prepare(SQL_SET_BANK_ACCOUNT_API_TOKEN)
    .bind(args.token_cipher, args.token_key_ver, args.token_prefix, args.fetch_enabled ? 1 : 0, args.ingest_mode ?? null, id)
    .first<BankAccountRow>();
  return row ? mapBankAccount(row) : null;
}

const SQL_SET_BANK_ACCOUNT_API_FETCH_ENABLED = `
UPDATE bank_accounts
SET api_fetch_enabled = ?,
    ingest_mode = COALESCE(?, ingest_mode)
WHERE id = ?
RETURNING ${BANK_ACCOUNT_PUBLIC_COLS}
`;

export async function setBankAccountApiFetchEnabled(db: D1Database, id: number, args: {
  fetch_enabled: boolean;
  ingest_mode?: 'email' | 'api' | 'both';
}): Promise<BankAccount | null> {
  const row = await db
    .prepare(SQL_SET_BANK_ACCOUNT_API_FETCH_ENABLED)
    .bind(args.fetch_enabled ? 1 : 0, args.ingest_mode ?? null, id)
    .first<BankAccountRow>();
  return row ? mapBankAccount(row) : null;
}

const SQL_CLEAR_BANK_ACCOUNT_API_TOKEN = `
UPDATE bank_accounts
SET api_token_cipher = NULL,
    api_token_key_ver = NULL,
    api_token_prefix = NULL,
    api_fetch_enabled = 0,
    ingest_mode = 'email',
    api_last_error = NULL
WHERE id = ?
RETURNING ${BANK_ACCOUNT_PUBLIC_COLS}
`;

export async function clearBankAccountApiToken(db: D1Database, id: number): Promise<BankAccount | null> {
  const row = await db.prepare(SQL_CLEAR_BANK_ACCOUNT_API_TOKEN).bind(id).first<BankAccountRow>();
  return row ? mapBankAccount(row) : null;
}

const SQL_FIND_BANK_ACCOUNT_API_MATERIALS = `
SELECT ${BANK_ACCOUNT_PUBLIC_COLS}, api_token_cipher, api_token_key_ver
FROM bank_accounts
WHERE id = ? AND api_token_cipher IS NOT NULL AND api_token_key_ver IS NOT NULL
`;

export async function findBankAccountApiMaterials(db: D1Database, id: number): Promise<ApiFetchAccount | null> {
  const row = await db.prepare(SQL_FIND_BANK_ACCOUNT_API_MATERIALS).bind(id).first<ApiFetchAccountRow>();
  return row ? mapApiFetchAccount(row) : null;
}

const SQL_LIST_DUE_API_ACCOUNTS = `
SELECT ${BANK_ACCOUNT_PUBLIC_COLS}, api_token_cipher, api_token_key_ver
FROM bank_accounts
WHERE api_fetch_enabled = 1
  AND api_token_cipher IS NOT NULL
  AND api_token_key_ver IS NOT NULL
  AND ingest_mode IN ('api', 'both')
  AND (api_last_fetch_at IS NULL OR (julianday('now') - julianday(api_last_fetch_at)) * 86400 >= ?)
ORDER BY COALESCE(api_last_fetch_at, '1970-01-01T00:00:00.000Z'), id
LIMIT ?
`;

export async function listDueApiFetchAccounts(db: D1Database, minIntervalS: number, limit = 20): Promise<ApiFetchAccount[]> {
  const result = await db.prepare(SQL_LIST_DUE_API_ACCOUNTS).bind(minIntervalS, limit).all<ApiFetchAccountRow>();
  return result.results.map(mapApiFetchAccount);
}

export async function tryAcquireApiSyncLease(db: D1Database, leaseSeconds: number): Promise<boolean> {
  await db
    .prepare(`INSERT OR IGNORE INTO schema_meta (key, value) VALUES ('api_sync_lease_until', '1970-01-01 00:00:00')`)
    .run();
  const result = await db
    .prepare(`
      UPDATE schema_meta
      SET value = datetime('now', ?)
      WHERE key = 'api_sync_lease_until'
        AND datetime(value) <= datetime('now')
    `)
    .bind(`+${Math.max(1, Math.floor(leaseSeconds))} seconds`)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

const SQL_IS_BANK_ACCOUNT_API_DUE = `
SELECT 1
FROM bank_accounts
WHERE id = ?
  AND (api_last_fetch_at IS NULL OR (julianday('now') - julianday(api_last_fetch_at)) * 86400 >= ?)
LIMIT 1
`;

export async function isBankAccountApiFetchDue(db: D1Database, id: number, minIntervalS: number): Promise<boolean> {
  const row = await db.prepare(SQL_IS_BANK_ACCOUNT_API_DUE).bind(id, minIntervalS).first();
  return row !== null;
}

export async function markBankAccountApiFetchStarted(db: D1Database, id: number): Promise<void> {
  await db.prepare(`UPDATE bank_accounts SET api_last_fetch_at = datetime('now') WHERE id = ?`).bind(id).run();
}

export async function markBankAccountApiPointerSet(db: D1Database, id: number): Promise<void> {
  await db
    .prepare(`
      UPDATE bank_accounts
      SET api_last_fetch_at = datetime('now'),
          api_last_success_at = datetime('now'),
          api_last_error = NULL,
          api_backfill_done = 0
      WHERE id = ?
    `)
    .bind(id)
    .run();
}

export async function markBankAccountApiFetchSuccess(db: D1Database, id: number, args: {
  backfill_done: boolean;
}): Promise<void> {
  await db
    .prepare(`
      UPDATE bank_accounts
      SET api_last_fetch_at = datetime('now'),
          api_last_success_at = datetime('now'),
          api_last_error = NULL,
          api_backfill_done = ?
      WHERE id = ?
    `)
    .bind(args.backfill_done ? 1 : 0, id)
    .run();
}

export async function markBankAccountApiFetchFailure(db: D1Database, id: number, error: string): Promise<void> {
  await db
    .prepare(`UPDATE bank_accounts SET api_last_fetch_at = datetime('now'), api_last_error = ? WHERE id = ?`)
    .bind(error.slice(0, 500), id)
    .run();
}

// Cascade subscriptions; transactions stay (audit trail). Returns true if a row was deleted.
export async function deleteBankAccount(db: D1Database, id: number): Promise<boolean> {
  await db.prepare(`DELETE FROM webhook_subscriptions WHERE bank_account_id = ?`).bind(id).run();
  const r = await db.prepare(`DELETE FROM bank_accounts WHERE id = ?`).bind(id).run();
  return r.meta.changes > 0;
}

// ---- consumers ----

const SQL_CREATE_CONSUMER = `INSERT INTO webhook_consumers (app_id, callback_url, secret_cipher, secret_hash, secret_prefix) VALUES (?, ?, ?, ?, ?) RETURNING id, app_id, callback_url, secret_cipher, secret_hash, secret_prefix, prev_secret_cipher, prev_expires_at, admin_key_hash, admin_key_prefix, created_at`;

export async function createConsumer(db: D1Database, args: {
  app_id: string;
  callback_url: string;
  secret_cipher: string;
  secret_hash: string;
  secret_prefix: string;
}): Promise<WebhookConsumer> {
  const row = await db
    .prepare(SQL_CREATE_CONSUMER)
    .bind(args.app_id, args.callback_url, args.secret_cipher, args.secret_hash, args.secret_prefix)
    .first<WebhookConsumer>();
  if (!row) throw new Error('createConsumer: no row returned');
  return row;
}

const SQL_FIND_CONSUMER_BY_APP_ID = `SELECT id, app_id, callback_url, secret_cipher, secret_hash, secret_prefix, prev_secret_cipher, prev_expires_at, admin_key_hash, admin_key_prefix, created_at FROM webhook_consumers WHERE app_id = ?`;

const SQL_FIND_CONSUMER_BY_ADMIN_KEY_PREFIX = `SELECT id, app_id, callback_url, secret_cipher, secret_hash, secret_prefix, prev_secret_cipher, prev_expires_at, admin_key_hash, admin_key_prefix, created_at FROM webhook_consumers WHERE admin_key_prefix = ?`;

export async function findConsumerByAdminKeyPrefix(db: D1Database, prefix: string): Promise<WebhookConsumer | null> {
  const row = await db.prepare(SQL_FIND_CONSUMER_BY_ADMIN_KEY_PREFIX).bind(prefix).first<WebhookConsumer>();
  return row ?? null;
}

const SQL_SET_CONSUMER_ADMIN_KEY = `UPDATE webhook_consumers SET admin_key_hash = ?, admin_key_prefix = ? WHERE app_id = ?`;

export async function setConsumerAdminKey(db: D1Database, appId: string, hash: string, prefix: string): Promise<void> {
  await db.prepare(SQL_SET_CONSUMER_ADMIN_KEY).bind(hash, prefix, appId).run();
}

export async function findConsumerByAppId(db: D1Database, appId: string): Promise<WebhookConsumer | null> {
  const row = await db.prepare(SQL_FIND_CONSUMER_BY_APP_ID).bind(appId).first<WebhookConsumer>();
  return row ?? null;
}

// ---- consumer secret rotation ----

export interface RotatedSecretCiphers {
  newCipher: string;
  newHash: string;
  newPrefix: string;
  prevExpiresAt: string;
}

const SQL_ROTATE_SECRET = `UPDATE webhook_consumers SET prev_secret_cipher = secret_cipher, prev_expires_at = ?, secret_cipher = ?, secret_hash = ?, secret_prefix = ? WHERE app_id = ?`;

export async function rotateConsumerSecret(db: D1Database, appId: string, rotated: RotatedSecretCiphers): Promise<void> {
  const result = await db
    .prepare(SQL_ROTATE_SECRET)
    .bind(rotated.prevExpiresAt, rotated.newCipher, rotated.newHash, rotated.newPrefix, appId)
    .run();
  if (result.meta.changes === 0) throw new Error(`rotateConsumerSecret: app_id not found: ${appId}`);
}

const SQL_UPDATE_CONSUMER_CALLBACK = `UPDATE webhook_consumers SET callback_url = ? WHERE app_id = ? RETURNING id, app_id, callback_url, secret_cipher, secret_hash, secret_prefix, prev_secret_cipher, prev_expires_at, admin_key_hash, admin_key_prefix, created_at`;

export async function updateConsumer(db: D1Database, appId: string, input: { callback_url: string }): Promise<WebhookConsumer | null> {
  const row = await db.prepare(SQL_UPDATE_CONSUMER_CALLBACK).bind(input.callback_url, appId).first<WebhookConsumer>();
  return row ?? null;
}

const SQL_DELETE_CONSUMER = `DELETE FROM webhook_consumers WHERE app_id = ?`;

export async function deleteConsumer(db: D1Database, appId: string): Promise<void> {
  await db.prepare(SQL_DELETE_CONSUMER).bind(appId).run();
}

// ---- subscriptions ----

// Active = not soft-deleted. The cap and the active view both exclude tombstones.
const SQL_COUNT_SUBSCRIPTIONS = `SELECT COUNT(*) as cnt FROM webhook_subscriptions WHERE bank_account_id = ? AND deleted_at IS NULL`;
// Re-subscribe reactivates a tombstoned row (a fresh interval) rather than
// colliding on UNIQUE(bank_account_id, consumer_app_id).
const SQL_CREATE_SUBSCRIPTION = `
  INSERT INTO webhook_subscriptions (bank_account_id, consumer_app_id) VALUES (?, ?)
  ON CONFLICT(bank_account_id, consumer_app_id) DO UPDATE SET deleted_at = NULL, created_at = datetime('now')
    WHERE webhook_subscriptions.deleted_at IS NOT NULL
  RETURNING id, bank_account_id, consumer_app_id, created_at`;
const SQL_FIND_ACTIVE_SUBSCRIPTION = `SELECT id, bank_account_id, consumer_app_id, created_at FROM webhook_subscriptions WHERE bank_account_id = ? AND consumer_app_id = ? AND deleted_at IS NULL`;

export async function createSubscription(db: D1Database, args: {
  app_id: string;
  bank_account_id: number;
}): Promise<WebhookSubscription> {
  const countRow = await db.prepare(SQL_COUNT_SUBSCRIPTIONS).bind(args.bank_account_id).first<{ cnt: number }>();
  if ((countRow?.cnt ?? 0) >= 20) throw new Error('subscription_cap_reached:20');
  const row = await db
    .prepare(SQL_CREATE_SUBSCRIPTION)
    .bind(args.bank_account_id, args.app_id)
    .first<WebhookSubscription>();
  if (row) return row;
  // Empty RETURNING means the conflict row was already ACTIVE (the DO UPDATE
  // WHERE deleted_at IS NOT NULL did not fire) — a genuine duplicate.
  const existing = await db.prepare(SQL_FIND_ACTIVE_SUBSCRIPTION).bind(args.bank_account_id, args.app_id).first<WebhookSubscription>();
  if (existing) throw new Error('subscription_already_exists');
  throw new Error('createSubscription: no row returned');
}

// Soft-delete: the tombstone preserves the delivery intent of transactions
// ingested during the active window. A hard DELETE would drop that intent.
const SQL_DELETE_SUBSCRIPTION = `UPDATE webhook_subscriptions SET deleted_at = datetime('now') WHERE id = ? AND deleted_at IS NULL`;

export async function deleteSubscription(db: D1Database, id: number): Promise<void> {
  await db.prepare(SQL_DELETE_SUBSCRIPTION).bind(id).run();
}

const SQL_FIND_ACTIVE_SUBSCRIPTIONS = `SELECT consumer_app_id FROM webhook_subscriptions WHERE bank_account_id = ? AND deleted_at IS NULL LIMIT 21`;

export async function findActiveSubscriptions(db: D1Database, bankAccountId: number): Promise<Array<{ consumer_app_id: string }>> {
  const result = await db.prepare(SQL_FIND_ACTIVE_SUBSCRIPTIONS).bind(bankAccountId).all<{ consumer_app_id: string }>();
  if (result.results.length === 21) {
    log('subscription_cap_warning', { bank_account_id: bankAccountId, count: '21+' });
    return result.results.slice(0, 20);
  }
  return result.results;
}

// ---- transactions: insert with idempotent enqueue gate ----

const SQL_INSERT_TRANSACTION = `
INSERT OR IGNORE INTO transactions (
  bank_account_id, amount_cents, currency, counter_account, bank_code, bank_name,
  vs, ks, ss, message, sender_name, user_identification, transaction_type,
  performed_by, comment, command_id, source, date, date_offset_min,
  transaction_id, external_id
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

const SQL_SELECT_TRANSACTION_BY_ID = `SELECT id, bank_account_id, amount_cents, currency, counter_account, bank_code, bank_name, vs, ks, ss, message, sender_name, user_identification, transaction_type, performed_by, comment, command_id, source, date, date_offset_min, transaction_id, external_id FROM transactions WHERE id = ?`;

const SQL_FIND_DUPLICATE_EXT = `SELECT id FROM transactions WHERE external_id = ? AND external_id IS NOT NULL LIMIT 1`;
const SQL_FIND_DUPLICATE_FIO = `SELECT id FROM transactions WHERE bank_account_id = ? AND transaction_id = ? AND transaction_id IS NOT NULL LIMIT 1`;
const SQL_FIND_DUPLICATE_FUZZY = `
SELECT id
FROM transactions
WHERE bank_account_id = ?
  AND vs = ?
  AND amount_cents = ?
  AND currency = ?
  AND substr(date, 1, 10) BETWEEN date(?, '-3 days') AND date(?, '+3 days')
LIMIT 1
`;

function fuzzyDateDay(date: string): string | null {
  return /^\d{4}-\d{2}-\d{2}/.test(date) ? date.slice(0, 10) : null;
}

async function findFuzzyDuplicate(db: D1Database, bankAccountId: number, p: Omit<Transaction, 'id' | 'bank_account_id'>): Promise<boolean> {
  if (!p.vs) return false;
  const dateDay = fuzzyDateDay(p.date);
  if (!dateDay) return false;
  const hit = await db
    .prepare(SQL_FIND_DUPLICATE_FUZZY)
    .bind(bankAccountId, p.vs, p.amount_cents, p.currency, dateDay, dateDay)
    .first<{ id: number }>();
  return hit !== null;
}

export async function insertTransaction(db: D1Database, args: {
  bank_account_id: number;
  payload: Omit<Transaction, 'id' | 'bank_account_id'>;
}): Promise<InsertResult> {
  const p = {
    ...args.payload,
    vs: resolveVariableSymbol(args.payload),
  };

  if (p.transaction_id != null) {
    const hit = await db.prepare(SQL_FIND_DUPLICATE_FIO).bind(args.bank_account_id, p.transaction_id).first<{ id: number }>();
    if (hit) return { status: 'skipped', reason: 'duplicate_transaction_id' };
  }
  if (p.external_id != null) {
    const hit = await db.prepare(SQL_FIND_DUPLICATE_EXT).bind(p.external_id).first<{ id: number }>();
    if (hit) return { status: 'skipped', reason: 'duplicate_external_id' };
  }
  if (await findFuzzyDuplicate(db, args.bank_account_id, p)) {
    return { status: 'skipped', reason: 'fuzzy_duplicate' };
  }

  const result = await db
    .prepare(SQL_INSERT_TRANSACTION)
    .bind(
      args.bank_account_id,
      p.amount_cents, p.currency, p.counter_account ?? null, p.bank_code ?? null, p.bank_name ?? null,
      p.vs ?? null, p.ks ?? null, p.ss ?? null, p.message ?? null, p.sender_name ?? null,
      p.user_identification ?? null, p.transaction_type ?? null, p.performed_by ?? null,
      p.comment ?? null, p.command_id ?? null,
      p.source, p.date, p.date_offset_min ?? null,
      p.transaction_id ?? null, p.external_id ?? null,
    )
    .run();

  if (result.meta.changes === 0) {
    // Determine which constraint was hit. The same-day fuzzy unique index is
    // a race guard for parallel email/API inserts between the preselect and insert.
    if (p.transaction_id != null) {
      const hit = await db.prepare(SQL_FIND_DUPLICATE_FIO).bind(args.bank_account_id, p.transaction_id).first<{ id: number }>();
      if (hit) return { status: 'skipped', reason: 'duplicate_transaction_id' };
    }
    if (p.external_id != null) {
      const hit = await db.prepare(SQL_FIND_DUPLICATE_EXT).bind(p.external_id).first<{ id: number }>();
      if (hit) return { status: 'skipped', reason: 'duplicate_external_id' };
    }
    if (await findFuzzyDuplicate(db, args.bank_account_id, p)) {
      return { status: 'skipped', reason: 'fuzzy_duplicate' };
    }
    // Fallback — changes=0 without a known unique hit should not happen with the schema.
    return { status: 'skipped', reason: 'fuzzy_duplicate' };
  }

  const rowId = result.meta.last_row_id;
  const row = await db.prepare(SQL_SELECT_TRANSACTION_BY_ID).bind(rowId).first<Transaction>();
  if (!row) throw new Error('insertTransaction: row vanished after insert');
  return { status: 'inserted', transaction: row };
}

// ---- parse_log ----

const SQL_INSERT_PARSE_LOG = `INSERT INTO parse_log (bank_account_id, external_id, raw_data, error_message) VALUES (?, ?, ?, ?)`;

export async function insertParseLog(db: D1Database, args: {
  bank_account_id?: number | null;
  external_id?: string | null;
  raw_data?: string | null;
  error_message: string;
}): Promise<void> {
  try {
    await db
      .prepare(SQL_INSERT_PARSE_LOG)
      .bind(args.bank_account_id ?? null, args.external_id ?? null, args.raw_data ?? null, args.error_message)
      .run();
  } catch (err) {
    console.error(JSON.stringify({ ts: new Date().toISOString(), event: 'parse_log_write_failed', error: String(err) }));
  }
}

// ---- consumer secret retrieval (with rotation grace) ----

export interface ResolvedConsumerSecret {
  callback_url: string;
  primary_cipher: string;
  prev_cipher_in_grace: string | null;
}

const SQL_GET_CONSUMER_SECRET = `SELECT callback_url, secret_cipher, prev_secret_cipher, prev_expires_at FROM webhook_consumers WHERE app_id = ?`;

export async function getConsumerSecretMaterials(db: D1Database, appId: string): Promise<ResolvedConsumerSecret | null> {
  const row = await db.prepare(SQL_GET_CONSUMER_SECRET).bind(appId).first<{
    callback_url: string;
    secret_cipher: string;
    prev_secret_cipher: string | null;
    prev_expires_at: string | null;
  }>();
  if (!row) return null;
  const inGrace = row.prev_expires_at != null && row.prev_secret_cipher != null
    ? row.prev_expires_at > new Date().toISOString()
    : false;
  return {
    callback_url: row.callback_url,
    primary_cipher: row.secret_cipher,
    prev_cipher_in_grace: inGrace ? row.prev_secret_cipher : null,
  };
}

// ---- webhook log ----

const SQL_INSERT_WEBHOOK_LOG = `INSERT INTO webhook_log (delivery_id, consumer_app_id, bank_account_id, transaction_id, attempt, http_status, error_message) VALUES (?, ?, ?, ?, ?, ?, ?)`;

export async function insertWebhookLogEntry(db: D1Database, args: {
  delivery_id: string;
  consumer_app_id: string;
  bank_account_id?: number | null;
  transaction_id?: number | null;
  attempt: number;
  http_status?: number | null;
  error_message?: string | null;
}): Promise<void> {
  await db
    .prepare(SQL_INSERT_WEBHOOK_LOG)
    .bind(
      args.delivery_id, args.consumer_app_id,
      args.bank_account_id ?? null, args.transaction_id ?? null,
      args.attempt, args.http_status ?? null, args.error_message ?? null,
    )
    .run();
}

// ---- event_log ----

const SQL_WRITE_EVENT = `INSERT INTO event_log (event_type, bank_account_id, detail) VALUES (?, ?, ?)`;

export async function writeEvent(db: D1Database, args: {
  event_type: string;
  bank_account_id?: number | null;
  detail?: Record<string, unknown> | null;
}): Promise<void> {
  await db
    .prepare(SQL_WRITE_EVENT)
    .bind(args.event_type, args.bank_account_id ?? null, args.detail != null ? JSON.stringify(args.detail) : null)
    .run();
}

// ---- consumer list ----

const SQL_LIST_CONSUMERS = `SELECT id, app_id, callback_url, secret_prefix, admin_key_prefix, created_at FROM webhook_consumers ORDER BY id`;

export async function listConsumers(db: D1Database): Promise<Array<{
  id: number; app_id: string; callback_url: string; secret_prefix: string; created_at: string;
}>> {
  const result = await db.prepare(SQL_LIST_CONSUMERS).all<{
    id: number; app_id: string; callback_url: string; secret_prefix: string; created_at: string;
  }>();
  return result.results;
}

// ---- subscription list ----

const SQL_LIST_SUBSCRIPTIONS_ALL = `SELECT id, bank_account_id, consumer_app_id, created_at FROM webhook_subscriptions ORDER BY id`;
const SQL_LIST_SUBSCRIPTIONS_BY_APP = `SELECT id, bank_account_id, consumer_app_id, created_at FROM webhook_subscriptions WHERE consumer_app_id = ? ORDER BY id`;
const SQL_LIST_SUBSCRIPTIONS_BY_ACCOUNT = `SELECT id, bank_account_id, consumer_app_id, created_at FROM webhook_subscriptions WHERE bank_account_id = ? ORDER BY id`;

export async function listSubscriptions(db: D1Database, filters?: {
  app_id?: string;
  bank_account_id?: number;
}): Promise<Array<{ id: number; bank_account_id: number; consumer_app_id: string; created_at: string }>> {
  type Row = { id: number; bank_account_id: number; consumer_app_id: string; created_at: string };
  if (filters?.app_id) {
    const r = await db.prepare(SQL_LIST_SUBSCRIPTIONS_BY_APP).bind(filters.app_id).all<Row>();
    return r.results;
  }
  if (filters?.bank_account_id != null) {
    const r = await db.prepare(SQL_LIST_SUBSCRIPTIONS_BY_ACCOUNT).bind(filters.bank_account_id).all<Row>();
    return r.results;
  }
  const r = await db.prepare(SQL_LIST_SUBSCRIPTIONS_ALL).all<Row>();
  return r.results;
}

// ---- transactions list (admin query) ----

const SQL_LIST_TRANSACTIONS = `SELECT id, bank_account_id, amount_cents, currency, vs, source, date, external_id, transaction_id, sender_name, counter_account, bank_code, bank_name, message, created_at FROM transactions WHERE created_at > datetime(?) ORDER BY id LIMIT ?`;

export async function listTransactions(db: D1Database, since: string, limit: number): Promise<Array<{
  id: number; bank_account_id: number; amount_cents: number; currency: string;
  vs: string | null; source: string; date: string; external_id: string | null;
  transaction_id: string | null; sender_name: string | null; counter_account: string | null;
  bank_code: string | null; bank_name: string | null; message: string | null; created_at: string;
}>> {
  type Row = { id: number; bank_account_id: number; amount_cents: number; currency: string; vs: string | null; source: string; date: string; external_id: string | null; transaction_id: string | null; sender_name: string | null; counter_account: string | null; bank_code: string | null; bank_name: string | null; message: string | null; created_at: string };
  const r = await db.prepare(SQL_LIST_TRANSACTIONS).bind(since, limit).all<Row>();
  return r.results;
}

// ---- parse_log list (admin query) ----

const SQL_LIST_PARSE_LOG = `SELECT id, bank_account_id, external_id, error_message, raw_data, created_at FROM parse_log WHERE created_at > datetime(?) ORDER BY id DESC LIMIT ?`;

export async function listParseLog(db: D1Database, since: string, limit: number): Promise<Array<{
  id: number; bank_account_id: number | null; external_id: string | null;
  error_message: string | null; raw_data: string | null; created_at: string;
}>> {
  type Row = { id: number; bank_account_id: number | null; external_id: string | null; error_message: string | null; raw_data: string | null; created_at: string };
  const r = await db.prepare(SQL_LIST_PARSE_LOG).bind(since, limit).all<Row>();
  return r.results;
}

// Unmatched mails: parse_log entries where pairing routing failed (mail reached worker but no bank account matched).
// Includes raw_data so admin can inspect actual sender / subject / body to decide whether to register a new account or block sender.
const SQL_LIST_UNMATCHED_MAILS = `SELECT id, external_id, error_message, raw_data, created_at FROM parse_log WHERE (error_message LIKE 'no_pairing_code:%' OR error_message LIKE 'unknown_pairing_code:%') AND created_at > datetime(?) ORDER BY id DESC LIMIT ?`;

export async function listUnmatchedMails(db: D1Database, since: string, limit: number): Promise<Array<{
  id: number; external_id: string | null; error_message: string | null; raw_data: string | null; created_at: string;
}>> {
  type Row = { id: number; external_id: string | null; error_message: string | null; raw_data: string | null; created_at: string };
  const r = await db.prepare(SQL_LIST_UNMATCHED_MAILS).bind(since, limit).all<Row>();
  return r.results;
}

// ---- webhook_log list (admin query) ----

const SQL_LIST_WEBHOOK_LOG = `SELECT id, delivery_id, consumer_app_id, http_status, error_message, attempt, created_at FROM webhook_log WHERE created_at > datetime(?) ORDER BY id LIMIT ?`;

export async function listWebhookLog(db: D1Database, since: string, limit: number): Promise<Array<{
  id: number; delivery_id: string; consumer_app_id: string; http_status: number | null;
  error_message: string | null; attempt: number; created_at: string;
}>> {
  type Row = { id: number; delivery_id: string; consumer_app_id: string; http_status: number | null; error_message: string | null; attempt: number; created_at: string };
  const r = await db.prepare(SQL_LIST_WEBHOOK_LOG).bind(since, limit).all<Row>();
  return r.results;
}

// ---- health / status queries ----

const SQL_COUNT_BANK_ACCOUNTS = `SELECT COUNT(*) as cnt FROM bank_accounts`;
const SQL_COUNT_CONSUMERS = `SELECT COUNT(*) as cnt FROM webhook_consumers`;
const SQL_LAST_TX_AT = `SELECT MAX(created_at) as ts FROM transactions`;
const SQL_LAST_EMAIL_AT = `SELECT MAX(created_at) as ts FROM event_log WHERE event_type = 'tx_inserted'`;
const SQL_PARSE_ERRORS_24H = `SELECT COUNT(*) as cnt FROM parse_log WHERE created_at > datetime('now','-1 day')`;
const SQL_PARSE_FAILURES_24H = `SELECT COUNT(*) as cnt FROM parse_log WHERE created_at > datetime('now','-1 day') AND error_message NOT LIKE 'not_transaction:%'`;
const SQL_NOT_TRANSACTION_24H = `SELECT COUNT(*) as cnt FROM parse_log WHERE error_message LIKE 'not_transaction:%' AND created_at > datetime('now','-1 day')`;
const SQL_TX_INSERTED_24H = `SELECT COUNT(*) as cnt FROM event_log WHERE event_type = 'tx_inserted' AND created_at > datetime('now','-1 day')`;
const SQL_UNKNOWN_CURRENCY_24H = `SELECT COUNT(*) as cnt FROM parse_log WHERE error_message LIKE 'unknown_currency:%' AND created_at > datetime('now','-1 day')`;
const SQL_OUTGOING_FILTERED_24H = `SELECT COUNT(*) as cnt FROM parse_log WHERE error_message = 'outgoing_filtered' AND created_at > datetime('now','-1 day')`;
const SQL_UNKNOWN_PROVIDER_24H = `SELECT COUNT(*) as cnt FROM parse_log WHERE error_message LIKE 'unknown_provider:%' AND created_at > datetime('now','-1 day')`;
const SQL_UNMATCHED_24H = `SELECT COUNT(*) as cnt FROM parse_log WHERE (error_message LIKE 'no_pairing_code:%' OR error_message LIKE 'unknown_pairing_code:%') AND created_at > datetime('now','-1 day')`;
const SQL_DELIVERY_ACTIVE = `SELECT COUNT(*) as cnt FROM webhook_delivery_jobs WHERE status IN ('pending', 'dispatching', 'queued')`;
const SQL_DELIVERY_STALLED = `SELECT COUNT(*) as cnt FROM webhook_delivery_jobs WHERE status IN ('pending', 'dispatching', 'queued') AND julianday(created_at) <= julianday('now', '-10 minutes')`;
const SQL_DELIVERY_TERMINAL = `SELECT COUNT(*) as cnt FROM webhook_delivery_jobs WHERE status = 'terminal'`;
const SQL_DELIVERY_OLDEST_PENDING = `SELECT MIN(created_at) as ts FROM webhook_delivery_jobs WHERE status IN ('pending', 'dispatching', 'queued')`;
const SQL_PENDING_DELIVERY_ALERTS = `SELECT COUNT(*) as cnt FROM webhook_delivery_alerts WHERE posted_at IS NULL`;
const SQL_PER_ACCOUNT_TX_7D = `SELECT bank_account_id, COUNT(*) as cnt FROM transactions WHERE created_at > datetime('now','-7 days') GROUP BY bank_account_id`;
const SQL_PER_ACCOUNT_PARSE_ERRORS_24H = `SELECT bank_account_id, COUNT(*) as cnt FROM parse_log WHERE bank_account_id IS NOT NULL AND created_at > datetime('now','-1 day') GROUP BY bank_account_id`;
const SQL_PER_ACCOUNT_LAST_EMAIL = `SELECT bank_account_id, MAX(created_at) as ts FROM event_log WHERE event_type = 'tx_inserted' GROUP BY bank_account_id`;
const SQL_API_RATE_LIMITED_24H = `SELECT COUNT(*) as cnt FROM event_log WHERE event_type = 'api_rate_limited' AND created_at > datetime('now','-1 day')`;
const SQL_PER_CONSUMER_WEBHOOK_LAST = `SELECT consumer_app_id, MAX(created_at) as ts FROM webhook_log GROUP BY consumer_app_id`;
const SQL_PER_CONSUMER_WEBHOOKS_24H = `SELECT consumer_app_id, COUNT(*) as cnt FROM webhook_log WHERE created_at > datetime('now','-1 day') GROUP BY consumer_app_id`;
const SQL_PER_CONSUMER_ERRORS_24H = `SELECT consumer_app_id, COUNT(*) as cnt FROM webhook_log WHERE http_status IS NOT NULL AND (http_status < 200 OR http_status >= 300) AND created_at > datetime('now','-1 day') GROUP BY consumer_app_id`;
const SQL_PER_CONSUMER_DELIVERED = `SELECT consumer_app_id, MAX(delivered_at) as ts FROM webhook_delivery_jobs WHERE delivered_at IS NOT NULL GROUP BY consumer_app_id`;

export interface HealthData {
  ok: boolean;
  db: 'ok' | 'error';
  bank_accounts: number;
  consumers: number;
  last_email_at: string | null;
  last_tx_at: string | null;
  parse_errors_24h: number;
}

export async function getHealthData(db: D1Database): Promise<HealthData> {
  const [baCnt, consCnt, lastTx, lastEmail, parseErr] = await Promise.all([
    db.prepare(SQL_COUNT_BANK_ACCOUNTS).first<{ cnt: number }>(),
    db.prepare(SQL_COUNT_CONSUMERS).first<{ cnt: number }>(),
    db.prepare(SQL_LAST_TX_AT).first<{ ts: string | null }>(),
    db.prepare(SQL_LAST_EMAIL_AT).first<{ ts: string | null }>(),
    db.prepare(SQL_PARSE_ERRORS_24H).first<{ cnt: number }>(),
  ]);
  return {
    ok: true,
    db: 'ok',
    bank_accounts: baCnt?.cnt ?? 0,
    consumers: consCnt?.cnt ?? 0,
    last_email_at: lastEmail?.ts ?? null,
    last_tx_at: lastTx?.ts ?? null,
    parse_errors_24h: parseErr?.cnt ?? 0,
  };
}

export interface StatusData {
  service: {
    parse_failures_24h: number;
    parse_failure_rate_24h: number;
    unknown_currency_24h: number;
    outgoing_filtered_24h: number;
    unknown_provider_24h: number;
    /** Mails reaching CF→worker but not matching any registered bank account (no_pairing_code or unknown_pairing_code). */
    unmatched_24h: number;
    /** Non-transaction bank emails (statements, marketing, alerts) — expected noise, not parser bugs. */
    not_transaction_24h: number;
  };
  bank_accounts: Array<{
    id: number;
    label: string | null;
    account_type: string;
    last_email_at: string | null;
    last_api_pull_at: string | null;
    tx_count_7d: number;
    parse_errors_24h: number;
  }>;
  consumers: Array<{
    app_id: string;
    last_webhook_at: string | null;
    webhooks_24h: number;
    webhook_errors_24h: number;
  }>;
  queues: {
    main_pending: number;
    /** Canonical: jobs not yet delivered/terminal (pending+dispatching+queued). */
    delivery_active: number;
    delivery_stalled: number;
    delivery_terminal: number;
    oldest_undelivered_at: string | null;
    /** Unposted rows in the per-job alert outbox. */
    pending_delivery_alerts: number;
    api_rate_limited_24h: number;
  };
}

export async function getStatusData(db: D1Database): Promise<StatusData> {
  const [
    failures, txInserted24h, unknownCurr, outgoing, unknownProv, unmatched, deliveryActive, deliveryStalled, deliveryTerminal, oldestUndelivered, pendingAlerts, notTransaction,
    apiRateLimited, accountRows, txPer7d, parseErrPerAcct, lastEmailPerAcct,
    consumerRows, webhookLast, webhooks24h, webhookErrors24h, deliveredPerConsumer,
  ] = await Promise.all([
    db.prepare(SQL_PARSE_FAILURES_24H).first<{ cnt: number }>(),
    db.prepare(SQL_TX_INSERTED_24H).first<{ cnt: number }>(),
    db.prepare(SQL_UNKNOWN_CURRENCY_24H).first<{ cnt: number }>(),
    db.prepare(SQL_OUTGOING_FILTERED_24H).first<{ cnt: number }>(),
    db.prepare(SQL_UNKNOWN_PROVIDER_24H).first<{ cnt: number }>(),
    db.prepare(SQL_UNMATCHED_24H).first<{ cnt: number }>(),
    db.prepare(SQL_DELIVERY_ACTIVE).first<{ cnt: number }>(),
    db.prepare(SQL_DELIVERY_STALLED).first<{ cnt: number }>(),
    db.prepare(SQL_DELIVERY_TERMINAL).first<{ cnt: number }>(),
    db.prepare(SQL_DELIVERY_OLDEST_PENDING).first<{ ts: string | null }>(),
    db.prepare(SQL_PENDING_DELIVERY_ALERTS).first<{ cnt: number }>(),
    db.prepare(SQL_NOT_TRANSACTION_24H).first<{ cnt: number }>(),
    db.prepare(SQL_API_RATE_LIMITED_24H).first<{ cnt: number }>(),
    db.prepare(SQL_LIST_BANK_ACCOUNTS).all<{ id: number; account_type: string; label: string | null; api_last_success_at: string | null; created_at: string }>(),
    db.prepare(SQL_PER_ACCOUNT_TX_7D).all<{ bank_account_id: number; cnt: number }>(),
    db.prepare(SQL_PER_ACCOUNT_PARSE_ERRORS_24H).all<{ bank_account_id: number; cnt: number }>(),
    db.prepare(SQL_PER_ACCOUNT_LAST_EMAIL).all<{ bank_account_id: number; ts: string | null }>(),
    db.prepare(SQL_LIST_CONSUMERS).all<{ id: number; app_id: string; callback_url: string; secret_prefix: string; created_at: string }>(),
    db.prepare(SQL_PER_CONSUMER_WEBHOOK_LAST).all<{ consumer_app_id: string; ts: string | null }>(),
    db.prepare(SQL_PER_CONSUMER_WEBHOOKS_24H).all<{ consumer_app_id: string; cnt: number }>(),
    db.prepare(SQL_PER_CONSUMER_ERRORS_24H).all<{ consumer_app_id: string; cnt: number }>(),
    db.prepare(SQL_PER_CONSUMER_DELIVERED).all<{ consumer_app_id: string; ts: string | null }>(),
  ]);

  const failuresCount = failures?.cnt ?? 0;
  const insertedCount = txInserted24h?.cnt ?? 0;
  const total24h = failuresCount + insertedCount;

  const tx7dMap = new Map(txPer7d.results.map(r => [r.bank_account_id, r.cnt]));
  const parseErrMap = new Map(parseErrPerAcct.results.map(r => [r.bank_account_id, r.cnt]));
  const lastEmailMap = new Map(lastEmailPerAcct.results.map(r => [r.bank_account_id, r.ts]));

  const webhookLastMap = new Map(webhookLast.results.map(r => [r.consumer_app_id, r.ts]));
  const webhooks24hMap = new Map(webhooks24h.results.map(r => [r.consumer_app_id, r.cnt]));
  const webhookErrMap = new Map(webhookErrors24h.results.map(r => [r.consumer_app_id, r.cnt]));
  const deliveredMap = new Map(deliveredPerConsumer.results.map(r => [r.consumer_app_id, r.ts]));

  return {
    service: {
      parse_failures_24h: failuresCount,
      parse_failure_rate_24h: total24h > 0 ? Math.round((failuresCount / total24h) * 10000) / 10000 : 0,
      unknown_currency_24h: unknownCurr?.cnt ?? 0,
      outgoing_filtered_24h: outgoing?.cnt ?? 0,
      unknown_provider_24h: unknownProv?.cnt ?? 0,
      unmatched_24h: unmatched?.cnt ?? 0,
      not_transaction_24h: notTransaction?.cnt ?? 0,
    },
    bank_accounts: accountRows.results.map(a => ({
      id: a.id,
      label: a.label ?? null,
      account_type: a.account_type,
      last_email_at: lastEmailMap.get(a.id) ?? null,
      last_api_pull_at: a.api_last_success_at ?? null,
      tx_count_7d: tx7dMap.get(a.id) ?? 0,
      parse_errors_24h: parseErrMap.get(a.id) ?? 0,
    })),
    consumers: consumerRows.results.map(c => ({
      app_id: c.app_id,
      last_webhook_at: deliveredMap.get(c.app_id) ?? webhookLastMap.get(c.app_id) ?? null,
      webhooks_24h: webhooks24hMap.get(c.app_id) ?? 0,
      webhook_errors_24h: webhookErrMap.get(c.app_id) ?? 0,
    })),
    queues: {
      main_pending: 0, // Cloudflare Analytics binding not available in basic setup
      delivery_active: deliveryActive?.cnt ?? 0,
      delivery_stalled: deliveryStalled?.cnt ?? 0,
      delivery_terminal: deliveryTerminal?.cnt ?? 0,
      oldest_undelivered_at: oldestUndelivered?.ts ?? null,
      pending_delivery_alerts: pendingAlerts?.cnt ?? 0,
      api_rate_limited_24h: apiRateLimited?.cnt ?? 0,
    },
  };
}

// ---- retention ----

const SQL_PRUNE_PARSE_LOG = `DELETE FROM parse_log WHERE created_at < datetime('now', '-30 days')`;
const SQL_PRUNE_WEBHOOK_LOG = `DELETE FROM webhook_log WHERE created_at < datetime('now', '-90 days')`;
const SQL_PRUNE_EVENT_LOG = `DELETE FROM event_log WHERE created_at < datetime('now', '-30 days')`;
const SQL_PRUNE_TRANSACTIONS = `DELETE FROM transactions WHERE created_at < datetime('now', '-90 days')`;
const SQL_CLEAR_EXPIRED_PREV_SECRETS = `UPDATE webhook_consumers SET prev_secret_cipher = NULL, prev_expires_at = NULL WHERE prev_expires_at < datetime('now')`;

export async function pruneRetention(db: D1Database): Promise<{
  parse_log_deleted: number;
  webhook_log_deleted: number;
  event_log_deleted: number;
  expired_prev_secrets_cleared: number;
  transactions_deleted: number;
}> {
  const parseLogResult = await db.prepare(SQL_PRUNE_PARSE_LOG).run();
  const webhookLogResult = await db.prepare(SQL_PRUNE_WEBHOOK_LOG).run();
  const eventLogResult = await db.prepare(SQL_PRUNE_EVENT_LOG).run();
  const txResult = await db.prepare(SQL_PRUNE_TRANSACTIONS).run();
  const secretsResult = await db.prepare(SQL_CLEAR_EXPIRED_PREV_SECRETS).run();
  return {
    parse_log_deleted: parseLogResult.meta.changes,
    webhook_log_deleted: webhookLogResult.meta.changes,
    event_log_deleted: eventLogResult.meta.changes,
    expired_prev_secrets_cleared: secretsResult.meta.changes,
    transactions_deleted: txResult.meta.changes,
  };
}
