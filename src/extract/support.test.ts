import { describe, expect, it } from 'vitest';
import { loadReferenceData } from '../io/reference-files.js';
import { emptyDeal, getField, type Deal } from '../domain/schema.js';
import { checkEvidenceSupport, distinctiveQuoteTokens } from './support.js';

const data = loadReferenceData('data');

function withField(deal: Deal, path: string, value: string | null, evidence: string | null): Deal {
  const clone = structuredClone(deal) as unknown as Record<string, unknown>;
  const segments = path.split('.');
  let node = clone;
  for (const segment of segments.slice(0, -1)) node = node[segment] as Record<string, unknown>;
  node[segments[segments.length - 1] as string] = { value, evidence, status: 'stated' };
  return clone as unknown as Deal;
}

function check(deal: Deal, source = ''): ReturnType<typeof checkEvidenceSupport> {
  return checkEvidenceSupport(deal, source, data);
}

describe('hedged quantities', () => {
  it('drops a quantity qualified by an approximation', () => {
    // The exact phrasing from the supplied incomplete recap. Four explicit
    // prompt instructions did not stop the model reporting 5000 here.
    const deal = withField(emptyDeal(), 'quantity.value', '5000', 'about 5,000 mt each');
    const result = check(deal);
    expect(result.failures[0]?.rule).toBe('quantity is hedged or ranged');
    expect(getField(result.deal, 'quantity.value')?.value).toBeNull();
  });

  it('drops a quantity that is really a cargo count', () => {
    const deal = withField(emptyDeal(), 'quantity.value', '5000', '2-3 cargoes of 5,000 mt');
    expect(check(deal).failures).toHaveLength(1);
  });

  it('keeps a firm quantity with a tolerance, because +/- is not a hedge', () => {
    const deal = withField(emptyDeal(), 'quantity.value', '30000', "30,000 MT +/- 10% in seller's option");
    expect(check(deal).failures).toHaveLength(0);
  });

  it('keeps a plain firm quantity', () => {
    const deal = withField(emptyDeal(), 'quantity.value', '220000', '220,000 bbl');
    expect(check(deal).failures).toHaveLength(0);
  });
});

describe('quantity units', () => {
  it('drops a unit that appears nowhere in the evidence', () => {
    const deal = withField(emptyDeal(), 'quantity.unit', 'MT', 'qty 10,000 +/- 10 pct');
    expect(check(deal).failures[0]?.rule).toBe('no unit token in the evidence');
  });

  it('keeps a unit the message writes down, in either notation', () => {
    for (const evidence of ['30,000 MT', '220,000 bbl', '10,000 metric tonnes', '5,000 barrels']) {
      const deal = withField(emptyDeal(), 'quantity.unit', 'MT', evidence);
      expect(check(deal).failures, evidence).toHaveLength(0);
    }
  });
});

describe('pricing statistic', () => {
  it('drops a statistic nobody wrote down', () => {
    const deal = withField(
      emptyDeal(),
      'pricing.statistic',
      'mean',
      'Platts CIF NWE ULSD 10 ppm over B/L +0/+2',
    );
    expect(check(deal).failures[0]?.rule).toBe('no statistic word in the evidence');
  });

  it('does not let "Ultra Low Sulphur" vouch for a low-of-the-day basis', () => {
    // The product grade contains the word "low". Without stripping it, the
    // product name would support a pricing basis nobody agreed.
    const deal = withField(
      emptyDeal(),
      'pricing.statistic',
      'low',
      'Ultra Low Sulphur Diesel 10 ppm, Platts CIF NWE',
    );
    expect(check(deal).failures).toHaveLength(1);
  });

  it('keeps a statistic the message states', () => {
    for (const evidence of [
      'Mean of Platts FOB MED Italy Gasoil 0.1%',
      'mean of the HIGH quotations, Argus CIF NWE Naphtha',
      'average of Platts FOB ARA Jet A-1',
    ]) {
      const deal = withField(emptyDeal(), 'pricing.statistic', 'mean', evidence);
      expect(check(deal).failures, evidence).toHaveLength(0);
    }
  });
});

describe('quotation codes', () => {
  const GASOLINE = 'Price: Mean of Platts CIF NWE Gasoline 95 RON over B/L +0/+3, plus USD 12.00/MT';

  it('drops a code whose quotation the message never names', () => {
    // Case 20: the message names a gasoline assessment we hold no series for.
    // The model answers with the nearest series it was offered.
    const deal = withField(
      emptyDeal(),
      'pricing.quote_code',
      'PLATTS_CIF_NWE_ULSD_10PPM',
      'Platts CIF NWE Gasoline 95 RON',
    );
    const result = check(deal, GASOLINE);
    expect(result.failures[0]?.rule).toBe('the message names no part of this quotation');
    expect(getField(result.deal, 'pricing.quote_code')?.value).toBeNull();
  });

  it('does not let a date vouch for a quotation', () => {
    // "10" is a token of "Platts CIF NWE ULSD 10 ppm" and a substring of the
    // date "14.10.2026". This was a real bug in the first version of the check.
    const source = 'Recap of our call today 14.10.2026. Price: Platts CIF NWE Gasoline 95 RON';
    const deal = withField(emptyDeal(), 'pricing.quote_code', 'PLATTS_CIF_NWE_ULSD_10PPM', source);
    expect(check(deal, source).failures).toHaveLength(1);
  });

  it('keeps a code the message actually names', () => {
    const source = 'Mean of Platts FOB MED Italy Gasoil 0.1% over B/L +0/+3';
    const deal = withField(emptyDeal(), 'pricing.quote_code', 'PLATTS_FOB_MED_ITALY_GASOIL_01', source);
    expect(check(deal, source).failures).toHaveLength(0);
  });

  it('keeps every code in the reference data when its own name is the evidence', () => {
    // Guards the stoplist: if a real quotation had no distinctive token left,
    // the rule would reject it every time.
    for (const code of data.quoteCodes) {
      const name = data.quotesByCode.get(code)?.[0]?.name ?? '';
      const tokens = distinctiveQuoteTokens(name);
      expect(tokens.length, code).toBeGreaterThan(0);
      // Every token must carry a letter. A bare number matched inside a date
      // and vouched for a quotation the message never named.
      for (const token of tokens) expect(/[a-z]/.test(token), `${code} ${token}`).toBe(true);
      const deal = withField(emptyDeal(), 'pricing.quote_code', code, name);
      expect(check(deal, name).failures, code).toHaveLength(0);
    }
  });
});

describe('the checks as a whole', () => {
  it('never invents a value, only removes one', () => {
    const result = check(emptyDeal());
    expect(result.failures).toHaveLength(0);
    for (const path of ['quantity.value', 'quantity.unit', 'pricing.statistic', 'pricing.quote_code']) {
      expect(getField(result.deal, path)?.value).toBeNull();
    }
  });

  it('marks what it drops ambiguous, so the trader gets a question', () => {
    const deal = withField(emptyDeal(), 'quantity.value', '5000', 'about 5,000 mt each');
    expect(getField(check(deal).deal, 'quantity.value')?.status).toBe('ambiguous');
  });

  it('does not mutate the deal it was given', () => {
    const deal = withField(emptyDeal(), 'quantity.value', '5000', 'about 5,000 mt');
    check(deal);
    expect(getField(deal, 'quantity.value')?.value).toBe('5000');
  });
});
