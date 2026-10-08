# Security rollout reference

The initial hardening rollout is complete. Use this checklist when changing an
existing installation's security boundary. Use the [operations guide](operations.md)
for ordinary deployment and schema-13 recovery migration.

Production changes require authority for the affected deployment and data.
Keep diagnostics to sanitized counts and hostnames; do not print credentials,
transaction data, tenant identifiers, message bodies or callback paths/queries.

## Inspect before changing

Check callback hosts, cross-owner subscriptions and credential-shaped cache rows:

```sql
SELECT lower(substr(callback_url, instr(callback_url, '://') + 3,
  CASE WHEN instr(substr(callback_url, instr(callback_url, '://') + 3), '/') = 0
       THEN length(callback_url)
       ELSE instr(substr(callback_url, instr(callback_url, '://') + 3), '/') - 1 END)) AS callback_host,
       count(*) AS consumers
FROM webhook_consumers
GROUP BY callback_host
ORDER BY callback_host;

SELECT count(*) AS cross_owner_subscriptions
FROM webhook_subscriptions s
JOIN bank_accounts b ON b.id = s.bank_account_id
WHERE s.deleted_at IS NULL AND s.consumer_app_id <> b.owner_app_id;

SELECT count(*) AS credential_shaped_idempotency_rows
FROM idempotency_keys
WHERE response_body LIKE '%"secret"%'
   OR response_body LIKE '%"admin_key"%';
```

Review every shared subscription; retain only approved sharing. Build the exact
callback allowlist from reviewed hosts. Inspect R2 object keys/dates only. If cache
rows contained credentials, treat plaintext backups from that interval as affected.

## Verify email trust

Establish the Cloudflare-owned authentication service ID and duplicate-header
behavior from sanitized accepted/rejected evidence. Set `EMAIL_AUTHSERV_ID` and
test a legitimate bank message plus a controlled spoof rejection. Leave ingestion
paused if ownership of the authentication evidence cannot be established.

## Apply the cutover

1. Deploy tenant containment and verify a foreign subscription returns generic
   403 without changing subscription or delivery rows.
2. Set exact callback hosts, the verified email service ID and backup key version.
   Store backup keys independently from R2.
3. Apply only missing forward migrations. For a pre-hardening database this starts
   with `0010_security_hardening.sql`; never reapply the baseline.
4. Remove unapproved sharing. If credential-bearing cache rows existed, rotate
   affected webhook/admin keys and update consumers atomically. Verify both ends
   before deleting affected plaintext backups. Previous webhook secrets have a
   24-hour grace period.
5. Deploy the intended artifact and verify its recorded Cloudflare version is at
   100%, accounting for concurrent deployments.
6. Check public health, anonymous denial of detailed routes, authenticated health,
   foreign-subscription denial, redirect rejection and one durable receipt for a
   valid signed delivery.

## Rollback and publication

Rollback only to a Worker retaining tenant containment, protected diagnostics,
callback restrictions, safe webhook verification and encrypted backups. Do not
roll back schema 10 or restore deleted credential-bearing cache data. Later
schemas also require a compatible Worker.

Before tagging, verify GitHub branch/tag protection, required checks and PRs,
secret scanning/push protection, Dependabot security updates and pinned Actions.
Configure npm trusted publishing for the `npm` environment. Incomplete controls
mean the artifact remains a candidate, not a supported release.
