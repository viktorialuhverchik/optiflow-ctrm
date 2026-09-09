import { describe, expect, it } from 'vitest';
import { isDecimalString, isIsoDate, parseDecimalString, parseIsoDate } from './brands.js';

describe('isIsoDate', () => {
  it('accepts real calendar dates', () => {
    expect(isIsoDate('2026-08-11')).toBe(true);
    expect(isIsoDate('2024-02-29')).toBe(true);
  });

  it('rejects dates that look right but do not exist', () => {
    expect(isIsoDate('2026-02-29')).toBe(false); // 2026 is not a leap year
    expect(isIsoDate('2026-04-31')).toBe(false);
    expect(isIsoDate('2026-13-01')).toBe(false);
    expect(isIsoDate('2026-00-10')).toBe(false);
  });

  it('rejects anything that is not the exact format', () => {
    expect(isIsoDate('11.08.2026')).toBe(false);
    expect(isIsoDate('2026-8-11')).toBe(false);
    expect(isIsoDate('2026-08-11T00:00:00Z')).toBe(false);
  });

  it('reports the failure as a value, not an exception', () => {
    const result = parseIsoDate('2026-02-29');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('BAD_DATE');
  });
});

describe('isDecimalString', () => {
  it('accepts canonical decimals including negatives', () => {
    expect(isDecimalString('0')).toBe(true);
    expect(isDecimalString('30000')).toBe(true);
    expect(isDecimalString('-12.50')).toBe(true);
    expect(isDecimalString('0.5')).toBe(true);
  });

  it('rejects the forms a recap actually contains, so they must be normalised first', () => {
    expect(isDecimalString('30,000')).toBe(false);
    expect(isDecimalString('+12.50')).toBe(false);
    expect(isDecimalString('12.50 USD')).toBe(false);
    expect(isDecimalString('007')).toBe(false);
    expect(isDecimalString('')).toBe(false);
  });

  it('returns a BAD_DECIMAL error rather than throwing', () => {
    const result = parseDecimalString('30,000');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('BAD_DECIMAL');
  });
});
