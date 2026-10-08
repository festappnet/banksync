# BankSync integration and operations guide

## What the Worker handles

- authenticates sender and recipient identity from Cloudflare-owned envelope
  evidence and a configured trusted `Authentication-Results` authserv-id;
- parses supported Fio Bank and Air Bank notifications and can poll the Fio API;
- pairs each notification through a per-account receiver address;
- normalizes transaction data and deduplicates it in D1;
- creates durable delivery jobs and retries them through Cloudflare Queues;
- heals stalled delivery state without repeating a completed consumer outcome;
- encrypts stored credentials and optional R2 backup envelopes;
- records administrative audit events and applies bounded retention;
- exposes only coarse public health while protecting detailed operator routes.

## Deploy the Worker

### Prerequisites

- Node.js 20 or newer and pnpm;
- a Cloudflare account with Workers, D1, Queues and Email Routing;
- an R2 bucket for authenticated email recovery or encrypted backups;
- exact callback hostnames for every intended webhook consumer.

### Setup

1. Clone this repository and run `pnpm install`.
2. Copy [`wrangler.example.toml`](../wrangler.example.toml) to `wrangler.toml` and
   replace every resource placeholder.
3. Create the D1 database and queues named by the configuration.
4. Apply the baseline and forward migrations on a fresh database. An existing
   database must apply only its missing forward migrations in order. The released
   0.2.8 Worker supports schema versions 10, 11 and 12; schema 12 adds optional
   payment references. Migration 0013 in this branch is unreleased and requires
   the compatible recovery Worker before enabling its new behavior. Preserve
   recorded migration history and use a scoped reviewed rollout.
5. Configure `ADMIN_SECRET`, `WEBHOOK_KEK`, `ENCRYPTION_KEY_V1`, and-when R2
   backups are enabled-the selected `BACKUP_ENCRYPTION_KEY_Vn` with
   `pnpm wrangler secret put <NAME>`.
6. Set `CALLBACK_HOST_ALLOWLIST` to exact consumer hostnames. Production rejects
   an empty policy, credentials, IP literals, special-use hosts, suffix matches,
   fragments and redirects.
7. Inspect sanitized accepted and rejected Cloudflare messages, establish the
   Cloudflare-owned authserv-id, and set `EMAIL_AUTHSERV_ID`. Email ingestion
   deliberately remains disabled until this value is known; MIME headers are
   never used as an identity fallback.
8. Run `pnpm check`, review the dry-run artifact, and deploy the composition you
   have configured.

All key families must use independent random 32-byte base64 values. Keep backup
keys outside R2 and prove restore before rotation. Never commit `wrangler.toml`,
`.dev.vars`, bank API tokens, backup keys or webhook secrets.

### Migration rules

Fresh databases use the single canonical baseline `0001_schema.sql`, which
creates schema version 10. Existing databases retain their recorded `0001`-`0009`
history and advance through `0010_security_hardening.sql`, then
`0011_complete_bank_facts.sql` to version 11 and `0012_payment_references.sql`
to version 12. Never renumber or replace the baseline. Do not apply a newer
schema to a running Worker that does not support it.

BankSync D1 is intentionally independent of consumer billing databases.
BankSync emits authenticated transaction facts. Each consumer owns settlement,
invoicing and its own durable delivery claim.

For local development, use placeholder Cloudflare identifiers, copy
`.dev.vars.example` to `.dev.vars`, apply migrations locally, then run:

```bash
pnpm dev
```

## Webhook contract

BankSync sends event `transaction.received`. Existing consumers default to
`event_version: "1"`; consumers prepared for complete signed bank facts can opt
into `"2"` as described in the [integration contract](#version-02-integration-contract).
`delivery_id` is stable across retries and is the consumer's idempotency key.
Each request includes:

- `X-BankSync-Timestamp`
- `X-BankSync-Delivery-Id`
- `X-BankSync-Signature: sha256=<hex>`

The HMAC input is the exact byte sequence:

```text
timestamp + "." + deliveryId + "." + bodyBytes
```

Verify the raw body before JSON parsing. `verifyWebhook` validates the raw-body
HMAC, timestamp syntax and tolerance, delivery header/body equality, event name
and event version. Failure throws `WebhookVerificationError` with a stable code.
There is intentionally no public HMAC-only verifier.

```ts
import { verifyWebhook } from "@festapp/banksync";

const event = await verifyWebhook({
  secret,
  timestamp: request.headers.get("x-banksync-timestamp") ?? "",
  deliveryId: request.headers.get("x-banksync-delivery-id") ?? "",
  signature: request.headers.get("x-banksync-signature") ?? "",
  bodyBytes: new Uint8Array(await request.arrayBuffer()),
});
```

Atomically claim `event.delivery_id` in your database before applying payment
changes. Set `eventVersion: "2"` when consuming version 2 events.

## Security model

- **Email trust:** Cloudflare Email Routing is the SMTP/envelope seam. A message
  needs a configured trusted auth result plus aligned DKIM or DMARC and exact
  agreement between envelope and MIME identities.
- **Tenant authority:** `bank_accounts.owner_app_id` decides who may operate on
  an account. Only an administrator may create a cross-owner subscription.
- **Callback egress:** every attempt revalidates the current exact-host policy
  immediately before fetch and never follows redirects.
- **Replay handling:** BankSync keeps delivery IDs stable; consumers must claim
  them atomically in their own durable storage before side effects.
- **Credential handling:** credential creation and rotation reject
  `Idempotency-Key`; their plaintext responses never enter the idempotency cache.
- **Operator visibility:** public HTTP exposes only `GET /health`. `/status` and
  `/health/deep` require administrator authentication.
- **Backups:** optional R2 backups are AES-256-GCM `.sql.enc` envelopes and omit
  ephemeral idempotency, rate-limit and poll-lease tables. SQL is read in bounded
  pages, encrypted continuously and uploaded in 5 MiB multipart parts. Restores
  preserve deleted AUTOINCREMENT identities and start with recovery paused and
  payment allocation disabled. Apply the same schema migrations before loading.
  A backup owns a maintenance window for at most 15 minutes; it drains in-flight
  bank/email claims and verifies ownership before publishing. Configuration writes
  return `503` with `Retry-After: 60` during maintenance. Crashed backup windows
  expire automatically; operator-created manual windows remain paused.

Decrypt a backup into a new mode-0600 file without printing plaintext:

```bash
BACKUP_DECRYPTION_KEY='<base64 key>' \
  node scripts/decrypt-backup.mjs backup.sql.enc restored.sql
```

For the full rollout and rollback rules, see
[`security-hardening-rollout.md`](security-hardening-rollout.md).

## Development

```bash
pnpm check
pnpm pack --dry-run
```

`pnpm check` runs type checking, the complete test suite, dual ESM/CommonJS
builds, and package-export verification. Provider-live tests are intentionally
outside the default suite and must never use production bank credentials.

Dependabot minor and patch updates for development dependencies and GitHub
Actions automatically merge after all required checks pass on an up-to-date
branch. Major updates and production dependency updates require manual review.
TypeScript major updates are held back until the declaration build supports
the newer compiler API. The auto-merge workflow reads verified Dependabot
metadata only; it never checks out or runs pull-request code.

Stable releases are created from protected `v*` tags by GitHub Actions, publish
to npm through OIDC trusted publishing, and attach the exact same tarball,
checksum, provenance and SBOM to the GitHub Release.

## Version 0.2 integration contract

Existing consumers default to event version 1. Register a new prepared consumer
with `event_version: "2"`; its receiver calls `verifyWebhook({...args,
eventVersion: "2"})`. Receipt version remains 1. V1 receives only incoming facts
in its original shape; archived delivery payloads are immutable.

V2 adds `payer_reference`, `raw_vs`, signed `amount_cents`, `direction`,
`identity_kind` and `identity_provenance`. Decimal amounts and numeric bank IDs
are range-checked without rounding. Similar VS/amount/date never deduplicates
real movements. Transport IDs are account-scoped. Fio `ID pokynu` is a command,
not a movement; unproven email IDs are observations. Financial consumers must
quarantine observations until their own authorized reconciliation establishes
bank identity. `both` is unavailable to v2 pending provider correlation proof.

On schemas 11 and 12, all Fio manual/queue/cron imports share physical-account and full
credential-hash leases. Imports use bounded `periods` reads, an encrypted durable
batch, and a checkpoint committed only after every row succeeds. They never
advance `/last`. The bootstrap covers 90 calendar dates; subsequent pulls overlap
three days. Older unresolved windows require operator/bank authorization rather
than silent truncation. Receiving-account and statement currency mismatches leave
the batch open. The released 0.2.8 path does not yet use the bank
`/last` cursor: safe incremental polling, cursor recovery, partial recovery
indexes and completed-payload cleanup are being implemented together.

A new connection can be created with `ingest_enabled:false`. Persist mapping and
verify its owner subscription before `PUT /bank-accounts/:id/ingest-state` with
`{enabled:true}`. Account identity cannot change under existing movements.
`GET .../ingest-state` provides the full credential digest for timeout recovery,
never the credential. Creation idempotency receipts are retained permanently.

New v2 email connections require `AUTHENTICATED_EMAIL_SPOOL=on` and `BACKUPS`.
Strict bank authentication precedes encrypted R2 persistence; persistence precedes
D1 account lookup. Original MIME bytes and trusted envelope evidence survive D1
outages. Scheduled cursor recovery visits failed messages without starving newer
ones. Authenticated parse failures retain their encrypted recovery evidence. The
released recovery loop retries unresolved messages; bounded backoff and explicit
quarantine state are part of the unreleased operations work. No active legacy recipient
migration is implied. New provider email automation requires real sanitized bank
fixtures and a genuine authenticated ingress canary.

`GET /bank-accounts/:id/transaction-export` returns complete account facts with
`cursor`, fixed `high_water` and `complete`; persist both coordinates.
`POST /admin/cutover-reconcile` is admin-only, requires a manifest SHA-256 and
an exact owner consumer/account/ID window, creates only missing v2 intents, and
never rewrites an archived payload or globally changes subscription intervals.
Unresolved or quarantined facts are retained beyond the usual 90-day cleanup.
Publishing this package does not deploy the shared Worker, mutate D1, enable bank
polling, or authorize replay of another consumer's history.

Canonical v2 transactions preserve bank-provided VS and payer reference without inferring an order identifier. Each consumer (Festapp, Mendelio, or another application) owns payment matching and business rules. The existing v1 RF-to-VS projection remains only as an explicit backwards-compatible adapter.

Successful schema 11 Fio imports immediately sweep the canonical webhook outbox into the delivery queue, including retryable dispatch failures from earlier imports. Periodic reconciliation remains recovery; consumers do not wait for its next tick in the normal path.


### Fio token authorization failures

A newly created Fio token must also be authorized in Internetbanking; creating
or copying it alone does not activate it. Fio documents HTTP 500 as a nonexistent
or inactive token ([Fio API documentation](https://www.fio.cz/docs/cz/API_Bankovnictvi.pdf),
section 8). An observed inactive token returned that response after 30.4 seconds.
The client allows 55 seconds; an egress proxy should allow at least 45 seconds
upstream and mark forwarded responses with `x-fio-upstream-status`. Only a direct
or explicitly forwarded bank 500 becomes `fio_token_invalid_or_inactive`.
Transport timeouts and proxy failures remain transient, not token diagnoses.
Manual sync returns HTTP 422 with that stable error code, which is also stored
in `api_last_error` and exposed by the owner-scoped account status endpoint.

## Optional payment references (schema 12)

`migrations/0012_payment_references.sql` adds a permanent physical-account registry.
The existing v2 import/delivery pipeline remains active on schemas 11 and 12.
Tenant `GET /bank-accounts/:id/account-health` requires ownership or an active
subscription and is independent of optional reference enrollment. Health reports
fresh successful import observation, not an invented completeness watermark.

Reference enrollment requires an admin to map aliases to a canonical CZ IBAN,
grant the consumer, import known historical symbols and explicitly activate with
`registry_verified:true`. The registry starts locked and backups restore it locked.
Admin `POST /bank-accounts/:id/payment-reference-admin` supports `grant`, `import`
and `activate`; historical import uses `vs`. A collision during import is recorded
and locks further allocation until an operator resolves the inventory.

Enrolled tenants `POST /bank-accounts/:id/payment-references` with `source_ref` and
`payload_hash` to reserve a cryptographically random unique ten-digit symbol, optionally requesting `variable_symbol` (1-10 digits).
`GET` with `source_ref` retrieves only the caller's reservation. The same immutable
command returns the same reservation; a different command or requested symbol
collides with 409 `reference_conflict`. Leading zeros share a namespace. A requested
symbol already held for another purpose is rejected without replacement, overwriting
history or locking unrelated runtime reservations. Allocated symbols never expire
or get reused, and account deletion/recreation does not erase physical identity.

This capability is optional. Its uniqueness guarantee covers enrolled/imported
references, not independently generated symbols in other applications. No external
allocator is automatically migrated and payment-reference use never implies a new
BankSync instance or bank import. `pnpm check` includes transactional SQLite cases
for concurrency/idempotency, scope, aliases, collisions and exhaustion.

## Recovery operations (schema 13 candidate)

This branch contains the unreleased schema-13 recovery Worker. Complete its
migration and restore checks before rollout; the published 0.2.8 Worker cannot
run schema 13. Existing schemas 10-12 remain supported by the candidate.

Fio uses one credential-wide cursor, a verified bounded bootstrap, and one
bank operation per invocation. Existing verified account history is retained;
cutover starts at its current checkpoint minus three days. Only a new or
unverified alias needs the initial 90-calendar-date history. Normal polling uses `/last`; `/periods` checks
three overlapping days once daily. A lost response first resets the bank
pointer to the proven movement ID, or the stored bootstrap date. A saved
response resumes import without another bank request. All valid active aliases
receive the response before the checkpoint commits. A newly active alias gets
backfill before joining an advanced cursor. Use a dedicated token: other
programs must not advance the same bank pointer. The egress relay must support
`transactions`, `periods`, `set-last-date` and `set-last-id`.

Credential changes fence in-flight writes. A statement with an unexpected
receiving account, changed facts, invalid movement or unexplained cursor never
advances the checkpoint. Long unresolved gaps require authorized bank-history
access. The current D1 parameter budget supports up to 12 active aliases per
token and physical account; larger groups fail explicitly without omitting
recipients.

Authenticated email retries share a durable claim and retry schedule of 5
minutes, 15 minutes, 1 hour, 6 hours and then 1 day. Unsupported bank dates and
conflicting Message-ID bodies enter quarantine. Available encrypted evidence
and original digests remain available for operator review; quarantine does not
create a transaction. Completed recovery payloads are cleared immediately;
metadata remains seven days. Cleanup drains at most 500 rows per category per
invocation and preserves pending and quarantined evidence.

The administrator-only `/status` includes `operations`: open recovery age,
quarantine counts and age, due email retries, active Fio freshness, maintenance
and backup times, and D1 allocation/growth. Allocation comes from D1 query
metadata; deleting payloads frees reusable SQLite pages and may not immediately
shrink the database file. A daily successful maintenance samples allocation;
growth is unknown until two samples exist. Unknown backup/freshness remains
unknown rather than appearing healthy.

Operational warnings use the existing alert integration: recovery older than
1 hour, any quarantine, API freshness older than 30 minutes, maintenance older
than 2 days, backup older than 9 days, D1 allocation above 8 GB or growth above
50 MB/day. Missing recorded maintenance, backup or first API success is reported
explicitly. Delivery incidents retain their separate durable per-job alerts;
historical terminal deliveries are not counted as new operational failures.

### Safe recovery migration window

Before rebuilding the email recovery table, deploy the complete compatible
candidate on the existing schema and set `schema_meta.recovery_maintenance` to
`on`. The candidate holds newly authenticated mail in encrypted R2, defers
bank polling and scheduled recovery, and fences new ledger writes within their
SQL statement. Existing webhook delivery remains available. Confirm the durable
email spool is enabled and bound before entering maintenance; without a durable
spool email is rejected for retry rather than acknowledged and lost.

Drain previously started bank leases, take the encrypted backup and Time Travel
bookmark, apply only the missing migration, and verify preserved pending bodies,
consumer subscriptions, schema and indices. Clear the maintenance marker only
after these checks. Scheduled recovery then imports held emails through the
normal authenticated path. Never leave the marker on after a successful rollout;
its state is visible in the protected operations status.
