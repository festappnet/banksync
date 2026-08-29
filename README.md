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

```bash
pnpm add @festapp/banksync
```

The root export contains runtime-neutral parsing and webhook helpers:

```ts
import {
  detectProvider,
  parseEmail,
  verifyWebhookSignature,
  type WebhookEnvelope,
} from "@festapp/banksync";
```

The Cloudflare Worker is a separate export so importing the core does not pull
Cloudflare bindings into application code:

```ts
export { default } from "@festapp/banksync/cloudflare";
export type { Env } from "@festapp/banksync/cloudflare";
```

## Deploy to Cloudflare

1. Clone this repository and install dependencies with `pnpm install`.
2. Copy `wrangler.example.toml` to `wrangler.toml` and replace every placeholder.
3. Create the D1 database, queues and optional R2 bucket named in the config.
4. Apply the included migrations with `pnpm wrangler d1 migrations apply <database-name> --remote`.
5. Set `ADMIN_SECRET`, `WEBHOOK_KEK` and `ENCRYPTION_KEY_V1` with
   `pnpm wrangler secret put <NAME>`.
6. Run `pnpm deploy` and configure Cloudflare Email Routing to deliver the
   pairing-address domain to the Worker.

`WEBHOOK_KEK` and `ENCRYPTION_KEY_V1` must be independent random 32-byte
base64 values. Never commit `wrangler.toml`, `.dev.vars`, bank API tokens or
consumer webhook secrets.

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
JSON parsing. The `verifyWebhookSignature` helper implements this contract.

## Development

```bash
pnpm check
pnpm pack --dry-run
```

Provider-live tests are intentionally not part of the default suite and must
never be run with production bank credentials.

## License

MIT
