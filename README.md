# BankSync

BankSync turns bank transaction notifications into durable, signed webhooks.
It is a TypeScript package and a deployable Cloudflare Worker maintained by
[Festapp](https://github.com/festappnet).

The included Worker supports:

- Fio Bank notification email and Fio API ingestion;
- Air Bank notification email ingestion;
- MIME parsing, sender allowlisting and per-account pairing addresses;
- layered transaction deduplication in Cloudflare D1;
- durable webhook delivery through Cloudflare Queues with retry and healing;
- encrypted webhook secrets, audit records, retention and optional R2 backups.

## Install as a package

`v0.1.0` is an unsafe preview and must not be used in production. Install only
the latest version published to npm by the protected release workflow after its
checksum and provenance are available:

```bash
pnpm add festapp-banksync
```

The root export contains runtime-neutral parsing and webhook helpers:

```ts
import {
  detectProvider,
  parseEmail,
  verifyWebhook,
  type WebhookEnvelope,
} from "festapp-banksync";
```

The Cloudflare Worker is a separate export so importing the core does not pull
Cloudflare bindings into application code:

```ts
export { default } from "festapp-banksync/cloudflare";
export type { Env } from "festapp-banksync/cloudflare";
```

## Deploy to Cloudflare

1. Clone this repository and install dependencies with `pnpm install`.
2. Copy `wrangler.example.toml` to `wrangler.toml` and replace every placeholder.
3. Create the D1 database, queues and optional R2 bucket named in the config.
4. For a fresh database apply the baseline; for an existing production database
   whose history ends at `0009`, apply only `0010_security_hardening.sql` through
   a scoped reviewed migration operation.
5. Set `ADMIN_SECRET`, `WEBHOOK_KEK`, `ENCRYPTION_KEY_V1`, and the active
   `BACKUP_ENCRYPTION_KEY_Vn` with
   `pnpm wrangler secret put <NAME>`.
6. Configure `CALLBACK_HOST_ALLOWLIST` with exact consumer hostnames. Production
   refuses an empty allowlist, credentials, IP literals, special-use hosts,
   fragments, suffix matches, and redirects.
7. Inspect one sanitized accepted and rejected Cloudflare message to establish
   the Cloudflare-owned Authentication-Results authserv-id, then configure it as
   `EMAIL_AUTHSERV_ID`. Email ingest intentionally remains disabled while it is
   absent; MIME headers are never an identity fallback.
8. Run the release gates and deploy the exact attested artifact.

All three key families must be independent random 32-byte base64 values.
`BACKUP_ENCRYPTION_KEY_VERSION` selects the active backup key. Store backup
keys outside R2 and test restore before rotation. Never commit `wrangler.toml`,
`.dev.vars`, bank API tokens, backup keys, or consumer webhook secrets.

### Migration baseline

Fresh databases are created from the single canonical schema baseline
`migrations/0001_schema.sql` (schema version 10). The original incremental
`0001`–`0009` history remains recorded in existing D1 databases but is not
needed to create a new deployment. To stay compatible with those databases,
production upgrade is `0010_security_hardening.sql`; all future migrations must
start at `0011` or higher. Never renumber
or replace the baseline filename.

BankSync's D1 schema is intentionally independent of any consumer's billing
database. Billing settlement belongs behind each consumer's signed webhook
endpoint, so installing BankSync never creates or changes Mendelio/Supabase
billing tables or routines.

For local development, copy `.dev.vars.example` to `.dev.vars`, use placeholder
Cloudflare resource identifiers in `wrangler.toml`, apply migrations locally,
and run `pnpm dev`.

## Webhook contract

BankSync sends `transaction.received` version `1`. `delivery_id` is stable
across retries and is the consumer idempotency key. Each request includes:

- `X-BankSync-Timestamp`
- `X-BankSync-Delivery-Id`
- `X-BankSync-Signature: sha256=<hex>`

The HMAC input is the exact byte sequence
`timestamp + "." + deliveryId + "." + bodyBytes`. Verify the raw body before
JSON parsing. `verifyWebhook` validates raw-body HMAC, timestamp syntax and
tolerance, delivery header/body equality, event, and event version, then returns
a typed verified envelope. It throws `WebhookVerificationError` with a stable
code. There is intentionally no HMAC-only public verifier.

```ts
import { verifyWebhook } from "festapp-banksync";

const bodyBytes = new Uint8Array(await request.arrayBuffer());
const envelope = await verifyWebhook({
  secret,
  timestamp: request.headers.get("x-banksync-timestamp") ?? "",
  deliveryId: request.headers.get("x-banksync-delivery-id") ?? "",
  signature: request.headers.get("x-banksync-signature") ?? "",
  bodyBytes,
});
// Atomically claim envelope.delivery_id in durable consumer storage before any
// billing or other side effect. The verifier cannot provide durable replay
// protection on its own.
```

## Trust boundaries and operations

- Cloudflare Email Routing is the trusted SMTP/envelope boundary. The Worker
  requires one configured trusted auth result plus aligned DKIM or DMARC and
  exact agreement between envelope and MIME identities.
- `bank_accounts.owner_app_id` is the tenant authorization authority. Only an
  admin can create a cross-owner subscription.
- Public HTTP exposes only `GET /health` with `{ "ok": true }` or a stable
  unavailable response. `/status` and `/health/deep` require admin auth.
- Callback delivery revalidates the current exact-host policy immediately before
  every fetch and never follows redirects.
- Idempotency is scoped by principal, method, and canonical path. Credential
  creation/rotation endpoints reject `Idempotency-Key` and never cache responses.
- R2 backups are AES-256-GCM `.sql.enc` envelopes. Ephemeral idempotency and
  rate-limit tables are excluded. Decrypt to a new mode-0600 file without
  printing plaintext:

```bash
BACKUP_DECRYPTION_KEY='<base64 key>' \
  node scripts/decrypt-backup.mjs backup.sql.enc restored.sql
```

## Development

```bash
pnpm check
pnpm pack --dry-run
```

Provider-live tests are intentionally not part of the default suite and must
never be run with production bank credentials.

## License

MIT
