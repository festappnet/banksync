import type { D1Database } from '@cloudflare/workers-types';
import type { CfRoutingConfig } from './cf_routing';
import { createRule, deleteRule, CfRoutingError, cfRoutingEnabled } from './cf_routing';
import { log, logError } from './logger';

export type OutboxOp = 'create' | 'delete';
export type OutboxStatus = 'pending' | 'completed' | 'failed';

export interface OutboxRow {
  id: number;
  op: OutboxOp;
  pairing_code: string | null;
  cf_rule_id: string | null;
  bank_account_id: number | null;
  status: OutboxStatus;
  attempts: number;
  last_error: string | null;
  next_attempt_at: string;
  created_at: string;
  completed_at: string | null;
}

const MAX_ATTEMPTS = 10;

/** backoff: min(60 * 2^(attempts-1), 3600). 60s, 2min, 4min, 8min, 16min, 32min, 60min cap. */
export function nextAttemptAt(attempts: number): string {
  const seconds = Math.min(60 * Math.pow(2, attempts - 1), 3600);
  return new Date(Date.now() + seconds * 1000).toISOString().replace('T', ' ').replace(/\..+$/, '');
}

export async function enqueueCreate(db: D1Database, args: {
  pairing_code: string;
  bank_account_id: number;
}): Promise<number> {
  const row = await db
    .prepare(`INSERT INTO cf_routing_outbox (op, pairing_code, bank_account_id) VALUES ('create', ?, ?) RETURNING id`)
    .bind(args.pairing_code, args.bank_account_id)
    .first<{ id: number }>();
  if (!row) throw new Error('enqueueCreate: no row returned');
  return row.id;
}

export async function enqueueDelete(db: D1Database, args: {
  cf_rule_id: string;
}): Promise<number> {
  const row = await db
    .prepare(`INSERT INTO cf_routing_outbox (op, cf_rule_id) VALUES ('delete', ?) RETURNING id`)
    .bind(args.cf_rule_id)
    .first<{ id: number }>();
  if (!row) throw new Error('enqueueDelete: no row returned');
  return row.id;
}

export async function markCompleted(db: D1Database, outboxId: number, cfRuleIdForCreate?: string | null): Promise<void> {
  const outboxUpdate = db.prepare(
    `UPDATE cf_routing_outbox SET status = 'completed', completed_at = datetime('now'), cf_rule_id = COALESCE(?, cf_rule_id) WHERE id = ?`
  ).bind(cfRuleIdForCreate ?? null, outboxId);

  if (cfRuleIdForCreate) {
    // Also write back cf_rule_id to bank_accounts for create ops
    const row = await db
      .prepare(`SELECT bank_account_id FROM cf_routing_outbox WHERE id = ?`)
      .bind(outboxId)
      .first<{ bank_account_id: number | null }>();
    const bankAccountId = row?.bank_account_id ?? null;
    if (bankAccountId !== null) {
      const bankUpdate = db.prepare(
        `UPDATE bank_accounts SET cf_rule_id = ? WHERE id = ?`
      ).bind(cfRuleIdForCreate, bankAccountId);
      await db.batch([outboxUpdate, bankUpdate]);
      return;
    }
  }

  await outboxUpdate.run();
}

export async function markFailureAttempt(db: D1Database, outboxId: number, error: string): Promise<void> {
  const row = await db
    .prepare(`SELECT attempts FROM cf_routing_outbox WHERE id = ?`)
    .bind(outboxId)
    .first<{ attempts: number }>();
  const currentAttempts = row?.attempts ?? 0;
  const newAttempts = currentAttempts + 1;
  const nextAt = nextAttemptAt(newAttempts);
  const newStatus: OutboxStatus = newAttempts >= MAX_ATTEMPTS ? 'failed' : 'pending';
  await db
    .prepare(`UPDATE cf_routing_outbox SET attempts = ?, last_error = ?, next_attempt_at = ?, status = ? WHERE id = ?`)
    .bind(newAttempts, error, nextAt, newStatus, outboxId)
    .run();
}

export async function fetchDuePending(db: D1Database, limit = 50): Promise<OutboxRow[]> {
  const result = await db
    .prepare(`SELECT * FROM cf_routing_outbox WHERE status = 'pending' AND next_attempt_at <= datetime('now') ORDER BY id LIMIT ?`)
    .bind(limit)
    .all<OutboxRow>();
  return result.results;
}

async function currentCreateTarget(
  db: D1Database,
  row: OutboxRow,
): Promise<{ pairing_code: string; cf_rule_id: string | null } | null> {
  if (row.bank_account_id === null) return null;
  return db
    .prepare(`SELECT pairing_code, cf_rule_id FROM bank_accounts WHERE id = ?`)
    .bind(row.bank_account_id)
    .first<{ pairing_code: string; cf_rule_id: string | null }>();
}

async function claimCreatedRule(
  db: D1Database,
  row: OutboxRow,
  ruleId: string,
): Promise<boolean> {
  if (row.bank_account_id === null || !row.pairing_code) return false;
  const claimed = await db
    .prepare(`UPDATE bank_accounts
      SET cf_rule_id = ?
      WHERE id = ? AND pairing_code = ? AND cf_rule_id IS NULL
      RETURNING id`)
    .bind(ruleId, row.bank_account_id, row.pairing_code)
    .first<{ id: number }>();
  return claimed !== null;
}

export async function processOutbox(db: D1Database, cfg: CfRoutingConfig): Promise<{
  attempted: number;
  succeeded: number;
  failed_attempt: number;
  exhausted: number;
}> {
  const counts = { attempted: 0, succeeded: 0, failed_attempt: 0, exhausted: 0 };

  if (!cfRoutingEnabled(cfg)) {
    log('outbox_skipped', { reason: 'CF_API_TOKEN unset' });
    return counts;
  }

  const rows = await fetchDuePending(db);

  for (const row of rows) {
    counts.attempted++;
    try {
      if (row.op === 'create') {
        if (!row.pairing_code || row.bank_account_id === null) {
          await markFailureAttempt(db, row.id, 'outbox_create_missing_pairing_code');
          counts.failed_attempt++;
          if ((row.attempts + 1) >= MAX_ATTEMPTS) counts.exhausted++;
          continue;
        }

        const target = await currentCreateTarget(db, row);
        if (!target || target.pairing_code !== row.pairing_code) {
          // The account was deleted or rotated while this deferred intent was
          // waiting. Completing without an external create prevents an orphan.
          await markCompleted(db, row.id);
          log('outbox_create_cancelled', { outbox_id: row.id, reason: 'stale_target' });
          counts.succeeded++;
          continue;
        }
        if (target.cf_rule_id) {
          // A concurrent/synchronous provision already won.
          await markCompleted(db, row.id, target.cf_rule_id);
          counts.succeeded++;
          continue;
        }

        const ruleId = await createRule(cfg, row.pairing_code);
        if (!ruleId) throw new Error('outbox_create_missing_rule_id');
        if (!await claimCreatedRule(db, row, ruleId)) {
          // The target vanished or changed after the preflight but before the
          // Cloudflare response. Compensate immediately instead of leaking a
          // routing rule with no owning DB row.
          await deleteRule(cfg, ruleId);
          await markCompleted(db, row.id);
          log('outbox_create_cancelled', { outbox_id: row.id, reason: 'lost_claim' });
          counts.succeeded++;
          continue;
        }
        await markCompleted(db, row.id, ruleId);
        log('outbox_create_succeeded', { outbox_id: row.id, pairing_code: row.pairing_code });
        counts.succeeded++;
      } else {
        // op === 'delete'
        if (!row.cf_rule_id) {
          await markFailureAttempt(db, row.id, 'outbox_delete_missing_cf_rule_id');
          counts.failed_attempt++;
          if ((row.attempts + 1) >= MAX_ATTEMPTS) counts.exhausted++;
          continue;
        }
        await deleteRule(cfg, row.cf_rule_id);
        await markCompleted(db, row.id);
        log('outbox_delete_succeeded', { outbox_id: row.id, cf_rule_id: row.cf_rule_id });
        counts.succeeded++;
      }
    } catch (err) {
      // 404 on delete is handled by deleteRule (idempotent) — so it won't reach here.
      // Any other CF error → schedule retry.
      const errMsg = err instanceof CfRoutingError
        ? `CF ${err.status}: ${err.message}`
        : String(err);
      logError('outbox_op_failed', err, { outbox_id: row.id, op: row.op });
      const prevAttempts = row.attempts;
      await markFailureAttempt(db, row.id, errMsg);
      counts.failed_attempt++;
      if ((prevAttempts + 1) >= MAX_ATTEMPTS) counts.exhausted++;
    }
  }

  if (counts.attempted > 0) {
    log('outbox_reconcile_done', {
      attempted: counts.attempted,
      succeeded: counts.succeeded,
      failed_attempt: counts.failed_attempt,
      exhausted: counts.exhausted,
    });
  }

  return counts;
}
