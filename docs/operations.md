# Deploy and operate BankSync

Use this reference when running your own Worker. To receive webhooks from an
existing installation, start with the [integration guide](guide.md).

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
   database must apply only its missing forward migrations in order. BankSync 0.2.9
   supports
   schemas 10-13. Schema 12 adds optional payment references; schema 13 adds
   bounded recovery and incremental Fio polling. For an existing installation,
   follow the [migration procedure](#migrate-an-existing-installation).
5. Configure `ADMIN_SECRET`, `WEBHOOK_KEK`, `ENCRYPTION_KEY_V1`, and, when R2
   backups are enabled, the selected `BACKUP_ENCRYPTION_KEY_Vn` with
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
to version 12, then `0013_recovery_operations.sql` to version 13. Never renumber or replace the baseline.
Do not apply a newer
schema to a running Worker that does not support it.

BankSync D1 is intentionally independent of consumer billing databases.
BankSync emits authenticated transaction facts. Each consumer owns settlement,
invoicing and its own durable delivery claim.

For local development, use placeholder Cloudflare identifiers, copy
`.dev.vars.example` to `.dev.vars`, apply migrations locally, then run:

```bash
pnpm dev
```

## Recovery and monitoring

Available in BankSync 0.2.9 on schema 13. Schemas 10-12 remain supported.

### Fio polling

Fio uses one credential-wide cursor, a verified bounded bootstrap, and one
bank operation per invocation. Existing verified account history is retained;
cutover starts at its current checkpoint minus three days. Only a new or
unverified alias needs the initial 90-calendar-date history. Normal polling uses `/last`;
`/periods` checks
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

### Email recovery and retention

Authenticated email retries share a durable claim and retry schedule of 5
minutes, 15 minutes, 1 hour, 6 hours and then 1 day. Unsupported bank dates and
conflicting Message-ID bodies enter quarantine. Available encrypted evidence
and original digests remain available for operator review; quarantine does not
create a transaction. Completed recovery payloads are cleared immediately;
metadata remains seven days. Cleanup drains at most 500 rows per category per
invocation and preserves pending and quarantined evidence.

### Monitoring

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

## Migrate an existing installation

Before rebuilding the email recovery table, deploy the complete compatible
0.2.9 Worker on the existing schema and set `schema_meta.recovery_maintenance` to
`on`. The Worker holds newly authenticated mail in encrypted R2, defers
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

## Fio token authorization failures

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

## Security and backups

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

## Development and releases

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

## Account export and reconciliation

`GET /bank-accounts/:id/transaction-export` returns complete account facts with
`cursor`, fixed `high_water` and `complete`. Persist both coordinates.

`POST /admin/cutover-reconcile` requires administrator authentication, a manifest
SHA-256 and an exact consumer/account/ID window. It creates missing v2 delivery
intents without rewriting archived payloads or globally changing subscription
intervals. Pending or quarantined facts survive normal 90-day cleanup. A package
release does not authorize replay of another consumer's history.

Account identity cannot change under existing movements.
`GET /bank-accounts/:id/ingest-state` exposes a credential digest for timeout
recovery, never the credential. Creation idempotency receipts are permanent.

New v2 email connections require `AUTHENTICATED_EMAIL_SPOOL=on` and the `BACKUPS`
binding. Bank authentication happens before encrypted R2 persistence; persistence
happens before D1 lookup. Original MIME bytes and trusted envelope evidence survive
D1 outages. New email providers require sanitized real-bank fixtures and an
authenticated ingress canary. Existing recipients are not migrated automatically.
