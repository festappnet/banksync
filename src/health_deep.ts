import type { D1Database, Queue } from '@cloudflare/workers-types';
import type { CfRoutingConfig } from './cf_routing';
import { cfRoutingEnabled } from './cf_routing';

export type HealthStatus = 'green' | 'yellow' | 'red';

export interface DeepHealthResult {
  status: HealthStatus;
  components: {
    db_read: HealthStatus;
    db_write: HealthStatus;
    queue_producer: HealthStatus;
    cf_api: HealthStatus;
    outbox_drift: HealthStatus;
    /** Existence (never value) of ALERT_WEBHOOK_URL + BACKUPS. Red in production
     * when either is missing — a silent "alerter/backup disabled" is a release blocker. */
    required_secrets: HealthStatus;
  };
  details: {
    db_read_latency_ms?: number;
    db_write_latency_ms?: number;
    /** true when caller passes null queue (test mode) */
    queue_send_skipped: boolean;
    cf_api_latency_ms?: number;
    cf_api_status?: number;
    outbox_pending_count: number;
    outbox_failed_count: number;
  };
  /** ISO 8601 of probe time */
  probed_at: string;
}

export interface DeepHealthArgs {
  db: D1Database;
  queue: Queue<unknown> | null;
  cf: CfRoutingConfig;
  /** Presence of required operational bindings. Never their values. */
  secrets?: {
    alertWebhookPresent: boolean;
    backupsPresent: boolean;
    isProduction: boolean;
  };
}

function probeRequiredSecrets(secrets: DeepHealthArgs['secrets']): HealthStatus {
  if (!secrets) return 'green'; // not evaluated (e.g. unit tests)
  const bothPresent = secrets.alertWebhookPresent && secrets.backupsPresent;
  if (bothPresent) return 'green';
  // Missing a required binding is a release blocker in production, a warning elsewhere.
  return secrets.isProduction ? 'red' : 'yellow';
}

const CF_API = 'https://api.cloudflare.com/client/v4';

function aggregateStatus(statuses: HealthStatus[]): HealthStatus {
  if (statuses.some(s => s === 'red')) return 'red';
  if (statuses.some(s => s === 'yellow')) return 'yellow';
  return 'green';
}

async function probeDbRead(db: D1Database): Promise<{ status: HealthStatus; latency_ms: number }> {
  const t0 = Date.now();
  try {
    await db.prepare('SELECT 1 as ok').first();
    const ms = Date.now() - t0;
    const status: HealthStatus = ms < 200 ? 'green' : ms < 1000 ? 'yellow' : 'red';
    return { status, latency_ms: ms };
  } catch {
    return { status: 'red', latency_ms: Date.now() - t0 };
  }
}

async function probeDbWrite(db: D1Database): Promise<{ status: HealthStatus; latency_ms: number }> {
  const t0 = Date.now();
  let rowId: number | null = null;
  try {
    const inserted = await db
      .prepare(`INSERT INTO event_log (event_type) VALUES ('health_probe') RETURNING id`)
      .first<{ id: number }>();
    rowId = inserted?.id ?? null;
    const ms = Date.now() - t0;
    const status: HealthStatus = ms < 500 ? 'green' : ms < 2000 ? 'yellow' : 'red';
    return { status, latency_ms: ms };
  } catch {
    return { status: 'red', latency_ms: Date.now() - t0 };
  } finally {
    if (rowId !== null) {
      try {
        await db.prepare('DELETE FROM event_log WHERE id = ?').bind(rowId).run();
      } catch {
        // best-effort; pruneRetention will sweep it
      }
    }
  }
}

function probeQueueProducer(queue: Queue<unknown> | null): { status: HealthStatus; skipped: boolean } {
  if (queue === null) return { status: 'yellow', skipped: true };
  return { status: typeof queue.send === 'function' ? 'green' : 'yellow', skipped: false };
}

async function probeCfApi(cfg: CfRoutingConfig): Promise<{ status: HealthStatus; latency_ms?: number; http_status?: number }> {
  if (!cfRoutingEnabled(cfg)) return { status: 'green' };
  const t0 = Date.now();
  try {
    const res = await fetch(`${CF_API}/zones/${cfg.zoneId}/email/routing`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${cfg.apiToken}` },
    });
    const ms = Date.now() - t0;
    const httpStatus = res.status;
    if (!res.ok) return { status: 'red', latency_ms: ms, http_status: httpStatus };
    const status: HealthStatus = ms < 1000 ? 'green' : ms < 3000 ? 'yellow' : 'red';
    return { status, latency_ms: ms, http_status: httpStatus };
  } catch {
    return { status: 'red', latency_ms: Date.now() - t0 };
  }
}

async function probeOutboxDrift(db: D1Database): Promise<{ status: HealthStatus; pending_count: number; failed_count: number }> {
  try {
    const [pendingRow, failedRow] = await Promise.all([
      db.prepare(`SELECT COUNT(*) as cnt FROM cf_routing_outbox WHERE status = 'pending'`).first<{ cnt: number }>(),
      db.prepare(`SELECT COUNT(*) as cnt FROM cf_routing_outbox WHERE status = 'failed'`).first<{ cnt: number }>(),
    ]);
    const pending = pendingRow?.cnt ?? 0;
    const failed = failedRow?.cnt ?? 0;
    let status: HealthStatus = 'green';
    if (failed > 0) status = 'red';
    else if (pending > 0) status = 'yellow';
    return { status, pending_count: pending, failed_count: failed };
  } catch {
    return { status: 'red', pending_count: 0, failed_count: 0 };
  }
}

/**
 * Active end-to-end health probe. Should run in < 5s.
 * Aggregation: any 'red' → 'red'; else any 'yellow' → 'yellow'; else 'green'.
 */
export async function deepHealth(args: DeepHealthArgs): Promise<DeepHealthResult> {
  const probed_at = new Date().toISOString();

  const [dbRead, dbWrite, cfApi, outboxDrift] = await Promise.all([
    probeDbRead(args.db),
    probeDbWrite(args.db),
    probeCfApi(args.cf),
    probeOutboxDrift(args.db),
  ]);
  const queueProbe = probeQueueProducer(args.queue);

  const components = {
    db_read: dbRead.status,
    db_write: dbWrite.status,
    queue_producer: queueProbe.status,
    cf_api: cfApi.status,
    outbox_drift: outboxDrift.status,
    required_secrets: probeRequiredSecrets(args.secrets),
  } satisfies DeepHealthResult['components'];

  const status = aggregateStatus(Object.values(components));

  const details: DeepHealthResult['details'] = {
    queue_send_skipped: queueProbe.skipped,
    outbox_pending_count: outboxDrift.pending_count,
    outbox_failed_count: outboxDrift.failed_count,
  };
  if (dbRead.latency_ms !== undefined) details.db_read_latency_ms = dbRead.latency_ms;
  if (dbWrite.latency_ms !== undefined) details.db_write_latency_ms = dbWrite.latency_ms;
  if (cfApi.latency_ms !== undefined) details.cf_api_latency_ms = cfApi.latency_ms;
  if (cfApi.http_status !== undefined) details.cf_api_status = cfApi.http_status;

  return {
    status,
    components,
    details,
    probed_at,
  };
}

// ---- Drift audit ----

export interface DriftAuditResult {
  outbox_pending: Array<{
    id: number;
    op: 'create' | 'delete';
    pairing_code: string | null;
    cf_rule_id: string | null;
    bank_account_id: number | null;
    status: 'pending' | 'failed';
    attempts: number;
    last_error: string | null;
    created_at: string;
  }>;
  db_rows_missing_cf_rule: Array<{
    id: number;
    account_number: string;
    pairing_code: string;
    cf_rule_id: string | null;
  }>;
  cf_rules_orphaned: Array<{
    rule_id: string;
    matcher_value: string;
  }>;
  cf_api_disabled: boolean;
}

interface CfRule {
  id: string;
  matchers?: Array<{ type: string; field?: string; value?: string }>;
}

interface CfRulesResponse {
  success: boolean;
  result?: CfRule[];
  result_info?: { cursor?: string };
}

async function fetchAllCfRules(cfg: CfRoutingConfig): Promise<CfRule[]> {
  const rules: CfRule[] = [];
  let url: string | null = `${CF_API}/zones/${cfg.zoneId}/email/routing/rules?per_page=1000`;

  while (url !== null) {
    const res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${cfg.apiToken}` },
    });
    if (!res.ok) throw new Error(`CF rules list failed: ${res.status}`);
    const json = await res.json() as CfRulesResponse;
    if (!json.success || !json.result) throw new Error('CF rules list: success=false');
    rules.push(...json.result);
    const cursor = json.result_info?.cursor;
    url = cursor ? `${CF_API}/zones/${cfg.zoneId}/email/routing/rules?per_page=1000&cursor=${encodeURIComponent(cursor)}` : null;
  }

  return rules;
}

/** Calls CF API to list routing rules + cross-references with DB. */
export async function auditCfRoutingDrift(args: {
  db: D1Database;
  cf: CfRoutingConfig;
}): Promise<DriftAuditResult> {
  const { db, cf } = args;

  // Always fetch outbox pending/failed rows
  const outboxResult = await db
    .prepare(`SELECT id, op, pairing_code, cf_rule_id, bank_account_id, status, attempts, last_error, created_at FROM cf_routing_outbox WHERE status IN ('pending', 'failed') ORDER BY id`)
    .all<{
      id: number; op: 'create' | 'delete'; pairing_code: string | null; cf_rule_id: string | null;
      bank_account_id: number | null; status: 'pending' | 'failed'; attempts: number;
      last_error: string | null; created_at: string;
    }>();

  const outbox_pending = outboxResult.results;

  if (!cfRoutingEnabled(cf)) {
    return {
      outbox_pending,
      db_rows_missing_cf_rule: [],
      cf_rules_orphaned: [],
      cf_api_disabled: true,
    };
  }

  // Fetch DB bank_accounts that should have Cloudflare Email Routing.
  // API-only accounts intentionally do not create or need a CF email rule.
  const dbAccountsResult = await db
    .prepare(`SELECT id, account_number, pairing_code, cf_rule_id FROM bank_accounts WHERE ingest_mode IN ('email', 'both') ORDER BY id`)
    .all<{ id: number; account_number: string; pairing_code: string; cf_rule_id: string | null }>();
  const dbAccounts = dbAccountsResult.results;

  // Fetch CF rules
  const cfRules = await fetchAllCfRules(cf);

  // Build set of CF rule ids
  const cfRuleIds = new Set(cfRules.map(r => r.id));

  // DB rows missing CF rule: cf_rule_id is null OR not found in CF
  const db_rows_missing_cf_rule = dbAccounts.filter(
    a => a.cf_rule_id === null || !cfRuleIds.has(a.cf_rule_id),
  );

  // Build set of DB cf_rule_ids (non-null)
  const dbCfRuleIds = new Set(
    dbAccounts.map(a => a.cf_rule_id).filter((id): id is string => id !== null),
  );

  // banksync-managed rule pattern: <hex4-32>@<domain> (production = 10, test fixtures may be shorter)
  const banksyncPattern = new RegExp(`^[0-9a-f]{4,32}@${escapeRegExp(cf.domain)}$`);

  // CF rules orphaned: literal matcher with banksync pattern, not referenced by any DB row
  const cf_rules_orphaned = cfRules
    .filter(r => {
      const firstMatcher = r.matchers?.[0];
      if (!firstMatcher) return false;
      if (firstMatcher.type !== 'literal') return false;
      const val = firstMatcher.value ?? '';
      if (!banksyncPattern.test(val)) return false;
      return !dbCfRuleIds.has(r.id);
    })
    .map(r => ({
      rule_id: r.id,
      matcher_value: r.matchers![0]!.value ?? '',
    }));

  return {
    outbox_pending,
    db_rows_missing_cf_rule,
    cf_rules_orphaned,
    cf_api_disabled: false,
  };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
