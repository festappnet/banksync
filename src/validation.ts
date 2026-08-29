import * as v from 'valibot';

/**
 * Custom error class for validation failures.
 * Thrown by parseBody() when valibot validation fails.
 */
export class ValidationError extends Error {
  constructor(
    public readonly issues: unknown[],
    message: string,
  ) {
    super(message);
    this.name = 'ValidationError';
  }
}

/**
 * Parse and validate a request body against a schema.
 * Throws ValidationError if validation fails.
 */
export function parseBody<TSchema extends v.GenericSchema>(
  schema: TSchema,
  body: unknown,
): v.InferOutput<TSchema> {
  try {
    return v.parse(schema, body);
  } catch (err) {
    if (err instanceof v.ValiError) {
      const message = `validation_failed: ${err.issues[0]?.message ?? 'unknown'}`;
      throw new ValidationError(err.issues as unknown[], message);
    }
    throw err;
  }
}

// ============================================================================
// POST /bank-accounts
// ============================================================================

export const CreateBankAccountSchema = v.object({
  account_number: v.pipe(v.string(), v.minLength(3), v.maxLength(64)),
  account_type: v.optional(v.picklist(['FIO', 'AIRBANK'])),
  ingest_mode: v.optional(v.picklist(['email', 'api', 'both'])),
  fio_api_token: v.optional(v.pipe(v.string(), v.minLength(8), v.maxLength(512))),
  label: v.optional(v.pipe(v.string(), v.maxLength(120))),
  /** owner consumer app_id — must already exist as a registered consumer (otherwise FK fails). */
  owner_app_id: v.pipe(v.string(), v.regex(/^[a-z0-9][a-z0-9-_]{1,63}$/)),
});

export type CreateBankAccountInput = v.InferOutput<typeof CreateBankAccountSchema>;

// PATCH/PUT — all fields optional; at least one must be present.
export const UpdateBankAccountSchema = v.pipe(
  v.object({
    account_number: v.optional(v.pipe(v.string(), v.minLength(3), v.maxLength(64))),
    account_type: v.optional(v.picklist(['FIO', 'AIRBANK'])),
    ingest_mode: v.optional(v.picklist(['email', 'api', 'both'])),
    label: v.optional(v.union([v.pipe(v.string(), v.maxLength(120)), v.null_()])),
  }),
  v.check(
    (o) => o.account_number !== undefined || o.account_type !== undefined || o.ingest_mode !== undefined || o.label !== undefined,
    'at least one of account_number, account_type, ingest_mode, label must be provided',
  ),
);
export type UpdateBankAccountInput = v.InferOutput<typeof UpdateBankAccountSchema>;

// ============================================================================
// PUT /bank-accounts/:id/owner
// ============================================================================

export const UpdateBankAccountOwnerSchema = v.object({
  owner_app_id: v.pipe(v.string(), v.regex(/^[a-z0-9][a-z0-9-_]{1,63}$/)),
});

export type UpdateBankAccountOwnerInput = v.InferOutput<typeof UpdateBankAccountOwnerSchema>;

// ============================================================================
// PUT /bank-accounts/:id/fio-token
// ============================================================================

export const UpdateFioTokenSchema = v.pipe(
  v.object({
    fio_api_token: v.optional(v.pipe(v.string(), v.maxLength(512))),
    fetch_enabled: v.optional(v.boolean()),
    ingest_mode: v.optional(v.picklist(['api', 'both'])),
  }),
  v.check(
    (o) => o.fio_api_token !== undefined || o.fetch_enabled !== undefined || o.ingest_mode !== undefined,
    'at least one of fio_api_token, fetch_enabled, ingest_mode must be provided',
  ),
);

export type UpdateFioTokenInput = v.InferOutput<typeof UpdateFioTokenSchema>;

// ============================================================================
// POST /consumers
// ============================================================================

export const CreateConsumerSchema = v.object({
  app_id: v.pipe(v.string(), v.regex(/^[a-z0-9][a-z0-9-_]{1,63}$/)),
  callback_url: v.pipe(v.string(), v.url(), v.regex(/^https:\/\//)),
});

export type CreateConsumerInput = v.InferOutput<typeof CreateConsumerSchema>;

// ============================================================================
// PUT /consumers/:app_id
// ============================================================================

export const UpdateConsumerSchema = v.object({
  callback_url: v.pipe(v.string(), v.url(), v.regex(/^https:\/\//)),
});

export type UpdateConsumerInput = v.InferOutput<typeof UpdateConsumerSchema>;

const SPECIAL_HOSTS = new Set([
  'localhost', 'localhost.localdomain', 'local', 'internal', 'test', 'invalid',
  'example', 'onion', 'home.arpa',
]);
const SPECIAL_SUFFIXES = ['.localhost', '.local', '.internal', '.test', '.invalid', '.example', '.onion', '.home.arpa'];

function isIpLiteral(hostname: string): boolean {
  if (hostname.startsWith('[') || hostname.endsWith(']')) return true;
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname);
}

/** Exact-host callback policy. The returned URL is canonical and safe to persist. */
export function validateCallbackUrl(
  raw: string,
  options: { environment?: string | undefined; allowlist?: string | undefined },
): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ValidationError([], 'invalid_callback_url');
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  if (
    url.protocol !== 'https:' || url.username || url.password || url.hash ||
    !hostname || SPECIAL_HOSTS.has(hostname) || SPECIAL_SUFFIXES.some(suffix => hostname.endsWith(suffix)) ||
    isIpLiteral(hostname)
  ) {
    throw new ValidationError([], 'invalid_callback_url');
  }
  url.hostname = hostname;
  const allowed = (options.allowlist ?? '').split(',').map(value => value.trim().toLowerCase().replace(/\.$/, '')).filter(Boolean);
  if (options.environment === 'production' && (!allowed.length || !allowed.includes(hostname))) {
    throw new ValidationError([], 'callback_host_not_allowed');
  }
  return url.toString();
}

// ============================================================================
// POST /subscriptions
// ============================================================================

export const CreateSubscriptionSchema = v.object({
  app_id: v.pipe(v.string(), v.regex(/^[a-z0-9][a-z0-9-_]{1,63}$/)),
  bank_account_id: v.pipe(v.number(), v.integer(), v.minValue(1)),
});

export type CreateSubscriptionInput = v.InferOutput<typeof CreateSubscriptionSchema>;

// ============================================================================
// POST /webhooks/replay
// ============================================================================

export const ReplayWebhookSchema = v.pipe(
  v.object({
    tx_id: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
    delivery_id: v.optional(v.pipe(v.string(), v.regex(/^[0-9A-HJKMNP-TV-Z]{26}$/))),
    // A replay must carry an operator reason; it is audited with the actor. An
    // already-delivered job is only re-driven when force=true.
    reason: v.pipe(v.string(), v.trim(), v.minLength(3), v.maxLength(500)),
    force: v.optional(v.boolean()),
  }),
  v.check(
    (obj) => obj.tx_id !== undefined || obj.delivery_id !== undefined,
    'tx_id or delivery_id required',
  ),
);

export type ReplayWebhookInput = v.InferOutput<typeof ReplayWebhookSchema>;
