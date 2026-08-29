import { describe, it, expect } from 'vitest';
import * as v from 'valibot';
import {
  CreateBankAccountSchema,
  CreateConsumerSchema,
  CreateSubscriptionSchema,
  ReplayWebhookSchema,
  ValidationError,
  parseBody,
  type CreateBankAccountInput,
  type CreateConsumerInput,
  type CreateSubscriptionInput,
  type ReplayWebhookInput,
} from './validation';

// ============================================================================
// CreateBankAccountSchema
// ============================================================================

describe('CreateBankAccountSchema', () => {
  it('parses a valid minimal request', () => {
    const input = { account_number: '1234567890/2010', owner_app_id: 'festapp' };
    const result = v.parse(CreateBankAccountSchema, input);
    expect(result).toEqual(input);
    expect(result.account_type).toBeUndefined();
    expect(result.label).toBeUndefined();
  });

  it('parses a valid request with all fields', () => {
    const input = {
      account_number: '1234567890/2010',
      account_type: 'FIO',
      label: 'Fio festapp',
      owner_app_id: 'festapp',
    };
    const result = v.parse(CreateBankAccountSchema, input);
    expect(result).toEqual(input);
  });

  it('parses with AIRBANK account type', () => {
    const input = {
      account_number: 'IBAN-format-here',
      account_type: 'AIRBANK',
      label: 'Airbank account',
      owner_app_id: 'tutoring',
    };
    const result = v.parse(CreateBankAccountSchema, input);
    expect(result.account_type).toBe('AIRBANK');
  });

  it('rejects missing account_number', () => {
    const input = { owner_app_id: 'festapp' };
    expect(() => v.parse(CreateBankAccountSchema, input)).toThrow();
  });

  it('rejects missing owner_app_id', () => {
    const input = { account_number: '1234567890/2010' };
    expect(() => v.parse(CreateBankAccountSchema, input)).toThrow();
  });

  it('rejects account_number that is too short', () => {
    const input = { account_number: 'ab', owner_app_id: 'festapp' };
    expect(() => v.parse(CreateBankAccountSchema, input)).toThrow();
  });

  it('rejects account_number that exceeds max length', () => {
    const input = { account_number: 'a'.repeat(65), owner_app_id: 'festapp' };
    expect(() => v.parse(CreateBankAccountSchema, input)).toThrow();
  });

  it('rejects invalid account_type (not in picklist)', () => {
    const input = {
      account_number: '1234567890/2010',
      account_type: 'CHASE',
      owner_app_id: 'festapp',
    };
    expect(() => v.parse(CreateBankAccountSchema, input)).toThrow();
  });

  it('rejects label exceeding max length', () => {
    const input = {
      account_number: '1234567890/2010',
      label: 'x'.repeat(121),
      owner_app_id: 'festapp',
    };
    expect(() => v.parse(CreateBankAccountSchema, input)).toThrow();
  });

  it('rejects account_number with wrong type', () => {
    const input = { account_number: 123, owner_app_id: 'festapp' };
    expect(() => v.parse(CreateBankAccountSchema, input)).toThrow();
  });

  it('rejects invalid owner_app_id slug', () => {
    const input = { account_number: '1234567890/2010', owner_app_id: 'NOT-LOWERCASE' };
    expect(() => v.parse(CreateBankAccountSchema, input)).toThrow();
  });

  it('accepts valid IBAN-style account number', () => {
    const input = { account_number: 'CZ4530300000002758626030', owner_app_id: 'festapp' };
    const result = v.parse(CreateBankAccountSchema, input);
    expect(result.account_number).toBe('CZ4530300000002758626030');
  });

  it('infers correct TypeScript type', () => {
    const input: CreateBankAccountInput = {
      account_number: '1234567890/2010',
      account_type: 'FIO',
      label: 'Test',
      owner_app_id: 'festapp',
    };
    expect(input.account_number).toBeDefined();
  });
});

// ============================================================================
// CreateConsumerSchema
// ============================================================================

describe('CreateConsumerSchema', () => {
  it('parses a valid request', () => {
    const input = {
      app_id: 'festapp',
      callback_url: 'https://api.festapp.example/webhook',
    };
    const result = v.parse(CreateConsumerSchema, input);
    expect(result).toEqual(input);
  });

  it('parses app_id with digits and hyphens', () => {
    const input = {
      app_id: 'my-app-123',
      callback_url: 'https://example.com/webhook',
    };
    const result = v.parse(CreateConsumerSchema, input);
    expect(result.app_id).toBe('my-app-123');
  });

  it('parses app_id with underscores', () => {
    const input = {
      app_id: 'my_app_name',
      callback_url: 'https://example.com/webhook',
    };
    const result = v.parse(CreateConsumerSchema, input);
    expect(result.app_id).toBe('my_app_name');
  });

  it('rejects uppercase app_id', () => {
    const input = {
      app_id: 'FESTAPP',
      callback_url: 'https://example.com/webhook',
    };
    expect(() => v.parse(CreateConsumerSchema, input)).toThrow();
  });

  it('rejects app_id starting with hyphen', () => {
    const input = {
      app_id: '-festapp',
      callback_url: 'https://example.com/webhook',
    };
    expect(() => v.parse(CreateConsumerSchema, input)).toThrow();
  });

  it('rejects app_id with special characters', () => {
    const input = {
      app_id: 'fest!app',
      callback_url: 'https://example.com/webhook',
    };
    expect(() => v.parse(CreateConsumerSchema, input)).toThrow();
  });

  it('rejects http callback_url (requires https)', () => {
    const input = {
      app_id: 'festapp',
      callback_url: 'http://insecure.example/webhook',
    };
    expect(() => v.parse(CreateConsumerSchema, input)).toThrow();
  });

  it('rejects invalid URL format', () => {
    const input = {
      app_id: 'festapp',
      callback_url: 'not-a-url',
    };
    expect(() => v.parse(CreateConsumerSchema, input)).toThrow();
  });

  it('rejects missing callback_url', () => {
    const input = { app_id: 'festapp' };
    expect(() => v.parse(CreateConsumerSchema, input)).toThrow();
  });

  it('rejects missing app_id', () => {
    const input = { callback_url: 'https://example.com/webhook' };
    expect(() => v.parse(CreateConsumerSchema, input)).toThrow();
  });

  it('accepts complex callback_url', () => {
    const input = {
      app_id: 'my-app',
      callback_url: 'https://api.example.com:8443/webhook/callback?foo=bar',
    };
    const result = v.parse(CreateConsumerSchema, input);
    expect(result.callback_url).toBe('https://api.example.com:8443/webhook/callback?foo=bar');
  });

  it('infers correct TypeScript type', () => {
    const input: CreateConsumerInput = {
      app_id: 'festapp',
      callback_url: 'https://example.com/webhook',
    };
    expect(input.app_id).toBeDefined();
  });
});

// ============================================================================
// CreateSubscriptionSchema
// ============================================================================

describe('CreateSubscriptionSchema', () => {
  it('parses a valid request', () => {
    const input = {
      app_id: 'festapp',
      bank_account_id: 1,
    };
    const result = v.parse(CreateSubscriptionSchema, input);
    expect(result).toEqual(input);
  });

  it('parses with larger bank_account_id', () => {
    const input = {
      app_id: 'my-app',
      bank_account_id: 999,
    };
    const result = v.parse(CreateSubscriptionSchema, input);
    expect(result.bank_account_id).toBe(999);
  });

  it('rejects bank_account_id of 0 (minValue 1)', () => {
    const input = {
      app_id: 'festapp',
      bank_account_id: 0,
    };
    expect(() => v.parse(CreateSubscriptionSchema, input)).toThrow();
  });

  it('rejects negative bank_account_id', () => {
    const input = {
      app_id: 'festapp',
      bank_account_id: -1,
    };
    expect(() => v.parse(CreateSubscriptionSchema, input)).toThrow();
  });

  it('rejects bank_account_id as string', () => {
    const input = {
      app_id: 'festapp',
      bank_account_id: '1',
    };
    expect(() => v.parse(CreateSubscriptionSchema, input)).toThrow();
  });

  it('rejects non-integer bank_account_id', () => {
    const input = {
      app_id: 'festapp',
      bank_account_id: 1.5,
    };
    expect(() => v.parse(CreateSubscriptionSchema, input)).toThrow();
  });

  it('rejects invalid app_id', () => {
    const input = {
      app_id: 'INVALID',
      bank_account_id: 1,
    };
    expect(() => v.parse(CreateSubscriptionSchema, input)).toThrow();
  });

  it('rejects missing app_id', () => {
    const input = { bank_account_id: 1 };
    expect(() => v.parse(CreateSubscriptionSchema, input)).toThrow();
  });

  it('rejects missing bank_account_id', () => {
    const input = { app_id: 'festapp' };
    expect(() => v.parse(CreateSubscriptionSchema, input)).toThrow();
  });

  it('infers correct TypeScript type', () => {
    const input: CreateSubscriptionInput = {
      app_id: 'festapp',
      bank_account_id: 1,
    };
    expect(typeof input.bank_account_id).toBe('number');
  });
});

// ============================================================================
// ReplayWebhookSchema
// ============================================================================

describe('ReplayWebhookSchema', () => {
  it('parses with tx_id only', () => {
    const input = { tx_id: 42, reason: 'operator note' };
    const result = v.parse(ReplayWebhookSchema, input);
    expect(result).toEqual(input);
  });

  it('parses with delivery_id only', () => {
    const input = { delivery_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV', reason: 'operator note' };
    const result = v.parse(ReplayWebhookSchema, input);
    expect(result).toEqual(input);
  });

  it('parses with both tx_id and delivery_id', () => {
    const input = {
      tx_id: 42,
      delivery_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      reason: 'operator note',
    };
    const result = v.parse(ReplayWebhookSchema, input);
    expect(result).toEqual(input);
  });

  it('rejects empty object (neither tx_id nor delivery_id)', () => {
    const input = {};
    expect(() => v.parse(ReplayWebhookSchema, input)).toThrow();
  });

  it('rejects a replay with no reason (audited replay requires an operator reason)', () => {
    expect(() => v.parse(ReplayWebhookSchema, { tx_id: 42 })).toThrow();
  });

  it('rejects invalid delivery_id format', () => {
    const input = { delivery_id: 'not-a-ulid' };
    expect(() => v.parse(ReplayWebhookSchema, input)).toThrow();
  });

  it('rejects delivery_id with wrong length', () => {
    const input = { delivery_id: '01ARZ3NDEKTSV4RRFFQ69G5FA' }; // 25 chars, need 26
    expect(() => v.parse(ReplayWebhookSchema, input)).toThrow();
  });

  it('rejects delivery_id with lowercase I, L, O, or U (not valid ULID chars)', () => {
    // Valid ULID charset: 0-9A-HJKMNP-TV-Z (excludes I, L, O, U)
    const input = { delivery_id: '01IRZ3NDEKTSV4RRFFQ69G5FAV' }; // has 'I'
    expect(() => v.parse(ReplayWebhookSchema, input)).toThrow();
  });

  it('rejects tx_id as string', () => {
    const input = { tx_id: '42' };
    expect(() => v.parse(ReplayWebhookSchema, input)).toThrow();
  });

  it('rejects tx_id as float', () => {
    const input = { tx_id: 42.5 };
    expect(() => v.parse(ReplayWebhookSchema, input)).toThrow();
  });

  it('rejects tx_id of 0 (minValue 1)', () => {
    const input = { tx_id: 0 };
    expect(() => v.parse(ReplayWebhookSchema, input)).toThrow();
  });

  it('rejects negative tx_id', () => {
    const input = { tx_id: -1 };
    expect(() => v.parse(ReplayWebhookSchema, input)).toThrow();
  });

  it('accepts valid ULID with all caps', () => {
    const input = { delivery_id: '01BX5ZZKBK7JZRY9F27QK4RB4J', reason: 'operator note' };
    const result = v.parse(ReplayWebhookSchema, input);
    expect(result.delivery_id).toBe('01BX5ZZKBK7JZRY9F27QK4RB4J');
  });

  it('infers correct TypeScript type', () => {
    const input: ReplayWebhookInput = { tx_id: 42, reason: 'r' };
    expect(typeof input.tx_id).toBe('number');
  });
});

// ============================================================================
// parseBody wrapper function
// ============================================================================

describe('parseBody', () => {
  it('returns parsed result on valid input', () => {
    const input = { account_number: '1234567890/2010', owner_app_id: 'festapp' };
    const result = parseBody(CreateBankAccountSchema, input);
    expect(result).toEqual(input);
  });

  it('throws ValidationError on invalid input', () => {
    const input = {};
    expect(() => parseBody(CreateBankAccountSchema, input)).toThrow(ValidationError);
  });

  it('ValidationError has .issues array', () => {
    const input = {};
    try {
      parseBody(CreateBankAccountSchema, input);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).issues).toBeDefined();
      expect(Array.isArray((err as ValidationError).issues)).toBe(true);
    }
  });

  it('ValidationError message starts with validation_failed', () => {
    const input = {};
    try {
      parseBody(CreateBankAccountSchema, input);
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as ValidationError).message).toMatch(/^validation_failed:/);
    }
  });

  it('rethrows non-ValiError exceptions', () => {
    const schema = v.pipe(
      v.object({ x: v.number() }),
      v.check(() => {
        throw new TypeError('custom error');
      }),
    );
    expect(() => parseBody(schema, { x: 1 })).toThrow(TypeError);
  });
});

// ============================================================================
// Type inference tests (compile-time, documented via examples)
// ============================================================================

describe('Type inference', () => {
  it('CreateBankAccountInput includes all fields', () => {
    const input: CreateBankAccountInput = {
      account_number: 'test',
      account_type: 'FIO',
      label: 'label',
      owner_app_id: 'festapp',
    };
    expect(input).toBeDefined();
  });

  it('CreateConsumerInput has correct field types', () => {
    const input: CreateConsumerInput = {
      app_id: 'test',
      callback_url: 'https://example.com',
    };
    expect(input).toBeDefined();
  });

  it('CreateSubscriptionInput has correct field types', () => {
    const input: CreateSubscriptionInput = {
      app_id: 'test',
      bank_account_id: 123,
    };
    expect(input).toBeDefined();
  });

  it('ReplayWebhookInput allows partial object', () => {
    const input1: ReplayWebhookInput = { tx_id: 1, reason: 'r' };
    const input2: ReplayWebhookInput = { delivery_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV', reason: 'r' };
    const input3: ReplayWebhookInput = { tx_id: 1, delivery_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV', reason: 'r' };
    expect(input1).toBeDefined();
    expect(input2).toBeDefined();
    expect(input3).toBeDefined();
  });
});
