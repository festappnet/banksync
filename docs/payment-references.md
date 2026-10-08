# Optional payment references

BankSync can reserve variable symbols for applications sharing one bank account.
This is optional and does not change bank imports or webhook delivery.

## Enrollment

`migrations/0012_payment_references.sql` adds a permanent physical-account registry.
The existing v2 import/delivery pipeline remains active on schemas 11-13.
Tenant `GET /bank-accounts/:id/account-health` requires ownership or an active
subscription and is independent of optional reference enrollment. Health reports
fresh successful import observation, not an invented completeness watermark.

Reference enrollment requires an admin to map aliases to a canonical CZ IBAN,
grant the consumer, import known historical symbols and explicitly activate with
`registry_verified:true`. The registry starts locked and backups restore it locked.
Admin `POST /bank-accounts/:id/payment-reference-admin` supports `grant`, `import`
and `activate`; historical import uses `vs`. A collision during import is recorded
and locks further allocation until an operator resolves the inventory.

## Reserve a symbol

Enrolled tenants `POST /bank-accounts/:id/payment-references` with `source_ref` and
`payload_hash` to reserve a cryptographically random unique ten-digit symbol, optionally requesting `variable_symbol` (1-10 digits).
`GET` with `source_ref` retrieves only the caller's reservation. The same immutable
command returns the same reservation; a different command or requested symbol
collides with 409 `reference_conflict`. Leading zeros share a namespace. A requested
symbol already held for another purpose is rejected without replacement, overwriting
history or locking unrelated runtime reservations. Allocated symbols never expire
or get reused, and account deletion/recreation does not erase physical identity.

## Scope of the guarantee

This capability is optional. Its uniqueness guarantee covers enrolled/imported
references, not independently generated symbols in other applications. No external
allocator is automatically migrated and payment-reference use never implies a new
BankSync instance or bank import. `pnpm check` includes transactional SQLite cases
for concurrency/idempotency, scope, aliases, collisions and exhaustion.

Return to the [integration guide](guide.md).
