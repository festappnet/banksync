import {recoveryMaintenanceEnabled} from './recoveryMaintenance';
import {beginEmailRecovery,completeEmailRecovery,failEmailRecovery,emailFailureCategory,emailR2Disposition,type EmailRecoveryClaim} from './emailRecovery';
import {canonicalIban,mapPhysicalAccount,referenceScope,reservePaymentReference,lookupPaymentReference} from './paymentReferences';
import type {
  D1Database,
  ExecutionContext,
  Queue,
  ForwardableEmailMessage,
  Message,
  MessageBatch,
  ScheduledEvent,
  R2Bucket,
} from '@cloudflare/workers-types';
import { extractEmailBody } from './mime';
import type { ExtractedEmail } from './mime';
import { classifyEmail, extractPairingCode, parseAllowlist } from './email_classify';
import { authenticateEmailIdentity, EmailAuthenticationError, inspectAuthenticationResults, type EmailEnvelopeEvidence } from './email_auth';
import { decryptSecret, encryptSecret, webhookEncrypt, type VersionedSecretEnv } from './crypto';
import {
  assertSchemaVersion,
  findBankAccountByPairingCode,
  findBankAccountById,
  findBankAccountApiMaterials,
  pairingCodeExists,
  createBankAccount,
  listBankAccounts,
  listDueApiFetchAccounts,
  tryAcquireApiSyncLease,
  createConsumer,
  listConsumers,
  findConsumerByAppId,
  rotateConsumerSecret,
  updateConsumer,
  deleteConsumer,
  createSubscription,
  listSubscriptions,
  deleteSubscription,
  insertTransaction,
  insertParseLog,
  writeEvent,
  getStatusData,
  listTransactions,
  listParseLog,
  listWebhookLog,
  listUnmatchedMails,
  pruneRetention,
  pruneCompletedRecovery,
  updateBankAccount,
  updateBankAccountOwner,
  setBankAccountApiToken,
  setBankAccountApiFetchEnabled,
  clearBankAccountApiToken,
  isBankAccountApiFetchDue,
  markBankAccountApiFetchStarted,
  markBankAccountApiPointerSet,
  markBankAccountApiFetchSuccess,
  markBankAccountApiFetchFailure,
  deleteBankAccount,
  setConsumerAdminKey,
} from './db';
import {
  parseBody,
  ValidationError,
  CreateBankAccountSchema,
  UpdateBankAccountSchema,
  UpdateBankAccountOwnerSchema,
  CreateConsumerSchema,
  UpdateConsumerSchema,
  CreateSubscriptionSchema,
  ReplayWebhookSchema,
  UpdateFioTokenSchema,
  validateCallbackUrl,
} from './validation';
import { handleQueueBatch, WebhookQueueMessage } from './queue';
import { log, logError } from './logger';
import { deleteRule as cfDeleteRule } from './cf_routing';
import { resolveAuth, generateTenantAdminKey, timingSafeEqual } from './auth';
import type { AuthContext } from './auth';
import { enqueueCreate, processOutbox } from './outbox';
import * as cfIntent from './cfIntent';
import { checkIdempotency, recordIdempotency, sha256Hex } from './idempotency';
import { recordAudit, shouldAuditMethod, redactBodyForAudit, listAuditLog } from './audit';
import { checkAndIncrement, pruneOldBuckets } from './rate_limit';
import { deepHealth, auditCfRoutingDrift } from './health_deep';
import { readOperationsProbe } from './operationsProbe';
import { runBackupTick } from './backup';
import { createWebhookDeliveryCoordinator, DeliveryQueries } from './webhookDeliveryCoordinator';
import {
  ensureDeliveryJobs,
  findDeliveryJob,
  findDeliveryJobsForTransaction,
} from './webhookDelivery';
import { recoverBankAccount } from './bankRecovery';
import {recoverFioAccount} from './fioRecovery';
import { fetchNewTransactions, FioRateLimited, FioTransientFailure, FioTokenInvalidOrInactive, FioReceivingAccountMismatch, mapFioTransaction, setFioPointer } from './fio';
import type { ApiFetchAccount, BankAccount, Transaction } from './types';
import type { GenericSchema, InferOutput } from 'valibot';

export interface Env extends VersionedSecretEnv {
  DB: D1Database;
  WEBHOOK_QUEUE: Queue<WebhookQueueMessage>;
  API_SYNC_QUEUE?: Queue<ApiSyncQueueMessage>;
  ADMIN_SECRET: string;
  WEBHOOK_KEK: string;
  ENCRYPTION_KEY_VERSION?: string;
  ENCRYPTION_KEY_V1?: string;
  FIO_MIN_INTERVAL_S?: string;
  /**
   * Fio egress proxy. Cloudflare Workers cannot reach fioapi.fio.cz (HTTP 525
   * TLS handshake fail). When set, Fio pulls are relayed through this edge
   * function (running on a non-Cloudflare fixed IP). FIO_PROXY_URL is a plain
   * var; FIO_PROXY_SECRET is a wrangler secret. Both unset → direct Fio fetch.
   */
  FIO_PROXY_URL?: string;
  FIO_PROXY_SECRET?: string;
  /** comma-separated emails like 'noreply@fio.cz,info@airbank.cz' */
  SENDER_ALLOWLIST: string;
  /** 'production' | 'development' — gates POST /__test/email */
  ENV?: string;
  // ---- CF Email Routing auto-sync (Phase 1.5) ----
  /** CF API token w/ Zone:Email Routing Rules:Edit. When unset, banksync skips CF sync (dev mode). */
  CF_API_TOKEN?: string;
  /** CF zone id where Email Routing rules live. */
  CF_ZONE_ID?: string;
  /** Subdomain hosting bank-* receivers (e.g. banksync.festapp.net). */
  BANKSYNC_DOMAIN?: string;
  // ---- Phase 1.6 additions ----
  /** Optional credential restricted to GET /health/operations. */
  OPERATIONS_READ_TOKEN?: string;
  /** R2 bucket binding for weekly SQL backup. Undefined → backup disabled. */
  BACKUPS?: R2Bucket;
  /** Trusted authserv-id observed and verified from Cloudflare Email Routing. */
  EMAIL_AUTHSERV_ID?: string;
  /** Explicit capability for the shared encrypted authenticated ingress spool. */
  AUTHENTICATED_EMAIL_SPOOL?: 'on';
  /** Exact comma-separated callback hostnames allowed in production. */
  CALLBACK_HOST_ALLOWLIST?: string;
  /** Active application-layer backup key version. */
  BACKUP_ENCRYPTION_KEY_VERSION?: string;
  BACKUP_ENCRYPTION_KEY_V1?: string;
  BACKUP_ENCRYPTION_KEY_V2?: string;
}

interface ApiSyncQueueMessage {
  kind: 'api_sync_tick';
  source: 'cron' | 'self';
  enqueued_at: string;
}

function fioProxyConfig(env: Env): import('./fio').FioProxyConfig | undefined {
  const url = env.FIO_PROXY_URL?.trim();
  const secret = env.FIO_PROXY_SECRET?.trim();
  return url && secret ? { url, secret } : undefined;
}

function cfRoutingConfig(env: Env): import('./cf_routing').CfRoutingConfig {
  return {
    apiToken: env.CF_API_TOKEN,
    zoneId: env.CF_ZONE_ID ?? '',
    domain: env.BANKSYNC_DOMAIN ?? 'banksync.festapp.net',
  };
}

// ---- shared email processing logic (also called from /__test/email) ----

export async function processEmail(
  rawStream: ReadableStream<Uint8Array>,
  env: Env,
  envelope: EmailEnvelopeEvidence,
): Promise<void> {
  let bodyText: string | undefined;
  let spoolId: string | undefined;
  let recoveryClaim: EmailRecoveryClaim | undefined;
  const reader=rawStream.getReader();const parts:Uint8Array[]=[];let byteCount=0;
  while(true) {
    const item=await reader.read();if(item.done) break;
    byteCount+=item.value.byteLength;
    if(byteCount>512*1024) {await reader.cancel();throw new Error('email_body_limit');}
    parts.push(item.value);
  }
  const rawArray=new Uint8Array(byteCount);let offset=0;
  for(const part of parts) {rawArray.set(part,offset);offset+=part.length;}
  const rawBytes=rawArray.buffer;
  let binary='';for(let i=0;i<rawArray.length;i+=8192) binary+=String.fromCharCode(...rawArray.subarray(i,i+8192));
  const bytesBase64=btoa(binary);
  const rawMime = new TextDecoder().decode(rawBytes);
  let r2SpoolKey:string|undefined;

  try {
    // Step 1: extract MIME
    let extracted: ExtractedEmail;
    try {
      extracted = await extractEmailBody(new Blob([rawBytes]).stream());
      bodyText = extracted.text;
    } catch (err) {
      const rawText = await new Response(rawStream).text().catch(() => '(failed to read raw)');
      await insertParseLog(env.DB, {
        error_message: `mime_parse_failed: ${err}`,
        raw_data: rawText === '(failed to read raw)' ? rawText : '(raw MIME omitted)',
      });
      log('email_rejected_mime', {});
      return;
    }

    let identity;
    try {
      identity = authenticateEmailIdentity(envelope, extracted);
    } catch (err) {
      const reason = err instanceof EmailAuthenticationError ? err.code : 'email_authentication_failed';
      await insertParseLog(env.DB, { error_message: reason, raw_data: sanitizeDiagnosticRaw(extracted.text), external_id: extracted.messageId ?? null });
      log('email_rejected_authentication', { reason });
      return;
    }

    // R2 survives D1 outages. Spool only after strict bank authentication, but
    // before the first account lookup or database side effect. Preserve bytes.
    if(env.AUTHENTICATED_EMAIL_SPOOL==='on') {
      if(!env.BACKUPS) throw new Error('authenticated_spool_binding_required');
      const encrypted=await encryptSecret(JSON.stringify({bytesBase64,envelope}),env);
      r2SpoolKey=`authenticated-email-pending/${await sha256Hex(`${identity.recipient}:${bytesBase64}`)}`;
      const existing=await env.BACKUPS.head(r2SpoolKey);
      if(!existing) await env.BACKUPS.put(r2SpoolKey,JSON.stringify(encrypted));
    }

    if(await recoveryMaintenanceEnabled(env.DB)) {
      if(!r2SpoolKey) throw new Error('recovery_maintenance_requires_durable_spool');
      log('email_recovery_maintenance_deferred',{});
      return;
    }

    // Resolve the bank account from authenticated envelope recipient, then classify.
    // The lookup is read-only and harmless for emails that fail an earlier gate —
    // the outcome's bankAccountId stays null for pre-account rejects, so parse_log
    // rows are byte-identical to the inline pipeline this replaced.
    const allowlist = parseAllowlist(env.SENDER_ALLOWLIST);
    const pairingCode = extractPairingCode(identity.recipient);
    const account = pairingCode ? await findBankAccountByPairingCode(env.DB, pairingCode) : null;
    const schema = await env.DB.prepare("SELECT value FROM schema_meta WHERE key='version'").first<{value:string}>();
    if ((account || schema?.value==='13') && ['11','12','13'].includes(schema?.value??'')) {
      spoolId = await sha256Hex(`${account?.id??`recipient:${identity.recipient}`}:${extracted.messageId ?? await sha256Hex(rawMime)}`);
      const digest = await sha256Hex(rawMime);
      const encrypted = await encryptSecret(JSON.stringify({bytesBase64,envelope}),env);
      if(schema?.value==='13') {
        const recovery=await beginEmailRecovery(env.DB,{messageKey:spoolId,accountId:account?.id??null,digest,cipher:encrypted.cipher,keyVersion:encrypted.keyVersion,r2Key:r2SpoolKey});
        if(recovery.kind!=='claimed') {
          if(recovery.kind==='completed' && r2SpoolKey) await env.BACKUPS!.delete(r2SpoolKey);
          return;
        }
        recoveryClaim=recovery.claim;
      } else {
      await env.DB.prepare(`INSERT INTO authenticated_email_spool(id,bank_account_id,body_sha256,cipher,key_version)
        VALUES(?,?,?,?,?) ON CONFLICT(id) DO NOTHING`).bind(spoolId,account!.id,digest,encrypted.cipher,encrypted.keyVersion).run();
      const stored = await env.DB.prepare('SELECT body_sha256 FROM authenticated_email_spool WHERE id=?').bind(spoolId).first<{body_sha256:string}>();
      if (stored?.body_sha256 !== digest) throw new Error('email_transport_body_conflict');
      }
    }
    async function completeSpool() {
      if(recoveryClaim) await completeEmailRecovery(env.DB,recoveryClaim);
      else if(spoolId) await env.DB.prepare("UPDATE authenticated_email_spool SET state='completed',completed_at=datetime('now') WHERE id=?").bind(spoolId).run();
      if(r2SpoolKey) await env.BACKUPS!.delete(r2SpoolKey);
    }
    if (account && ['11','12','13'].includes(schema?.value??'')) {
      const enabled=await env.DB.prepare('SELECT ingest_enabled FROM bank_accounts WHERE id=?').bind(account.id).first<{ingest_enabled:number}>();
      if(enabled?.ingest_enabled===0) throw new Error('email_connection_paused');
    }
    const outcome = classifyEmail(extracted, identity, account, allowlist);

    // email_received audit fires once the email clears the security gate, before
    // provider/parse — exactly the outcomes flagged `received` (account is
    // guaranteed non-null there).
    if (outcome.received) {
      log('email_received', { pairing_code: pairingCode, message_id: extracted.messageId ?? null });
      await writeEvent(env.DB, { event_type: 'email_received', bank_account_id: account!.id, detail: { message_id: extracted.messageId ?? null } });
    }

    if (outcome.kind === 'reject' || outcome.kind === 'skip') {
      if((r2SpoolKey || recoveryClaim) && (outcome.reason.startsWith('parse_failed') || outcome.reason.startsWith('unknown_') || outcome.reason.startsWith('no_pairing'))) throw new Error('authenticated_email_quarantined');
      await insertParseLog(env.DB, {
        bank_account_id: outcome.bankAccountId ?? null,
        error_message: outcome.reason,
        raw_data: sanitizeDiagnosticRaw(extracted.text),
        external_id: extracted.messageId ?? null,
      });
      await completeSpool();
      return;
    }

    // Step 9: insert transaction (outcome.kind === 'insert')
    const acct = outcome.account;
    if (!outcome.parsed.date) throw new Error('email_missing_bank_date');
    let result;
    try {
      result = await insertTransaction(env.DB, {
        bank_account_id: acct.id,
        ...(recoveryClaim?{writeFence:{sql:`EXISTS (SELECT 1 FROM authenticated_email_spool WHERE id=? AND state='pending' AND claim_token=? AND datetime(claim_until)>datetime('now')) AND EXISTS (SELECT 1 FROM bank_accounts WHERE id=? AND account_number=? AND account_type=? AND ingest_enabled=1)`,values:[recoveryClaim.id,recoveryClaim.token,acct.id,acct.account_number,acct.account_type]}}:{}),
        payload: {
          ...outcome.parsed,
          date: outcome.parsed.date,
          external_id: extracted.messageId ?? null,
        },
      });
    } catch (err) {
      await insertParseLog(env.DB, {
        bank_account_id: acct.id,
        error_message: `db_insert_failed: ${err}`,
        raw_data: sanitizeDiagnosticRaw(JSON.stringify({ ...outcome.parsed, external_id: extracted.messageId ?? null })),
        external_id: extracted.messageId ?? null,
      });
      throw new Error('email_db_insert_failed');
    }

    // Step 10: gate on 'inserted' — idempotence rule
    if (result.status === 'skipped') {
      log('tx_skipped', { reason: result.reason, bank_account_id: acct.id });
      await writeEvent(env.DB, { event_type: 'tx_skipped', bank_account_id: acct.id, detail: { reason: result.reason } });
      await completeSpool();
      return;
    }

    const tx = result.transaction;
    log('tx_inserted', { bank_account_id: acct.id, tx_id: tx.id, vs: tx.vs, amount_cents: tx.amount_cents, currency: tx.currency });
    await writeEvent(env.DB, { event_type: 'tx_inserted', bank_account_id: acct.id, detail: { tx_id: tx.id } });

    await createWebhookDeliveryCoordinator(env).observeTransaction(tx.id);
    await completeSpool();

  } catch (err) {
    if(recoveryClaim) {
      // Persist retry/quarantine once. Expected recoverable failures are not
      // Worker exceptions and do not duplicate private parse-log payloads.
      try {
        if(await failEmailRecovery(env.DB,recoveryClaim,err)) {
          const failure=emailFailureCategory(err);
          log('email_recovery_deferred',{spool_id:recoveryClaim.id,reason:failure.code,quarantined:failure.permanent});
          return;
        }
        const retained=await env.DB.prepare('SELECT state FROM authenticated_email_spool WHERE id=?').bind(recoveryClaim.id).first<{state:string}>();
        if(retained && ['pending','completed','quarantined'].includes(retained.state)) return;
      } catch { /* D1 outage: R2 and the expiring claim retain the message. */ }
    }
    // Last-resort failure is surfaced when recovery state could not be stored.
    try {
      await insertParseLog(env.DB, {
        error_message: `unhandled: ${err}`,
        raw_data: sanitizeDiagnosticRaw(bodyText ?? 'Body read failed'),
      });
    } catch {
      // swallow insertParseLog failure — we cannot let the catch block throw
    }
    logError('email_unhandled_exception', err, {});
    throw new Error('email_ingest_incomplete');
  }
}

function sanitizeDiagnosticRaw(value: string): string {
  return value
    .slice(0, 4096)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/\b\d{6,}\b/g, '[number]');
}

// ---- helper: generate pairing_code (10 hex chars from 5 random bytes) ----

function generatePairingCode(): string {
  const bytes = new Uint8Array(5);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Generate a pairing code that is verified-unique against the DB.
 * 40-bit space: at 1M accounts, P(collision per attempt) ≈ 0.05%; 5 attempts → effectively zero.
 * Throws on the (essentially impossible) case of 5 consecutive collisions — caller surfaces 503.
 */
async function generateUniquePairingCode(db: D1Database): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generatePairingCode();
    if (!(await pairingCodeExists(db, code))) return code;
    log('pairing_code_collision_retry', { attempt: attempt + 1 });
  }
  throw new Error('pairing_code_collision_exhausted: 5 consecutive collisions (entropy/RNG misconfiguration?)');
}

// ---- helper: generate plain consumer secret (whsec_<base64url(32 bytes)>) ----

function generateConsumerSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  // base64url encode
  const b64 = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
  return 'whsec_' + b64;
}

function apiMinIntervalS(env: Env): number {
  const raw = env.FIO_MIN_INTERVAL_S;
  if (!raw) return 30;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 30;
}

function tokenPrefix(token: string): string {
  return token.slice(0, 6);
}

function yyyyMmDdDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

interface BankApiSyncResult {
  bank_account_id: number;
  provider: string;
  inserted: number;
  skipped_duplicate: number;
  skipped_outgoing: number;
  parse_errors: number;
  queued_webhooks: number;
  backfill: boolean;
  deferred: boolean;
}

const API_POLL_CRON = '* * * * *';
const MAINTENANCE_CRON = '15 3 * * *';
const API_SYNC_LEASE_S = 30;
const RECONCILIATION_INTERVAL_MINUTES = 5;

function scheduledCron(event: ScheduledEvent): string | null {
  const cron = (event as { cron?: unknown }).cron;
  return typeof cron === 'string' ? cron : null;
}

function shouldRunApiPolling(event: ScheduledEvent): boolean {
  const cron = scheduledCron(event);
  return cron === null || cron === API_POLL_CRON;
}

function shouldRunMaintenance(event: ScheduledEvent): boolean {
  const cron = scheduledCron(event);
  return cron === null || cron === MAINTENANCE_CRON;
}

function shouldRunReconciliation(event: ScheduledEvent): boolean {
  const cron = scheduledCron(event);
  if (cron === null) return true;
  if (cron !== API_POLL_CRON) return false;
  const scheduledTime = (event as { scheduledTime?: unknown }).scheduledTime;
  if (typeof scheduledTime !== 'number' || !Number.isFinite(scheduledTime)) return true;
  return Math.floor(scheduledTime / 60_000) % RECONCILIATION_INTERVAL_MINUTES === 0;
}

function apiSyncDelayS(env: Env): number {
  return Math.max(30, apiMinIntervalS(env));
}

async function runBankApiSync(env: Env, account: ApiFetchAccount): Promise<BankApiSyncResult> {
  if (account.account_type !== 'FIO') {
    throw new Error(`unsupported_api_account_type: ${account.account_type}`);
  }

  if(await recoveryMaintenanceEnabled(env.DB)) return {bank_account_id:account.id,provider:account.account_type,inserted:0,skipped_duplicate:0,skipped_outgoing:0,parse_errors:0,queued_webhooks:0,backfill:!account.api_backfill_done,deferred:true};
  const isBackfill = !account.api_backfill_done;
  let durableCursor=false;
  try {
    const schema = await env.DB.prepare("SELECT value FROM schema_meta WHERE key='version'").first<{value:string}>();
    durableCursor=schema?.value==='13';
    if(['11','12','13'].includes(schema?.value??'')) {
      const result=schema?.value==='13'
        ? await recoverFioAccount(env.DB,account,env,fioProxyConfig(env))
        : {...await recoverBankAccount(env.DB,account,env,fioProxyConfig(env)),deferred:false};
      const delivery=await createWebhookDeliveryCoordinator(env).sweep();
      return {bank_account_id:account.id,provider:account.account_type,inserted:result.inserted,skipped_duplicate:result.skipped,skipped_outgoing:0,parse_errors:0,queued_webhooks:delivery.queued,backfill:isBackfill,deferred:result.deferred};
    }
    const token = await decryptSecret(account.api_token_cipher, account.api_token_key_ver, env);
    if (isBackfill && account.api_last_success_at === null) {
      await markBankAccountApiFetchStarted(env.DB, account.id);
      await setFioPointer(token, yyyyMmDdDaysAgo(90), fioProxyConfig(env));
      await markBankAccountApiPointerSet(env.DB, account.id);
      await writeEvent(env.DB, {
        event_type: 'api_pointer_set',
        bank_account_id: account.id,
        detail: { provider: account.account_type, backfill_days: 90 },
      });
      return {
        bank_account_id: account.id,
        provider: account.account_type,
        inserted: 0,
        skipped_duplicate: 0,
        skipped_outgoing: 0,
        parse_errors: 0,
        queued_webhooks: 0,
        backfill: true,
        deferred: true,
      };
    }

    await markBankAccountApiFetchStarted(env.DB, account.id);
    const raw = await fetchNewTransactions(token, fioProxyConfig(env));
    let inserted = 0;
    let skippedDuplicate = 0;
    let skippedOutgoing = 0;
    let parseErrors = 0;
    let queuedWebhooks = 0;

    for (const item of raw) {
      let mapped;
      try {
        mapped = mapFioTransaction(item);
      } catch (err) {
        parseErrors++;
        await insertParseLog(env.DB, {
          bank_account_id: account.id,
          error_message: `${err}`.replace(/^Error:\s*/, ''),
          raw_data: JSON.stringify({ fields: Object.keys(item).sort() }),
        });
        continue;
      }

      if (mapped === null || mapped.amount_cents <= 0) {
        skippedOutgoing++;
        await insertParseLog(env.DB, {
          bank_account_id: account.id,
          error_message: 'outgoing_filtered',
          raw_data: null,
        });
        continue;
      }

      const insertResult = await insertTransaction(env.DB, {
        bank_account_id: account.id,
        payload: mapped,
      });
      if (insertResult.status === 'skipped') {
        skippedDuplicate++;
        continue;
      }

      inserted++;
      await writeEvent(env.DB, {
        event_type: 'tx_inserted',
        bank_account_id: account.id,
        detail: { tx_id: insertResult.transaction.id, source: 'api' },
      });
      if (!isBackfill) {
        queuedWebhooks += (await createWebhookDeliveryCoordinator(env).observeTransaction(insertResult.transaction.id)).dispatched;
      }
    }

    await markBankAccountApiFetchSuccess(env.DB, account.id, { backfill_done: true });
    await writeEvent(env.DB, {
      event_type: 'api_pull_completed',
      bank_account_id: account.id,
      detail: { provider: account.account_type, inserted, skipped_duplicate: skippedDuplicate, parse_errors: parseErrors, backfill: isBackfill },
    });

    return {
      bank_account_id: account.id,
      provider: account.account_type,
      inserted,
      skipped_duplicate: skippedDuplicate,
      skipped_outgoing: skippedOutgoing,
      parse_errors: parseErrors,
      queued_webhooks: queuedWebhooks,
      backfill: isBackfill,
      deferred: false,
    };
  } catch (err) {
    if(durableCursor && err instanceof Error && err.message==='bank_poll_busy') return {bank_account_id:account.id,provider:account.account_type,inserted:0,skipped_duplicate:0,skipped_outgoing:0,parse_errors:0,queued_webhooks:0,backfill:isBackfill,deferred:true};
    await markBankAccountApiFetchFailure(env.DB, account.id, (err instanceof FioTokenInvalidOrInactive || err instanceof FioReceivingAccountMismatch) ? err.code : String(err));
    if (err instanceof FioRateLimited) {
      await writeEvent(env.DB, {
        event_type: 'api_rate_limited',
        bank_account_id: account.id,
        detail: { provider: account.account_type, retry_after_s: err.retryAfterS },
      });
    }
    throw err;
  }
}

async function runDueBankApiSyncs(env: Env): Promise<void> {
  const accounts = await listDueApiFetchAccounts(env.DB, apiMinIntervalS(env));
  for (const account of accounts) {

    try {
      const result = await runBankApiSync(env, account);
      log('api_sync_completed', {
        bank_account_id: account.id,
        account_type: account.account_type,
        inserted: result.inserted,
        skipped_duplicate: result.skipped_duplicate,
        parse_errors: result.parse_errors,
        backfill: result.backfill,
        deferred: result.deferred,
      });
    } catch (err) {
      if (err instanceof FioRateLimited) {
        log('api_rate_limited', { bank_account_id: account.id, account_type: account.account_type, retry_after_s: err.retryAfterS });
        continue;
      }
      if (err instanceof FioTransientFailure) {
        logError('api_transient_failure', err, { bank_account_id: account.id, account_type: account.account_type });
        continue;
      }
      logError('api_sync_failed', err, { bank_account_id: account.id, account_type: account.account_type });
    }
  }
}

async function enqueueApiSyncTick(env: Env, delaySeconds: number, source: ApiSyncQueueMessage['source']): Promise<boolean> {
  if (!env.API_SYNC_QUEUE) return false;
  await env.API_SYNC_QUEUE.send({
    kind: 'api_sync_tick',
    source,
    enqueued_at: new Date().toISOString(),
  }, { delaySeconds });
  return true;
}

async function handleApiSyncQueue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
  await assertSchemaVersion(env.DB);
  for (const rawMsg of batch.messages) {
    const msg = rawMsg as Message<ApiSyncQueueMessage>;
    if (msg.body?.kind !== 'api_sync_tick') {
      logError('api_sync_queue_unknown_message', new Error('unknown api sync queue message'), { queue: batch.queue });
      msg.ack();
      continue;
    }

    try {
      const acquired = await tryAcquireApiSyncLease(env.DB, API_SYNC_LEASE_S);
      if (!acquired) {
        log('api_sync_tick_skipped_lease', { source: msg.body.source });
        msg.ack();
        continue;
      }

      await runDueBankApiSyncs(env);
      msg.ack();
    } catch (err) {
      logError('api_sync_tick_failed', err, { source: msg.body.source });
      msg.retry({ delaySeconds: apiSyncDelayS(env) });
    }
  }
}

// ---- helpers: standard responses ----

function unauthorized(): Response {
  return new Response('Unauthorized', { status: 401, headers: { 'WWW-Authenticate': 'Bearer' } });
}

function forbidden(): Response {
  return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
}

function jsonResponse(body: unknown, status = 200, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

function notFound(): Response {
  return new Response('Not found', { status: 404 });
}

// ---- /health ----

async function healthResponse(env: Env): Promise<Response> {
  try {
    await assertSchemaVersion(env.DB);
    return jsonResponse({ ok: true });
  } catch {
    return jsonResponse({ ok: false }, 503);
  }
}

// ---- /status ----

async function statusResponse(env: Env): Promise<Response> {
  const data = await getStatusData(env.DB);
  return jsonResponse(data);
}

// ---- /__test/email ----

async function runTestEmail(req: Request, env: Env): Promise<Response> {
  const raw = req.body;
  if (!raw) return new Response('Empty body', { status: 400 });
  // Wrap the body bytes as a ReadableStream<Uint8Array>
  const mailFrom = req.headers.get('x-test-mail-from');
  const rcptTo = req.headers.get('x-test-rcpt-to');
  if (!mailFrom || !rcptTo || !env.EMAIL_AUTHSERV_ID) return jsonResponse({ error: 'test_envelope_required' }, 400);
  await processEmail(raw as ReadableStream<Uint8Array>, env, {
    mailFrom,
    rcptTo,
    authenticationResults: req.headers.get('authentication-results'),
    trustedAuthservId: env.EMAIL_AUTHSERV_ID,
  });
  return new Response('ok', { status: 200 });
}

// ---- admin fetch dispatcher ----

async function adminFetch(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);

  if (url.pathname === '/health/operations') {
    const token = req.headers.get('Authorization')?.match(/^Bearer (\S+)$/)?.[1] ?? '';
    const configured = env.OPERATIONS_READ_TOKEN;
    if (!configured || configured.length < 32 || !token || !timingSafeEqual(token, configured)) return new Response('Unauthorized', { status: 401, headers: { 'WWW-Authenticate': 'Bearer', 'Cache-Control': 'no-store' } });
    if (req.method !== 'GET') return new Response(null, { status: 405, headers: { Allow: 'GET', 'Cache-Control': 'no-store' } });
    try {
      return Response.json(await readOperationsProbe(env.DB), { headers: { 'Cache-Control': 'no-store' } });
    } catch {
      return Response.json({ error: 'operations_unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
    }
  }

  // Public health is deliberately the only anonymous information surface.
  if (url.pathname === '/health' && req.method === 'GET') return healthResponse(env);

  // Detailed operator routes reject before schema/auth DB work unless the
  // statically bound admin credential is already valid.
  const isOperatorRoute = req.method === 'GET' && (url.pathname === '/status' || url.pathname === '/health/deep');
  if (isOperatorRoute) {
    const candidate = req.headers.get('X-Admin-Secret') ?? '';
    if (!candidate || !env.ADMIN_SECRET || !timingSafeEqual(candidate, env.ADMIN_SECRET)) return unauthorized();
    await assertSchemaVersion(env.DB);
    const probeLimit = await checkAndIncrement(env.DB, 'admin:operator-probe', { windowSeconds: 60, limit: 60 });
    if (!probeLimit.allowed) {
      return jsonResponse({ error: 'rate_limited', retry_after: probeLimit.retryAfter }, 429, { 'Retry-After': String(probeLimit.retryAfter) });
    }
    if (url.pathname === '/status') return statusResponse(env);
    const result = await deepHealth({
      db: env.DB,
      queue: env.WEBHOOK_QUEUE ?? null,
      cf: cfRoutingConfig(env),
      secrets: {
        backupsPresent: Boolean(
          env.BACKUPS
          && Number.isInteger(Number(env.BACKUP_ENCRYPTION_KEY_VERSION))
          && (env as unknown as Record<string, unknown>)[`BACKUP_ENCRYPTION_KEY_V${env.BACKUP_ENCRYPTION_KEY_VERSION}`],
        ),
        emailAuthPresent: Boolean(env.EMAIL_AUTHSERV_ID?.trim()),
        callbackPolicyPresent: Boolean(env.CALLBACK_HOST_ALLOWLIST?.trim()),
        isProduction: env.ENV === 'production',
      },
    });
    return jsonResponse(result, result.status === 'red' ? 503 : 200);
  }

  await assertSchemaVersion(env.DB);

  // 1. Resolve auth context (admin / tenant / unauth)
  const authCtx = await resolveAuth(req, env);
  const authPrincipal =
    authCtx.type === 'admin' ? 'admin' :
    authCtx.type === 'tenant' ? `tenant:${authCtx.app_id}` :
    'unauth';

  // 3. Test-only email injection — gated on ENV !== 'production' and requires admin auth
  if (url.pathname === '/__test/email' && req.method === 'POST') {
    if (env.ENV === 'production') return notFound();
    if (authCtx.type !== 'admin') return unauthorized();
    return runTestEmail(req, env);
  }

  // 4. All other endpoints require auth (admin or tenant)
  if (authCtx.type === 'unauth') {
    const sourceIp = req.headers.get('cf-connecting-ip') ?? 'unknown';
    const failed = await checkAndIncrement(env.DB, `auth-failed:${sourceIp}`, { windowSeconds: 60, limit: 20 });
    if (!failed.allowed) return jsonResponse({ error: 'rate_limited', retry_after: failed.retryAfter }, 429, { 'Retry-After': String(failed.retryAfter) });
    return unauthorized();
  }

  // 5. Rate limit — tenants only. Admin (super-admin) bypasses the per-principal cap because
  // legitimate admin usage (E2E suites, bulk reconciliation, batch ops) routinely exceeds 100 req/min
  // and the threat model for admin-secret leak is "rotate the secret immediately", not "rate-limit".
  {
    const rl = await checkAndIncrement(env.DB, authPrincipal, authCtx.type === 'admin' ? { windowSeconds: 60, limit: 1_000 } : undefined);
    if (!rl.allowed) {
      return jsonResponse({ error: 'rate_limited', retry_after: rl.retryAfter }, 429, { 'Retry-After': String(rl.retryAfter) });
    }
  }

  // 6. Read body once for mutating methods (handlers receive bodyText, do JSON.parse themselves)
  const isMutating = req.method !== 'GET' && req.method !== 'HEAD';
  let bodyText = '';
  if (isMutating) {
    const read = await readBoundedBody(req, 256 * 1024);
    if (read instanceof Response) return read;
    bodyText = read;
  }

  const credentialRoute = isCredentialReturningRoute(url.pathname, req.method);
  if (credentialRoute && req.headers.has('Idempotency-Key')) {
    return jsonResponse({ error: 'idempotency_not_supported' }, 400);
  }

  // 7. Idempotency check (only for mutating methods)
  if (isMutating && !credentialRoute) {
    const idem = await checkIdempotency({ db: env.DB, request: req, authPrincipal, requestBodyText: bodyText });
    if (idem.kind === 'hit') return new Response(idem.body, { status: idem.status, headers: { 'Content-Type': 'application/json' } });
    if (idem.kind === 'in_flight') return jsonResponse({ error: 'idempotency_request_in_flight' }, 409, { 'Retry-After': '1' });
    if (idem.kind === 'mismatch') return jsonResponse({ error: 'idempotency_key_body_mismatch' }, 422);
  }

  // 8. Dispatch to handler — capture response for audit + idempotency record
  const start = Date.now();
  let handlerResponse: Response;
  try {
    handlerResponse = await dispatch(url, req, env, authCtx, bodyText);
  } catch (err) {
    const idemKey = !credentialRoute ? req.headers.get('Idempotency-Key') : null;
    if (idemKey && idemKey.length >= 1 && idemKey.length <= 255) {
      await recordIdempotency({
        db: env.DB,
        keyHash: await sha256Hex(`${authPrincipal}\n${req.method.toUpperCase()}\n${url.pathname}\n${idemKey}`),
        authPrincipal,
        requestPath: url.pathname,
        requestMethod: req.method,
        requestBodyHash: bodyText.length > 0 ? await sha256Hex(bodyText) : null,
        responseStatus: 500,
        responseBody: '',
      });
    }
    throw err;
  }
  const duration = Date.now() - start;
  const respClone = handlerResponse.clone();
  const respBody = await respClone.text();

  // 9. Record idempotency cache (skip on server errors)
  if (isMutating && !credentialRoute) {
    const idemKey = req.headers.get('Idempotency-Key');
    if (idemKey && idemKey.length >= 1 && idemKey.length <= 255) {
      const keyHash = await sha256Hex(`${authPrincipal}\n${req.method.toUpperCase()}\n${url.pathname}\n${idemKey}`);
      const bodyHash = bodyText.length > 0 ? await sha256Hex(bodyText) : null;
      await recordIdempotency({
        db: env.DB,
        keyHash,
        authPrincipal,
        requestPath: url.pathname,
        requestMethod: req.method,
        requestBodyHash: bodyHash,
        responseStatus: handlerResponse.status,
        responseBody: respBody,
      });
    }
  }

  // 10. Audit log (mutating methods only)
  if (shouldAuditMethod(req.method)) {
    await recordAudit({
      db: env.DB,
      authPrincipal,
      httpMethod: req.method,
      requestPath: url.pathname,
      httpStatus: handlerResponse.status,
      requestBodySummary: bodyText ? redactBodyForAudit(bodyText) : null,
      sourceIp: req.headers.get('cf-connecting-ip'),
      userAgent: req.headers.get('user-agent'),
      durationMs: duration,
    });
  }

  return handlerResponse;
}

function isCredentialReturningRoute(pathname: string, method: string): boolean {
  if (method !== 'POST') return false;
  return pathname === '/consumers' || /^\/consumers\/[^/]+\/(?:rotate-secret|rotate-admin-key)$/.test(pathname);
}

async function readBoundedBody(req: Request, maxBytes: number): Promise<string | Response> {
  const declared = req.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
    return jsonResponse({ error: 'payload_too_large' }, 413);
  }
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel('payload_too_large');
      return jsonResponse({ error: 'payload_too_large' }, 413);
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder('utf-8', { fatal: true }).decode(all);
}

// ---- dispatch: all protected routes ----

/**
 * Resolve a bank account by id and enforce the tenant-owner guard in one step.
 * Returns the account on success, or the exact Response the route would have
 * returned (404 not_found / 403 forbidden). Admin callers always pass the guard.
 */
async function requireOwnedAccount(env: Env, id: number, authCtx: AuthContext): Promise<BankAccount | Response> {
  const existing = await findBankAccountById(env.DB, id);
  if (!existing) return jsonResponse({ error: 'not_found' }, 404);
  if (authCtx.type === 'tenant' && existing.owner_app_id !== authCtx.app_id) return forbidden();
  return existing;
}

/**
 * Parse + validate a JSON request body in one step. Returns the validated value,
 * or the exact Response the route would have returned (400 invalid JSON / 400
 * validation_failed). Re-throws non-validation errors so the outer handler 500s.
 */
function parseOr400<TSchema extends GenericSchema>(schema: TSchema, bodyText: string): InferOutput<TSchema> | Response {
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return jsonResponse({ error: 'invalid JSON' }, 400);
  }
  try {
    return parseBody(schema, body);
  } catch (err) {
    if (err instanceof ValidationError) return jsonResponse({ error: err.message, issues: err.issues }, 400);
    throw err;
  }
}

async function dispatch(
  url: URL,
  req: Request,
  env: Env,
  authCtx: AuthContext,
  bodyText: string,
): Promise<Response> {

  if(!['GET','HEAD','OPTIONS'].includes(req.method)
    && !/^\/bank-accounts\/\d+\/fio-sync$/.test(url.pathname)
    && await recoveryMaintenanceEnabled(env.DB)) {
    return jsonResponse({error:'recovery_maintenance_active'},503,{'Retry-After':'60'});
  }

  const referenceRoute=url.pathname.match(/^\/bank-accounts\/(\d+)\/(payment-references|payment-reference-admin|account-health)$/);
  if(referenceRoute){
    const version=await env.DB.prepare("SELECT value FROM schema_meta WHERE key='version'").first<{value:string}>();
    if(!['12','13'].includes(version?.value??''))return jsonResponse({error:'schema12_required'},409);
    const accountId=Number(referenceRoute[1]);
    try {
      if(referenceRoute[2]==='payment-reference-admin'&&req.method==='POST'){
        if(authCtx.type!=='admin')return forbidden();
        const input=JSON.parse(bodyText),physical=await mapPhysicalAccount(env.DB,accountId);
        if(input.op==='grant'&&typeof input.app_id==='string'){
          if(!await findConsumerByAppId(env.DB,input.app_id))return jsonResponse({error:'unknown_consumer'},404);
          await env.DB.prepare('INSERT INTO payment_reference_grants VALUES(?,?) ON CONFLICT DO NOTHING').bind(physical,input.app_id).run();return jsonResponse({ok:true,physical_account_id:physical});
        }
        if(input.op==='activate'&&input.registry_verified===true){
          if(await env.DB.prepare('SELECT 1 FROM payment_reference_conflicts WHERE physical_account_id=? LIMIT 1').bind(physical).first())return jsonResponse({error:'reference_conflict'},409);
          await env.DB.prepare('UPDATE physical_accounts SET allocation_enabled=1 WHERE id=?').bind(physical).run();return jsonResponse({ok:true});
        }
        if(input.op==='import')return jsonResponse(await reservePaymentReference(env.DB,physical,input.app_id,input.source_ref,input.payload_hash,input.vs,true));
        return jsonResponse({error:'invalid_operation'},400);
      }
      if(authCtx.type!=='tenant')return forbidden();
      if(referenceRoute[2]==='account-health'&&req.method==='GET'){
        const owned=await findBankAccountById(env.DB,accountId);if(!owned)return jsonResponse({error:'not_found'},404);
        if(owned.owner_app_id!==authCtx.app_id&&!await env.DB.prepare('SELECT 1 FROM webhook_subscriptions WHERE bank_account_id=? AND consumer_app_id=? AND deleted_at IS NULL').bind(accountId,authCtx.app_id).first())return forbidden();
        const row=await env.DB.prepare('SELECT api_fetch_enabled,api_last_success_at,api_last_error,ingest_enabled FROM bank_accounts WHERE id=?').bind(accountId).first<{api_fetch_enabled:number;api_last_success_at:string|null;api_last_error:string|null;ingest_enabled:number}>();
        const stamp=row?.api_last_success_at,observed=stamp?Date.parse(/(?:Z|[+-]\d\d:\d\d)$/.test(stamp)?stamp:stamp+'Z'):NaN;
        const healthy=!!row?.ingest_enabled&&!!row.api_fetch_enabled&&!row.api_last_error&&Number.isFinite(observed)&&Date.now()-observed<10*60*1000;
        return jsonResponse({physical_account_id:await sha256Hex(canonicalIban(owned.account_number)),bank_observation_status:healthy?'healthy':row?.api_last_error?'degraded':'unknown',last_success_at:stamp??null,bank_observed_through:null});
      }
      const physical=await referenceScope(env.DB,accountId,authCtx.app_id);
      if(req.method==='GET'){const result=await lookupPaymentReference(env.DB,physical,authCtx.app_id,url.searchParams.get('source_ref')??'');return result?jsonResponse(result):jsonResponse({error:'not_found'},404);}
      if(req.method==='POST'){const input=JSON.parse(bodyText);if(input.vs!==undefined||input.variable_symbol!==undefined&&typeof input.variable_symbol!=='string')return jsonResponse({error:'invalid_variable_symbol'},400);return jsonResponse(await reservePaymentReference(env.DB,physical,authCtx.app_id,input.source_ref,input.payload_hash,input.variable_symbol),201);}
    }catch(error){const code=error instanceof Error?error.message:'reference_unavailable';return jsonResponse({error:code},code==='reference_forbidden'?403:code==='reference_invalid'||code==='invalid_iban'?400:409);}
    return jsonResponse({error:'not_found'},404);
  }
  // POST /bank-accounts
  if (url.pathname === '/bank-accounts' && req.method === 'POST') {
    const input = parseOr400(CreateBankAccountSchema, bodyText);
    if (input instanceof Response) return input;
    // Tenant scope: can only create for own app_id
    if (authCtx.type === 'tenant' && input.owner_app_id !== authCtx.app_id) {
      return jsonResponse({ error: 'cannot_create_for_other_tenant' }, 403);
    }
    // Owner consumer must exist (FK constraint would fail otherwise — surface as 422 for clarity).
    const owner = await findConsumerByAppId(env.DB, input.owner_app_id);
    if (!owner) return jsonResponse({ error: `unknown owner_app_id: ${input.owner_app_id}` }, 422);
    if (input.fio_api_token !== undefined && (input.account_type ?? 'FIO') !== 'FIO') {
      return jsonResponse({ error: 'fio_api_token_supported_only_for_fio' }, 400);
    }
    const expanded=await env.DB.prepare("SELECT value FROM schema_meta WHERE key='version'").first<{value:string}>();
    if(input.ingest_enabled===false && !['11','12','13'].includes(expanded?.value??'')) return jsonResponse({error:'paused_ingest_requires_schema11'},409);
    const capability=['11','12','13'].includes(expanded?.value??'') ? await env.DB.prepare('SELECT event_version FROM webhook_consumers WHERE app_id=?').bind(input.owner_app_id).first<{event_version:string}>() : null;
    const ingestMode = input.ingest_mode ?? (input.fio_api_token ? 'api' : 'email');
    if(capability?.event_version==='2' && (ingestMode==='email'||ingestMode==='both') && (env.AUTHENTICATED_EMAIL_SPOOL!=='on'||!env.BACKUPS)) return jsonResponse({error:'durable_email_capability_not_configured'},503);
    if(capability?.event_version==='2' && ingestMode==='both') return jsonResponse({error:'both_requires_verified_correlation'},409);
    const pairingCode = await generateUniquePairingCode(env.DB);
    const createEmailRoute = ingestMode === 'email' || ingestMode === 'both';
    const encryptedApiToken = input.fio_api_token
      ? await encryptSecret(input.fio_api_token, env)
      : null;

    // Record outbox row first (paper trail), then attempt synchronous CF call
    const outboxId = createEmailRoute
      ? await enqueueCreate(env.DB, { pairing_code: pairingCode, bank_account_id: 0 })
      : null;

    let account;
    try {
      account = await createBankAccount(env.DB, {
        account_number: input.account_number,
        ...(input.account_type !== undefined ? { account_type: input.account_type } : {}),
        ingest_mode: ingestMode,
        pairing_code: pairingCode,
        ...(input.label !== undefined ? { label: input.label } : {}),
        owner_app_id: input.owner_app_id,
        cf_rule_id: null,
        api_token_cipher: encryptedApiToken?.cipher ?? null,
        api_token_key_ver: encryptedApiToken?.keyVersion ?? null,
        api_token_prefix: input.fio_api_token ? tokenPrefix(input.fio_api_token) : null,
        api_fetch_enabled: Boolean(input.fio_api_token && ingestMode !== 'email'),
      });
    } catch (err) {
      throw err;
    }

    const schemaVersion = await env.DB.prepare("SELECT value FROM schema_meta WHERE key='version'").first<{value:string}>();
    if (input.ingest_enabled === false) {
      if (!['11','12','13'].includes(schemaVersion?.value??'')) throw new Error('paused_ingest_requires_schema11');
      await env.DB.prepare('UPDATE bank_accounts SET ingest_enabled=0,api_fetch_enabled=0 WHERE id=?').bind(account.id).run();
    }
    // Best-path CF provision (stamp outbox with the real id + synchronous rule
    // create). Deferred on failure — the outbox row remains for the reconciler
    // and the client still gets 201.
    if (outboxId !== null) {
      const cfRuleId = await cfIntent.provisionRoute(env.DB, cfRoutingConfig(env), {
        outboxId,
        pairing: pairingCode,
        bankAccountId: account.id,
      });
      if (cfRuleId) account = { ...account, cf_rule_id: cfRuleId };
    }

    // Owner is auto-subscribed to its own bank account so webhooks fire by default.
    try {
      await createSubscription(env.DB, { app_id: input.owner_app_id, bank_account_id: account.id });
    } catch (err) {
      logError('owner_auto_subscribe_failed', err, { app_id: input.owner_app_id, bank_account_id: account.id });
    }
    return jsonResponse(account, 201);
  }

  // GET /bank-accounts (?owner=app_id filter)
  if (url.pathname === '/bank-accounts' && req.method === 'GET') {
    // Tenant: always filter to own accounts; ignore ?owner= param
    const owner = authCtx.type === 'tenant' ? authCtx.app_id : (url.searchParams.get('owner') ?? undefined);
    const accounts = await listBankAccounts(env.DB, owner);
    return jsonResponse(accounts);
  }

  // PUT /bank-accounts/:id
  const baMatch = url.pathname.match(/^\/bank-accounts\/(\d+)$/);
  if (baMatch && req.method === 'GET') {
    const account = await requireOwnedAccount(env, Number(baMatch[1]), authCtx);
    return account instanceof Response ? account : jsonResponse(account);
  }
  if (baMatch && req.method === 'PUT') {
    const id = Number(baMatch[1]);
    const existing = await requireOwnedAccount(env, id, authCtx);
    if (existing instanceof Response) return existing;
    const input = parseOr400(UpdateBankAccountSchema, bodyText);
    if (input instanceof Response) return input;
    if (input.account_number !== undefined && input.account_number !== existing.account_number
      && await env.DB.prepare('SELECT 1 FROM transactions WHERE bank_account_id=? LIMIT 1').bind(id).first()) return jsonResponse({error:'account_identity_immutable'},409);
    const updated = await updateBankAccount(env.DB, id, input);
    if (!updated) return jsonResponse({ error: 'not_found' }, 404);
    return jsonResponse(updated);
  }

  // PUT /bank-accounts/:id/owner — admin-only transfer for legacy ownership cleanup.
  const ownerMatch = url.pathname.match(/^\/bank-accounts\/(\d+)\/owner$/);
  if (ownerMatch && req.method === 'PUT') {
    if (authCtx.type !== 'admin') return forbidden();
    const id = Number(ownerMatch[1]);
    const existing = await findBankAccountById(env.DB, id);
    if (!existing) return jsonResponse({ error: 'not_found' }, 404);
    const input = parseOr400(UpdateBankAccountOwnerSchema, bodyText);
    if (input instanceof Response) return input;
    const owner = await findConsumerByAppId(env.DB, input.owner_app_id);
    if (!owner) return jsonResponse({ error: `unknown owner_app_id: ${input.owner_app_id}` }, 422);
    const updated = await updateBankAccountOwner(env.DB, id, input.owner_app_id);
    if (!updated) return jsonResponse({ error: 'not_found' }, 404);
    return jsonResponse(updated);
  }

  // DELETE /bank-accounts/:id  (cascades subscriptions; transactions kept as audit)
  if (baMatch && req.method === 'DELETE') {
    const id = Number(baMatch[1]);
    // Look up cf_rule_id BEFORE deleting the row, so we can clean up CF routing rule.
    const existing = await requireOwnedAccount(env, id, authCtx);
    if (existing instanceof Response) return existing;

    // Tear down the CF routing rule (outbox delete entry + best-effort sync delete).
    if (existing.cf_rule_id) {
      await cfIntent.deprovisionRoute(env.DB, cfRoutingConfig(env), existing.cf_rule_id);
    }
    const deleted = await deleteBankAccount(env.DB, id);
    if (!deleted) return jsonResponse({ error: 'not_found' }, 404);
    return new Response(null, { status: 204 });
  }

  // Bounded tenant control for a pre-mapped connection, plus safe credential proof.
  const stateMatch=url.pathname.match(/^\/bank-accounts\/(\d+)\/ingest-state$/);
  if(stateMatch && (req.method==='GET' || req.method==='PUT')) {
    const id=Number(stateMatch[1]);
    const existing=await requireOwnedAccount(env,id,authCtx);
    if(existing instanceof Response) return existing;
    const schema=await env.DB.prepare("SELECT value FROM schema_meta WHERE key='version'").first<{value:string}>();
    if(!['11','12','13'].includes(schema?.value??'')) return jsonResponse({error:'schema11_required'},409);
    if(req.method==='PUT') {
      let input; try {input=JSON.parse(bodyText);} catch{return jsonResponse({error:'invalid_json'},400);}
      if(typeof input.enabled!=='boolean') return jsonResponse({error:'enabled_required'},400);
      await env.DB.prepare(schema?.value==='13'
        ? 'UPDATE bank_accounts SET api_credential_generation=api_credential_generation+CASE WHEN ingest_enabled<>? THEN 1 ELSE 0 END,ingest_enabled=? WHERE id=?'
        : 'UPDATE bank_accounts SET ingest_enabled=? WHERE id=?')
        .bind(...(schema?.value==='13'?[input.enabled?1:0,input.enabled?1:0,id]:[input.enabled?1:0,id])).run();
    }
    return jsonResponse(await env.DB.prepare('SELECT ingest_enabled,api_token_hash FROM bank_accounts WHERE id=?').bind(id).first());
  }

  // PUT /bank-accounts/:id/fio-token — Fio adapter token endpoint; storage columns are provider-neutral api_*.
  const fioTokenMatch = url.pathname.match(/^\/bank-accounts\/(\d+)\/fio-token$/);
  if (fioTokenMatch && req.method === 'PUT') {
    const id = Number(fioTokenMatch[1]);
    const existing = await requireOwnedAccount(env, id, authCtx);
    if (existing instanceof Response) return existing;
    if (existing.account_type !== 'FIO') return jsonResponse({ error: 'fio_api_token_supported_only_for_fio' }, 400);

    const input = parseOr400(UpdateFioTokenSchema, bodyText);
    if (input instanceof Response) return input;

    const rawToken = input.fio_api_token?.trim();
    if (rawToken !== undefined && rawToken.length > 0 && rawToken.length < 8) {
      return jsonResponse({ error: 'validation_failed: fio_api_token must be at least 8 characters' }, 400);
    }

    if (rawToken && rawToken.length > 0) {
      const encrypted = await encryptSecret(rawToken, env);
      const updated = await setBankAccountApiToken(env.DB, id, {
        token_cipher: encrypted.cipher,
        token_key_ver: encrypted.keyVersion,
        token_prefix: tokenPrefix(rawToken),
        token_hash: await sha256Hex(rawToken),
        fetch_enabled: input.fetch_enabled ?? true,
        ingest_mode: input.ingest_mode ?? (existing.ingest_mode === 'email' ? 'api' : existing.ingest_mode),
      });
      if (!updated) return jsonResponse({ error: 'not_found' }, 404);
      const schemaVersion=await env.DB.prepare("SELECT value FROM schema_meta WHERE key='version'").first<{value:string}>();
      if(['11','12'].includes(schemaVersion?.value??'')) await env.DB.prepare('UPDATE bank_accounts SET api_token_hash=? WHERE id=?').bind(await sha256Hex(rawToken),id).run();
      log('bank_account_api_token_updated', { bank_account_id: id, account_type: existing.account_type, api_token_prefix: updated.api_token_prefix });
      return jsonResponse(updated);
    }

    if ((input.fetch_enabled ?? false) && !existing.api_token_set) {
      return jsonResponse({ error: 'api_token_not_configured' }, 422);
    }

    const fetchPatch: { fetch_enabled: boolean; ingest_mode?: 'api' | 'both' } = {
      fetch_enabled: input.fetch_enabled ?? existing.api_fetch_enabled,
    };
    if (input.ingest_mode !== undefined) fetchPatch.ingest_mode = input.ingest_mode;
    const updated = await setBankAccountApiFetchEnabled(env.DB, id, fetchPatch);
    if (!updated) return jsonResponse({ error: 'not_found' }, 404);
    return jsonResponse(updated);
  }

  // DELETE /bank-accounts/:id/fio-token — clears the provider-neutral API token and disables polling.
  if (fioTokenMatch && req.method === 'DELETE') {
    const id = Number(fioTokenMatch[1]);
    const existing = await requireOwnedAccount(env, id, authCtx);
    if (existing instanceof Response) return existing;
    if (existing.account_type !== 'FIO') return jsonResponse({ error: 'fio_api_token_supported_only_for_fio' }, 400);
    const updated = await clearBankAccountApiToken(env.DB, id);
    if (!updated) return jsonResponse({ error: 'not_found' }, 404);
    log('bank_account_api_token_deleted', { bank_account_id: id, account_type: existing.account_type });
    return jsonResponse(updated);
  }

  // POST /bank-accounts/:id/fio-sync — manual sync for setup verification.
  const fioSyncMatch = url.pathname.match(/^\/bank-accounts\/(\d+)\/fio-sync$/);
  if (fioSyncMatch && req.method === 'POST') {
    const id = Number(fioSyncMatch[1]);
    const existing = await requireOwnedAccount(env, id, authCtx);
    if (existing instanceof Response) return existing;
    if (existing.account_type !== 'FIO') return jsonResponse({ error: 'fio_api_token_supported_only_for_fio' }, 400);

    const minIntervalS = apiMinIntervalS(env);
    if (!(await isBankAccountApiFetchDue(env.DB, id, minIntervalS))) {
      return jsonResponse({
        error: 'api_fetch_throttled',
        retry_after_s: minIntervalS,
        api_last_fetch_at: existing.api_last_fetch_at,
        api_last_success_at: existing.api_last_success_at,
        api_last_error: existing.api_last_error,
      }, 429, { 'Retry-After': String(minIntervalS) });
    }

    const account = await findBankAccountApiMaterials(env.DB, id);
    if (!account) return jsonResponse({ error: 'api_token_not_configured' }, 422);
    try {
      const result = await runBankApiSync(env, account);
      const updated = await findBankAccountById(env.DB, id);
      return jsonResponse({
        inserted: result.inserted,
        skipped_duplicate: result.skipped_duplicate,
        skipped_outgoing: result.skipped_outgoing,
        parse_errors: result.parse_errors,
        queued_webhooks: result.queued_webhooks,
        backfill: result.backfill,
        deferred: result.deferred,
        api_last_fetch_at: updated?.api_last_fetch_at ?? null,
        api_last_success_at: updated?.api_last_success_at ?? null,
        api_last_error: updated?.api_last_error ?? null,
        api_backfill_done: updated?.api_backfill_done ?? false,
      });
    } catch (err) {
      if (err instanceof FioReceivingAccountMismatch) {
        return jsonResponse({error:err.code,expected_account:err.expectedAccount,received_account:err.receivedAccount},422);
      }
      if (err instanceof FioTokenInvalidOrInactive) {
        return jsonResponse({ error: err.code, bank_http_status: err.status }, 422);
      }
      if (err instanceof FioRateLimited || err instanceof FioTransientFailure) {
        logError('fio_api_manual_sync_failed', err, { bank_account_id: id });
        return jsonResponse({ error: 'fio_api_transient_failure' }, 503);
      }
      throw err;
    }
  }

  // POST /bank-accounts/:id/regenerate-pairing — rotate pairing token
  const regenMatch = url.pathname.match(/^\/bank-accounts\/(\d+)\/regenerate-pairing$/);
  if (regenMatch && req.method === 'POST') {
    const id = Number(regenMatch[1]);
    const existing = await requireOwnedAccount(env, id, authCtx);
    if (existing instanceof Response) return existing;

    const newPairing = await generateUniquePairingCode(env.DB);
    const result = await cfIntent.regenerateRoute(env.DB, cfRoutingConfig(env), {
      id,
      existingCfRuleId: existing.cf_rule_id,
      newPairing,
    });
    if (!result.ok) return jsonResponse(result.body, result.status);
    return jsonResponse(result.account);
  }

  // POST /consumers — admin only
  if (url.pathname === '/consumers' && req.method === 'POST') {
    if (authCtx.type === 'tenant') return forbidden();
    const input = parseOr400(CreateConsumerSchema, bodyText);
    if (input instanceof Response) return input;
    const schemaVersion=await env.DB.prepare("SELECT value FROM schema_meta WHERE key='version'").first<{value:string}>();
    if(input.event_version==='2' && !['11','12','13'].includes(schemaVersion?.value??'')) return jsonResponse({error:'v2_requires_schema11'},409);
    let callbackUrl: string;
    try {
      callbackUrl = validateCallbackUrl(input.callback_url, { environment: env.ENV, allowlist: env.CALLBACK_HOST_ALLOWLIST });
    } catch (err) {
      if (err instanceof ValidationError) return jsonResponse({ error: err.message }, 400);
      throw err;
    }
    const plain = generateConsumerSecret();
    // secret_prefix: first 12 chars — captures 'whsec_' prefix + 6 chars of the key material
    const secretPrefix = plain.slice(0, 12);
    const secretHash = await sha256Hex(plain);
    const secretCipher = await webhookEncrypt(plain, env.WEBHOOK_KEK);
    const consumer = await createConsumer(env.DB, {
      app_id: input.app_id,
      event_version: input.event_version ?? '1',
      callback_url: callbackUrl,
      secret_cipher: secretCipher,
      secret_hash: secretHash,
      secret_prefix: secretPrefix,
    });
    // Issue tenant admin key on consumer creation
    const { plain: adminKeyPlain, prefix: adminKeyPrefix, hash: adminKeyHash } = await generateTenantAdminKey();
    await setConsumerAdminKey(env.DB, input.app_id, adminKeyHash, adminKeyPrefix);
    log('tenant_admin_key_issued', { app_id: input.app_id, admin_key_prefix: adminKeyPrefix });
    // Secret shown ONCE — log loudly
    log('consumer_secret_issued', { app_id: consumer.app_id, secret_prefix: secretPrefix });
    return jsonResponse({ app_id: consumer.app_id, callback_url: consumer.callback_url, secret: plain, admin_key: adminKeyPlain, admin_key_prefix: adminKeyPrefix }, 201, { 'Cache-Control': 'no-store' });
  }

  // GET /consumers — admin only
  if (url.pathname === '/consumers' && req.method === 'GET') {
    if (authCtx.type === 'tenant') return forbidden();
    const consumers = await listConsumers(env.DB);
    return jsonResponse(consumers);
  }

  // PUT /consumers/:app_id — admin or matching tenant (update callback_url)
  // DELETE /consumers/:app_id — admin only
  const deleteConsumerMatch = url.pathname.match(/^\/consumers\/([^/]+)$/);
  if (deleteConsumerMatch && req.method === 'PUT') {
    const appId = decodeURIComponent(deleteConsumerMatch[1]!);
    if (authCtx.type === 'tenant' && authCtx.app_id !== appId) return forbidden();
    const input = parseOr400(UpdateConsumerSchema, bodyText);
    if (input instanceof Response) return input;
    let callbackUrl: string;
    try {
      callbackUrl = validateCallbackUrl(input.callback_url, { environment: env.ENV, allowlist: env.CALLBACK_HOST_ALLOWLIST });
    } catch (err) {
      if (err instanceof ValidationError) return jsonResponse({ error: err.message }, 400);
      throw err;
    }
    const updated = await updateConsumer(env.DB, appId, { callback_url: callbackUrl });
    if (!updated) return jsonResponse({ error: 'not_found' }, 404);
    log('consumer_callback_updated', { app_id: appId });
    return jsonResponse(updated);
  }
  if (deleteConsumerMatch && req.method === 'DELETE') {
    if (authCtx.type === 'tenant') return forbidden();
    const appId = decodeURIComponent(deleteConsumerMatch[1]!);
    await deleteConsumer(env.DB, appId);
    return new Response(null, { status: 204 });
  }

  // POST /consumers/:app_id/rotate-secret — admin only
  const rotateMatch = url.pathname.match(/^\/consumers\/([^/]+)\/rotate-secret$/);
  if (rotateMatch && req.method === 'POST') {
    if (authCtx.type === 'tenant') return forbidden();
    const appId = decodeURIComponent(rotateMatch[1]!);
    const existing = await findConsumerByAppId(env.DB, appId);
    if (!existing) return jsonResponse({ error: 'consumer not found' }, 404);
    const newPlain = generateConsumerSecret();
    const newPrefix = newPlain.slice(0, 12);
    const newHash = await sha256Hex(newPlain);
    const newCipher = await webhookEncrypt(newPlain, env.WEBHOOK_KEK);
    const prevExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await rotateConsumerSecret(env.DB, appId, {
      newCipher,
      newHash,
      newPrefix,
      prevExpiresAt,
    });
    log('consumer_secret_rotated', { app_id: appId, secret_prefix: newPrefix });
    return jsonResponse({ secret: newPlain }, 200, { 'Cache-Control': 'no-store' });
  }

  // POST /consumers/:app_id/rotate-admin-key — admin OR matching tenant
  const rotateAdminMatch = url.pathname.match(/^\/consumers\/([a-z0-9][a-z0-9-_]{1,63})\/rotate-admin-key$/);
  if (rotateAdminMatch && req.method === 'POST') {
    const appId = rotateAdminMatch[1]!;
    if (authCtx.type === 'tenant' && authCtx.app_id !== appId) return forbidden();
    const consumer = await findConsumerByAppId(env.DB, appId);
    if (!consumer) return jsonResponse({ error: 'not_found' }, 404);
    const { plain, prefix, hash } = await generateTenantAdminKey();
    await setConsumerAdminKey(env.DB, appId, hash, prefix);
    log('tenant_admin_key_rotated', { app_id: appId, admin_key_prefix: prefix });
    return jsonResponse({ admin_key: plain, admin_key_prefix: prefix }, 200, { 'Cache-Control': 'no-store' });
  }

  // POST /subscriptions
  if (url.pathname === '/subscriptions' && req.method === 'POST') {
    const input = parseOr400(CreateSubscriptionSchema, bodyText);
    if (input instanceof Response) return input;
    // Tenant scope: can only subscribe their own app_id
    if (authCtx.type === 'tenant') {
      if (input.app_id !== authCtx.app_id) return forbidden();
      const account = await findBankAccountById(env.DB, input.bank_account_id);
      if (!account || account.owner_app_id !== authCtx.app_id) return forbidden();
    }
    let sub;
    try {
      sub = await createSubscription(env.DB, { app_id: input.app_id, bank_account_id: input.bank_account_id });
    } catch (err) {
      const msg = String(err);
      if (msg.includes('subscription_cap_reached')) return jsonResponse({ error: 'subscription_cap_reached' }, 422);
      throw err;
    }
    return jsonResponse(sub, 201);
  }

  // GET /subscriptions
  if (url.pathname === '/subscriptions' && req.method === 'GET') {
    const appId = authCtx.type === 'tenant' ? authCtx.app_id : (url.searchParams.get('app_id') ?? undefined);
    const bankAccountIdStr = url.searchParams.get('bank_account_id');
    const bankAccountId = bankAccountIdStr ? parseInt(bankAccountIdStr, 10) : undefined;
    const filters: { app_id?: string; bank_account_id?: number } = {};
    if (appId !== undefined) filters.app_id = appId;
    if (bankAccountId !== undefined) filters.bank_account_id = bankAccountId;
    const subs = await listSubscriptions(env.DB, filters);
    return jsonResponse(subs);
  }

  // DELETE /subscriptions/:id
  const deleteSubMatch = url.pathname.match(/^\/subscriptions\/(\d+)$/);
  if (deleteSubMatch && req.method === 'DELETE') {
    const id = parseInt(deleteSubMatch[1]!, 10);
    // Tenant can remove only its normal owner subscription. Cross-owner sharing
    // is created and removed by an administrator only.
    if (authCtx.type === 'tenant') {
      const sub = await env.DB.prepare(`
        SELECT s.consumer_app_id, b.owner_app_id
        FROM webhook_subscriptions s
        JOIN bank_accounts b ON b.id = s.bank_account_id
        WHERE s.id = ? AND s.deleted_at IS NULL
      `).bind(id).first<{ consumer_app_id: string; owner_app_id: string | null }>();
      if (!sub || sub.consumer_app_id !== authCtx.app_id || sub.owner_app_id !== authCtx.app_id) return forbidden();
    }
    await deleteSubscription(env.DB, id);
    return new Response(null, { status: 204 });
  }

  // POST /webhooks/replay
  if (url.pathname === '/webhooks/replay' && req.method === 'POST') {
    const input = parseOr400(ReplayWebhookSchema, bodyText);
    if (input instanceof Response) return input;

    if (input.delivery_id) {
      const job = await findDeliveryJob(env.DB, input.delivery_id);
      if (!job) return jsonResponse({ error: 'delivery_id not found' }, 404);
      if (authCtx.type === 'tenant' && job.consumer_app_id !== authCtx.app_id) return forbidden();
      const replay = await createWebhookDeliveryCoordinator(env).replay(job.id, { force: input.force ?? false });
      return jsonResponse({ queued: replay.queued, noop: replay.noop ?? null, previous_status: replay.previous_status ?? null, delivery_id: input.delivery_id, job_id: job.id });
    }

    if (input.tx_id) {
      // tx_id mode: ensure existing canonical jobs, then replay those exact IDs.
      const txRow = await env.DB.prepare(`SELECT t.id, b.owner_app_id FROM transactions t JOIN bank_accounts b ON b.id = t.bank_account_id WHERE t.id = ?`).bind(input.tx_id).first<{ id: number; owner_app_id: string | null }>();
      if (!txRow) return jsonResponse({ error: 'transaction not found' }, 404);
      if (authCtx.type === 'tenant' && txRow.owner_app_id !== authCtx.app_id) return forbidden();
      const coordinator = createWebhookDeliveryCoordinator(env);
      await ensureDeliveryJobs(env.DB, txRow.id);
      const jobs = (await findDeliveryJobsForTransaction(env.DB, txRow.id))
        .filter(job => authCtx.type !== 'tenant' || job.consumer_app_id === authCtx.app_id);
      const replayed = await Promise.all(jobs.map(job => coordinator.replay(job.id, { force: input.force ?? false })));
      return jsonResponse({ queued: replayed.some(result => result.queued), delivery_ids: replayed.flatMap(result => result.delivery_id ? [result.delivery_id] : []), tx_id: input.tx_id });
    }

    return jsonResponse({ error: 'unreachable' }, 500);
  }

  // GET /webhooks/deliveries — canonical delivery lifecycle, including
  // pending/queued/delivered/terminal state. There is no legacy DLQ reader.
  if (url.pathname === '/webhooks/deliveries' && req.method === 'GET') {
    const limitStr = url.searchParams.get('limit');
    const limit = limitStr ? Math.min(parseInt(limitStr, 10), 100) : 50;
    const cursorStr = url.searchParams.get('cursor');
    const cursor = cursorStr ? parseInt(cursorStr, 10) : undefined;
    // Tenant scope is enforced IN SQL before LIMIT — never filter-after-limit,
    // which would let a tenant page into another consumer's jobs.
    const entries = await DeliveryQueries.list(env.DB, {
      limit,
      ...(cursor !== undefined && !Number.isNaN(cursor) ? { cursor } : {}),
      ...(authCtx.type === 'tenant' ? { consumerAppId: authCtx.app_id } : {}),
    });
    const next_cursor = entries.length === limit ? entries[entries.length - 1]!.id : null;
    return jsonResponse({ jobs: entries, next_cursor });
  }

  // Account-scoped complete export. Caller persists both cursor and fixed
  // high-water value; newer rows never shift a cutover traversal.
  const exportMatch=url.pathname.match(/^\/bank-accounts\/(\d+)\/transaction-export$/);
  if(exportMatch && req.method==='GET') {
    const id=Number(exportMatch[1]);
    const account=await requireOwnedAccount(env,id,authCtx);
    if(account instanceof Response) return account;
    const maximum=await env.DB.prepare('SELECT COALESCE(MAX(id),0) AS id FROM transactions WHERE bank_account_id=?').bind(id).first<{id:number}>();
    const high=Number(url.searchParams.get('high_water') ?? maximum?.id ?? 0);
    const cursor=Number(url.searchParams.get('cursor') ?? 0);
    const limit=Number(url.searchParams.get('limit') ?? 200);
    if(!Number.isSafeInteger(high)||high<0||!Number.isSafeInteger(cursor)||cursor<0||!Number.isSafeInteger(limit)||limit<1||limit>200) return jsonResponse({error:'invalid_cursor'},400);
    const rows=await env.DB.prepare('SELECT * FROM transactions WHERE bank_account_id=? AND id>? AND id<=? ORDER BY id LIMIT ?').bind(id,cursor,high,limit).all<Transaction>();
    return jsonResponse({bank_account_id:id,high_water:high,cursor:rows.results.at(-1)?.id ?? cursor,complete:rows.results.length<limit,transactions:rows.results});
  }
  // Historical missing intents are explicit, admin-only and limited to one
  // consumer/account/window. Existing archived payloads are never rewritten.
  if(url.pathname==='/admin/cutover-reconcile' && req.method==='POST') {
    if(authCtx.type!=='admin') return forbidden();
    let input;try{input=JSON.parse(bodyText);}catch{return jsonResponse({error:'invalid_json'},400);}
    if(typeof input.manifest_sha256!=='string'||!/^[0-9a-f]{64}$/.test(input.manifest_sha256)||typeof input.consumer_app_id!=='string'
      ||![input.account_id,input.from_id,input.through_id].every(n=>Number.isSafeInteger(n)&&n>0)||input.through_id<input.from_id) return jsonResponse({error:'invalid_manifest_window'},400);
    const account=await findBankAccountById(env.DB,input.account_id);
    if(account?.owner_app_id!==input.consumer_app_id) return forbidden();
    const created=await ensureDeliveryJobs(env.DB,undefined,{accountId:input.account_id,consumerAppId:input.consumer_app_id,fromId:input.from_id,throughId:input.through_id});
    await writeEvent(env.DB,{event_type:'cutover_reconcile',bank_account_id:input.account_id,detail:{consumer:input.consumer_app_id,manifest_sha256:input.manifest_sha256,from_id:input.from_id,through_id:input.through_id,created}});
    return jsonResponse({created});
  }

  // GET /transactions
  if (url.pathname === '/transactions' && req.method === 'GET') {
    const since = url.searchParams.get('since') ?? new Date(0).toISOString();
    const limitStr = url.searchParams.get('limit');
    const limit = limitStr ? Math.min(parseInt(limitStr, 10), 200) : 50;
    return jsonResponse(await listTransactions(env.DB, since, limit, authCtx.type === 'tenant' ? authCtx.app_id : undefined));
  }

  // GET /parse-log
  if (url.pathname === '/parse-log' && req.method === 'GET') {
    const since = url.searchParams.get('since') ?? new Date(0).toISOString();
    const limitStr = url.searchParams.get('limit');
    const limit = limitStr ? Math.min(parseInt(limitStr, 10), 200) : 50;
    return jsonResponse(await listParseLog(env.DB, since, limit, authCtx.type === 'tenant' ? authCtx.app_id : undefined));
  }

  // GET /webhook-log
  if (url.pathname === '/webhook-log' && req.method === 'GET') {
    const since = url.searchParams.get('since') ?? new Date(0).toISOString();
    const limitStr = url.searchParams.get('limit');
    const limit = limitStr ? Math.min(parseInt(limitStr, 10), 200) : 50;
    return jsonResponse(await listWebhookLog(env.DB, since, limit, authCtx.type === 'tenant' ? authCtx.app_id : undefined));
  }

  // GET /unmatched-mails — emails that didn't route to any bank account.
  if (url.pathname === '/unmatched-mails' && req.method === 'GET') {
    const since = url.searchParams.get('since') ?? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const limitStr = url.searchParams.get('limit');
    const limit = limitStr ? Math.min(parseInt(limitStr, 10), 200) : 50;
    const rows = await listUnmatchedMails(env.DB, since, limit);
    // Tenant sees no unmatched mails (bank_account_id is null on these rows — no way to filter)
    const filtered = authCtx.type === 'tenant' ? [] : rows;
    return jsonResponse(filtered);
  }

  // GET /admin/audit-cf-rules — admin only
  if (url.pathname === '/admin/audit-cf-rules' && req.method === 'GET') {
    if (authCtx.type !== 'admin') return forbidden();
    const result = await auditCfRoutingDrift({ db: env.DB, cf: cfRoutingConfig(env) });
    return jsonResponse(result);
  }

  // GET /admin/audit-log — admin only
  if (url.pathname === '/admin/audit-log' && req.method === 'GET') {
    if (authCtx.type !== 'admin') return forbidden();
    const sinceParam = url.searchParams.get('since');
    const principalParam = url.searchParams.get('principal');
    const limitRaw = url.searchParams.get('limit');
    const limit = limitRaw ? Math.min(parseInt(limitRaw, 10), 500) : 50;
    const auditArgs: Parameters<typeof listAuditLog>[1] = { limit };
    if (sinceParam !== null) auditArgs.since = sinceParam;
    if (principalParam !== null) auditArgs.authPrincipal = principalParam;
    const rows = await listAuditLog(env.DB, auditArgs);
    return jsonResponse(rows);
  }

  // POST /admin/process-outbox — admin only. On-demand reconciler trigger.
  // Useful for: E2E tests, incident recovery, drift cleanup outside of cron schedule.
  if (url.pathname === '/admin/process-outbox' && req.method === 'POST') {
    if (authCtx.type !== 'admin') return forbidden();
    const result = await processOutbox(env.DB, cfRoutingConfig(env));
    return jsonResponse(result);
  }

  // DELETE /admin/cf-rules/:rule_id — admin only. Force-removes a
  // Cloudflare email routing rule that audit-cf-rules surfaced as an
  // orphan (CF has it but D1 does not). Uses the worker's own
  // CF_API_TOKEN which has email-routing write scope.
  {
    const orphanMatch = url.pathname.match(/^\/admin\/cf-rules\/([A-Za-z0-9]+)$/);
    if (orphanMatch && req.method === 'DELETE') {
      if (authCtx.type !== 'admin') return forbidden();
      const ruleId = orphanMatch[1]!;
      await cfDeleteRule(cfRoutingConfig(env), ruleId);
      return jsonResponse({ deleted: true, rule_id: ruleId });
    }
  }

  // POST /admin/outbox/clear-stuck — admin only. Deletes every
  // cf_routing_outbox row stuck on CF 409 (duplicate zone rule from
  // a prior e2e run that didn't clean up) so the drift detector
  // reads zero. The audit lists rows in {pending, failed}, so flipping
  // status is not enough — the row has to disappear. Idempotent:
  // re-running on a clean outbox is a no-op.
  if (url.pathname === '/admin/outbox/clear-stuck' && req.method === 'POST') {
    if (authCtx.type !== 'admin') return forbidden();
    const cleared = await cfIntent.clearStuckOutbox(env.DB);
    return jsonResponse({ cleared });
  }

  return notFound();
}

// ---- Worker export ----

export default {
  async email(message: ForwardableEmailMessage, env: Env, _ctx: ExecutionContext) {
    await assertSchemaVersion(env.DB);

    // Step 0: size guard (BEFORE postal-mime)
    if (message.rawSize > 5 * 1024 * 1024) {
      await insertParseLog(env.DB, {
        error_message: `email_too_large: ${message.rawSize}`,
        raw_data: '(truncated, oversized email — first 4KB unavailable, body never read)',
      });
      log('email_rejected_oversized', { size: message.rawSize });
      return;
    }

    const trustedAuthservId = env.EMAIL_AUTHSERV_ID?.trim();
    if (!trustedAuthservId) {
      const inspection = inspectAuthenticationResults(message.headers.get('authentication-results'));
      await insertParseLog(env.DB, { error_message: 'email_ingest_disabled_untrusted_authserv', raw_data: null });
      log('email_rejected_authentication', {
        reason: 'trusted_authserv_not_configured',
        authentication_results_present: message.headers.has('authentication-results'),
        observed_authserv_id: inspection.observedAuthservId,
        authentication_results_ambiguous: inspection.ambiguous,
      });
      return;
    }
    await processEmail(message.raw as unknown as ReadableStream<Uint8Array>, env, {
      mailFrom: message.from,
      rcptTo: message.to,
      authenticationResults: message.headers.get('authentication-results'),
      trustedAuthservId,
    });
  },

  async fetch(req: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    try {
      return await adminFetch(req, env);
    } catch (err) {
      const requestId = crypto.randomUUID();
      logError('admin_fetch_error', err, { request_id: requestId });
      return jsonResponse({ error: 'internal_error', request_id: requestId }, 500);
    }
  },

  async queue(batch: MessageBatch<unknown>, env: Env, _ctx: ExecutionContext) {
    await assertSchemaVersion(env.DB);
    if (batch.queue === 'banksync-api-sync') {
      await handleApiSyncQueue(batch, env);
      return;
    }
    await handleQueueBatch(batch as MessageBatch<WebhookQueueMessage>, env);
  },

  async scheduled(event: ScheduledEvent, env: Env, _ctx: ExecutionContext) {
    await assertSchemaVersion(env.DB);
    if(await recoveryMaintenanceEnabled(env.DB)) {log('recovery_maintenance_tick_deferred',{});return;}
    const runPolling = shouldRunApiPolling(event);
    const runMaintenance = shouldRunMaintenance(event);
    const runReconciliation = runPolling && shouldRunReconciliation(event);

    if (runMaintenance) {
      try {
        const result = await pruneRetention(env.DB);
        log('retention_pruned', {
          parse_log_deleted: result.parse_log_deleted,
          webhook_log_deleted: result.webhook_log_deleted,
          event_log_deleted: result.event_log_deleted,
          transactions_deleted: result.transactions_deleted,
          idempotency_keys_deleted: result.idempotency_keys_deleted,
          admin_audit_log_deleted: result.admin_audit_log_deleted,
          expired_prev_secrets_cleared: result.expired_prev_secrets_cleared,
          recovery_payloads_cleared:result.recovery_payloads_cleared,recovery_batches_deleted:result.recovery_batches_deleted,
          email_payloads_cleared:result.email_payloads_cleared,email_spool_deleted:result.email_spool_deleted,
        });
      } catch (err) {
        logError('retention_failed', err, {});
        throw err;
      }
    }

    if (runPolling) {
      // Process CF outbox — picks up failed syncs from last tick
      try {
        const outboxResult = await processOutbox(env.DB, cfRoutingConfig(env));
        log('outbox_processed', outboxResult);
      } catch (err) {
        logError('outbox_process_failed', err, {});
      }

    }

    if (runReconciliation) {
      try { await pruneCompletedRecovery(env.DB); }
      catch(err) { logError('recovery_retention_failed',err,{}); }
      const recoverySchema = await env.DB.prepare("SELECT value FROM schema_meta WHERE key='version'").first<{value:string}>();
      if(env.AUTHENTICATED_EMAIL_SPOOL==='on' && env.BACKUPS) {
        const cursor=await env.DB.prepare("SELECT value FROM schema_meta WHERE key='email_spool_cursor'").first<{value:string}>();
        const page=await env.BACKUPS.list({prefix:'authenticated-email-pending/',limit:10,...(cursor?.value ? {cursor:cursor.value} : {})});
        for(const object of page.objects) {
          try {
            if(recoverySchema?.value==='13') {
              const disposition=await emailR2Disposition(env.DB,object.key);
              if(disposition==='delete') {await env.BACKUPS.delete(object.key);continue;}
              if(disposition==='retain') continue;
            }
            const stored=await env.BACKUPS.get(object.key);if(!stored) continue;
            const encrypted=JSON.parse(await stored.text());
            const message=JSON.parse(await decryptSecret(encrypted.cipher,encrypted.keyVersion,env));
            const bytes=Uint8Array.from(atob(message.bytesBase64),c=>c.charCodeAt(0));
            await processEmail(new Blob([bytes]).stream(),env,message.envelope);
          } catch { log('authenticated_email_recovery_pending',{spool_key:object.key}); }
        }
        await env.DB.prepare("INSERT INTO schema_meta(key,value) VALUES('email_spool_cursor',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(page.truncated?page.cursor:'').run();
      }
      const schema = await env.DB.prepare("SELECT value FROM schema_meta WHERE key='version'").first<{value:string}>();
      if(['11','12','13'].includes(schema?.value??'')) {
        const pending = await env.DB.prepare(schema?.value==='13'
          ? "SELECT id,cipher,key_version FROM authenticated_email_spool WHERE state='pending' AND datetime(next_attempt_at)<=datetime('now') AND (claim_until IS NULL OR datetime(claim_until)<=datetime('now')) ORDER BY next_attempt_at,created_at,id LIMIT 10"
          : "SELECT id,cipher,key_version FROM authenticated_email_spool WHERE state='pending' ORDER BY attempts,created_at LIMIT 10").all<{id:string;cipher:string;key_version:number}>();
        for(const row of pending.results) {
          try {
            if(schema?.value!=='13') await env.DB.prepare('UPDATE authenticated_email_spool SET attempts=attempts+1 WHERE id=?').bind(row.id).run();
            const message=JSON.parse(await decryptSecret(row.cipher,row.key_version,env));
            const restored=Uint8Array.from(atob(message.bytesBase64),c=>c.charCodeAt(0));
          await processEmail(new Blob([restored]).stream(),env,message.envelope);
          } catch { log('email_recovery_pending',{spool_id:row.id}); }
        }
      }
      // Durable webhook healing runs independently of a new bank event. It
      // derives jobs first, so a transaction committed before a failed
      // queue.send is recovered within the bounded reconciliation interval.
      try {
        const swept = await createWebhookDeliveryCoordinator(env).sweep();
        if (swept.created > 0 || swept.considered > 0) {
          log('webhook_delivery_sweep', { created: swept.created, considered: swept.considered, queued: swept.queued, failed: swept.failed });
        }
      } catch (err) {
        logError('webhook_delivery_sweep_failed', err, {});
      }
    }

    if (runMaintenance) {
      // Rate-limit bucket cleanup
      try {
        await pruneOldBuckets(env.DB);
      } catch (err) {
        logError('rate_limit_prune_failed', err, {});
      }
    }

    if (runPolling) {
      // Bank API polling. Cron can only run once per minute, so production uses
      // a delayed queue tick to maintain 30s cadence while retaining cron as a reseed.
      try {
        if (await enqueueApiSyncTick(env, 0, 'cron')) {
          log('api_sync_tick_enqueued', { delay_seconds: 0, source: 'cron' });
        } else {
          await runDueBankApiSyncs(env);
        }
      } catch (err) {
        logError('api_sync_tick_failed', err, {});
      }
    }

    // Weekly backup (Sundays only)
    const dayOfWeek = new Date().getUTCDay();
    if (runMaintenance && dayOfWeek === 0 && env.BACKUPS) {
      try {
        const version = Number(env.BACKUP_ENCRYPTION_KEY_VERSION ?? '');
        const encryptionKey = Number.isInteger(version)
          ? env[`BACKUP_ENCRYPTION_KEY_V${version}` as 'BACKUP_ENCRYPTION_KEY_V1' | 'BACKUP_ENCRYPTION_KEY_V2']
          : undefined;
        const backup = await runBackupTick(env.DB, { bucket: env.BACKUPS, prefix: 'banksync', retain: 8, encryptionKey, keyVersion: version });
        if(backup.uploaded) await env.DB.prepare("INSERT INTO schema_meta(key,value) VALUES('last_backup_at',datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
        log('backup_tick', { uploaded: backup.uploaded, key: backup.key ?? null, size_bytes: backup.size_bytes ?? null });
      } catch (err) {
        logError('backup_tick_failed', err, {});
      }
    }
  },
};
