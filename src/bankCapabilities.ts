/** Canonical bank identities accepted by the management API and email ingress. */
export const BANK_ACCOUNT_TYPES = ['FIO', 'AIRBANK', 'CSOB', 'MONETA', 'CREDITAS', 'RAIFFEISENBANK', 'UNICREDIT', 'CSAS'] as const;
export type BankAccountType = typeof BANK_ACCOUNT_TYPES[number];

export const BANK_PROVIDERS = {
  '2010': { accountType: 'FIO', emailProvider: 'fio_email', api: true },
  '3030': { accountType: 'AIRBANK', emailProvider: 'airbank_email', api: false },
  '0300': { accountType: 'CSOB', emailProvider: 'csob_email', api: false },
  '0600': { accountType: 'MONETA', emailProvider: 'moneta_email', api: false },
  '2250': { accountType: 'CREDITAS', emailProvider: 'creditas_email', api: false },
  '5500': { accountType: 'RAIFFEISENBANK', emailProvider: 'raiffeisenbank_email', api: false },
  '2700': { accountType: 'UNICREDIT', emailProvider: 'unicredit_email', api: false },
  '0800': { accountType: 'CSAS', emailProvider: 'csas_email', api: false },
} as const;
