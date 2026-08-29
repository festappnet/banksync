// CF Email Routing API client — bridges banksync DB state to Cloudflare's per-zone routing rule store.
// Auto-sync hooks live in the Cloudflare worker admin endpoints.
//
// All CF calls authenticate with a bearer token (CF_API_TOKEN secret). Token must have:
//   Zone:Email Routing Rules:Edit (write)
//   Zone:Zone:Read (verify)
// Token is scoped to the festapp.net zone in our setup.

import { log, logError } from './logger';

export interface CfRoutingConfig {
  /** CF API bearer token. When undefined or empty, CF sync is disabled (dev/test mode). */
  apiToken: string | undefined;
  /** CF zone id where Email Routing rules live. Hardcoded per-environment via wrangler.toml [vars]. */
  zoneId: string;
  /** Subdomain hosting bank-* receivers (matcher value template). */
  domain: string;
}

const CF_API = 'https://api.cloudflare.com/client/v4';

export class CfRoutingError extends Error {
  constructor(
    public readonly status: number,
    public readonly cfErrors: Array<{ code: number; message: string }>,
    summary: string,
  ) {
    super(summary);
    this.name = 'CfRoutingError';
  }
}

/** Returns true iff CF auto-sync is enabled for this environment. */
export function cfRoutingEnabled(cfg: CfRoutingConfig): boolean {
  return Boolean(cfg.apiToken && cfg.apiToken.length > 0);
}

/** Builds the email matcher value for a given pairing code. Pairing IS the local-part (no prefix). */
export function pairingEmail(domain: string, pairingCode: string): string {
  return `${pairingCode}@${domain}`;
}

/**
 * Create a literal routing rule for a specific pairing email → banksync Worker.
 * Returns the CF rule id.
 * No-op if cfRoutingEnabled() is false — returns null.
 */
export async function createRule(cfg: CfRoutingConfig, pairingCode: string): Promise<string | null> {
  if (!cfRoutingEnabled(cfg)) {
    log('cf_routing_skipped', { op: 'create', pairing_code: pairingCode, reason: 'CF_API_TOKEN unset' });
    return null;
  }

  const matcherValue = pairingEmail(cfg.domain, pairingCode);
  const body = {
    matchers: [{ type: 'literal', field: 'to', value: matcherValue }],
    actions: [{ type: 'worker', value: ['banksync'] }],
    enabled: true,
    name: `auto: ${matcherValue}`,
  };

  const res = await fetch(`${CF_API}/zones/${cfg.zoneId}/email/routing/rules`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${cfg.apiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const json = await res.json() as {
    success: boolean;
    errors?: Array<{ code: number; message: string }>;
    result?: { id: string };
  };
  if (!res.ok || !json.success || !json.result?.id) {
    const errs = json.errors ?? [];
    throw new CfRoutingError(
      res.status,
      errs,
      `cf_routing_create_failed: ${res.status} ${errs.map(e => `[${e.code}]${e.message}`).join('; ') || 'unknown'}`,
    );
  }
  log('cf_routing_rule_created', { rule_id: json.result.id, pairing_code: pairingCode });
  return json.result.id;
}

/**
 * Delete a routing rule by CF rule id. Best-effort: 404 (already gone) is treated as success;
 * other errors throw.
 */
export async function deleteRule(cfg: CfRoutingConfig, ruleId: string): Promise<void> {
  if (!cfRoutingEnabled(cfg)) {
    log('cf_routing_skipped', { op: 'delete', rule_id: ruleId, reason: 'CF_API_TOKEN unset' });
    return;
  }

  const res = await fetch(`${CF_API}/zones/${cfg.zoneId}/email/routing/rules/${ruleId}`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${cfg.apiToken}` },
  });
  if (res.status === 404) {
    // Rule already deleted — idempotent success.
    log('cf_routing_rule_already_gone', { rule_id: ruleId });
    return;
  }
  const json = await res.json() as {
    success: boolean;
    errors?: Array<{ code: number; message: string }>;
  };
  if (!res.ok || !json.success) {
    const errs = json.errors ?? [];
    throw new CfRoutingError(
      res.status,
      errs,
      `cf_routing_delete_failed: ${res.status} ${errs.map(e => `[${e.code}]${e.message}`).join('; ') || 'unknown'}`,
    );
  }
  log('cf_routing_rule_deleted', { rule_id: ruleId });
}

/**
 * Best-effort delete: never throws. Logs failures and returns false.
 * Use when CF state is secondary (DB row is the source of truth for ownership).
 */
export async function safeDeleteRule(cfg: CfRoutingConfig, ruleId: string): Promise<boolean> {
  try {
    await deleteRule(cfg, ruleId);
    return true;
  } catch (err) {
    logError('cf_routing_safe_delete_failed', err, { rule_id: ruleId });
    return false;
  }
}
