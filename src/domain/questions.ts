/**
 * Questions are structured output too (B7).
 *
 * A `null` mandatory field without a question is not an abstention, it is a
 * silent gap, and the scorer grades it lower than a null that came with a
 * question. The text has to name the field and be answerable by a trader in one
 * line, because that is the whole point: a bad invoice is expensive, a one-line
 * reply is not.
 *
 * Question wording is a fixed template per field rather than model output. That
 * keeps the questions deterministic (D5) and stops a weak model from turning a
 * missing differential into a vague "please clarify the pricing".
 */
import { MANDATORY_FIELDS, getField, type Deal, type MandatoryField } from './schema.js';

export const QUESTION_REASONS = ['absent', 'ambiguous', 'unresolvable'] as const;
export type QuestionReason = (typeof QUESTION_REASONS)[number];

export type Question = {
  readonly field: string;
  readonly reason: QuestionReason;
  readonly question: string;
};

/** What to ask when the recap simply does not say. */
const ABSENT: Record<MandatoryField, string> = {
  'recap_date': 'What date was this recap agreed?',
  'buyer': 'Who is the buyer, as the legal entity name?',
  'seller': 'Who is the seller, as the legal entity name?',
  'product.as_written': 'What is the product?',
  'product.product_code': 'Which product in our reference list does this match?',
  'quantity.value': 'What is the quantity?',
  'quantity.unit': 'Is the quantity in MT or BBL?',
  'quantity.tolerance_pct': 'What is the quantity tolerance, in percent?',
  'quantity.tolerance_option': 'Whose option is the quantity tolerance, seller or buyer?',
  'delivery_term.incoterm':
    'Which Incoterm applies, one of EXW, FAS, FOB, CFR, CIF, DAP or DDP? The recap does not state one.',
  'delivery_term.place': 'What is the named port or place for the delivery term?',
  'delivery_window.from': 'What is the first day of the laycan?',
  'delivery_window.to': 'What is the last day of the laycan?',
  'pricing.quote_code': 'Which published quotation prices this deal?',
  'pricing.statistic': 'Which statistic applies, mean, high, low or mean of high?',
  'pricing.period': 'What is the pricing period, for example B/L +0/+3 or an explicit date range?',
  'pricing.differential.value':
    'What is the differential? Signed, negative for a discount. The recap does not state one.',
  'pricing.differential.unit': 'Is the differential per MT or per BBL?',
  'currency': 'What is the deal currency, as an ISO code?',
  'payment_terms.as_written': 'What are the payment terms?',
};

/** What to ask when the recap says something, but it could mean more than one thing. */
const AMBIGUOUS: Partial<Record<MandatoryField, string>> = {
  'recap_date':
    'The thread contains more than one date. Which one is the date this recap was agreed?',
  'delivery_term.incoterm':
    'The delivery term is written as trader shorthand rather than an Incoterm. Which Incoterm applies?',
  'quantity.value':
    'The quantity is stated as a range or an approximation. What is the firm figure to contract on?',
  'delivery_window.from': 'The laycan is not stated as firm dates. What is the first day?',
  'delivery_window.to': 'The laycan is not stated as firm dates. What is the last day?',
  'pricing.period': 'The pricing period is referred to but not stated. What is it, exactly?',
};

export type Unresolvable = {
  readonly field: string;
  /** Safe to show a trader. Never contains full recap text (code-style §12). */
  readonly detail: string;
};

/**
 * Build the question list for a deal.
 *
 * Order follows MANDATORY_FIELDS so two runs on the same deal produce a
 * byte-identical list. `unresolvable` carries codes the model produced that do
 * not exist in the reference data, which is a different problem from a value
 * being absent and deserves its own question.
 */
export function generateQuestions(deal: Deal, unresolvable: readonly Unresolvable[] = []): Question[] {
  const questions: Question[] = [];
  const unresolvableByField = new Map(unresolvable.map((u) => [u.field, u]));

  for (const path of MANDATORY_FIELDS) {
    const unresolved = unresolvableByField.get(path);
    if (unresolved !== undefined) {
      questions.push({
        field: path,
        reason: 'unresolvable',
        question: `${ABSENT[path]} ${unresolved.detail}`,
      });
      continue;
    }

    const entry = getField(deal, path);
    if (entry === null) continue;

    if (entry.status === 'ambiguous') {
      questions.push({
        field: path,
        reason: 'ambiguous',
        question: AMBIGUOUS[path] ?? ABSENT[path],
      });
      continue;
    }

    if (entry.value === null) {
      questions.push({ field: path, reason: 'absent', question: ABSENT[path] });
    }
  }

  // Conditional-turned-mandatory: FX is required once the deal is not in USD.
  const currency = getField(deal, 'currency');
  const fxRate = getField(deal, 'fx.rate');
  const fxBasis = getField(deal, 'fx.basis');
  if (
    typeof currency?.value === 'string' &&
    currency.value !== 'USD' &&
    fxRate?.value === null &&
    fxBasis?.value === null
  ) {
    questions.push({
      field: 'fx.rate',
      reason: 'absent',
      question: `The deal is in ${currency.value}, so a USD conversion is needed. What FX rate applies, or which published rate on which date?`,
    });
  }

  return questions;
}

/** True when the deal has every mandatory field and nothing was flagged. */
export function isComplete(questions: readonly Question[]): boolean {
  return questions.length === 0;
}
