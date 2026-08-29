export interface BankAccount {
  id: number;
  account_number: string;
  account_type: string;
  ingest_mode: 'email' | 'api' | 'both';
  pairing_code: string;
  label: string | null;
  owner_app_id: string | null;
  /** CF Email Routing rule id (set when banksync calls CF API on account create); null in dev/test environments without CF_API_TOKEN. */
  cf_rule_id: string | null;
  api_token_set: boolean;
  api_token_prefix: string | null;
  api_fetch_enabled: boolean;
  api_last_fetch_at: string | null;
  api_last_success_at: string | null;
  api_last_error: string | null;
  api_backfill_done: boolean;
  created_at: string;
}

export interface Transaction {
  id: number;
  bank_account_id: number;
  /** INTEGER, lowest unit (e.g. 1990 = 19.90 CZK), incoming-only — always positive */
  amount_cents: number;
  /** ISO 4217 alpha-3 uppercase (CZK/EUR/USD) */
  currency: string;
  counter_account: string | null;
  bank_code: string | null;
  bank_name: string | null;
  vs: string | null;
  ks: string | null;
  ss: string | null;
  message: string | null;
  sender_name: string | null;
  /** Fio API column7, available only from Fio API pull */
  user_identification: string | null;
  /** Fio API column8, available only from Fio API pull */
  transaction_type: string | null;
  /** Fio API column9, available only from Fio API pull */
  performed_by: string | null;
  /** Fio API column25, available only from Fio API pull */
  comment: string | null;
  /** Fio API column17 — ID pokynu, available only from Fio API pull */
  command_id: string | null;
  source: 'email' | 'fio_api';
  date: string;
  /** Original timezone offset in minutes (e.g. CET=60, CEST=120). Debug only — all queries use UTC date. */
  date_offset_min: number | null;
  transaction_id: string | null;
  external_id: string | null;
}

export interface WebhookEnvelope {
  event: 'transaction.received';
  /** Bumped when shape of `data` or signing string changes */
  event_version: '1';
  /** ULID, stable across retries — sole idempotence key */
  delivery_id: string;
  pairing_code: string;
  data: Transaction;
}

export type InsertResult =
  | { status: 'inserted'; transaction: Transaction }
  | {
      status: 'skipped';
      reason: 'duplicate_transaction_id' | 'duplicate_external_id' | 'fuzzy_duplicate';
    };

export interface WebhookConsumer {
  id: number;
  app_id: string;
  callback_url: string;
  /** AES-GCM ciphertext; base64(iv || ct || tag) */
  secret_cipher: string;
  /** SHA-256(plaintext) hex — audit / mismatch detection */
  secret_hash: string;
  /** First 6 characters of plaintext for identification */
  secret_prefix: string;
  /** Previous secret ciphertext during rotation grace period */
  prev_secret_cipher: string | null;
  /** UTC ISO; NULL when no active rotation grace */
  prev_expires_at: string | null;
  admin_key_hash: string | null;
  admin_key_prefix: string | null;
  created_at: string;
}

export interface WebhookSubscription {
  id: number;
  bank_account_id: number;
  consumer_app_id: string;
  created_at: string;
}

export interface ApiFetchAccount extends BankAccount {
  api_token_cipher: string;
  api_token_key_ver: number;
}
