# Optional payment references

Reserve variable symbols when several applications share a bank account.
This optional feature requires schema 12 or 13 and does not change bank imports.

## Enroll an account

An administrator calls `POST /bank-accounts/:id/payment-reference-admin` to:

1. Map aliases to a canonical CZ IBAN and `grant` access to a consumer.
2. `import` known historical symbols using `vs`.
3. `activate` allocation with `registry_verified:true`.

The registry starts locked and restores locked. An import collision is recorded
and locks allocation until an operator resolves the inventory.

## Reserve a symbol

Call `POST /bank-accounts/:id/payment-references` with `source_ref` and
`payload_hash`. BankSync reserves a random, unique ten-digit symbol. To request a
specific symbol, also send `variable_symbol` (1-10 digits).

| Request | Result |
| --- | --- |
| Same immutable command | Same reservation |
| Changed command for an existing reference | HTTP 409 `reference_conflict` |
| Requested symbol already in use | HTTP 409; existing reservation stays intact |
| `GET` with `source_ref` | Only the caller's reservation |

Leading zeros share a namespace. Symbols never expire or get reused. Deleting
and recreating an account does not erase its physical identity. Runtime conflicts
do not overwrite history or lock unrelated reservations.

## Limits

Uniqueness covers enrolled/imported symbols, not symbols generated independently
elsewhere. Existing allocators are not migrated automatically. Account health is
available to an owner or active subscriber without reference enrollment; it
reports observed successful imports, not proof of complete bank history.

Return to the [integration guide](guide.md).
