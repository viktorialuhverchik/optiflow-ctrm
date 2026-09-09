import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { convertToUsd, parseFxPair, resolveFx, usdPerUnitFromPair } from './fx.js';
import { expect as unwrap } from './result.js';

describe('parseFxPair', () => {
  it('reads a pair and its rate', () => {
    expect(unwrap(parseFxPair('USD/AED 3.6725'), 'peg')).toEqual({
      base: 'USD',
      quote: 'AED',
      value: new Decimal('3.6725'),
    });
    expect(unwrap(parseFxPair('EUR/USD at 1.0920'), 'euro')).toEqual({
      base: 'EUR',
      quote: 'USD',
      value: new Decimal('1.0920'),
    });
  });

  it('reads the prose notation a recap actually uses', () => {
    // recap_02: "Currency: EUR, converted at a fixed agreed rate of 1.0852 USD per EUR".
    expect(unwrap(parseFxPair('a fixed agreed rate of 1.0852 USD per EUR'), 'prose')).toEqual({
      base: 'EUR',
      quote: 'USD',
      value: new Decimal('1.0852'),
    });
  });

  it('resolves the prose notation in the right direction', () => {
    const fx = unwrap(resolveFx('EUR', 'a fixed agreed rate of 1.0852 USD per EUR'), 'prose eur');
    expect(fx.usdPerUnit.toString()).toBe('1.0852');
    expect(convertToUsd(new Decimal('1000'), fx).toString()).toBe('1085.2');
  });

  it('rejects text with no rate in it', () => {
    // "ECB EUR/USD fixing on B/L date" names a basis but no number. That has to
    // be looked up, and this module holds no market data.
    expect(parseFxPair('ECB EUR/USD fixing on B/L date').ok).toBe(false);
    expect(parseFxPair('as agreed').ok).toBe(false);
  });
});

describe('usdPerUnitFromPair', () => {
  it('inverts when USD is the base currency', () => {
    const pair = unwrap(parseFxPair('USD/AED 3.6725'), 'peg');
    const rate = unwrap(usdPerUnitFromPair(pair, 'AED'), 'aed');
    expect(rate.toDecimalPlaces(6).toString()).toBe('0.272294');
  });

  it('uses the rate directly when USD is the quote currency', () => {
    const pair = unwrap(parseFxPair('EUR/USD 1.0920'), 'eur');
    expect(unwrap(usdPerUnitFromPair(pair, 'EUR'), 'eur').toString()).toBe('1.092');
  });

  it('refuses a pair that does not involve the deal currency', () => {
    const pair = unwrap(parseFxPair('EUR/USD 1.0920'), 'eur');
    expect(usdPerUnitFromPair(pair, 'AED').ok).toBe(false);
  });
});

describe('resolveFx', () => {
  it('is the identity for USD', () => {
    const fx = unwrap(resolveFx('USD', null), 'usd');
    expect(fx.usdPerUnit.toString()).toBe('1');
    expect(fx.source).toBe('usd');
  });

  it('falls back to the published peg for AED', () => {
    const fx = unwrap(resolveFx('AED', null), 'aed');
    expect(fx.source).toBe('peg');
    expect(convertToUsd(new Decimal('36725'), fx).toString()).toBe('10000');
  });

  it('prefers a rate the recap actually states over the peg', () => {
    const fx = unwrap(resolveFx('AED', 'USD/AED 3.6700'), 'stated aed');
    expect(fx.source).toBe('stated');
    expect(fx.asWritten).toBe('USD/AED 3.6700');
  });

  it('refuses a non-pegged currency with no stated rate rather than inventing one', () => {
    const result = resolveFx('EUR', null);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('CURRENCY_MISMATCH');
  });

  it('refuses a EUR basis that names a fixing but no number', () => {
    expect(resolveFx('EUR', 'ECB EUR/USD fixing on B/L date').ok).toBe(false);
  });

  it('converts a stated EUR rate', () => {
    const fx = unwrap(resolveFx('EUR', 'EUR/USD 1.0920'), 'eur');
    expect(convertToUsd(new Decimal('1000'), fx).toString()).toBe('1092');
  });
});
