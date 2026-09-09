/**
 * The scorer. Pure, and the most safety-critical code in the repository.
 *
 * A scorer bug produces confident, wrong conclusions about the whole system,
 * which is the same failure mode we are trying to eliminate in the extractor.
 * It therefore has its own unit tests covering every bucket.
 *
 * The six outcomes are fixed by docs/rules-and-constraints.md §4. The one that
 * matters is `confident_nonsense`: the recap did not state a value and the
 * extractor produced one anyway. That is the bad invoice.
 */
import Decimal from 'decimal.js';
import type { Question } from '../domain/questions.js';
import {
  MANDATORY_FIELDS,
  MONEY_CRITICAL_FIELDS,
  getField,
  type Deal,
} from '../domain/schema.js';
import type { EvalCase } from './case.js';

export const OUTCOMES = [
  'correct',
  'correct_abstention',
  'unflagged_abstention',
  'wrong_abstention',
  'wrong_value',
  'confident_nonsense',
] as const;
export type Outcome = (typeof OUTCOMES)[number];

export type FieldScore = {
  readonly field: string;
  readonly mandatory: boolean;
  readonly moneyCritical: boolean;
  readonly expected: string | null;
  readonly actual: string | null;
  readonly outcome: Outcome;
  /** True when the extractor asked a question about this field. */
  readonly flagged: boolean;
};

/**
 * Deliberately carries no timing. Latency is never reproducible, and a duration
 * inside this object would make the scores block undiffable, which is the whole
 * point of separating it from timings (D3).
 */
export type CaseScore = {
  readonly caseId: string;
  readonly caseClass: string;
  readonly fields: readonly FieldScore[];
  /** At least one wrong mandatory field that carried no question. */
  readonly silentError: boolean;
  /** The same, restricted to money-critical fields. This is the one that invoices. */
  readonly silentCriticalError: boolean;
  /** `confident_nonsense` on a money-critical field. The release gate. */
  readonly gateViolation: boolean;
  readonly questionCount: number;
  /** Set when the extractor threw. The case still scores, as all-wrong. */
  readonly failure: string | null;
};

const MONEY_CRITICAL_SET = new Set<string>(MONEY_CRITICAL_FIELDS);
const MANDATORY_SET = new Set<string>(MANDATORY_FIELDS);

const DECIMAL_LIKE = /^-?\d+(?:\.\d+)?$/;

/**
 * Compare two field values.
 *
 * Numbers compare numerically, so `12.50` and `12.5` are the same answer.
 * Everything else compares as case-insensitive text with whitespace collapsed
 * and trailing punctuation removed, so `Helvig Energy AG` and
 * `helvig energy ag.` are the same answer. Deliberately no fuzzy matching
 * beyond that: `Helvig Energy` is a different legal entity from
 * `Helvig Energy AG`, and a scorer that forgave the difference would hide a
 * real contract defect.
 */
export function valuesMatch(expected: string, actual: string): boolean {
  if (DECIMAL_LIKE.test(expected.trim()) && DECIMAL_LIKE.test(actual.trim())) {
    return new Decimal(expected.trim()).eq(new Decimal(actual.trim()));
  }
  return normaliseText(expected) === normaliseText(actual);
}

export function normaliseText(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.,;]+$/, '');
}

function actualValueOf(deal: Deal, path: string): string | null {
  const field = getField(deal, path);
  if (field === null) return null;
  if (field.value === null) return null;
  return String(field.value);
}

export function classify(
  expected: string | null,
  actual: string | null,
  flagged: boolean,
): Outcome {
  if (expected === null) {
    if (actual === null) return flagged ? 'correct_abstention' : 'unflagged_abstention';
    // The recap did not state this and the extractor produced a value anyway.
    return 'confident_nonsense';
  }
  if (actual === null) return 'wrong_abstention';
  return valuesMatch(expected, actual) ? 'correct' : 'wrong_value';
}

export function scoreCase(
  evalCase: EvalCase,
  deal: Deal,
  questions: readonly Question[],
  failure: string | null = null,
): CaseScore {
  const flaggedFields = new Set(questions.map((q) => q.field));
  const fields: FieldScore[] = [];

  // Mandatory fields first, in registry order, then any conditional field the
  // case chose to pin. Order is fixed so two runs diff cleanly (D5).
  const conditional = [...evalCase.expected.keys()]
    .filter((path) => !MANDATORY_SET.has(path))
    .sort();

  for (const path of [...MANDATORY_FIELDS, ...conditional]) {
    if (!evalCase.expected.has(path)) continue;
    const expected = evalCase.expected.get(path) ?? null;
    const actual = actualValueOf(deal, path);
    const flagged = flaggedFields.has(path);
    fields.push({
      field: path,
      mandatory: MANDATORY_SET.has(path),
      moneyCritical: MONEY_CRITICAL_SET.has(path),
      expected,
      actual,
      outcome: classify(expected, actual, flagged),
      flagged,
    });
  }

  const silentError = fields.some(
    (f) =>
      f.mandatory &&
      (f.outcome === 'wrong_value' || f.outcome === 'confident_nonsense') &&
      !f.flagged,
  );

  const silentCriticalError = fields.some(
    (f) =>
      f.moneyCritical &&
      (f.outcome === 'wrong_value' || f.outcome === 'confident_nonsense') &&
      !f.flagged,
  );

  const gateViolation = fields.some(
    (f) => f.moneyCritical && f.outcome === 'confident_nonsense',
  );

  return {
    caseId: evalCase.meta.id,
    caseClass: evalCase.meta.class,
    fields,
    silentError,
    silentCriticalError,
    gateViolation,
    questionCount: questions.length,
    failure,
  };
}

// --------------------------------------------------------------------------
// Aggregation
// --------------------------------------------------------------------------

export type OutcomeCounts = Record<Outcome, number>;

export type Summary = {
  readonly caseCount: number;
  readonly mandatoryFieldCount: number;
  readonly counts: OutcomeCounts;
  /** correct / mandatory fields whose expected value is non-null. */
  readonly accuracy: number;
  /** correct_abstention / mandatory fields whose expected value is null. */
  readonly abstentionRate: number;
  /** wrong_abstention / mandatory fields whose expected value is non-null. */
  readonly overRefusalRate: number;
  /**
   * Cases with at least one unflagged wrong mandatory field.
   *
   * It saturates. With twenty mandatory fields a case and accuracy in the
   * eighties, almost every case has one, so it separates a good extractor from a
   * very good one poorly. It is kept because it is the honest whole-deal number.
   */
  readonly silentErrorRate: number;
  /**
   * The same, restricted to the fields that reach an invoice. This is the
   * number to steer by once the gate passes.
   */
  readonly silentCriticalRate: number;
  /** Invented values on mandatory fields. */
  readonly confidentNonsense: number;
  /**
   * Invented values on every scored field, conditional ones included. A
   * fabricated demurrage rate or FX rate costs money too, and the mandatory-only
   * count would not show it.
   */
  readonly confidentNonsenseAll: number;
  readonly gateViolations: number;
  readonly gatePassed: boolean;
  readonly failures: number;
};

export function zeroCounts(): OutcomeCounts {
  return {
    correct: 0,
    correct_abstention: 0,
    unflagged_abstention: 0,
    wrong_abstention: 0,
    wrong_value: 0,
    confident_nonsense: 0,
  };
}

export function summarise(scores: readonly CaseScore[]): Summary {
  const counts = zeroCounts();
  let mandatoryFieldCount = 0;
  let expectedValueCount = 0;
  let expectedNullCount = 0;
  let confidentNonsenseAll = 0;

  for (const score of scores) {
    for (const field of score.fields) {
      if (field.outcome === 'confident_nonsense') confidentNonsenseAll += 1;
      if (!field.mandatory) continue;
      mandatoryFieldCount += 1;
      counts[field.outcome] += 1;
      if (field.expected === null) expectedNullCount += 1;
      else expectedValueCount += 1;
    }
  }

  const silentErrors = scores.filter((s) => s.silentError).length;
  const silentCritical = scores.filter((s) => s.silentCriticalError).length;
  const gateViolations = scores.filter((s) => s.gateViolation).length;

  return {
    caseCount: scores.length,
    mandatoryFieldCount,
    counts,
    accuracy: ratio(counts.correct, expectedValueCount),
    abstentionRate: ratio(counts.correct_abstention, expectedNullCount),
    overRefusalRate: ratio(counts.wrong_abstention, expectedValueCount),
    silentErrorRate: ratio(silentErrors, scores.length),
    silentCriticalRate: ratio(silentCritical, scores.length),
    confidentNonsense: counts.confident_nonsense,
    confidentNonsenseAll,
    gateViolations,
    gatePassed: gateViolations === 0,
    failures: scores.filter((s) => s.failure !== null).length,
  };
}

export function summariseByClass(
  scores: readonly CaseScore[],
): ReadonlyMap<string, Summary> {
  const byClass = new Map<string, CaseScore[]>();
  for (const score of scores) {
    const list = byClass.get(score.caseClass);
    if (list === undefined) byClass.set(score.caseClass, [score]);
    else list.push(score);
  }
  const out = new Map<string, Summary>();
  for (const name of [...byClass.keys()].sort()) {
    out.set(name, summarise(byClass.get(name) ?? []));
  }
  return out;
}

/** 0 when there is nothing to divide by, so an empty class reads as 0, not NaN. */
function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}
