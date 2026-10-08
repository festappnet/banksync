# Integrate BankSync

BankSync turns Fio API transactions and Fio/Air Bank emails into signed webhooks.
It stores bank facts and retries delivery. Your application decides which payment
matches an order and whether that order can be settled.

## Connect your application

1. Register a consumer with `POST /consumers`: supply `app_id`, your HTTPS
   `callback_url` and `event_version: "2"`. Store its webhook secret securely.
   The Worker operator must allow your exact callback hostname.
2. Connect the bank account and create its consumer subscription with
   `POST /subscriptions` using `app_id` and `bank_account_id`.
3. Implement the receiver below. Persist each delivery and its processing result
   before acknowledging it.

For a new account, use `ingest_enabled:false` while saving your application's
account mapping. Verify the subscription, then enable ingestion through
`PUT /bank-accounts/:id/ingest-state` with `{ "enabled": true }`.

## Webhook contract

Each request contains a `transaction.received` event and three headers:

| Header | Meaning |
| --- | --- |
| `X-BankSync-Timestamp` | Signed request timestamp |
| `X-BankSync-Delivery-Id` | Delivery ID, unchanged across retries |
| `X-BankSync-Signature` | HMAC signature as `sha256=<hex>` |

### Verify and process

Pass the **original body bytes** to `verifyWebhook`. Do not parse or reserialize
JSON first. The verifier checks the signature, timestamp, event version and
agreement between the header and body delivery IDs.

```ts
import { verifyWebhook, type WebhookEnvelope } from "@festapp/banksync";

export async function receiveWebhook(
  request: Request,
  secret: string,
  processOnce: (event: WebhookEnvelope) => Promise<void>,
): Promise<Response> {
  const event = await verifyWebhook({
    secret,
    timestamp: request.headers.get("x-banksync-timestamp") ?? "",
    deliveryId: request.headers.get("x-banksync-delivery-id") ?? "",
    signature: request.headers.get("x-banksync-signature") ?? "",
    bodyBytes: new Uint8Array(await request.arrayBuffer()),
    eventVersion: "2",
  });

  await processOnce(event);
  return Response.json({
    ok: true,
    receipt_version: 1,
    delivery_id: event.delivery_id,
    outcome: "recorded",
  });
}
```

`processOnce` is your application's database operation, not an SDK function.
In one transaction, store a unique `delivery_id`, the bank fact and the processing
result. A completed duplicate must return without applying the payment again.
Do not mark a delivery complete before its work commits. External side effects
need their own durable outbox or idempotency key.

Invalid requests throw `WebhookVerificationError`; reject them with a non-2xx
response. Processing failures must also return non-2xx so BankSync can retry.

### Acknowledge delivery

**HTTP 200 alone is insufficient.** Return the JSON receipt shown above after
committing your result. `ok` must be `true`, `receipt_version` must be `1`, and
`delivery_id` must match the request. `outcome` is your result name: 1-64 lowercase
letters, digits or underscores. You may also include a string `order_id` up to
200 characters.

Event version 2 still uses receipt version 1. A missing or invalid receipt causes
another delivery attempt with the same `delivery_id`.

For a receiver in another language, sign the exact bytes
`timestamp + "." + deliveryId + "." + bodyBytes` with the shared secret using
HMAC-SHA256. Match the SDK's timestamp and envelope validation as well.

## Version 0.2 integration contract

| Event version | Bank facts | Receiver setting |
| --- | --- | --- |
| `"1"` (default) | Incoming transactions in the legacy shape | Default verifier |
| `"2"` (recommended for new integrations) | Signed amount, direction and identity evidence | `eventVersion: "2"` |

V2 adds `payer_reference`, `raw_vs`, `direction`, `identity_kind` and
`identity_provenance`. `amount_cents` is an integer in minor currency units;
provider transaction identifiers remain strings. Archived delivery payloads keep their original
version.

Use proven movement identity for automatic settlement. An email observation is
not proof of a bank movement; retain it for authorized reconciliation. A matching
variable symbol, amount and date alone cannot establish identity. Fio's
`ID pokynu` identifies a command, not a movement. V2 does not support `both`
ingestion until provider correlation is proven.

BankSync preserves bank-provided references. Each consumer owns order matching;
BankSync does not infer an order ID from a reference.

## How synchronization works

- **Fio:** a new account imports 90 calendar dates. Normal polling then uses
  `/last` to request new movements. Once daily, `/periods` checks three overlapping
  days. Recovery resets the pointer to a proven committed ID or bootstrap date.
  Use a dedicated Fio token so another program cannot advance the same cursor.
- **Email:** authenticated messages are stored encrypted before processing.
  Failed messages retry with backoff; unsupported or conflicting messages enter
  quarantine for operator review. Completed recovery payloads are removed.
- **Delivery:** imported facts enter a durable webhook outbox. Queue retries and
  periodic recovery preserve the delivery ID; your receiver prevents duplicate
  business effects.

## Deploy the Worker

An existing BankSync operator can connect your consumer; installing the npm
package alone does not deploy a service. To run your own instance, follow
[deployment and operations](operations.md#deploy-the-worker).
BankSync 0.2.9 supports schemas 10-13.

## Further reference

- [Account export and controlled reconciliation](operations.md#account-export-and-reconciliation)
- [Fio recovery, retention and monitoring](operations.md#recovery-and-monitoring)
- [Optional payment-reference allocation](payment-references.md)
- [Security, backups and migrations](operations.md#security-and-backups)
