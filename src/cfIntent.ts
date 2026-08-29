import type { D1Database } from '@cloudflare/workers-types';
import type { BankAccount } from './types';
import type { CfRoutingConfig } from './cf_routing';
import { createRule as cfCreateRule, safeDeleteRule as cfSafeDeleteRule, CfRoutingError } from './cf_routing';
import { enqueueDelete, markCompleted, markFailureAttempt } from './outbox';
import { regenerateBankAccountPairing } from './db';
import { logError } from './logger';

/**
 * cfIntent — the Cloudflare Email Routing choreography the HTTP layer used to
 * inline: outbox write-back + synchronous rule create/delete + the regenerate
 * create-before-delete dance. The cf_routing + outbox leaves remain the single
 * source of the actual CF API calls and table writes; cfIntent only sequences
 * them, keeping that I/O orchestration out of the 1600-line request dispatcher.
 *
 * Note the deliberately DIFFERENT failure semantics per route:
 *   - provisionRoute  DEFERS on CF failure (account already created → still 201)
 *   - regenerateRoute HARD-FAILS on CF failure (no new rule → 503/500, no mutate)
 * A single uniform helper would distort these, so they stay distinct.
 */

/**
 * Best-path CF rule provision for a freshly created account. The caller enqueues
 * the outbox row BEFORE the DB mutate (paper trail); here we stamp it with the
 * real bank_account_id and try the CF API. On failure we record a retry attempt
 * and DEFER to the reconciler — the caller still returns 201. Returns the new
 * cf_rule_id, or null when CF is unavailable / the create was deferred.
 */
export async function provisionRoute(
  db: D1Database,
  cfg: CfRoutingConfig,
  args: { outboxId: number; pairing: string; bankAccountId: number },
): Promise<string | null> {
  // Stamp the outbox row with the real bank_account_id now that we have it.
  await db.prepare(`UPDATE cf_routing_outbox SET bank_account_id = ? WHERE id = ?`).bind(args.bankAccountId, args.outboxId).run();
  try {
    const cfRuleId = await cfCreateRule(cfg, args.pairing);
    await markCompleted(db, args.outboxId, cfRuleId);
    return cfRuleId;
  } catch (err) {
    await markFailureAttempt(db, args.outboxId, String(err));
    logError('cf_routing_create_deferred', err, { bank_account_id: args.bankAccountId });
    // Don't throw — DB row exists, reconciler will retry; client gets 201.
    return null;
  }
}

/**
 * Tear down the CF rule for a deleted account: record the delete intent in the
 * outbox, then fire a best-effort synchronous delete (NOT awaited — the outbox
 * reconciler is the durable path; a transient CF failure must not block the
 * account delete).
 */
export async function deprovisionRoute(db: D1Database, cfg: CfRoutingConfig, cfRuleId: string): Promise<void> {
  await enqueueDelete(db, { cf_rule_id: cfRuleId });
  // best-effort sync delete
  cfSafeDeleteRule(cfg, cfRuleId).catch(err => {
    logError('cf_routing_delete_deferred', err, { cf_rule_id: cfRuleId });
  });
}

export type RegenerateResult =
  | { ok: true; account: BankAccount }
  | { ok: false; status: number; body: Record<string, unknown> };

/**
 * Zero-downtime pairing rotation: create the NEW CF rule FIRST (so no inbound
 * mail lands nowhere), then swap the DB pairing, then best-effort delete the OLD
 * rule. CF create here is hard-fail (unlike provisionRoute's defer) — without the
 * new rule the rotation can't proceed, so we 503/500 and leave the account
 * untouched. Any failure AFTER the new rule exists rolls it back.
 */
export async function regenerateRoute(
  db: D1Database,
  cfg: CfRoutingConfig,
  args: { id: number; existingCfRuleId: string | null; newPairing: string },
): Promise<RegenerateResult> {
  // Create new CF rule first so there's no window where the new pairing email has nowhere to land.
  let newCfRuleId: string | null = null;
  try {
    newCfRuleId = await cfCreateRule(cfg, args.newPairing);
  } catch (err) {
    logError('cf_routing_create_failed_on_regen', err, { id: args.id, pairing_code: args.newPairing });
    const status = err instanceof CfRoutingError ? 503 : 500;
    return { ok: false, status, body: { error: 'cf_routing_create_failed', detail: String(err) } };
  }

  let account: BankAccount | null;
  try {
    account = await regenerateBankAccountPairing(db, args.id, args.newPairing, newCfRuleId);
  } catch (err) {
    if (newCfRuleId) await cfSafeDeleteRule(cfg, newCfRuleId);
    throw err;
  }
  if (!account) {
    // Race: row deleted between the caller's lookup and this update. Roll back the new CF rule.
    if (newCfRuleId) await cfSafeDeleteRule(cfg, newCfRuleId);
    return { ok: false, status: 404, body: { error: 'not_found' } };
  }

  // Old CF rule cleanup — best-effort.
  if (args.existingCfRuleId) {
    await cfSafeDeleteRule(cfg, args.existingCfRuleId);
  }
  return { ok: true, account };
}

/**
 * Drop every cf_routing_outbox row wedged on a CF 409 (duplicate zone rule left
 * by a prior e2e run). The drift audit lists {pending, failed} rows, so the row
 * has to disappear, not just flip status. Idempotent. Returns the count cleared.
 */
export async function clearStuckOutbox(db: D1Database): Promise<number> {
  const result = await db.prepare(
    `DELETE FROM cf_routing_outbox
       WHERE last_error LIKE '%409%'
         AND attempts >= 2
         AND status IN ('pending', 'failed')`
  ).run();
  return result.meta.changes ?? 0;
}
