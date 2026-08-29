import type { D1Database } from '@cloudflare/workers-types';
import { log, logError } from './logger';

// Per-job alert outbox. Each incident is a durable row keyed by a stable
// `incident_key`, so a new terminal payment incident is NEVER hidden behind a
// global debounce, and a drainer claims each due row with a lease + token so two
// cron ticks cannot post the same incident twice. Posting is at-least-once: if
// the POST succeeds but marking `posted_at` fails, the same `incident_key` may
// repeat — the operator dedupes on it; a silently dropped alert is not allowed.

export interface AlertOutboxConfig {
  webhookUrl: string | undefined;
  webhookSecret?: string | undefined;
  service: string;
}

const STALLED_GRACE_SECONDS = 10 * 60;
const CLAIM_LEASE_SECONDS = 60;

interface AlertJobFacts {
  id: number;
  delivery_id: string;
  consumer_app_id: string;
  incident_version: number;
  last_error?: string | null;
  last_http_status?: number | null;
  status: string;
}

function incidentPayload(kind: string, job: AlertJobFacts, service: string): string {
  return JSON.stringify({
    service,
    incident_kind: kind,
    delivery_job_id: job.id,
    delivery_id: job.delivery_id,
    consumer_app_id: job.consumer_app_id,
    status: job.status,
    last_error: job.last_error ?? null,
    last_http_status: job.last_http_status ?? null,
    detected_at: new Date().toISOString(),
  });
}

async function enqueue(db: D1Database, row: {
  deliveryJobId: number; kind: string; incidentKey: string; payload: string;
}): Promise<void> {
  // Idempotent on incident_key: a repeated detection never duplicates.
  await db.prepare(`
    INSERT OR IGNORE INTO webhook_delivery_alerts
      (delivery_job_id, incident_kind, incident_key, payload)
    VALUES (?, ?, ?, ?)
  `).bind(row.deliveryJobId, row.kind, row.incidentKey, row.payload).run();
}

/** Enqueue a terminal incident for a job that just went terminal. Keyed by the
 * incident_version so a force-redrive later opens a fresh incident. */
export async function enqueueTerminalIncident(db: D1Database, job: AlertJobFacts, service: string): Promise<void> {
  await enqueue(db, {
    deliveryJobId: job.id,
    kind: 'terminal',
    incidentKey: `job:${job.id}:terminal:${job.incident_version}`,
    payload: incidentPayload('terminal', job, service),
  });
}

/** When a job becomes delivered, close any open (already-posted) incident with a
 * single recovery event. A never-alerted incident produces no recovery. */
export async function enqueueRecoveryIfOpen(db: D1Database, job: AlertJobFacts, service: string): Promise<void> {
  const open = await db.prepare(`
    SELECT id FROM webhook_delivery_alerts
    WHERE delivery_job_id = ? AND incident_kind IN ('terminal', 'stalled') AND posted_at IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM webhook_delivery_alerts r
        WHERE r.delivery_job_id = webhook_delivery_alerts.delivery_job_id
          AND r.incident_kind = 'recovered'
          AND r.incident_key = 'job:' || webhook_delivery_alerts.delivery_job_id || ':recovered:' || webhook_delivery_alerts.id
      )
    ORDER BY id DESC LIMIT 1
  `).bind(job.id).first<{ id: number }>();
  if (!open) return;
  await enqueue(db, {
    deliveryJobId: job.id,
    kind: 'recovered',
    incidentKey: `job:${job.id}:recovered:${open.id}`,
    payload: incidentPayload('recovered', job, service),
  });
}

/** Detect active jobs stuck past the grace period without a stalled incident. */
export async function detectStalledIncidents(db: D1Database, service: string): Promise<number> {
  const rows = await db.prepare(`
    SELECT j.id, j.delivery_id, j.consumer_app_id, j.incident_version, j.last_error, j.last_http_status, j.status
    FROM webhook_delivery_jobs j
    WHERE j.status IN ('pending', 'dispatching', 'queued')
      AND datetime(j.created_at) <= datetime('now', '-${STALLED_GRACE_SECONDS} seconds')
      AND NOT EXISTS (
        SELECT 1 FROM webhook_delivery_alerts a
        WHERE a.delivery_job_id = j.id AND a.incident_kind = 'stalled'
          AND a.incident_key = 'job:' || j.id || ':stalled:' || j.incident_version
      )
    LIMIT 100
  `).all<AlertJobFacts>();
  for (const job of rows.results) {
    await enqueue(db, {
      deliveryJobId: job.id,
      kind: 'stalled',
      incidentKey: `job:${job.id}:stalled:${job.incident_version}`,
      payload: incidentPayload('stalled', job, service),
    });
  }
  return rows.results.length;
}

export async function countPendingDeliveryAlerts(db: D1Database): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) AS cnt FROM webhook_delivery_alerts WHERE posted_at IS NULL`).first<{ cnt: number }>();
  return row?.cnt ?? 0;
}

function backoffSeconds(attempts: number): number {
  return Math.min(30 * 2 ** Math.max(0, attempts), 1800);
}

/** Drain due alert rows: claim with a lease + token, POST, mark posted. */
export async function drainDeliveryAlerts(
  db: D1Database,
  cfg: AlertOutboxConfig,
  limit = 20,
): Promise<{ posted: number; failed: number }> {
  if (!cfg.webhookUrl) return { posted: 0, failed: 0 };

  const due = await db.prepare(`
    SELECT id, payload, post_attempts, incident_key
    FROM webhook_delivery_alerts
    WHERE posted_at IS NULL
      AND datetime(next_attempt_at) <= datetime('now')
      AND (lease_until IS NULL OR datetime(lease_until) <= datetime('now'))
    ORDER BY next_attempt_at, id
    LIMIT ?
  `).bind(limit).all<{ id: number; payload: string; post_attempts: number; incident_key: string }>();

  let posted = 0;
  let failed = 0;
  for (const alert of due.results) {
    const token = crypto.randomUUID();
    const claim = await db.prepare(`
      UPDATE webhook_delivery_alerts
      SET lease_until = datetime('now', '+${CLAIM_LEASE_SECONDS} seconds'), dispatch_token = ?
      WHERE id = ? AND posted_at IS NULL
        AND (lease_until IS NULL OR datetime(lease_until) <= datetime('now'))
    `).bind(token, alert.id).run();
    if (claim.meta.changes !== 1) continue; // another ticker owns it

    let ok = false;
    try {
      const res = await fetch(cfg.webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(cfg.webhookSecret ? { Authorization: `Bearer ${cfg.webhookSecret}` } : {}),
        },
        body: alert.payload,
      });
      ok = res.ok;
      if (!ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      failed++;
      await db.prepare(`
        UPDATE webhook_delivery_alerts
        SET post_attempts = post_attempts + 1, lease_until = NULL,
            next_attempt_at = datetime('now', '+' || ? || ' seconds'), last_error = ?
        WHERE id = ? AND dispatch_token = ?
      `).bind(backoffSeconds(alert.post_attempts + 1), String(err), alert.id, token).run();
      continue;
    }

    // POST succeeded. If this write fails the alert may repeat (at-least-once),
    // never vanish; the operator dedupes on incident_key.
    await db.prepare(`
      UPDATE webhook_delivery_alerts
      SET posted_at = datetime('now'), lease_until = NULL, last_error = NULL
      WHERE id = ? AND dispatch_token = ?
    `).bind(alert.id, token).run();
    posted++;
  }
  if (posted > 0 || failed > 0) log('delivery_alerts_drained', { posted, failed });
  return { posted, failed };
}
