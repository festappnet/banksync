# Payment-reference issuance retired

BankSync imports and delivers bank facts. Consumers own VS allocation, invoices,
order matching and uniqueness rules. BankSync never requires a bank transaction
reference to be registered, unique, allocated or associated with an order.

The former `/bank-accounts/:id/payment-references` and
`/bank-accounts/:id/payment-reference-admin` endpoints now return HTTP 410
`endpoint_retired`, including requests carrying previously cached idempotency keys.
They no longer allocate, reserve, import, grant or activate payment references.
The payment-reference-specific package exports `normalizeVs` and `PaymentReference`
are removed. This is a breaking capability withdrawal for any external consumer;
deploy only after verifying its usage inventory. No connected consumer was found
in the local Festapp/Mendelio source inventory on 2026-10-18.

`canonicalIban` remains a bank-account identity utility; `/account-health` remains
an authorized read-only bank-observation endpoint. Polling leases still normalize
account identity. Neither depends on the obsolete registry.

Migration 0012 remains immutable history. Migration 0014 locks historical
registries and removes their bank-account edit trigger. It does not delete
reservations, conflicts, aliases or grants. Backups retain these old audit tables
and restore their allocation flag locked; no runtime allocation writer remains.
Historical tables may be removed only under a separate authorized retention and
consumer-reconciliation operation. VS/RF fields, legacy v1 projection utilities,
v2 raw facts, webhook signatures and deliveries retain their existing contracts.

Deploy a schema-13/14 compatible runtime before applying 0014. Rollback must use
this issuance-free compatible runtime; never reactivate the retired allocator.
No production operation is authorized by this source change.
