# Deploy and operate BankSync

This page is for Worker operators. Application developers should start with the
[integration guide](guide.md). BankSync 0.2.9 supports D1 schemas 10-13;
incremental polling and bounded recovery require schema 13.

## Deploy the Worker

You need Node.js 20+, pnpm, and Cloudflare Workers, D1, Queues and Email Routing.
Use R2 for authenticated email recovery and encrypted backups.

1. Run `pnpm install`. Copy `wrangler.example.toml` to `wrangler.toml` and replace
   its resource placeholders with your database, queues and bucket.
2. Apply migrations in order. Fresh databases start with `0001_schema.sql`
   (schema 10), then `0010` through `0013`. Existing databases keep their recorded
   history and apply only missing migrations. Never replace an existing baseline.
3. Set `ADMIN_SECRET`, `WEBHOOK_KEK`, `ENCRYPTION_KEY_V1` and, for backups, the
   selected `BACKUP_ENCRYPTION_KEY_Vn` using `pnpm wrangler secret put <NAME>`.
   Use independent random 32-byte base64 keys; keep backup keys outside R2.
4. Set `CALLBACK_HOST_ALLOWLIST` to exact HTTPS consumer hostnames. Production
   rejects an empty list, IP literals, special-use hosts, URL credentials,
   fragments and redirects. Host suffixes do not grant access.
5. Establish the Cloudflare-owned authentication service ID from sanitized
   accepted/rejected email evidence, then set `EMAIL_AUTHSERV_ID`. Email ingestion
   stays disabled until that trust boundary is configured.
6. For new v2 email accounts, enable `AUTHENTICATED_EMAIL_SPOOL=on` and bind
   `BACKUPS`. Authentication precedes encrypted persistence; persistence precedes
   D1 lookup. Test new providers with real sanitized bank fixtures and an
   authenticated ingress canary.
7. Run `pnpm check`, inspect the deployment dry run, then deploy your composition.
   Verify health, protected routes and one signed delivery with a durable receipt.

Keep tokens, keys, `wrangler.toml` and `.dev.vars` out of Git. BankSync's database
stores bank facts; each application's billing database owns settlement.

For local development, use placeholder resource IDs, copy `.dev.vars.example`,
apply migrations locally and run `pnpm dev`.

## Recovery and monitoring

### Fio polling

Use a dedicated token: Fio has one cursor per credential, and another program
using that token can advance it. A relay must support `transactions`, `periods`,
`set-last-date` and `set-last-id`.

| Situation | Behavior |
| --- | --- |
| New or unverified account alias | Import 90 calendar dates before joining the cursor |
| Existing verified history at cutover | Start at the checkpoint minus three days |
| Normal polling | Fetch new movements through `/last` |
| Daily reconciliation | Check three overlapping days through `/periods` |
| Saved response with unfinished import | Resume it without another bank request |
| Lost response | Reset to a proven committed movement ID or stored bootstrap date |

Each invocation performs at most one bank operation. Every valid active alias
receives the batch before its checkpoint commits. Up to 12 active aliases per
token and physical account are supported; larger groups fail explicitly.

Credential changes invalidate in-flight writes. Unexpected receiving accounts,
changed facts, invalid movements and unexplained cursors leave the batch open.
Long unresolved gaps require authorized bank-history access.

### Email recovery and retention

Retries share a durable claim and use delays of 5 minutes, 15 minutes, 1 hour,
6 hours and then 1 day. Unsupported dates or conflicting Message-ID bodies enter
quarantine and do not create transactions. Preserve their encrypted evidence
and digests for review.

Completed recovery payloads are deleted immediately; metadata lasts seven days.
Cleanup processes at most 500 rows per category per invocation. Pending and
quarantined evidence is retained. Existing email recipients are not migrated
merely by publishing a package.

### Monitoring

BankSync runs without a monitoring service. Public `GET /health` exposes coarse
health; administrator-only `/status` and `/health/deep` retain diagnostics.

Optionally set `OPERATIONS_READ_TOKEN` to a random value of at least 32 characters.
`GET /health/operations` accepts `Authorization: Bearer <token>` and returns
`{ major: 1, observed_at: <Unix milliseconds>, metrics: { ... } }`. The token
cannot access administrator or tenant routes. This endpoint only reads storage,
returns `Cache-Control: no-store`, and exposes counts/ages/storage sizes without
account IDs, bank information, callback URLs, secrets or exception messages.
Unconfigured/wrong credentials return 401; other methods return 405; unavailable
storage or a schema other than 13 returns 503.

Metrics cover active subscriptions' terminal/pending deliveries and oldest age,
recovery backlog/quarantine, email backlog/quarantine, enabled API accounts and
freshness, parse failures/import counts/unmatched mail over 24 hours, maintenance,
backup and physical D1 allocation/growth. Ages use seconds; storage uses bytes.
Missing maintenance/backup/growth evidence is `null`, never a fabricated success.
Growth needs two daily samples; deleting rows may not shrink physical allocation.

Your monitor owns polling, thresholds, incident state and notification delivery.
No monitoring SDK, webhook, service binding or notification database is required
by BankSync. Version 0.3.0 removes `ALERT_WEBHOOK_URL`, `ALERT_WEBHOOK_SECRET` and
`status.queues.pending_delivery_alerts`. Historical `alert_state` and
`webhook_delivery_alerts` tables are retained only as backup-covered evidence:
there are no live writers, readers or retry jobs. Applied migrations stay intact.

## Migrate an existing installation

For schema 13, use this order:

1. Deploy the compatible 0.2.9 Worker on the existing schema. Confirm the encrypted
   email spool is enabled and bound.
2. Set `schema_meta.recovery_maintenance` to `on`. Bank polling, recovery and new
   ledger writes pause; authenticated mail waits encrypted in R2. Existing
   webhook delivery continues. Without a durable spool, mail is rejected for retry.
3. Drain existing bank leases. Take an encrypted backup and a Time Travel bookmark.
4. Apply only missing migrations. Verify schema, indices, pending email bodies and
   consumer subscriptions.
5. Clear the maintenance marker after verification. Check that polling and held
   email recovery resume. The protected status reports whether maintenance is on.

For older security cutovers and rollback constraints, see
[security rollout](security-hardening-rollout.md).

## Fio token authorization failures

Authorize new tokens in Fio Internetbanking after creating them. A direct bank
HTTP 500, or one explicitly forwarded by a relay, maps to
`fio_token_invalid_or_inactive`. Manual sync returns HTTP 422 and records the
code in `api_last_error`. A timeout or proxy failure remains transient.

The client timeout is 55 seconds. Relays should allow at least 45 seconds upstream
and forward `x-fio-upstream-status`; an inactive token can take about 30 seconds
to respond. See section 8 of the [Fio API manual](https://www.fio.cz/docs/cz/API_Bankovnictvi.pdf).

## Security and backups

Account owners control access; cross-owner subscriptions require an administrator.
Email trust comes from Cloudflare envelope evidence, aligned DKIM/DMARC and the
configured authentication service ID. MIME headers alone cannot establish it.
Callback policy is checked before every attempt. Credential creation/rotation
reject `Idempotency-Key` so plaintext credentials cannot enter that cache.

Backups are streamed AES-256-GCM `.sql.enc` envelopes. They omit ephemeral
idempotency, rate-limit and poll-lease tables and preserve AUTOINCREMENT sequence
values. A backup drains bank/email claims and owns maintenance for at most
15 minutes. Configuration writes return `503` with `Retry-After: 60` while paused.
Crashed backup windows expire; manually created maintenance stays on.

Decrypt into a new mode-0600 file without printing plaintext:

```bash
BACKUP_DECRYPTION_KEY='<base64 key>' \
  node scripts/decrypt-backup.mjs backup.sql.enc restored.sql
```

Restore into a separate database with the matching schema migrations. Restores
start with recovery paused and payment-reference allocation locked. Verify the
restore before rotating keys or resuming processing.

## Account export and reconciliation

`GET /bank-accounts/:id/transaction-export` returns complete facts with `cursor`,
a fixed `high_water` and `complete`. Persist both coordinates.

`POST /admin/cutover-reconcile` requires an administrator, a manifest SHA-256 and
an exact consumer/account/ID window. It creates missing v2 intents without
rewriting archived payloads or changing subscription intervals globally.
Pending/quarantined facts survive the normal 90-day cleanup. Replaying another
consumer's history requires separate authority.

Account identity cannot change under existing movements. The ingest-state route
exposes a credential digest for timeout recovery, never the credential. Creation
idempotency receipts are permanent.

## Development and releases

Run `pnpm check` for types, tests, ESM/CommonJS builds and package exports, then
`pnpm pack --dry-run`. Provider-live tests are separate and must not use production
bank credentials.

Development dependency/Actions minor and patch updates may auto-merge after
required checks. Major and production dependency updates need manual review.
TypeScript majors wait for declaration-build compatibility. Automation uses
verified Dependabot metadata without executing PR code.

Protected `v*` tags trigger npm OIDC publishing. GitHub releases attach the same
tarball, checksum, provenance and SBOM. Publishing the SDK does not deploy a
Worker or change production data.
