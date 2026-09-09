import { describe, expect, it } from 'vitest';
import type { Question } from '../domain/questions.js';
import { MANDATORY_FIELDS, emptyDeal, type Deal } from '../domain/schema.js';
import type { EvalCase } from './case.js';
import { classify, scoreCase, summarise, summariseByClass, valuesMatch } from './score.js';

function makeCase(expected: Record<string, string | null>, caseClass = 'clean'): EvalCase {
  const fields: Record<string, string | null> = {};
  for (const path of MANDATORY_FIELDS) fields[path] = null;
  Object.assign(fields, expected);
  return {
    meta: {
      id: 'test-case',
      title: 'test',
      class: caseClass as EvalCase['meta']['class'],
      reference_date: '2026-08-11',
      source: 'invented',
      notes: '',
    },
    text: 'irrelevant',
    expected: new Map(Object.entries(fields)),
    directory: 'memory',
  };
}

function withField(deal: Deal, path: string, value: string | null): Deal {
  const clone = structuredClone(deal) as unknown as Record<string, unknown>;
  const segments = path.split('.');
  let node = clone;
  for (const segment of segments.slice(0, -1)) node = node[segment] as Record<string, unknown>;
  node[segments[segments.length - 1] as string] = {
    value,
    evidence: value,
    status: value === null ? 'absent' : 'stated',
  };
  return clone as unknown as Deal;
}

function question(field: string): Question {
  return { field, reason: 'absent', question: 'q?' };
}

describe('valuesMatch', () => {
  it('compares decimals numerically', () => {
    expect(valuesMatch('12.50', '12.5')).toBe(true);
    expect(valuesMatch('-12.50', '-12.5')).toBe(true);
    expect(valuesMatch('30000', '30000.00')).toBe(true);
    expect(valuesMatch('12.50', '-12.50')).toBe(false);
  });

  it('compares text case-insensitively with whitespace collapsed', () => {
    expect(valuesMatch('Helvig Energy AG', 'helvig  energy ag')).toBe(true);
    expect(valuesMatch('Helvig Energy AG', 'Helvig Energy AG.')).toBe(true);
  });

  it('does not forgive a different legal entity', () => {
    // A shortened counterparty name is a real contract defect, not a near miss.
    expect(valuesMatch('Helvig Energy AG', 'Helvig Energy')).toBe(false);
    expect(valuesMatch('Optiflow Trading DMCC', 'Optiflow Trading LLC')).toBe(false);
  });
});

describe('classify', () => {
  it('scores a matching value as correct', () => {
    expect(classify('FOB', 'FOB', false)).toBe('correct');
  });

  it('scores a differing value as wrong_value', () => {
    expect(classify('FOB', 'CIF', false)).toBe('wrong_value');
  });

  it('separates a flagged abstention from a silent one', () => {
    // A null without a question is a gap, not an abstention (B7).
    expect(classify(null, null, true)).toBe('correct_abstention');
    expect(classify(null, null, false)).toBe('unflagged_abstention');
  });

  it('scores an invented value as confident_nonsense', () => {
    expect(classify(null, '-12.50', false)).toBe('confident_nonsense');
  });

  it('still calls it confident_nonsense when the extractor also asked', () => {
    // Emitting a number and a question about it is better than staying silent,
    // but the number is still invented and still reaches an invoice.
    expect(classify(null, '-12.50', true)).toBe('confident_nonsense');
  });

  it('scores an unnecessary refusal as wrong_abstention', () => {
    expect(classify('FOB', null, true)).toBe('wrong_abstention');
  });
});

describe('scoreCase', () => {
  it('scores only the fields the case pinned', () => {
    const evalCase = makeCase({ buyer: 'Helvig Energy AG' });
    const deal = withField(emptyDeal(), 'buyer', 'Helvig Energy AG');
    const score = scoreCase(evalCase, deal, []);
    expect(score.fields).toHaveLength(MANDATORY_FIELDS.length);
    expect(score.fields.find((f) => f.field === 'buyer')?.outcome).toBe('correct');
  });

  it('marks a silent error when a wrong mandatory field carried no question', () => {
    const evalCase = makeCase({ 'pricing.differential.value': '-12.50' });
    const deal = withField(emptyDeal(), 'pricing.differential.value', '-2.50');
    const score = scoreCase(evalCase, deal, []);
    expect(score.silentError).toBe(true);
  });

  it('does not mark a silent error when the wrong field was flagged', () => {
    const evalCase = makeCase({ 'pricing.differential.value': '-12.50' });
    const deal = withField(emptyDeal(), 'pricing.differential.value', '-2.50');
    const score = scoreCase(evalCase, deal, [question('pricing.differential.value')]);
    expect(score.silentError).toBe(false);
  });

  it('does not mark a silent error for an over-refusal', () => {
    // Refusing a value we did have is annoying, not dangerous. It must not be
    // counted in the metric that maps to a bad invoice.
    const evalCase = makeCase({ 'pricing.differential.value': '-12.50' });
    const score = scoreCase(evalCase, emptyDeal(), [question('pricing.differential.value')]);
    expect(score.fields.find((f) => f.field === 'pricing.differential.value')?.outcome).toBe(
      'wrong_abstention',
    );
    expect(score.silentError).toBe(false);
  });

  it('trips the release gate on an invented money-critical value', () => {
    const evalCase = makeCase({});
    const deal = withField(emptyDeal(), 'pricing.differential.value', '-2.50');
    expect(scoreCase(evalCase, deal, []).gateViolation).toBe(true);
  });

  it('does not trip the gate on an invented value outside the money-critical set', () => {
    const evalCase = makeCase({});
    const deal = withField(emptyDeal(), 'buyer', 'Someone Invented AG');
    const score = scoreCase(evalCase, deal, []);
    expect(score.fields.find((f) => f.field === 'buyer')?.outcome).toBe('confident_nonsense');
    expect(score.gateViolation).toBe(false);
    expect(score.silentError).toBe(true);
  });

  it('counts an invented conditional value, which the mandatory-only count hides', () => {
    // A fabricated demurrage rate never reaches the mandatory tally, and it is
    // still money. Case 11 puts a real demurrage figure for a different deal in
    // the same message, so this is not hypothetical.
    const base = makeCase({});
    const evalCase: EvalCase = {
      ...base,
      expected: new Map([...base.expected, ['demurrage.rate_per_day', null]]),
    };
    const deal = withField(emptyDeal(), 'demurrage.rate_per_day', '28000');
    const summary = summarise([scoreCase(evalCase, deal, [])]);
    expect(summary.confidentNonsense).toBe(0);
    expect(summary.confidentNonsenseAll).toBe(1);
  });

  it('scores conditional fields the case pinned, after the mandatory ones', () => {
    const evalCase = makeCase({});
    const withLaw: EvalCase = {
      ...evalCase,
      expected: new Map([...evalCase.expected, ['law', 'English law']]),
    };
    const deal = withField(emptyDeal(), 'law', 'English law');
    const score = scoreCase(withLaw, deal, []);
    const last = score.fields[score.fields.length - 1];
    expect(last?.field).toBe('law');
    expect(last?.mandatory).toBe(false);
    expect(last?.outcome).toBe('correct');
  });

  it('produces the same field order on every run', () => {
    const evalCase = makeCase({});
    const a = scoreCase(evalCase, emptyDeal(), []).fields.map((f) => f.field);
    const b = scoreCase(evalCase, emptyDeal(), []).fields.map((f) => f.field);
    expect(a).toEqual(b);
    expect(a.slice(0, MANDATORY_FIELDS.length)).toEqual([...MANDATORY_FIELDS]);
  });
});

describe('summarise', () => {
  it('cannot be gamed by refusing everything', () => {
    // The all-null baseline: perfect on abstention, useless overall. If a
    // single headline number could be maximised by refusing, the metric would
    // be worthless, so accuracy and abstention are reported separately.
    const mustAbstain = makeCase({}, 'must_abstain');
    const clean = makeCase({ buyer: 'Helvig Energy AG', seller: 'Optiflow Trading DMCC' }, 'clean');
    const allQuestions = MANDATORY_FIELDS.map(question);

    const scores = [
      scoreCase(mustAbstain, emptyDeal(), allQuestions),
      scoreCase(clean, emptyDeal(), allQuestions),
    ];
    const summary = summarise(scores);

    expect(summary.abstentionRate).toBe(1);
    expect(summary.accuracy).toBe(0);
    expect(summary.overRefusalRate).toBe(1);
    expect(summary.confidentNonsense).toBe(0);
    expect(summary.gatePassed).toBe(true);
    expect(summary.silentErrorRate).toBe(0);
  });

  it('counts a silent error per case, not per field', () => {
    const evalCase = makeCase({ buyer: 'A', seller: 'B' });
    const deal = withField(withField(emptyDeal(), 'buyer', 'X'), 'seller', 'Y');
    const summary = summarise([scoreCase(evalCase, deal, [])]);
    expect(summary.silentErrorRate).toBe(1);
    expect(summary.counts.wrong_value).toBe(2);
  });

  it('reports 0 rather than NaN for an empty set', () => {
    const summary = summarise([]);
    expect(summary.accuracy).toBe(0);
    expect(summary.silentErrorRate).toBe(0);
    expect(summary.gatePassed).toBe(true);
  });

  it('breaks results down by case class in a stable order', () => {
    const scores = [
      scoreCase(makeCase({}, 'must_abstain'), emptyDeal(), []),
      scoreCase(makeCase({}, 'clean'), emptyDeal(), []),
    ];
    expect([...summariseByClass(scores).keys()]).toEqual(['clean', 'must_abstain']);
  });
});
