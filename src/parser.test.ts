import { describe, it, expect } from 'vitest';
import { detectProvider, parseEmail } from './parser.js';

// ---------------------------------------------------------------------------
// Golden fixture bodies (derived from festapp test_parser_comprehensive.ts)
// ---------------------------------------------------------------------------

const FIO_CZK_INCOMING = `
Vážený kliente,

na Vašem účtu 2600000000/2010 byl zaznamenán pohyb:

Částka: 1 234,50 CZK
Protiúčet: 123456789/0100
Název protiúčtu: Jan Novak
VS: 5555
KS: 0308
SS: 99
Zpráva pro příjemce: Test Payment Fio
ID pokynu: 111122223333
Datum pohybu: 08.05.2026 14:30 +0200

Zůstatek: 10 000,00 CZK

S pozdravem,
Fio banka, a.s.
`;

const FIO_EUR_INCOMING = `
Vážený kliente,

na Vašem účtu 2600000000/2010 byl zaznamenán pohyb:

Částka: 99,00 EUR
Protiúčet: 987654321/0800
Název protiúčtu: Petra Svobodova
VS: 1001

S pozdravem,
Fio banka, a.s.
`;

const FIO_OUTGOING = `
Vážený kliente,

na Vašem účtu 2600000000/2010 byl zaznamenán pohyb:

Částka: -500,00 CZK
Protiúčet: 111222333/0100
VS: 7777

S pozdravem,
Fio banka, a.s.
`;

const FIO_NO_VS = `
Vážený kliente,

Částka: 200,00 CZK
Protiúčet: 111222333/0100
Název protiúčtu: Firma s.r.o.
Zpráva pro příjemce: Faktura 2026

S pozdravem,
Fio banka, a.s.
`;

const FIO_UNKNOWN_CURRENCY = `
Vážený kliente,

Částka: 50,00 GBP
Protiúčet: 111222333/0100
VS: 1234

S pozdravem,
Fio banka, a.s.
`;

const AIRBANK_INCOMING = `
Dobrý den,

zůstatek na účtu Běžný účet 1 číslo 9876543210/3030 se zvýšil o částku 1,00 CZK. Dostupný zůstatek k 24.01.2026 v 05:24 je 9 999,00 CZK.

Pro úplnost uvádíme detaily této úhrady:

Příchozí úhrada z účtu Novák, Jan číslo 1234567890/2010
Částka: 1,00 CZK
Datum zaúčtování: 24.01.2026
Variabilní symbol: 1
Konstantní symbol: 123
Specifický symbol: 12
Zpráva pro příjemce: hello
Kód transakce: 148100000001


Nechceme, aby Vás naše upozornění jakkoliv obtěžovala.
`;

const GARBAGE = `
Hello,

This is a completely unrelated email with no bank fields at all.
Please disregard.
`;

// Real AirBank notification received 2026-05-09 (minimal — no VS/KS/SS/Zpráva)
const AIRBANK_REAL_2026_05_09 = `
Dobrý den,

zůstatek na účtu Běžný účet 1 číslo 9876543210/3030 se zvýšil o částku 1,00 CZK.
Dostupný zůstatek k 09.05.2026 v 01:21 je 9 999,00 CZK.

Pro úplnost uvádíme detaily této úhrady:

Příchozí úhrada z účtu Novák, Jan číslo 1234567890/2010
Částka: 1,00 CZK
Datum zaúčtování: 09.05.2026
Kód transakce: 158100000001

S pozdravem,
Air Bank a.s.
`;

// Same as above but without the "Datum zaúčtování" line — parser must return date: null
const AIRBANK_NO_DATE = `
Dobrý den,

zůstatek na účtu Běžný účet 1 číslo 9876543210/3030 se zvýšil o částku 1,00 CZK.
Dostupný zůstatek k 09.05.2026 v 01:21 je 9 999,00 CZK.

Pro úplnost uvádíme detaily této úhrady:

Příchozí úhrada z účtu Novák, Jan číslo 1234567890/2010
Částka: 1,00 CZK
Kód transakce: 158100000001

S pozdravem,
Air Bank a.s.
`;

// ---------------------------------------------------------------------------
// 1. Happy path — Fio CZK incoming
// ---------------------------------------------------------------------------

describe('parseEmail — Fio CZK incoming', () => {
  it('returns a populated transaction object', () => {
    const result = parseEmail(FIO_CZK_INCOMING, 'fio_email');
    expect(result).not.toBeNull();
    if (!result) return;

    expect(result.amount_cents).toBe(123450); // 1234.50 CZK = 123450 cents
    expect(result.currency).toBe('CZK');
    expect(result.source).toBe('email');
    expect(result.vs).toBe('5555');
    expect(result.ks).toBe('0308');
    expect(result.ss).toBe('99');
    expect(result.counter_account).toBe('123456789');
    expect(result.bank_code).toBe('0100');
    expect(result.bank_name).toBe('Komerční banka, a.s.');
    expect(result.sender_name).toBe('Jan Novak');
    expect(result.message).toBe('Test Payment Fio');
    expect(result.transaction_id).toBe('111122223333');
    expect(result.external_id).toBeNull();
    // API-only fields must be null for email source
    expect(result.user_identification).toBeNull();
    expect(result.transaction_type).toBeNull();
    expect(result.performed_by).toBeNull();
    expect(result.comment).toBeNull();
    expect(result.command_id).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. Fio EUR incoming
// ---------------------------------------------------------------------------

describe('parseEmail — Fio EUR incoming', () => {
  it('normalises currency to EUR and computes cents correctly', () => {
    const result = parseEmail(FIO_EUR_INCOMING, 'fio_email');
    expect(result).not.toBeNull();
    if (!result) return;

    expect(result.currency).toBe('EUR');
    expect(result.amount_cents).toBe(9900); // 99.00 EUR = 9900 cents
    expect(result.source).toBe('email');
  });
});

// ---------------------------------------------------------------------------
// 3. AirBank incoming
// ---------------------------------------------------------------------------

describe('parseEmail — AirBank incoming', () => {
  it('detectProvider returns airbank_email for /3030 account', () => {
    expect(detectProvider(AIRBANK_INCOMING, '9876543210/3030')).toBe('airbank_email');
  });

  it('returns a valid parsed object', () => {
    const result = parseEmail(AIRBANK_INCOMING, 'airbank_email');
    expect(result).not.toBeNull();
    if (!result) return;

    expect(result.currency).toBe('CZK');
    expect(result.amount_cents).toBe(100); // 1.00 CZK = 100 cents
    expect(result.source).toBe('email');
    expect(result.vs).toBe('1');
    expect(result.ks).toBe('123');
    expect(result.ss).toBe('12');
    expect(result.message).toBe('hello');
    expect(result.counter_account).toBe('1234567890');
    expect(result.bank_code).toBe('2010');
    expect(result.bank_name).toBe('Fio banka, a.s.');
    expect(result.sender_name).toBe('Novák, Jan');
    expect(result.transaction_id).toBe('148100000001');
  });

  it('date is in UTC ISO format', () => {
    const result = parseEmail(AIRBANK_INCOMING, 'airbank_email');
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.date).toMatch(/Z$/);
    expect(result.date).toContain('2026-01-24');
  });
});

// ---------------------------------------------------------------------------
// 4. Outgoing transaction → null
// ---------------------------------------------------------------------------

describe('parseEmail — outgoing transaction', () => {
  it('returns null for negative amount', () => {
    const result = parseEmail(FIO_OUTGOING, 'fio_email');
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 5. Missing VS
// ---------------------------------------------------------------------------

describe('parseEmail — missing VS', () => {
  it('returns vs: null but populates other fields', () => {
    const result = parseEmail(FIO_NO_VS, 'fio_email');
    expect(result).not.toBeNull();
    if (!result) return;

    expect(result.vs).toBeNull();
    expect(result.amount_cents).toBe(20000); // 200.00 CZK = 20000 cents
    expect(result.counter_account).toBe('111222333');
    expect(result.bank_code).toBe('0100');
    expect(result.message).toBe('Faktura 2026');
    expect(result.sender_name).toBe('Firma s.r.o.');
  });
});

// ---------------------------------------------------------------------------
// 6. Unknown currency → throws
// ---------------------------------------------------------------------------

describe('parseEmail — unknown currency', () => {
  it('throws on unrecognised currency string', () => {
    expect(() => parseEmail(FIO_UNKNOWN_CURRENCY, 'fio_email')).toThrow('unknown_currency');
  });
});

// ---------------------------------------------------------------------------
// 7. Garbage / unparseable body → null
// ---------------------------------------------------------------------------

describe('parseEmail — garbage body', () => {
  it('returns null when no bank fields are found', () => {
    expect(parseEmail(GARBAGE, 'fio_email')).toBeNull();
    expect(parseEmail(GARBAGE, 'airbank_email')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 8. detectProvider matrix
// ---------------------------------------------------------------------------

describe('detectProvider', () => {
  it('CZ IBAN with 2010 → fio_email', () => {
    expect(detectProvider('', 'CZ1220100000000000001234')).toBe('fio_email');
  });

  it('legacy /2010 → fio_email', () => {
    expect(detectProvider('', '1234567890/2010')).toBe('fio_email');
  });

  it('legacy /3030 → airbank_email', () => {
    expect(detectProvider('', '999/3030')).toBe('airbank_email');
  });

  it('unknown bank code → unknown', () => {
    expect(detectProvider('', '123456/0800')).toBe('unknown');
  });

  it('IBAN with 3030 → airbank_email', () => {
    expect(detectProvider('', 'CZ1230300000000000001234')).toBe('airbank_email');
  });

  it('null account + no body keywords → unknown', () => {
    expect(detectProvider('Hello world', null)).toBe('unknown');
  });

  it('null account + fio keyword in body → fio_email', () => {
    expect(detectProvider('Fio banka, a.s. pohyb na účtu', null)).toBe('fio_email');
  });
});

// ---------------------------------------------------------------------------
// 9. AirBank real email — 2026-05-09 (minimal, no VS/KS/SS)
// ---------------------------------------------------------------------------

describe('parseEmail — AirBank real 2026-05-09', () => {
  it('parses all available fields correctly', () => {
    const result = parseEmail(AIRBANK_REAL_2026_05_09, 'airbank_email');
    expect(result).not.toBeNull();
    if (!result) return;

    expect(result.amount_cents).toBe(100);
    expect(result.currency).toBe('CZK');
    expect(result.transaction_id).toBe('158100000001');
    expect(result.sender_name).toBe('Novák, Jan');
    expect(result.counter_account).toBe('1234567890');
    expect(result.bank_code).toBe('2010');
    expect(result.bank_name).toBe('Fio banka, a.s.');
    expect(result.vs).toBeNull();
    expect(result.source).toBe('email');
  });

  it('date is noon UTC for date-only field', () => {
    const result = parseEmail(AIRBANK_REAL_2026_05_09, 'airbank_email');
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.date).not.toBeNull();
    expect(result.date).toContain('2026-05-09');
    expect(result.date).toMatch(/Z$/);
  });
});

// ---------------------------------------------------------------------------
// 10. AirBank — missing Datum zaúčtování → date: null
// ---------------------------------------------------------------------------

describe('parseEmail — AirBank no date field', () => {
  it('returns date: null when Datum zaúčtování is absent', () => {
    const result = parseEmail(AIRBANK_NO_DATE, 'airbank_email');
    expect(result).not.toBeNull();
    if (!result) return;

    expect(result.date).toBeNull();
    expect(result.amount_cents).toBe(100);
    expect(result.sender_name).toBe('Novák, Jan');
    expect(result.transaction_id).toBe('158100000001');
  });
});

// ---------------------------------------------------------------------------
// 11. Date normalisation — explicit offset
// ---------------------------------------------------------------------------

describe('parseEmail — date normalisation', () => {
  const FIO_WITH_OFFSET = `
Vážený kliente,

Částka: 100,00 CZK
Protiúčet: 111222333/0100
Datum pohybu: 08.05.2026 14:30 +0200

S pozdravem, Fio banka, a.s.
`;

  it('converts 14:30 +0200 to 12:30 UTC (Z suffix)', () => {
    const result = parseEmail(FIO_WITH_OFFSET, 'fio_email');
    expect(result).not.toBeNull();
    if (!result) return;

    expect(result.date).toMatch(/Z$/);
    // 14:30 +0200 = 12:30 UTC
    expect(result.date).toContain('T12:30:00.000Z');
    expect(result.date_offset_min).toBe(120);
  });
});
