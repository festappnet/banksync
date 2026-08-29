# Secure BankSync public release

Date: 2026-08-29  
Status: Ready for execution  
Verification: release

## Outcome

BankSync can be published and promoted as `@festapp/banksync` only after its
production Worker and reusable package enforce tenant isolation, authenticate
bank email using Cloudflare-owned envelope/authentication evidence, avoid
persisting recoverable credentials, constrain outbound webhooks, expose only a
minimal public health surface, ship one clean D1 baseline plus a safe production
upgrade, and use a hardened release supply chain.

Observable end state:

- no tenant can observe, subscribe to, replay, mutate, or receive transactions
  for an account it does not own unless an administrator explicitly grants the
  subscription;
- untrusted MIME headers cannot establish sender, recipient, DKIM, or DMARC
  identity;
- no public endpoint reveals account labels, consumer identifiers, activity
  timestamps, queue state, secret-binding state, or active dependency probes;
- plaintext webhook/admin secrets cannot enter D1 idempotency rows or R2
  backups;
- production callbacks are limited to configured hosts and cannot redirect;
- fresh D1 installs and upgraded production D1 both reach the same schema;
- release artifacts are reproducible, checksummed, provenance-bearing, and
  built by protected CI from an immutable tag.

## Scope

### In scope

- Cloudflare Worker HTTP, Email Routing, Queue, D1, R2, and scheduled entry
  points in `src/cloudflare.ts` and their supporting modules.
- Tenant/admin authentication and authorization, subscription sharing, webhook
  replay, idempotency, callback validation/delivery, health/status, error
  handling, request limits, email trust, credential storage, backup contents,
  and public verification helpers.
- The locally prepared D1 baseline squash and its compatibility with the nine
  migrations already applied to production.
- Mendelio's BankSync consumer boundary in
  `packages/app-shared/src/banksyncWebhook.ts`, production composition in
  `services/banksync`, and its separate Supabase billing schema.
- GitHub repository controls, CI pinning, dependency automation, artifact
  provenance, npm publication, production rollout, and release verification.

### Out of scope

- Redesigning Mendelio pricing, credit settlement, invoice, or order models.
- Adding banks or changing transaction parsing semantics except where required
  to bind parsing to authenticated envelope identity.
- General security work outside BankSync and its direct Mendelio webhook
  consumer.
- Deleting historical D1 data that is not credential-bearing and is retained by
  the documented retention policy.

## Constraints

- The existing public GitHub release `v0.1.0` and its source are already
  externally visible; treat it as an unsafe preview and do not promote it to
  npm or recommend production adoption.
- Production D1 has recorded the original migration filenames `0001` through
  `0009`. Cloudflare records migration filenames in `d1_migrations`, so the
  next production upgrade must be `0010` or higher. The squashed
  `0001_schema.sql` is only the fresh-install baseline.
- Existing production data must be preserved except explicitly identified
  ephemeral idempotency rows and affected backup objects. Any deletion of
  remote D1/R2 data is a separately authorized production action.
- BankSync D1 and Mendelio Supabase billing remain separate authorities.
  BankSync emits authenticated transaction facts; the consumer's billing RPCs
  decide and persist settlement.
- Applications and Workers must not receive a Supabase full-project key. The
  Mendelio consumer continues through registered workload capability RPCs.
- Do not publish, deploy, rotate secrets, delete backups, change GitHub
  protections, commit, or push merely by executing this plan; those operational
  actions require their normal separate authority and repository gates.
- No compatibility fallback may preserve a known insecure authorization or
  verification path. This is a pre-1.0 contract; secure breaking changes are
  preferred over aliases that keep the weak behavior reachable.

## Current-state evidence

| Claim | Evidence | Consequence |
|---|---|---|
| A tenant can subscribe its own app to any numeric account ID. | `src/cloudflare.ts:1049-1063`, `CreateSubscriptionSchema` | Critical cross-tenant webhook disclosure; production containment is first. |
| `/status` is unauthenticated and returns labels, account IDs, consumer IDs, timestamps, and delivery counts. | `src/cloudflare.ts:575-577`; production GET returned 200 with those fields on 2026-08-29. | Operator status must move behind admin auth; public health must be minimal. |
| `/health/deep` is unauthenticated and performs a D1 write plus a Cloudflare API request. | `src/cloudflare.ts:588-603`, `src/health_deep.ts:57-137`; production GET returned 200. | It is both an information and externally triggerable work/DoS surface. |
| Idempotency identity omits method and path. | `src/idempotency.ts:34-56` | The same key/principal/body can replay a response from another route. |
| Entire mutation responses are stored in plaintext. | `src/cloudflare.ts:646-661`, `src/idempotency.ts:59-72` | Consumer creation and secret rotation responses can put plaintext credentials in D1. |
| Backups include `idempotency_keys`, all transaction data, raw parse data, and encrypted secret tables in a plaintext SQL object. | `src/backup.ts:23-42,77-104` | Credential-bearing rows and PII are copied into R2 without application-layer encryption. |
| Email parsing derives From, To, and authentication from raw MIME. | `src/mime.ts:20-62`, `src/cloudflare.ts:1272-1287` | The code does not bind decisions to the Cloudflare envelope or a trusted authserv-id. |
| Callback validation only requires an HTTPS URL and fetch follows redirects. | `src/validation.ts:99-112`, `src/webhookSender.ts:34-44` | A tenant controls arbitrary outbound HTTPS requests and redirect destinations. |
| The exported verification helper checks only HMAC bytes. | `src/relay.ts:83-118` | Consumers can appear verified while omitting freshness and header/body identity checks. |
| Mendelio's consumer independently checks a five-minute timestamp window and claims a delivery by body hash before settlement. | `packages/app-shared/src/banksyncWebhook.ts:createBanksyncWebhookHandler` | Preserve these guarantees while moving to the canonical package verifier. |
| No known production dependency vulnerability was reported. | `pnpm audit --prod --audit-level low` on 2026-08-29 | Dependency CVEs are not the release blocker, but automation is still required. |
| GitHub main is unprotected; secret scanning, push protection, Dependabot security updates, and SHA pinning are disabled. | GitHub repository/actions APIs on 2026-08-29 | A green build alone is not an adequate publication chain. |
| Local migration squash creates the same structural schema as original 0001-0009 and the suite passes. | Local structural PRAGMA comparison: 15 tables; `pnpm check`: 27 files, 497 tests | Preserve this WIP, then extend it for the security migration/version. |
| Latest Mendelio deletion removed only `services/banksync/migrations/0001-0009` after package extraction. | Mendelio commit `03e3798a9` | No billing migration was lost in the package cutover. |
| Billing inbox/settlement remains in separate Supabase migrations and capability RPCs. | `supabase/migrations/20260729174000_dating_user_and_workload_authority_allowlist.sql` and sibling workload migrations | Do not move billing schema into BankSync or the D1 baseline. |

Representative flow: Cloudflare Email Routing invokes `email()`; MIME and
account pairing create a D1 transaction; the durable delivery coordinator
signs and posts an envelope to a subscribed consumer; Mendelio verifies the
request, atomically claims `billing.banksync_delivery_claim`, executes the
app-specific payment RPC, and completes the immutable receipt. The critical
bypass occurs before delivery: tenant-controlled subscription creation can add
the attacker's consumer to another tenant's account.

### Execution evidence (2026-08-29)

- Local source hardening passes 28 Vitest files / 530 tests, typecheck, build,
  production dependency audit, Wrangler Worker dry-run, and both fresh and
  recorded-0001–0009-to-0010 disposable Wrangler D1 migration flows.
- Two independent `npm pack --ignore-scripts` runs produced byte-identical
  `festapp-banksync-0.1.1.tgz` with SHA-256
  `0531be239d33ee543bfaa34b9b97a1da093c1106beed64dccb305af3fbaec57d`.
  It contains only `0001_schema.sql` and `0010_security_hardening.sql` under
  `migrations/` and has no weak verifier export.
- Read-only production checks still show the old state: deployment version
  `e525ef60-ebd7-423e-ade2-02d8018de819` at 100%, D1 schema version 9,
  anonymous `/status` and `/health/deep` returning 200, and two active
  cross-owner subscriptions. No credential-shaped idempotency row was found.
- Callback host-only inventory returned `httpbin.org`, `maturita.festapp.net`,
  `mendelio.net`, `muzazena.festapp.net`, and `voice.mendelio.net`; each requires
  explicit operator approval before allowlist enforcement, especially the
  apparent test host.
- GitHub still has no ruleset or main protection, secret scanning/push
  protection and Dependabot security updates are disabled, and npm returns 404
  for `@festapp/banksync`. Those external controls and publication remain
  intentionally unapplied without separate authority.

## Target architecture and invariants

### Canonical owner and contract

- `BankSync Worker` owns authenticated bank-event ingestion, normalized
  transactions, delivery intent, and signed delivery attempts in D1.
- `webhook_consumers` owns callback identity and encrypted signing material.
- `bank_accounts.owner_app_id` is the authorization source of truth for tenant
  account operations.
- Cross-consumer sharing is an administrator-only operation. A tenant may only
  create or remove a subscription whose account owner and consumer both equal
  its own `app_id`; owner auto-subscription remains the normal path.
- `@festapp/banksync` owns the canonical high-level webhook verification
  contract: raw body HMAC, timestamp syntax and tolerance, delivery-ID header
  equality with parsed body, event/version validation, and structured errors.
- Each consumer owns business settlement and its idempotent inbox. BankSync
  transport success never implies payment success without the returned durable
  receipt.

### Invariants

1. Tenant authorization is derived from stored ownership, never caller-supplied
   `app_id` or knowledge of a numeric ID.
2. Only an admin can establish a subscription across two different owners.
3. A bank email is accepted only when Cloudflare envelope recipient matches the
   pairing address, envelope sender agrees with authenticated sender identity,
   and a trusted Cloudflare authentication result proves aligned DKIM or DMARC.
4. Duplicate or attacker-supplied `Authentication-Results` headers cannot
   override the trusted Cloudflare result.
5. Public `/health` returns only coarse availability. Detailed status and active
   probes require admin auth and rate limiting.
6. Every accepted mutation body is bounded before full buffering.
7. Idempotency identity includes principal, method, canonical path, and caller
   key; a key cannot cross routes.
8. Endpoints that return credentials reject `Idempotency-Key` and never persist
   their response body.
9. No backup object contains plaintext credentials or unencrypted raw financial
   data; ephemeral caches are excluded from backups.
10. In production, callback hosts must match an explicit allowlist, URLs cannot
    contain credentials, and webhook fetch uses `redirect: 'manual'`.
11. Verification rejects stale/future timestamps, malformed signatures,
    delivery header/body mismatch, unsupported event versions, and replayed
    delivery IDs at the consumer persistence seam.
12. Fresh install and production upgrade report one runtime schema version and
    contain no legacy DLQ/archive table.
13. A release tag is immutable in practice: protected creation path, SHA-pinned
    CI dependencies, reproducible pack output, checksums, and provenance.

### Entry points and forbidden bypasses

- Public: `GET /health` only, returning a non-sensitive coarse result.
- Admin-only: `/status`, `/health/deep`, consumer creation/deletion/secret
  rotation, cross-owner subscriptions, CF rule operations, audit/unmatched data.
- Tenant: own bank accounts, own callback within the allowlist, own delivery
  status/replay, and own owner subscription only.
- Email: `ForwardableEmailMessage` envelope plus trusted Cloudflare auth result;
  raw MIME is content, never identity authority.
- Forbidden: caller-supplied ownership, filter-after-limit authorization,
  untrusted MIME auth headers, public active probes, unrestricted callback
  egress, low-level HMAC-only success presented as complete verification,
  plaintext credential caching, or a second migration history for billing.

## Decisions, assumptions, and blockers

### Decisions

- **D1:** Cross-owner subscriptions are admin-only. This retains intentional
  shared-account support without inventing a public sharing-token protocol.
- **D2:** Existing tenant cross-owner subscriptions are not grandfathered.
  Inventory them; explicitly approve legitimate rows or delete them during the
  production remediation.
- **D3:** `/status` and `/health/deep` move behind admin auth. Monitoring that
  needs detailed data must send the admin credential or use an internal binding;
  the public status application continues to use coarse `/health`.
- **D4:** Credential-returning endpoints do not support response idempotency.
  They reject an idempotency header rather than silently weakening one-time
  disclosure semantics.
- **D5:** Production callback egress requires an exact configured hostname
  allowlist and rejects redirects. Generic public adopters configure their own
  hosts; development may use a separately explicit development allowlist.
- **D6:** Replace the exported HMAC-only verifier with a high-level safe verifier
  before 1.0. Do not retain the old name as a compatibility alias.
- **D7:** Backup objects use application-layer authenticated encryption with an
  independent versioned backup key. `idempotency_keys` and rate-limit buckets
  are not backed up.
- **D8:** The canonical fresh baseline becomes schema version 10 and a separate
  `0010_security_hardening.sql` upgrades existing production. Future migrations
  begin at `0011`.
- **D9:** `v0.1.0` remains factual history but is clearly marked preview/unsafe;
  the first promoted package is a new version, never a replaced tag or asset.

### Assumptions

- **A1 (not established during execution):** Current Cloudflare Workers Email
  documentation confirms that `message.from` and `message.to` are SMTP envelope
  fields and that Email Routing requires incoming mail to pass SPF or DKIM, but
  it does not document a stable Cloudflare-owned Authentication-Results
  authserv-id or a first-class authentication-result field. The implementation
  therefore fails closed unless `EMAIL_AUTHSERV_ID` is explicitly configured and
  rejects absent, duplicate, or ambiguous matching results. Email ingestion must
  remain paused until one sanitized accepted and one rejected production header
  establish the real value; raw MIME is not a fallback. Evidence:
  `https://developers.cloudflare.com/email-service/api/route-emails/email-handler/`
  and `https://developers.cloudflare.com/email-service/reference/postmaster/`.
- **A2:** All legitimate production callback hosts are enumerable in Mendelio
  configuration; impact if false: an explicit per-consumer operator approval
  store is needed; resolve by: list current consumer callbacks with host-only
  projection before implementation.
- **A3:** Public status monitoring only requires coarse `/health`; impact if
  false: add an authenticated status-probe credential, not a public detailed
  endpoint; resolve by: trace `apps/status/src/status/probes.ts`.
- **A4:** No external adopter relies on `v0.1.0`; impact if false: publish a
  security advisory and migration note, but do not restore insecure behavior;
  resolve by: GitHub traffic/package download evidence where available.

### Blockers

- **B1:** npm publication remains blocked until the Festapp npm account/token or
  trusted-publisher configuration is valid.
- **B2:** Remote D1/R2 deletion, secret rotation, GitHub protection changes,
  production deployment, commit, push, and release publication require their
  normal separate operational authority.

## Deletion ledger

| Artifact | Current role | Final action | Removal proof |
|---|---|---|---|
| Tenant cross-owner `POST /subscriptions` behavior | Creates unauthorized delivery intent | Reject unless account owner equals authenticated tenant; admin remains explicit sharing authority | Negative integration test with two tenants and delivery fan-out assertion |
| Public detailed `/status` | Operator projection | Require admin auth | Unauthenticated production request is 401/404 and contains no labels/IDs |
| Public active `/health/deep` | Dependency probe | Require admin auth or internal binding | Unauthenticated request performs no D1/CF work and returns 401/404 |
| HMAC-only `verifyWebhookSignature` public contract | Partial verification helper | Replace with high-level `verifyWebhook`; remove old export and tests | `rg` absence plus consumer migration and negative contract tests |
| Unscoped idempotency hash | Keyed only by principal/key | Include method and canonical path | Cross-route same-key test is a miss, not a replay |
| Idempotency on credential endpoints | Stores one-time secrets | Reject header and skip cache | D1 assertion contains no returned secret/admin key |
| `idempotency_keys` in backups | Copies cached responses | Exclude with documented exemption | Backup completeness test and dump absence |
| Plain `.sql` R2 backups | Restorable plaintext financial data | Replace with versioned AES-GCM envelope and restore documentation/tooling | R2 fixture cannot contain SQL/PII strings and decrypts with correct key only |
| Arbitrary HTTPS callback and redirects | Tenant-controlled egress | Exact allowlist, no credentials/IP literals, `redirect: manual` | URL matrix and redirect integration tests |
| Raw MIME identity authority | From/To/auth source | Use Cloudflare envelope and trusted auth result | Spoofed duplicate-header tests rejected |
| Full error strings in HTTP 500 | Diagnostic response | Stable public error code; detail only in redacted logs | Failure test contains no SQL/config detail |
| Original incremental migrations `0002-0009` in fresh package | Development history | Keep deleted; retain only git history | Packed artifact contains baseline + `0010`, no obsolete files |
| Migration tests for obsolete intermediate states | Historical transition proof | Replace with baseline parity and 0009→0010 upgrade tests | Test inventory and fresh/upgrade schema comparison |
| Mendelio local webhook verifier duplicate | Secure but duplicate implementation | Move to package high-level verifier | `rg` absence of local HMAC construction |
| Unpinned GitHub Actions majors | Mutable CI code | Pin full commit SHAs with update comments | Workflow policy/API reports SHA pinning |
| Unprotected main/tags and disabled security automation | Release bypass | Enable ruleset, required checks, secret scanning/push protection, Dependabot | GitHub API state and rejected bypass test where safe |

## Implementation waves

### Wave 0 — Contain the production tenant breach

**Goal**

No authenticated tenant can create a new cross-owner subscription while the
rest of the hardening is being built.

**Changes**

- `src/cloudflare.ts: POST /subscriptions` — load the referenced bank account
  before creation. For tenant auth, require both `input.app_id === auth.app_id`
  and `account.owner_app_id === auth.app_id`; return the same generic forbidden
  response for nonexistent and foreign accounts to prevent enumeration.
- `src/index.test.ts` — add two-tenant negative tests and assert that no
  subscription or delivery job is created.
- Add an admin positive test proving explicit cross-owner sharing still works.

**Migration/deletion**

- Read-only inventory query: group active subscriptions where
  `consumer_app_id <> bank_accounts.owner_app_id`. Do not print account/payment
  data.
- Prepare a reviewed list of legitimate shared rows. Production deletion of any
  unapproved row is a separate authorized operation.

**Failure and compatibility**

- Owner auto-subscription during account creation remains valid.
- A generic 403 prevents account-ID probing. No temporary feature flag or legacy
  tenant bypass is allowed.

**Validation**

- Targeted two-tenant tests plus the BankSync typecheck.
- On an isolated D1, attempt foreign subscription and verify subscription/job
  counts are unchanged.

**Exit condition**

- The negative test is green and a separately authorized production deploy
  returns 403 for a disposable cross-tenant attempt without creating a row.

### Wave 1 — Establish trusted email identity

**Goal**

Only Cloudflare-authenticated bank mail addressed to the account's actual
envelope recipient can create a transaction.

**Changes**

- `src/cloudflare.ts: email/processEmail` — pass a structured trusted envelope
  containing `message.from`, `message.to`, and selected `message.headers` instead
  of letting MIME parsing decide identity.
- `src/mime.ts` — restrict MIME output to content fields and diagnostic headers;
  remove From/To/authentication as decision authority.
- Add `src/email_auth.ts` — parse exactly the Cloudflare-owned authentication
  result identified in A1, require aligned DMARC or aligned DKIM, reject
  ambiguous/duplicate trusted results, and compare normalized envelope/header
  identities where applicable.
- `src/email_classify.ts` — accept already authenticated sender/recipient facts;
  pair only from the envelope recipient.
- Tests: forged MIME From/To, attacker-prepended and appended
  `Authentication-Results`, multiple results, mismatched envelope/header,
  subdomain alignment, absent authentication, and real sanitized bank fixtures.

**Migration/deletion**

- Delete `ExtractedEmail.authResults`, `dkimPass`, `dmarcPass`, and `isAligned`
  as raw-MIME-derived authority once all callers move.

**Failure and compatibility**

- Fail closed when trusted authentication evidence is absent or ambiguous.
- If A1 fails, stop email ingest and document the Cloudflare-supported
  alternative; do not fall back to trusting raw MIME.

**Validation**

- Targeted MIME/classification/Worker tests.
- One authorized production test from an allowed bank source and one controlled
  spoof rejection, checking only outcome metadata.

**Exit condition**

- Every identity decision traces to the Cloudflare envelope/trusted result, and
  searching the classifier finds no raw `Authentication-Results` trust path.

### Wave 2 — Close HTTP information, work-amplification, and error surfaces

**Goal**

Unauthenticated HTTP traffic can only perform a cheap, non-sensitive health
read; authenticated traffic is bounded and errors reveal no internals.

**Changes**

- `src/cloudflare.ts` — make `/status` and `/health/deep` admin-only and move auth
  resolution before them. Keep `/health` public but return only `{ok:true}` or a
  stable unavailable shape.
- `src/health_deep.ts` — retain active probes for authenticated operator use;
  ensure repeated/concurrent probes cannot accumulate `health_probe` rows.
- Add bounded body reading with a 256 KiB default before JSON parsing; reject
  oversized or misleading `Content-Length` bodies with 413.
- Replace `jsonResponse({error:String(err)})` with a stable
  `internal_error`/request correlation ID; keep redacted diagnostic detail only
  in Worker logs.
- Rate-limit failed authentication by source IP and add a separate high admin
  ceiling; do not rely solely on tenant-principal limiting.
- Update Mendelio status probe to consume only coarse `/health` or send a
  dedicated authenticated credential if A3 disproves the assumption.

**Migration/deletion**

- Delete tests and docs asserting unauthenticated detailed status/deep health.

**Failure and compatibility**

- Health failure must not serialize D1/Cloudflare exception text.
- Rate-limit state remains bounded by existing pruning and cannot use
  caller-controlled proxy headers instead of `cf-connecting-ip`.

**Validation**

- Route tests for unauthenticated 401, minimal public health, 413 streaming
  cutoff, stable 500, and rate-limit concurrency.
- Production smoke with cache-busted URLs proving detailed data is absent.

**Exit condition**

- Anonymous GETs expose no identifiers and cannot trigger D1 writes or external
  API probes.

### Wave 3 — Remove credential persistence and harden idempotency/backups

**Goal**

Idempotency is route-scoped and no D1/R2 persistence path stores plaintext
credentials or unencrypted financial backups.

**Changes**

- `src/idempotency.ts` — hash `principal + method + canonical pathname + key`;
  on lookup verify stored method/path/body as defense in depth.
- `src/cloudflare.ts` — classify credential-returning routes centrally. Reject
  `Idempotency-Key` on consumer creation and both secret rotations, and never
  pass their response to `recordIdempotency`.
- `src/backup.ts` — move `idempotency_keys` and `rate_limit_buckets` to
  `BACKUP_EXCLUDED` with explicit ephemeral-state reasons.
- Add versioned AES-GCM backup encryption using a distinct
  `BACKUP_ENCRYPTION_KEY_Vn`, random IV, authenticated metadata, `.sql.enc`
  suffix, and a deterministic restore/decrypt command or script that never
  prints secrets by default.
- Redact or minimize `parse_log.raw_data`; retain only bounded content needed
  for parser diagnosis, with sender/recipient/account identifiers masked where
  they are not necessary.

**Migration/deletion**

- Add `migrations/0010_security_hardening.sql`: clear existing
  `idempotency_keys`, apply any required schema/index constraint, and update
  `schema_meta` to `10`.
- Update squashed `0001_schema.sql` to the final version-10 fresh schema while
  preserving its filename. Future migrations begin at `0011`.
- Before remote deletion, query only counts/boolean indicators to determine
  whether credential-shaped response bodies exist.
- If credential rows existed, rotate affected webhook/admin keys, update
  consumers atomically, verify both sides, then remove R2 backups containing the
  old plaintext objects. These are separate authorized production actions.

**Failure and compatibility**

- Keep previous webhook secret only for the existing bounded 24-hour delivery
  grace; tenant admin keys have no compatibility fallback.
- A lost backup key makes backups unrecoverable; store it separately from R2 and
  document rotation/restore before enabling encrypted output.

**Validation**

- Idempotency cross-route/method tests, credential endpoint cache-absence tests,
  backup string-absence and encrypt/decrypt/tamper tests.
- Structural comparison of fresh baseline versus original 0001-0009 plus 0010
  upgrade.
- Disposable Wrangler D1 migration apply for both fresh and upgrade fixtures.

**Exit condition**

- No database or backup fixture contains returned plaintext credentials; fresh
  and upgrade schemas are structurally equivalent at version 10.

### Wave 4 — Constrain webhook egress and make verification safe by default

**Goal**

Tenant callbacks cannot turn BankSync into arbitrary egress, and package
consumers cannot accidentally omit replay/freshness checks.

**Changes**

- `src/validation.ts` — parse callback URLs into a canonical validator that
  rejects credentials, fragments, IP literals, localhost/special-use hosts,
  non-HTTPS schemes, and hosts outside `CALLBACK_HOST_ALLOWLIST` in production.
- `src/webhookSender.ts` — set `redirect:'manual'`; treat every 3xx as a terminal
  configuration failure and retain the 10-second abort.
- Revalidate stored callback URLs immediately before every send so legacy rows
  cannot bypass newer policy.
- `src/relay.ts` — replace the public HMAC-only helper with `verifyWebhook`, which
  validates timestamp tolerance, signature syntax/bytes, JSON envelope,
  delivery header/body equality, event and version, and returns a typed verified
  envelope. Do not export a weak alias.
- Migrate Mendelio `packages/app-shared/src/banksyncWebhook.ts` to the package
  verifier while preserving its D1/Supabase inbox claim, body hash, lease, and
  immutable receipt logic.

**Migration/deletion**

- Inventory existing callback hosts and configure the exact production
  allowlist before enforcing it. Invalid rows block rollout and require explicit
  operator correction; no permissive fallback.
- Delete Mendelio's duplicate local HMAC construction after parity tests pass.

**Failure and compatibility**

- DNS rebinding cannot be completely proven by URL syntax. Exact hostname
  allowlisting and no redirects are the production security boundary.
- The safe verifier does not own durable replay storage; its return type/docs
  require consumers to persist delivery-ID idempotency before side effects.

**Validation**

- Callback URL matrix including Unicode/punycode, mixed case, trailing dot,
  encoded credentials, IPv4/IPv6, redirects, and allowlist suffix confusion.
- Webhook tests for stale/future timestamps, delivery mismatch, tampering,
  unsupported version, and valid delivery.
- Mendelio owning tests for claim/replay/in-flight/hash conflict and one
  end-to-end signed webhook against a disposable billing database.

**Exit condition**

- Every outbound fetch target passes current policy, no redirect is followed,
  and Mendelio imports the canonical verifier with no local signature duplicate.

### Wave 5 — Harden repository and artifact supply chain

**Goal**

Only reviewed, green, immutable source can produce the promoted package and
release artifacts.

**Changes**

- `.github/workflows/check.yml` — pin every action to a full commit SHA and keep
  the readable release tag in a comment; add minimal explicit permissions.
- Add Dependabot for npm and GitHub Actions, CodeQL for TypeScript, dependency
  review on pull requests, and a secret-pattern/security test appropriate for a
  public repository.
- Add a release workflow triggered by a protected version tag. It installs with
  frozen lockfile, runs the complete release gates, packs once, emits SHA-256,
  produces provenance/SBOM, publishes that exact tarball to npm through trusted
  publishing, and attaches the same bytes/checksum to GitHub Release.
- Configure GitHub ruleset: protected main, required `check`/security jobs,
  reviewed PRs, no force push/deletion, protected version tags, secret scanning
  plus push protection, Dependabot security updates, and Actions SHA pinning.
- Add a security policy and private vulnerability reporting instructions.

**Migration/deletion**

- Mark `v0.1.0` as a preview affected by the pre-release security hardening;
  never replace its tag or asset.
- Stop manually built release tarballs once the workflow is authoritative.

**Failure and compatibility**

- If npm trusted publishing cannot be configured, stop before promotion. A
  GitHub asset may be a release candidate but must not be described as the
  canonical public package.
- Repository settings are external state and must be verified after API/UI
  mutation; config files alone are insufficient.

**Validation**

- GitHub API confirms ruleset, scanning, Dependabot, workflow permissions, and
  SHA-pinning policy.
- A release candidate workflow from a non-final tag produces one tarball whose
  local, GitHub, and registry checksums match and whose provenance identifies
  the protected commit.

**Exit condition**

- Direct unreviewed publication is unavailable, and artifact identity is
  traceable from npm/GitHub bytes to one protected commit.

### Wave 6 — Release verification and legacy contraction

**Goal**

Ship the secure package, upgrade Mendelio and production safely, then prove the
old insecure paths and migration history are absent.

**Changes**

- Complete package docs: threat model, trust boundaries, secure callback setup,
  email authentication requirements, webhook verification/idempotency example,
  encrypted backup restore, key rotation, migration numbering, and security
  disclosure.
- Update `services/banksync/package.json` to the promoted immutable package
  version, update lock integrity, and keep the Mendelio Worker wrapper minimal.
- Update Mendelio Wrangler variables/secrets for callback host allowlist and
  backup key version; do not commit values.
- Remove stale references claiming the registry package is unavailable once npm
  publication is verified.

**Migration/deletion**

- Apply only `0010_security_hardening.sql` to production D1. Never reapply the
  squashed baseline or use a full unrelated migration push.
- Perform reviewed subscription cleanup, required secret rotations, and old R2
  backup deletion in that order, with recovery evidence captured first.
- Packed package must contain only `0001_schema.sql` and
  `0010_security_hardening.sql`; original `0002-0009` remain only in git history.

**Failure and compatibility**

- Deploy from the main Mendelio checkout as required. Confirm the deployment
  version ID because another session may deploy concurrently.
- Rollback may restore the previous Worker binary only if it does not reopen the
  cross-tenant authorization path. Do not roll schema version backward or
  recreate deleted plaintext caches/backups.
- If consumer update fails after secret rotation, use the bounded previous
  webhook-secret grace to complete the cutover; never add an indefinite dual
  secret path.

**Validation**

- Public repo release gates: typecheck, all tests, build, pack inspection,
  dependency audit, disposable fresh/upgrade D1, Worker dry run.
- Mendelio standard checks for the package consumer and billing webhook, then
  release build/deploy gates required by its runbook.
- Production smoke: minimal public health; anonymous detailed routes denied;
  authenticated status healthy; disposable tenant cannot subscribe foreign
  account; valid bank/API transaction produces exactly one signed delivery and
  one immutable billing receipt; callback redirect rejected; deployment list
  shows the intended version at 100%.

**Exit condition**

- The promoted npm/GitHub artifact, Mendelio lockfile, running Worker version,
  D1 schema version, GitHub controls, and documented checksum all identify the
  same secure release, and every deletion-ledger absence proof passes.

## Rollout and rollback

1. Build and test Wave 0 first; deploy the authorization containment as a
   standalone emergency production change after approval.
2. Implement Waves 1-4 against isolated D1 and sanitized fixtures. Do not expose
   permissive feature flags.
3. Inventory callback hosts, cross-owner subscriptions, credential-shaped
   idempotency rows, and affected backup dates using counts/host-only output.
4. Land `0010`, package/runtime changes, Mendelio consumer update, and config
   support before enforcing production secrets/allowlists.
5. Verify encrypted backup restore and consumer secret rotation in isolation.
6. Harden GitHub/npm external state, then create a release candidate through CI.
7. Apply the scoped production D1 migration and data remediation, deploy the
   intended Worker version, and run one final release smoke.
8. Promote the exact tested tarball to npm and GitHub Release. Never rebuild
   between test and publication.

Rollback is binary-forward: revert to the last secure Worker revision only.
Database version 10 and deletion of credential-bearing ephemeral rows remain.
Do not restore public detailed routes, tenant cross-owner subscription, weak
verification exports, plaintext backup output, or old R2 objects.

## Verification strategy

| Risk or invariant | Verification seam | Command/observation |
|---|---|---|
| Tenant isolation | Worker route + D1 subscription/job state | Targeted two-tenant Vitest and disposable D1 negative flow |
| Email identity | Envelope/auth parser | Spoof/duplicate/mismatch fixtures plus sanitized real header |
| Public exposure | HTTP routes | Anonymous route matrix and production cache-busted smoke |
| Work amplification | Deep-health side effects | Assert unauthenticated request invokes no DB write/fetch |
| Secret persistence | D1 and backup dump | Search structured rows/decrypted fixtures for known canary secrets |
| Idempotency isolation | Cache lookup | Same key/body across methods/routes never hits |
| Callback egress | URL policy and fetch adapter | Host matrix, manual redirect, timeout tests |
| Webhook authenticity/replay | Public verifier + Mendelio inbox | Tamper/freshness/ID tests and database claim replay tests |
| Schema convergence | SQLite/D1 metadata | Fresh baseline versus 0001-0009+0010 structural comparison |
| Billing separation | Repository boundaries | No BankSync migration references Supabase/billing; Mendelio RPC tests pass |
| Supply chain | GitHub/npm APIs and artifact bytes | Required settings enabled; checksum/provenance equality |
| Production identity | Cloudflare deployment state | Intended version ID at 100% plus post-deploy route/flow smoke |

## Definition of complete

- [ ] Wave 0 containment is running in production.
- [ ] Every tenant path authorizes from stored ownership and all foreign-ID
      negative tests leave D1 unchanged.
- [ ] Email identity uses only Cloudflare-owned evidence and spoof fixtures fail.
- [ ] Public HTTP exposes only coarse health and cannot trigger active probes.
- [ ] Credential responses never enter idempotency or backup persistence.
- [ ] Backup objects are application-layer encrypted and restore is proven.
- [ ] Callback egress is allowlisted and redirect-free.
- [ ] The canonical verifier is used by Mendelio with durable replay handling.
- [ ] Fresh and upgraded D1 converge at version 10; legacy DLQ and migration
      artifacts are absent from the package.
- [ ] No BankSync migration was moved into or confused with Mendelio billing.
- [ ] GitHub main/tags, CI actions, scanning, and release workflow are hardened.
- [ ] npm authentication/trusted publishing works and published bytes match the
      tested GitHub artifact and checksum.
- [ ] Mendelio lockfile and production Worker run that exact version.
- [ ] Full release verification and production smoke pass after the final deploy.

## Residual risks

- Cloudflare remains the trusted ingress, execution, D1, Queue, and R2 provider;
  this plan does not defend against compromise of the Cloudflare account itself.
- Exact callback hostname allowlisting mitigates general egress abuse but does
  not attest the security of an allowlisted consumer application.
- Bank-generated email formats can change; authenticated mail may still fail
  parsing safely and require parser maintenance.
- Historical `v0.1.0` source remains public. Security comes from preventing its
  promotion/use and shipping a clearly documented fixed release, not attempting
  to erase public git history.
