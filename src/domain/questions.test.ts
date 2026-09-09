import { describe, expect, it } from 'vitest';
import { generateQuestions, isComplete } from './questions.js';
import { MANDATORY_FIELDS, emptyDeal, type Deal } from './schema.js';

function withField(deal: Deal, path: string, value: unknown, status = 'stated'): Deal {
  const clone = structuredClone(deal) as unknown as Record<string, unknown>;
  const segments = path.split('.');
  let node = clone;
  for (const segment of segments.slice(0, -1)) {
    node = node[segment] as Record<string, unknown>;
  }
  const last = segments[segments.length - 1] as string;
  node[last] = { value, evidence: value === null ? null : String(value), status };
  return clone as unknown as Deal;
}

describe('generateQuestions', () => {
  it('asks about every mandatory field on an empty deal, in schema order', () => {
    const questions = generateQuestions(emptyDeal());
    expect(questions.map((q) => q.field)).toEqual([...MANDATORY_FIELDS]);
    expect(questions.every((q) => q.reason === 'absent')).toBe(true);
  });

  it('produces byte-identical output on repeated runs', () => {
    const a = JSON.stringify(generateQuestions(emptyDeal()));
    const b = JSON.stringify(generateQuestions(emptyDeal()));
    expect(a).toBe(b);
  });

  it('names the field in the question text', () => {
    const questions = generateQuestions(emptyDeal());
    const differential = questions.find((q) => q.field === 'pricing.differential.value');
    expect(differential?.question).toContain('differential');
    expect(differential?.question).toContain('negative for a discount');
  });

  it('stops asking once a field is stated', () => {
    let deal = emptyDeal();
    deal = withField(deal, 'buyer', 'Helvig Energy AG');
    const fields = generateQuestions(deal).map((q) => q.field);
    expect(fields).not.toContain('buyer');
    expect(fields).toContain('seller');
  });

  it('asks a different question when a value is present but ambiguous', () => {
    // "delivered Rotterdam" is trader shorthand, not an Incoterm (B5). The
    // place is known, the term is not, and the question has to say so.
    const deal = withField(emptyDeal(), 'delivery_term.incoterm', null, 'ambiguous');
    const question = generateQuestions(deal).find((q) => q.field === 'delivery_term.incoterm');
    expect(question?.reason).toBe('ambiguous');
    expect(question?.question).toContain('trader shorthand');
  });

  it('asks even when an ambiguous field carries a value', () => {
    const deal = withField(emptyDeal(), 'recap_date', '2026-08-20', 'ambiguous');
    const question = generateQuestions(deal).find((q) => q.field === 'recap_date');
    expect(question?.reason).toBe('ambiguous');
  });

  it('turns an unresolvable code into its own question', () => {
    const deal = withField(emptyDeal(), 'pricing.quote_code', 'PLATTS_MADE_UP');
    const questions = generateQuestions(deal, [
      { field: 'pricing.quote_code', detail: 'We do not hold a series called PLATTS_MADE_UP.' },
    ]);
    const question = questions.find((q) => q.field === 'pricing.quote_code');
    expect(question?.reason).toBe('unresolvable');
    expect(question?.question).toContain('PLATTS_MADE_UP');
  });

  it('asks for FX once the deal is not in USD', () => {
    const deal = withField(emptyDeal(), 'currency', 'EUR');
    const fx = generateQuestions(deal).find((q) => q.field === 'fx.rate');
    expect(fx?.question).toContain('EUR');
  });

  it('does not ask for FX on a USD deal', () => {
    const deal = withField(emptyDeal(), 'currency', 'USD');
    expect(generateQuestions(deal).some((q) => q.field === 'fx.rate')).toBe(false);
  });

  it('reports a fully stated deal as complete', () => {
    let deal = emptyDeal();
    for (const path of MANDATORY_FIELDS) deal = withField(deal, path, 'x');
    deal = withField(deal, 'currency', 'USD');
    expect(isComplete(generateQuestions(deal))).toBe(true);
  });
});
