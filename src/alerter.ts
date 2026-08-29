import type { D1Database } from '@cloudflare/workers-types';
import { getStatusData } from './db';
import { log, logError } from './logger';

export interface AlerterConfig {
  /** Webhook URL to POST alerts to. Undefined → alerter disabled. Slack incoming webhook, Discord, generic. */
  webhookUrl: string | undefined;
  /** Optional bearer used by an internal alert-ingest endpoint. */
  webhookSecret?: string | undefined;
  /** Hostname/identifier surfaced in alert payload. */
  service: string;
  /**
   * Non-delivery aggregate thresholds. Delivery incidents (stalled/terminal)
   * do NOT flow through this global-debounce alerter anymore — each is a durable
   * per-job incident in the alert outbox (see alertOutbox.ts). This path only
   * covers parse/unmatched aggregates, which may share one debounce.
   */
  thresholds: {
    parse_failure_rate_24h: number;
    unmatched_24h: number;
  };
}

export const DEFAULT_THRESHOLDS = {
  parse_failure_rate_24h: 0.05,
  unmatched_24h: 10,
};

export interface AlertPayload {
  service: string;
  severity: 'warn' | 'error';
  triggered_thresholds: Array<{ metric: string; value: number; threshold: number }>;
  status_snapshot: {
    parse_failure_rate_24h: number;
    parse_failures_24h: number;
    unknown_currency_24h: number;
    unknown_provider_24h: number;
    unmatched_24h: number;
  };
  probed_at: string;
}

/**
 * Evaluate the non-delivery aggregate thresholds against current /status data.
 * Returns the AlertPayload to send (with `triggered_thresholds.length > 0`) — or
 * null if all thresholds pass. Delivery stalls/terminals are handled per-job by
 * the alert outbox, not here.
 *
 * severity: 'error' if parse_failure_rate_24h > 50%, else 'warn'.
 */
export async function evaluateThresholds(db: D1Database, cfg: AlerterConfig): Promise<AlertPayload | null> {
  const status = await getStatusData(db);

  const triggered: Array<{ metric: string; value: number; threshold: number }> = [];

  if (status.service.parse_failure_rate_24h > cfg.thresholds.parse_failure_rate_24h) {
    triggered.push({
      metric: 'parse_failure_rate_24h',
      value: status.service.parse_failure_rate_24h,
      threshold: cfg.thresholds.parse_failure_rate_24h,
    });
  }

  if (status.service.unmatched_24h >= cfg.thresholds.unmatched_24h) {
    triggered.push({
      metric: 'unmatched_24h',
      value: status.service.unmatched_24h,
      threshold: cfg.thresholds.unmatched_24h,
    });
  }

  if (triggered.length === 0) {
    return null;
  }

  const severity: 'warn' | 'error' = status.service.parse_failure_rate_24h > 0.5 ? 'error' : 'warn';

  return {
    service: cfg.service,
    severity,
    triggered_thresholds: triggered,
    status_snapshot: {
      parse_failure_rate_24h: status.service.parse_failure_rate_24h,
      parse_failures_24h: status.service.parse_failures_24h,
      unknown_currency_24h: status.service.unknown_currency_24h,
      unknown_provider_24h: status.service.unknown_provider_24h,
      unmatched_24h: status.service.unmatched_24h,
    },
    probed_at: new Date().toISOString(),
  };
}

function toSlackPayload(p: AlertPayload): Record<string, unknown> {
  const lines = p.triggered_thresholds
    .map(t => `• ${t.metric}: ${t.value} (threshold: ${t.threshold})`)
    .join('\n');
  const emoji = p.severity === 'error' ? '🚨' : '⚠️';
  return {
    text: `${emoji} banksync alert (${p.severity}) on ${p.service}\n${lines}`,
    severity: p.severity,
    service: p.service,
    triggered_thresholds: p.triggered_thresholds,
    status_snapshot: p.status_snapshot,
    probed_at: p.probed_at,
  };
}

/**
 * POST the alert payload as JSON to webhookUrl. Best-effort: catches errors, logs them, returns false.
 *
 * For Slack-compatible payload: include `text` field summarizing.
 */
export async function postAlert(payload: AlertPayload, cfg: AlerterConfig): Promise<boolean> {
  if (!cfg.webhookUrl) {
    return false;
  }

  const body = toSlackPayload(payload);

  try {
    const response = await globalThis.fetch(cfg.webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cfg.webhookSecret ? { Authorization: `Bearer ${cfg.webhookSecret}` } : {}),
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      logError('alert_post_failed', new Error(`HTTP ${response.status}`), {
        metric_parse_rate: payload.status_snapshot.parse_failure_rate_24h,
      });
      return false;
    }

    log('alert_posted', {
      severity: payload.severity,
      triggered_count: payload.triggered_thresholds.length,
    });
    return true;
  } catch (err) {
    logError('alert_post_exception', err, {
      metric_parse_rate: payload.status_snapshot.parse_failure_rate_24h,
    });
    return false;
  }
}

/**
 * Run a complete alerter tick. Combines evaluate + post.
 * Returns:
 *   { fired: false } when alerter disabled OR no thresholds breached
 *   { fired: true, payload, posted: boolean }
 */
export async function runAlerterTick(
  db: D1Database,
  cfg: AlerterConfig,
): Promise<{ fired: false } | { fired: true; payload: AlertPayload; posted: boolean }> {
  if (!cfg.webhookUrl) {
    return { fired: false };
  }

  const payload = await evaluateThresholds(db, cfg);
  if (!payload) {
    const prior = await db.prepare(`SELECT value FROM alert_state WHERE key = 'alerter_active'`).first<{ value: string }>();
    if (!prior || prior.value !== 'active') return { fired: false };

    const status = await getStatusData(db);
    const recovery: AlertPayload = {
      service: cfg.service,
      severity: 'warn',
      triggered_thresholds: [{ metric: 'delivery_recovered', value: 0, threshold: 0 }],
      status_snapshot: {
        parse_failure_rate_24h: status.service.parse_failure_rate_24h,
        parse_failures_24h: status.service.parse_failures_24h,
        unknown_currency_24h: status.service.unknown_currency_24h,
        unknown_provider_24h: status.service.unknown_provider_24h,
        unmatched_24h: status.service.unmatched_24h,
      },
      probed_at: new Date().toISOString(),
    };
    const posted = await postAlert(recovery, cfg);
    if (posted) {
      await db.prepare(`INSERT INTO alert_state (key, value, updated_at) VALUES ('alerter_active', 'resolved', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
        .bind(new Date().toISOString()).run();
    }
    return { fired: true, payload: recovery, posted };
  }

  const prior = await db.prepare(`SELECT value, updated_at FROM alert_state WHERE key = 'alerter_active'`).first<{ value: string; updated_at: string }>();
  const repeatAfterMs = 30 * 60 * 1000;
  if (prior?.value === 'active' && Date.now() - new Date(prior.updated_at).getTime() < repeatAfterMs) {
    return { fired: false };
  }

  const posted = await postAlert(payload, cfg);
  if (posted) {
    await db.prepare(`INSERT INTO alert_state (key, value, updated_at) VALUES ('alerter_active', 'active', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
      .bind(new Date().toISOString()).run();
  }
  return { fired: true, payload, posted };
}
