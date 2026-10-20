# Bank notification email formats

BankSync parses movement notifications, including messages phrased as a balance
increase or decrease. A balance itself is never used as the movement amount.

Supported email layouts:

| Bank code | Provider | Notification layout |
| --- | --- | --- |
| 2010 | fio_email | Existing labelled Fio movement notification |
| 3030 | airbank_email | Existing balance-change notification and payment details |
| 0300 | csob_email | Moje info / Parametry platby |
| 0600 | moneta_email | Přišly peníze / Odešly peníze |
| 2250 | creditas_email | Balance change / Detail platby |
| 5500 | raiffeisenbank_email | Pohyb na účtě / Částka v měně účtu |
| 2700 | unicredit_email | Informace o pohybu na účtu |
| 0800 | csas_email | Informace o transakci / Směr platby |

`BANK_PROVIDERS` and `BANK_ACCOUNT_TYPES` are exported by the SDK and own the
management account types, bank codes and API/email capabilities. Only Fio supports
API ingestion; other providers accept email mode.

`bankNotices.ts` owns the six additional text layouts and their field extraction.
`parser.ts` converts them to the existing transaction contract. MIME decoding,
sender authentication and account routing stay in their existing ingress layers.
The registered account's bank code selects the provider, including Czech IBANs;
a counterparty account or a bank name in message text does not override it.

Amounts use exact integer minor units and retain direction. The account-currency
amount wins over the transaction-currency amount (Česká spořitelna). Missing VS
stays null, leading zeroes remain intact, and missing transaction dates stay null
for the existing ingress handling. Notifications remain observations under the
existing identity contract. No database schema or payment matcher is changed.

The format investigation used the published bank-notification samples in
[radekhulan/myucto at 35309d6](https://github.com/radekhulan/myucto/tree/35309d6/api/tests/Unit/Bank).
The implementation and synthetic test messages were independently authored;
no PHP parser or test fixture was copied. Synthetic examples demonstrate format
handling, not authentication or bank movement identity.

The existing configured sender allowlist and authentication gate still apply.
Adding a parser does not change live routing, allowlists or deployment settings.

Air Bank notices with an adjacent amount and `Datum uvolnění peněz` field are
classified as non-transactional when sent by the authenticated, allowed bank
sender with a balance-increase subject. A booking or execution date prevents
this classification. These notices complete their durable email spool without
creating a transaction or webhook, including when the recipient has no registered
payment account. Ordinary unknown-recipient payments remain quarantined.
