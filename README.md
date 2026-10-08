# BankSync

Czech bank emails and Fio API transactions, delivered as signed webhooks.

Runs on Cloudflare Workers with D1, Queues and encrypted recovery in R2.
Supports Fio API, Fio emails and Air Bank emails. BankSync authenticates,
deduplicates and retries delivery; your application handles payment matching.

## Install

```bash
pnpm add @festapp/banksync
```

Verify the raw webhook body with `verifyWebhook` and commit processing atomically
with a unique `event.delivery_id`, then return a delivery receipt.
See the [webhook example](docs/guide.md#webhook-contract) and
[integration contract](docs/guide.md#version-02-integration-contract).

## Documentation

- [Integration and webhook example](docs/guide.md)
- [Deploy the Worker](docs/operations.md#deploy-the-worker) - Node.js 20+, pnpm and Cloudflare
- [Optional payment references](docs/payment-references.md)
- [Security and rollout](docs/security-hardening-rollout.md)
- [npm package](https://www.npmjs.com/package/@festapp/banksync) and [releases](https://github.com/festappnet/banksync/releases)

For development, run `pnpm install` and `pnpm check`.
Keep bank tokens, webhook secrets and local configuration out of Git.

[MIT](LICENSE) © Festapp
