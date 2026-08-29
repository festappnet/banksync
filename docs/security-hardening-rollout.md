# Security-hardening rollout gates

These steps describe external state that source changes do not apply. Run them
only with separate production authority. Never print account, transaction,
secret, callback path/query, or message content.

## Read-only inventory

Run host/count-only D1 queries before enabling the release:

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

Review every cross-owner subscription. Record explicit approval for legitimate
sharing and prepare deletion of all remaining rows; no row is grandfathered.
Configure `CALLBACK_HOST_ALLOWLIST` from the reviewed exact hostname inventory,
never from suffixes or URL paths.

List R2 backup object keys/dates only. If the credential-shaped count is nonzero,
treat all plaintext `.sql` objects created during the affected interval as
credential-bearing.

## Trusted email ingress gate

Cloudflare documents envelope `from`/`to` and platform SPF-or-DKIM acceptance,
but not a stable Authentication-Results authserv-id. Inspect one accepted and one
rejected production header without logging message content. Establish the
Cloudflare-owned authserv-id and duplicate-header behavior, set
`EMAIL_AUTHSERV_ID`, then run one legitimate bank message and one controlled
spoof rejection. Leave email ingest paused if ownership cannot be established.

## Ordered production cutover

1. Deploy the tenant-containment Worker after the normal emergency approval and
   prove a disposable foreign subscription returns the generic 403 without row
   or delivery-job changes.
2. Configure the exact callback allowlist, backup key version, and verified email
   authserv-id. Store backup keys independently from R2.
3. Apply only `0010_security_hardening.sql` to the production D1. Never apply the
   squashed baseline to an existing database.
4. Delete unapproved cross-owner subscriptions.
5. If credential-shaped cache rows existed, rotate affected webhook/admin keys,
   atomically update consumers, verify both ends, and only then delete affected
   plaintext R2 backups. The 24-hour previous-webhook-secret grace is the only
   bounded compatibility window.
6. Deploy the intended Worker artifact, record its Cloudflare version ID, and
   verify it is at 100% after checking for concurrent deployments.
7. Smoke minimal public health, anonymous denial for detailed routes, admin
   health, foreign-subscription denial, redirect rejection, and exactly one
   durable billing receipt for one valid signed delivery.

Rollback is binary-forward: only a Worker revision that retains tenant
containment, admin-only detailed routes, callback policy, safe verification, and
encrypted backups may be restored. Schema v10 and deletion of credential-bearing
ephemeral data are not rolled back.

## Repository and publication controls

Before creating a protected version tag, independently verify through GitHub's
API/UI that main and `v*` tags cannot be force-pushed/deleted, required check and
security jobs are enforced, reviewed PRs are required, secret scanning/push
protection and Dependabot security updates are active, and Actions require SHA
pinning. Configure npm trusted publishing for the `npm` environment. If either
control plane is incomplete, the produced GitHub artifact is only a release
candidate and must not be promoted as the canonical package.
