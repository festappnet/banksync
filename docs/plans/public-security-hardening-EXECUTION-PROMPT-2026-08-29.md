# Execute: Secure BankSync public release

Work in `/Users/miakh/source/banksync` and the explicitly named Mendelio consumer
paths in `/Users/miakh/source/roman_seznamka`.

Use the applicable repository instructions and the release verification mode
recorded in the plan. Implement the entire authoritative plan:

`docs/plans/public-security-hardening-plan-2026-08-29.md`

Read it in full before editing. The target outcome is a BankSync package and
production Worker with proven tenant isolation, trusted email ingress,
non-sensitive HTTP surfaces, non-recoverable credential persistence,
constrained webhook egress, one safe verification contract, converged D1
migrations, and a protected reproducible release chain.

Execute the waves in dependency order, beginning with the production tenant
containment. Completion requires every deletion-ledger absence proof, not just a
green build. Do not leave placeholders, permissive flags, weak compatibility
aliases, duplicate verifiers, or a second billing/migration authority. If
current evidence invalidates a factual premise, update the authoritative plan
with the evidence and adapt that wave without changing the secure outcome.

Run only the validation required by the plan and repository rules. Do not start
an independent review or subagent audit unless explicitly requested.

Do not commit, push, publish, mutate GitHub/npm settings, apply remote D1 data
changes, delete R2 backups, rotate secrets, or deploy production without the
separate authority and gates identified in the plan. At handoff, report the
canonical contracts, migrated data/callers, deleted insecure paths, exact
artifact/deployment identity, verification results, and any unapplied
operational step.
