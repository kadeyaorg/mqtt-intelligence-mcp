import { describe, expect, it } from 'vitest';
import { isBrokerId, parseBrokerId, ValidationError } from '../../src/index.js';

describe('broker ids', () => {
  it.each(['a', 'factory-fr', 'factory_us_01', 'staging2', 'x'.repeat(63)])(
    'accepts %s',
    (value) => {
      expect(isBrokerId(value)).toBe(true);
      expect(parseBrokerId(value)).toBe(value);
    },
  );

  it.each([
    ['the empty string', ''],
    ['uppercase, which would allow two ids for one broker', 'Factory-FR'],
    ['a leading separator', '-factory'],
    ['a dot, which is ambiguous in storage keys', 'factory.fr'],
    ['a space', 'factory fr'],
    ['a slash', 'factory/fr'],
    ['more than 63 characters', 'x'.repeat(64)],
  ])('rejects %s', (_case, value) => {
    expect(isBrokerId(value)).toBe(false);
    expect(() => parseBrokerId(value)).toThrow(ValidationError);
  });

  it('reports INVALID_ARGUMENT with the offending id, which is not sensitive', () => {
    try {
      parseBrokerId('Factory FR');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      const validationError = error as ValidationError;
      expect(validationError.code).toBe('INVALID_ARGUMENT');
      expect(validationError.details).toEqual({ brokerId: 'Factory FR' });
    }
  });
});
