import type { D1Database } from '@cloudflare/workers-types';
import { SQL_PARSE_FAILURES_24H, SQL_TX_INSERTED_24H, SQL_UNMATCHED_24H } from './db';

/** Facts only. Thresholds and incident delivery belong to the external monitor. */
export async function readOperationsProbe(db: D1Database) {
  const schema = await db.prepare("SELECT value FROM schema_meta WHERE key='version'").first<{ value: string }>();
  if (schema?.value !== '13') throw new Error('operations_schema_unavailable');
  const [recovery, email, api, delivery, metadata, allocation, failures, inserted, unmatched] = await Promise.all([
    db.prepare(`SELECT count(CASE WHEN recovery_stage<>'quarantined' THEN 1 END) recovery_open,
      coalesce(max(CASE WHEN recovery_stage<>'quarantined' THEN max(0,unixepoch('now')-unixepoch(created_at)) END),0) recovery_oldest_age_s,
      count(CASE WHEN recovery_stage='quarantined' THEN 1 END) recovery_quarantined
      FROM bank_recovery_batches WHERE state<>'completed'`).first<Record<string, number>>(),
    db.prepare(`SELECT count(CASE WHEN state='pending' THEN 1 END) email_pending,
      count(CASE WHEN state='quarantined' THEN 1 END) email_quarantined,
      coalesce(max(CASE WHEN state='pending' THEN max(0,unixepoch('now')-unixepoch(created_at)) END),0) email_oldest_age_s
      FROM authenticated_email_spool WHERE state<>'completed'`).first<Record<string, number>>(),
    db.prepare(`SELECT count(*) api_accounts,
      count(CASE WHEN api_last_success_at IS NULL THEN 1 END) api_never_succeeded,
      coalesce(max(max(0,unixepoch('now')-unixepoch(api_last_success_at))),0) api_freshness_age_s
      FROM bank_accounts WHERE api_fetch_enabled=1 AND ingest_enabled=1 AND ingest_mode IN ('api','both')`).first<Record<string, number>>(),
    db.prepare(`SELECT count(CASE WHEN j.status='terminal' THEN 1 END) delivery_terminal,
      count(CASE WHEN j.status IN ('pending','dispatching','queued') THEN 1 END) delivery_pending,
      coalesce(max(CASE WHEN j.status IN ('pending','dispatching','queued') THEN max(0,unixepoch('now')-unixepoch(j.created_at)) END),0) delivery_oldest_age_s
      FROM webhook_delivery_jobs j JOIN transactions t ON t.id=j.transaction_id
      JOIN webhook_subscriptions s ON s.bank_account_id=t.bank_account_id AND s.consumer_app_id=j.consumer_app_id
      WHERE s.deleted_at IS NULL AND j.status<>'delivered'`).first<Record<string, number>>(),
    db.prepare(`SELECT key,value FROM schema_meta WHERE key IN ('recovery_maintenance','last_maintenance_at','last_backup_at','db_size_sample','db_size_previous_sample')`).all<{ key: string; value: string }>(),
    db.prepare('SELECT 1').all(),
    db.prepare(SQL_PARSE_FAILURES_24H).first<{ cnt: number }>(),
    db.prepare(SQL_TX_INSERTED_24H).first<{ cnt: number }>(),
    db.prepare(SQL_UNMATCHED_24H).first<{ cnt: number }>(),
  ]);
  const meta = new Map(metadata.results.map(row => [row.key, row.value]));
  const now = Date.now();
  const age = (key: string) => {
    const raw = meta.get(key);
    const value = raw ? Date.parse(raw.includes('T') ? raw : `${raw.replace(' ', 'T')}Z`) : NaN;
    return Number.isFinite(value) ? Math.max(0, Math.floor((now - value) / 1000)) : null;
  };
  let growth: number | null = null;
  try {
    const current = JSON.parse(meta.get('db_size_sample') ?? 'null');
    const prior = JSON.parse(meta.get('db_size_previous_sample') ?? 'null');
    const interval = current && prior ? Date.parse(current.at) - Date.parse(prior.at) : 0;
    if (interval >= 3600000 && Number.isFinite(current.bytes) && Number.isFinite(prior.bytes)) {
      growth = Math.round((current.bytes - prior.bytes) * 86400000 / interval);
    }
  } catch { /* Missing/invalid sampling evidence is unknown, never healthy zero. */ }
  return {
    major: 1 as const,
    observed_at: now,
    metrics: {
      ...recovery!, ...email!, ...api!, ...delivery!,
      parse_failures_24h: failures!.cnt, tx_inserted_24h: inserted!.cnt, unmatched_24h: unmatched!.cnt,
      recovery_maintenance: meta.get('recovery_maintenance') === 'on' ? 1 : 0,
      maintenance_age_s: age('last_maintenance_at'), backup_age_s: age('last_backup_at'),
      db_size_bytes: allocation.meta.size_after, db_growth_bytes_per_day: growth,
    },
  };
}
