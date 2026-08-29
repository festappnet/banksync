import { describe, it, expect } from 'vitest';

import { encodeRf } from './iso11649';

import { extractReferenceCandidates, resolveVariableSymbol } from './referenceCandidates.js';

describe('extractReferenceCandidates', () => {
  it('extracts a labelled VS token from the message', () => {
    expect(extractReferenceCandidates({ message: 'VS123456' })).toContain('123456');
  });

  it('extracts a slash-delimited /VS/ token', () => {
    expect(extractReferenceCandidates({ message: '/VS/123456 platba' })).toContain('123456');
  });

  it('extracts a bare VS-shaped digit run', () => {
    expect(extractReferenceCandidates({ message: 'payment 123456 order' })).toContain('123456');
  });

  it('extracts the VS core from an ISO 11649 RF reference', () => {
    expect(extractReferenceCandidates({ message: encodeRf('123456') })).toContain('123456');
  });

  it('accepts a spaced lowercase RF reference with a valid checksum', () => {
    const spaced = encodeRf('1234567890').toLowerCase().replace(/(.{4})(?=.)/g, '$1 ');
    expect(resolveVariableSymbol({ message: `platba ${spaced}` })).toBe('1234567890');
  });

  it('keeps a structured Czech VS ahead of an RF reference', () => {
    expect(resolveVariableSymbol({ vs: '0000000001', message: encodeRf('123456') })).toBe('0000000001');
  });

  it('does not promote a broken or alphanumeric RF reference to VS', () => {
    const valid = encodeRf('123456');
    const broken = `${valid.slice(0, 2)}${valid.slice(2, 4) === '99' ? '98' : '99'}${valid.slice(4)}`;
    expect(resolveVariableSymbol({ message: broken })).toBeNull();
    expect(resolveVariableSymbol({ message: encodeRf('ORDER123') })).toBeNull();
  });

  it('finds RF references in Fio API remittance fields', () => {
    expect(resolveVariableSymbol({ user_identification: encodeRf('42') })).toBe('42');
    expect(resolveVariableSymbol({ comment: encodeRf('9876543210') })).toBe('9876543210');
  });

  it('strips diacritics before matching', () => {
    expect(extractReferenceCandidates({ message: 'plátbá VS123456' })).toContain('123456');
  });

  it('also looks in the SS field', () => {
    expect(extractReferenceCandidates({ ss: '123456' })).toContain('123456');
  });

  it('puts the structured VS field first', () => {
    const out = extractReferenceCandidates({ vs: '654321', message: 'VS123456' });
    expect(out[0]).toBe('654321');
    expect(out).toContain('123456');
  });

  it('returns [] when there is no VS-shaped token', () => {
    expect(extractReferenceCandidates({ message: 'dekuji za platbu' })).toEqual([]);
  });

  it('dedupes and caps at 5 candidates', () => {
    const out = extractReferenceCandidates({
      message: '111111 222222 333333 444444 555555 666666 777777',
    });
    expect(out.length).toBeLessThanOrEqual(5);
  });
});
