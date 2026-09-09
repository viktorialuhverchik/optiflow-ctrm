import { describe, expect, it } from 'vitest';
import { isoDate } from './brands.js';
import { buildReferenceData, quotesInWindow, resolveProduct, resolveQuote } from './references.js';
import { expect as unwrap } from './result.js';

const PRODUCTS = [
  'product_code,product_name,typical_spec,default_unit,bbl_per_mt,density_kg_m3',
  'GO01,Gasoil 0.1% S,EN 590 equivalent,MT,7.45,845',
  'VLSFO,VLSFO 0.5% S,,MT,6.42,980',
].join('\n');

const QUOTES = [
  'date,publication,quote_code,quote_name,unit,low,high,mean',
  '2026-09-04,Platts,Q1,Quote One,USD/MT,629.73,632.73,631.23',
  // 2026-09-05 and -06 are a weekend: no publication, and that is normal.
  '2026-09-07,Platts,Q1,Quote One,USD/MT,625.85,628.85,627.35',
  '2026-09-08,Platts,Q1,Quote One,USD/MT,622.17,625.17,623.67',
].join('\n');

describe('buildReferenceData', () => {
  it('loads products and quotations and exposes sorted code lists', () => {
    const data = unwrap(buildReferenceData(PRODUCTS, QUOTES), 'build');
    expect(data.productCodes).toEqual(['GO01', 'VLSFO']);
    expect(data.quoteCodes).toEqual(['Q1']);
    expect(data.products.get('GO01')?.bblPerMt.toString()).toBe('7.45');
    expect(data.products.get('VLSFO')?.typicalSpec).toBeNull();
  });

  it('rejects a duplicate product code', () => {
    const dup = `${PRODUCTS}\nGO01,Duplicate,,MT,7.45,845`;
    expect(buildReferenceData(dup, QUOTES).ok).toBe(false);
  });

  it('rejects two quotations for the same code on the same day', () => {
    const dup = `${QUOTES}\n2026-09-08,Platts,Q1,Quote One,USD/MT,1,2,1.5`;
    expect(buildReferenceData(PRODUCTS, dup).ok).toBe(false);
  });

  it('rejects a quotation whose low is above its high', () => {
    const bad = QUOTES.replace('629.73,632.73', '999.00,632.73');
    expect(buildReferenceData(PRODUCTS, bad).ok).toBe(false);
  });

  it('rejects an unknown unit rather than defaulting it', () => {
    const bad = PRODUCTS.replace(',MT,7.45', ',TONNES,7.45');
    expect(buildReferenceData(bad, QUOTES).ok).toBe(false);
  });
});

describe('lookups', () => {
  const data = unwrap(buildReferenceData(PRODUCTS, QUOTES), 'build');

  it('resolves a known product and reports an unknown one as a domain error', () => {
    expect(unwrap(resolveProduct(data, 'GO01'), 'known').name).toBe('Gasoil 0.1% S');
    const missing = resolveProduct(data, 'NOPE');
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe('PRODUCT_UNRESOLVED');
  });

  it('reports an unknown quote code as a domain error', () => {
    const missing = resolveQuote(data, 'NOPE');
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe('QUOTE_CODE_UNRESOLVED');
  });
});

describe('quotesInWindow', () => {
  const data = unwrap(buildReferenceData(PRODUCTS, QUOTES), 'build');

  it('returns only published days and counts the window in calendar days', () => {
    const window = unwrap(
      quotesInWindow(data, 'Q1', { from: isoDate('2026-09-04'), to: isoDate('2026-09-07') }),
      'weekend window',
    );
    expect(window.quotes.map((q) => q.date)).toEqual(['2026-09-04', '2026-09-07']);
    expect(window.requestedDays).toBe(4);
    expect(window.outsideCoverage).toBe(false);
  });

  it('flags a window that runs past the end of the data we hold', () => {
    const window = unwrap(
      quotesInWindow(data, 'Q1', { from: isoDate('2026-09-07'), to: isoDate('2026-09-30') }),
      'past coverage',
    );
    expect(window.outsideCoverage).toBe(true);
    expect(window.coverage).toEqual({ from: '2026-09-04', to: '2026-09-08' });
  });

  it('refuses a window with no quotations at all instead of returning an average of nothing', () => {
    const result = quotesInWindow(data, 'Q1', {
      from: isoDate('2026-09-05'),
      to: isoDate('2026-09-06'),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('QUOTE_WINDOW_EMPTY');
  });
});
