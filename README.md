# BankSync

Czech bank emails and Fio API transactions, delivered as signed webhooks.

BankSync runs on Cloudflare Workers and provides a TypeScript package for webhook
consumers. It authenticates bank emails, parses transactions, deduplicates them
and retries delivery. Applications such as Festapp and Mendelio own payment
matching and settlement.

| Inputs | Delivery | Storage |
| --- | --- | --- |
| Fio API, Fio email, Air Bank email | Signed webhooks through Cloudflare Queues | D1; encrypted recovery and backups in R2 |

## Use the package

```bash
pnpm add @festapp/banksync
```

Verify the raw request body before parsing or applying payment changes:

```ts
import { verifyWebhook } from "@festapp/banksync";

const event = await verifyWebhook({
  secret,
  timestamp: request.headers.get("x-banksync-timestamp") ?? "",
  deliveryId: request.headers.get("x-banksync-delivery-id") ?? "",
  signature: request.headers.get("x-banksync-signature") ?? "",
  bodyBytes: new Uint8Array(await request.arrayBuffer()),
});
```

Claim `event.delivery_id` atomically in your database before side effects.
Existing consumers use event version 1; version 2 adds complete signed bank facts.
See the [integration contract](docs/guide.md#version-02-integration-contract).

## Run the Worker

Requires Node.js 20+, pnpm, Cloudflare Workers, D1, Queues, Email Routing and R2.
Clone this repository, run `pnpm install`, and copy
[wrangler.example.toml](wrangler.example.toml) to `wrangler.toml`.
Configure resources, secrets, trusted email authentication and callback hosts
using the [deployment guide](docs/guide.md#deploy-the-worker).

The Worker entry point is `@festapp/banksync/cloudflare`. Package installation
does not deploy a Worker or change a database.

## Documentation and development

- [Integration, migrations and operations](docs/guide.md)
- [Security model](docs/guide.md#security-model) and [rollout rules](docs/security-hardening-rollout.md)
- [npm package](https://www.npmjs.com/package/@festapp/banksync) and [releases](https://github.com/festappnet/banksync/releases)

```bash
pnpm check          # Types, tests, build and package exports
pnpm dev            # Local Worker after configuration and local migrations
```

Provider tests require test credentials. Never commit bank tokens, webhook
secrets, `.dev.vars` or `wrangler.toml`.

[MIT](LICENSE) © Festapp
