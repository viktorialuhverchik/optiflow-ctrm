import { describe, expect, it } from 'vitest';
import { normalisePricingPeriod } from './normalise.js';
import { parseBlRelativePeriod } from './pricing.js';

describe('normalisePricingPeriod', () => {
  it('strips the connective traders write in front of the period', () => {
    expect(normalisePricingPeriod('over B/L +0/+3')).toBe('B/L +0/+3');
    expect(normalisePricingPeriod('basis B/L -1/+3')).toBe('B/L -1/+3');
    expect(normalisePricingPeriod('  over   B/L +0/+2  ')).toBe('B/L +0/+2');
  });

  it('strips a stacked connective', () => {
    expect(normalisePricingPeriod('basis over B/L +0/+3')).toBe('B/L +0/+3');
  });

  it('strips trailing punctuation where the model stopped copying', () => {
    expect(normalisePricingPeriod('over B/L +0/+3,')).toBe('B/L +0/+3');
    expect(normalisePricingPeriod('B/L +0/+3.')).toBe('B/L +0/+3');
  });

  it('leaves an already-canonical period alone', () => {
    expect(normalisePricingPeriod('B/L +0/+3')).toBe('B/L +0/+3');
    expect(normalisePricingPeriod('B/L -1 / +3')).toBe('B/L -1 / +3');
  });

  it('does not eat a word that is part of the period', () => {
    expect(normalisePricingPeriod('the 5 days after B/L')).toBe('the 5 days after B/L');
    expect(normalisePricingPeriod('5 days after B/L')).toBe('5 days after B/L');
  });

  it('produces the canonical form the deal object stores', () => {
    // Why the rule exists: the model returns "over B/L +0/+3" about a third of
    // the time, and the stored value is what a contract and an invoice are read
    // off. The parser is tolerant of the connective as well, so an unnormalised
    // value from some other source still prices rather than failing outright.
    const raw = 'over B/L +0/+3';
    expect(normalisePricingPeriod(raw)).toBe('B/L +0/+3');
    expect(parseBlRelativePeriod(normalisePricingPeriod(raw)).ok).toBe(true);
    expect(parseBlRelativePeriod(raw).ok).toBe(true);
  });
});
