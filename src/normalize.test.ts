import { describe, test, expect } from 'vitest';
import { normalizeCurrency, toCents } from './normalize';

describe('normalizeCurrency', () => {
  test('normalizes kč to CZK', () => {
    expect(normalizeCurrency('Kč')).toBe('CZK');
  });

  test('normalizes kc to CZK', () => {
    expect(normalizeCurrency('kc')).toBe('CZK');
  });

  test('normalizes CZK to CZK', () => {
    expect(normalizeCurrency('CZK')).toBe('CZK');
  });

  test('normalizes czk to CZK', () => {
    expect(normalizeCurrency('czk')).toBe('CZK');
  });

  test('handles leading and trailing whitespace', () => {
    expect(normalizeCurrency(' EUR ')).toBe('EUR');
  });

  test('normalizes € to EUR', () => {
    expect(normalizeCurrency('€')).toBe('EUR');
  });

  test('normalizes eur to EUR', () => {
    expect(normalizeCurrency('eur')).toBe('EUR');
  });

  test('normalizes $ to USD', () => {
    expect(normalizeCurrency('$')).toBe('USD');
  });

  test('normalizes usd to USD', () => {
    expect(normalizeCurrency('usd')).toBe('USD');
  });

  test('throws for unknown currency GBP', () => {
    expect(() => normalizeCurrency('GBP')).toThrow('unknown_currency:');
  });

  test('throws for empty string', () => {
    expect(() => normalizeCurrency('')).toThrow('unknown_currency:');
  });
});

describe('toCents', () => {
  test('converts 19.99 CZK to 1999 cents', () => {
    expect(toCents(19.99, 'CZK')).toBe(1999);
  });

  test('converts 100 CZK to 10000 cents', () => {
    expect(toCents(100, 'CZK')).toBe(10000);
  });

  test('converts 0.01 CZK to 1 cent', () => {
    expect(toCents(0.01, 'CZK')).toBe(1);
  });

  test('rounds 99.989999 CZK to 9999 cents', () => {
    expect(toCents(99.989999, 'CZK')).toBe(9999);
  });

  test('converts 50 EUR to 5000 cents', () => {
    expect(toCents(50, 'EUR')).toBe(5000);
  });

  test('converts 50 USD to 5000 cents', () => {
    expect(toCents(50, 'USD')).toBe(5000);
  });

  test('throws for unsupported currency JPY', () => {
    expect(() => toCents(100, 'JPY')).toThrow('unsupported_currency_minor_unit: JPY');
  });

  test('throws for lowercase czk (only uppercase ISO is supported)', () => {
    expect(() => toCents(100, 'czk')).toThrow('unsupported_currency_minor_unit: czk');
  });
});
