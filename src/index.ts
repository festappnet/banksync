export {
  BANK_CODES,
  detectProvider,
  parseEmail,
  type EmailProvider,
  type ParsedEmailTransaction,
} from "./parser.js";
export { normalizeCurrency, toCents, decimalToCents } from "./normalize.js";
export {
  extractReferenceCandidates,
  resolveVariableSymbol,
  type ReferenceSource,
} from "./referenceCandidates.js";
export {
  buildWebhookEnvelope,
  signWebhook,
  verifyWebhook,
  WebhookVerificationError,
  type SignedWebhook,
  type VerifyWebhookArgs,
  type WebhookVerificationCode,
} from "./relay.js";
export { decodeRf, encodeRf } from "./iso11649.js";
export {
  fetchNewTransactions,
  mapFioTransaction,
  setFioPointer,
  fetchFioDelta,
  setFioPointerById,
  type FioStatement,
  FioApiError,
  FioRateLimited,
  FioTransientFailure,
  FioTokenInvalidOrInactive,
  FioReceivingAccountMismatch,
  type FioColumn,
  type FioProxyConfig,
  type FioTransaction,
} from "./fio.js";
export type {
  BankAccount,
  Transaction,
  WebhookEnvelope,
  WebhookConsumer,
  WebhookSubscription,
} from "./types.js";

export {normalizeVs,canonicalIban,type PaymentReference} from './paymentReferences.js';
