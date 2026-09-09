import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { isoDate, productCode } from './brands.js';
import { evaluatePriceFormula, parseBlRelativePeriod, resolvePricingPeriod } from './pricing.js';
import { buildReferenceData, type ProductRow } from './references.js';
import { expect as unwrap } from './result.js';

const PRODUCTS = [
  'product_code,product_name,typical_spec,default_unit,bbl_per_mt,density_kg_m3',
  'GO01,Gasoil 0.1% S,EN 590 equivalent,MT,7.45,845',
].join('\n');

// Real values from data/price_quotes.csv, trimmed to the window under test.
const QUOTES = [
  'date,publication,quote_code,quote_name,unit,low,high,mean',
  '2026-09-03,Platts,GASOIL,Gasoil,USD/MT,630.32,633.32,631.82',
  '2026-09-04,Platts,GASOIL,Gasoil,USD/MT,629.73,632.73,631.23',
  '2026-09-07,Platts,GASOIL,Gasoil,USD/MT,625.85,628.85,627.35',
  '2026-09-08,Platts,GASOIL,Gasoil,USD/MT,622.17,625.17,623.67',
].join('\n');

const BBL_QUOTES = [
  'date,publication,quote_code,quote_name,unit,low,high,mean',
  '2026-09-04,Platts,CRUDE,Crude,USD/BBL,80.00,82.00,81.00',
].join('\n');

const data = unwrap(buildReferenceData(PRODUCTS, QUOTES), 'reference data');
const bblData = unwrap(buildReferenceData(PRODUCTS, BBL_QUOTES), 'bbl reference data');
const gasoil: ProductRow = {
  code: productCode('GO01'),
  name: 'Gasoil 0.1% S',
  typicalSpec: null,
  defaultUnit: 'MT',
  bblPerMt: new Decimal('7.45'),
  densityKgM3: new Decimal('845'),
};

describe('parseBlRelativePeriod', () => {
  it('reads the two-sided forms', () => {
    expect(unwrap(parseBlRelativePeriod('B/L +0/+3'), 'recap_01')).toEqual({
      kind: 'bl_relative',
      fromOffset: 0,
      toOffset: 3,
    });
    expect(unwrap(parseBlRelativePeriod('B/L -1/+3'), 'primer example')).toEqual({
      kind: 'bl_relative',
      fromOffset: -1,
      toOffset: 3,
    });
    expect(unwrap(parseBlRelativePeriod('BL+0..BL+3'), 'canonical')).toEqual({
      kind: 'bl_relative',
      fromOffset: 0,
      toOffset: 3,
    });
  });

  it('excludes the B/L date itself from the one-sided form', () => {
    // The primer defines "B/L + 3" as the three days *after* the B/L date.
    // Reading it as 0..3 would shift every quotation by a day.
    expect(unwrap(parseBlRelativePeriod('B/L + 3'), 'one sided')).toEqual({
      kind: 'bl_relative',
      fromOffset: 1,
      toOffset: 3,
    });
    expect(unwrap(parseBlRelativePeriod('5 days after B/L'), 'prose')).toEqual({
      kind: 'bl_relative',
      fromOffset: 1,
      toOffset: 5,
    });
  });

  it('reads pricing on the B/L date alone', () => {
    expect(unwrap(parseBlRelativePeriod('on B/L date'), 'single day')).toEqual({
      kind: 'bl_relative',
      fromOffset: 0,
      toOffset: 0,
    });
  });

  it('rejects what it does not recognise instead of guessing', () => {
    expect(parseBlRelativePeriod('as per our call').ok).toBe(false);
    expect(parseBlRelativePeriod('B/L +3/-1').ok).toBe(false);
  });
});

describe('resolvePricingPeriod', () => {
  it('anchors a relative period on the B/L date, inclusive at both ends', () => {
    const period = unwrap(parseBlRelativePeriod('B/L +0/+3'), 'period');
    expect(unwrap(resolvePricingPeriod(period, isoDate('2026-09-04')), 'window')).toEqual({
      from: '2026-09-04',
      to: '2026-09-07',
    });
  });

  it('refuses to resolve a relative period with no B/L date rather than inventing one', () => {
    const period = unwrap(parseBlRelativePeriod('B/L +0/+3'), 'period');
    const result = resolvePricingPeriod(period, null);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('BAD_PERIOD');
  });

  it('passes an explicit window through', () => {
    expect(
      unwrap(
        resolvePricingPeriod(
          { kind: 'explicit', from: isoDate('2026-09-01'), to: isoDate('2026-09-05') },
          null,
        ),
        'explicit',
      ),
    ).toEqual({ from: '2026-09-01', to: '2026-09-05' });
  });
});

describe('evaluatePriceFormula', () => {
  const period = unwrap(parseBlRelativePeriod('B/L +0/+3'), 'period');

  it('averages only the days that published, and says how many did not', () => {
    const result = unwrap(
      evaluatePriceFormula(
        data,
        {
          quoteCode: 'GASOIL',
          statistic: 'mean',
          period,
          differential: new Decimal('-12.50'),
          differentialUnit: 'USD/MT',
        },
        isoDate('2026-09-04'),
        gasoil,
      ),
      'recap_01 pricing',
    );

    // 2026-09-04 mean 631.23 and 2026-09-07 mean 627.35. The weekend between
    // them published nothing, which is normal and must not drag the average.
    expect(result.quotesUsed.map((q) => q.date)).toEqual(['2026-09-04', '2026-09-07']);
    expect(result.quoteAverage.toString()).toBe('629.29');
    expect(result.unitPrice.toString()).toBe('616.79');
    expect(result.unit).toBe('USD/MT');
    expect(result.nonPublicationDays).toBe(2);
    expect(result.outsideCoverage).toBe(false);
  });

  it('uses the high column for mean_of_high', () => {
    const result = unwrap(
      evaluatePriceFormula(
        data,
        {
          quoteCode: 'GASOIL',
          statistic: 'mean_of_high',
          period,
          differential: new Decimal('0'),
          differentialUnit: 'USD/MT',
        },
        isoDate('2026-09-04'),
        gasoil,
      ),
      'mean of high',
    );
    // (632.73 + 628.85) / 2
    expect(result.quoteAverage.toString()).toBe('630.79');
  });

  it('converts a per-tonne differential onto a per-barrel quotation and records the factor', () => {
    const result = unwrap(
      evaluatePriceFormula(
        bblData,
        {
          quoteCode: 'CRUDE',
          statistic: 'mean',
          period: { kind: 'explicit', from: isoDate('2026-09-04'), to: isoDate('2026-09-04') },
          differential: new Decimal('-7.45'),
          differentialUnit: 'USD/MT',
        },
        null,
        gasoil,
      ),
      'mixed units',
    );
    expect(result.unit).toBe('USD/BBL');
    expect(result.unitPrice.toString()).toBe('80'); // 81.00 - (7.45 / 7.45)
    expect(result.differentialFactorBblPerMt?.toString()).toBe('7.45');
  });

  it('refuses a mixed-unit formula when no product is resolved to convert with', () => {
    const result = evaluatePriceFormula(
      bblData,
      {
        quoteCode: 'CRUDE',
        statistic: 'mean',
        period: { kind: 'explicit', from: isoDate('2026-09-04'), to: isoDate('2026-09-04') },
        differential: new Decimal('-7.45'),
        differentialUnit: 'USD/MT',
      },
      null,
      null,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('UNIT_UNCONVERTIBLE');
  });

  it('refuses to price at all when the differential is not stated', () => {
    // recap_03: "price tbc as per our call". Inventing a differential here is
    // the money-losing bug the whole system exists to prevent (B1).
    const result = evaluatePriceFormula(
      data,
      {
        quoteCode: 'GASOIL',
        statistic: 'mean',
        period,
        differential: null,
        differentialUnit: null,
      },
      isoDate('2026-09-04'),
      gasoil,
    );
    expect(result.ok).toBe(false);
  });

  it('reports a window that runs past the quotations we hold', () => {
    const result = unwrap(
      evaluatePriceFormula(
        data,
        {
          quoteCode: 'GASOIL',
          statistic: 'mean',
          period: { kind: 'explicit', from: isoDate('2026-09-07'), to: isoDate('2026-09-30') },
          differential: new Decimal('0'),
          differentialUnit: 'USD/MT',
        },
        null,
        gasoil,
      ),
      'past coverage',
    );
    expect(result.outsideCoverage).toBe(true);
  });
});
