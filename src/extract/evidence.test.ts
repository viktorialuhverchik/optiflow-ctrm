import { describe, expect, it } from 'vitest';
import { emptyDeal, getField, type Deal } from '../domain/schema.js';
import { evidenceAppearsIn, normaliseForSearch, verifyEvidence } from './evidence.js';

const SOURCE = `[Telegram, 2026-08-11 17:42]

CONFIRMED - RECAP 11.08.2026
Seller: Optiflow Trading DMCC
Quantity: 30,000 MT +/- 10% in seller's option
Price: Mean of Platts FOB MED Italy Gasoil 0.1% over B/L +0/+3,
minus USD 12.50/MT`;

function withField(deal: Deal, path: string, value: string | null, evidence: string | null): Deal {
  const clone = structuredClone(deal) as unknown as Record<string, unknown>;
  const segments = path.split('.');
  let node = clone;
  for (const segment of segments.slice(0, -1)) node = node[segment] as Record<string, unknown>;
  node[segments[segments.length - 1] as string] = { value, evidence, status: 'stated' };
  return clone as unknown as Deal;
}

describe('evidenceAppearsIn', () => {
  it('finds a verbatim span', () => {
    expect(evidenceAppearsIn(SOURCE, 'Optiflow Trading DMCC')).toBe(true);
    expect(evidenceAppearsIn(SOURCE, 'minus USD 12.50/MT')).toBe(true);
  });

  it('forgives wrapping and case, because a wrapped email line is not a fabrication', () => {
    expect(evidenceAppearsIn(SOURCE, 'over B/L +0/+3,\n   minus USD 12.50/MT')).toBe(true);
    expect(evidenceAppearsIn(SOURCE, 'optiflow trading dmcc')).toBe(true);
  });

  it('forgives nothing about digits or punctuation', () => {
    expect(evidenceAppearsIn(SOURCE, 'minus USD 12.60/MT')).toBe(false);
    expect(evidenceAppearsIn(SOURCE, '30.000 MT')).toBe(false);
  });

  it('rejects a paraphrase', () => {
    expect(evidenceAppearsIn(SOURCE, 'the seller is Optiflow')).toBe(false);
  });

  it('rejects empty evidence', () => {
    expect(evidenceAppearsIn(SOURCE, '   ')).toBe(false);
  });
});

describe('verifyEvidence', () => {
  it('keeps a value whose evidence is in the source', () => {
    const deal = withField(emptyDeal(), 'seller', 'Optiflow Trading DMCC', 'Seller: Optiflow Trading DMCC');
    const result = verifyEvidence(deal, SOURCE);
    expect(result.rejections).toHaveLength(0);
    expect(getField(result.deal, 'seller')?.value).toBe('Optiflow Trading DMCC');
  });

  it('drops a value whose evidence is not in the source', () => {
    // The failure this exists for: a fabricated differential with fabricated
    // words to back it up.
    const deal = withField(emptyDeal(), 'pricing.differential.value', '-2.50', 'minus USD 2.50/MT');
    const result = verifyEvidence(deal, SOURCE);
    expect(result.rejections).toEqual([
      { field: 'pricing.differential.value', reason: 'evidence_not_in_source', quoted: 'minus USD 2.50/MT' },
    ]);
    expect(getField(result.deal, 'pricing.differential.value')?.value).toBeNull();
  });

  it('marks a dropped field ambiguous rather than absent', () => {
    // The message may say it; we could not confirm where. The question the
    // trader gets should say that, not claim the message is silent.
    const deal = withField(emptyDeal(), 'buyer', 'Helvig Energy AG', 'Buyer: Helvig Energy AG');
    const result = verifyEvidence(deal, SOURCE);
    expect(getField(result.deal, 'buyer')?.status).toBe('ambiguous');
  });

  it('drops a value that carries no evidence at all', () => {
    const deal = withField(emptyDeal(), 'buyer', 'Helvig Energy AG', null);
    const result = verifyEvidence(deal, SOURCE);
    expect(result.rejections[0]?.reason).toBe('missing_evidence');
  });

  it('leaves an abstention alone, since a null needs no evidence', () => {
    const result = verifyEvidence(emptyDeal(), SOURCE);
    expect(result.rejections).toHaveLength(0);
    expect(getField(result.deal, 'buyer')?.status).toBe('absent');
  });

  it('does not mutate the deal it was given', () => {
    const deal = withField(emptyDeal(), 'buyer', 'Nobody', 'not in the message');
    verifyEvidence(deal, SOURCE);
    expect(getField(deal, 'buyer')?.value).toBe('Nobody');
  });
});

describe('normaliseForSearch', () => {
  it('collapses runs of whitespace and trims', () => {
    expect(normaliseForSearch('  a \n\t b  ')).toBe('a b');
  });
});
