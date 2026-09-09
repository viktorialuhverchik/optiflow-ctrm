import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { isoDate, productCode } from './brands.js';
import { resolveFx } from './fx.js';
import type { ProductRow, QuoteRow } from './references.js';
import { expect as unwrap } from './result.js';
import { computeProvisionalValue, type ValuationInput } from './valuation.js';

const naphtha: ProductRow = {
  code: productCode('NAPH'),
  name: 'Naphtha full range',
  typicalSpec: null,
  defaultUnit: 'MT',
  bblPerMt: new Decimal('8.90'),
  densityKgM3: new Decimal('705'),
};

const quotes: QuoteRow[] = [];

function baseInput(overrides: Partial<ValuationInput> = {}): ValuationInput {
  return {
    quoteAverage: new Decimal('600'),
    quoteUnit: 'USD/MT',
    differential: new Decimal('8.00'),
    differentialUnit: 'USD/MT',
    quantity: new Decimal('1000'),
    quantityUnit: 'MT',
    product: naphtha,
    fx: unwrap(resolveFx('USD', null), 'usd'),
    window: { from: isoDate('2026-09-11'), to: isoDate('2026-09-15') },
    quotesUsed: quotes,
    blDateEstimatedFrom: null,
    nonPublicationDays: 0,
    publishedDays: 5,
    ...overrides,
  };
}

describe('computeProvisionalValue', () => {
  it('applies the differential and multiplies by quantity', () => {
    const result = unwrap(computeProvisionalValue(baseInput()), 'simple');
    expect(result.unitPrice.toString()).toBe('608');
    expect(result.valueUsd.toString()).toBe('608000');
  });

  it('converts a barrels quantity onto a per-tonne price and records the factor', () => {
    // The mixed-unit case from recap_02: 220,000 bbl priced per tonne.
    const result = unwrap(
      computeProvisionalValue(baseInput({ quantity: new Decimal('8900'), quantityUnit: 'BBL' })),
      'mixed units',
    );
    expect(result.pricedQuantity.toString()).toBe('1000');
    expect(result.pricedQuantityUnit).toBe('MT');
    expect(result.valueUsd.toString()).toBe('608000');
    expect(result.assumptions.some((a) => a.kind === 'unit_converted')).toBe(true);
  });

  it('refuses a mixed-unit deal with no product to convert with', () => {
    const result = computeProvisionalValue(
      baseInput({ quantity: new Decimal('8900'), quantityUnit: 'BBL', product: null }),
    );
    expect(result.ok).toBe(false);
  });

  it('reports the deal-currency figure and the USD figure separately', () => {
    const fx = unwrap(resolveFx('EUR', 'a fixed agreed rate of 1.0852 USD per EUR'), 'eur');
    const result = unwrap(computeProvisionalValue(baseInput({ fx })), 'eur deal');
    expect(result.valueUsd.toString()).toBe('608000');
    expect(result.dealCurrency).toBe('EUR');
    // 608000 USD at 1.0852 USD per EUR
    expect(result.valueInDealCurrency.toDecimalPlaces(2).toString()).toBe('560265.39');
  });

  it('records an estimated bill of lading date as an assumption, not a fact', () => {
    const result = unwrap(
      computeProvisionalValue(baseInput({ blDateEstimatedFrom: isoDate('2026-09-12') })),
      'estimated bl',
    );
    const assumption = result.assumptions.find((a) => a.kind === 'bl_date_estimated');
    expect(assumption?.detail).toContain('2026-09-12');
    expect(assumption?.detail).toContain('will move');
  });

  it('says how many days of the window published', () => {
    const result = unwrap(
      computeProvisionalValue(baseInput({ nonPublicationDays: 2, publishedDays: 3 })),
      'weekend',
    );
    const assumption = result.assumptions.find((a) => a.kind === 'window_incomplete');
    expect(assumption?.detail).toContain('3 quotation(s)');
    expect(assumption?.detail).toContain('5-day window');
  });

  it('does not claim nothing published when the caller has only the average', () => {
    // The caller may hold the averaged figure without the individual rows.
    // Deriving the count from an empty rows array reported a window in which
    // nothing published, which was false and alarming.
    const result = unwrap(
      computeProvisionalValue(baseInput({ nonPublicationDays: 2, publishedDays: 3, quotesUsed: [] })),
      'no rows',
    );
    expect(result.assumptions.find((a) => a.kind === 'window_incomplete')?.detail).toContain(
      '3 quotation(s)',
    );
  });

  it('always records where the FX rate came from', () => {
    const result = unwrap(computeProvisionalValue(baseInput()), 'usd');
    expect(result.assumptions.some((a) => a.kind === 'fx_source')).toBe(true);
  });

  it('never returns a value without at least one assumption attached', () => {
    // An estimate with no stated basis is indistinguishable from a made-up
    // number once it is on an invoice.
    expect(unwrap(computeProvisionalValue(baseInput()), 'x').assumptions.length).toBeGreaterThan(0);
  });
});
