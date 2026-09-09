/**
 * Evidence support checks.
 *
 * `evidence.ts` asks whether the quoted words are in the message. This asks a
 * harder question: do those words actually support *this* value?
 *
 * It exists because prompting failed. Phase 6 put four explicit instructions in
 * the system prompt, one per known failure, each naming the exact mistake. The
 * model kept making all four. Its prior toward supplying the obvious industry
 * default is stronger than an instruction, and on a model this size that is not
 * something a better sentence fixes.
 *
 * So the guard moves into code, where it is deterministic and testable. This is
 * the same principle as the rest of the system: the model reads, code decides.
 * Every rule here can only move a field toward refusal. None can invent a value,
 * and none fires unless the evidence positively fails to support the value.
 *
 * The cost is over-refusal, which the scorer counts and the report shows. That
 * is the direction we want to fail in.
 */
import { getField, type Deal } from '../domain/schema.js';
import type { ReferenceData } from '../domain/references.js';

export type SupportFailure = {
  readonly field: string;
  readonly rule: string;
  readonly quoted: string;
};

/** Hedges and ranges. A quantity qualified by one of these is not a firm figure. */
const HEDGED = /\b(about|approx\.?|approximately|circa|ca\.|around|roughly|some|order of)\b|~/i;
const CARGO_RANGE = /\b\d+\s*[-–/]\s*\d+\s+(cargo|cargoes|lots?|parcels?|shipments?)\b/i;

/** Units a quantity can be written in. Absence means the unit was not stated. */
const UNIT_TOKEN = /\b(mt|m\.t\.|metric\s+tonnes?|tonnes?|tons?|bbls?|barrels?|kb|cbm)\b/i;

/** Pricing statistics. Absence means the statistic was not stated. */
const STATISTIC_TOKEN = /\b(mean|average|avg|high|low|highest|lowest)\b/i;

/**
 * "Ultra Low Sulphur Diesel" contains the word "low", and a quotation name is
 * often quoted as evidence for the statistic. Removing the grade phrase first
 * stops a product name from vouching for a pricing basis nobody agreed. This is
 * narrow on purpose: it removes a known product grade, not every occurrence.
 */
const GRADE_NOISE = /\bultra\s+low\s+sulphur\b|\blow\s+sulphur\b/gi;

/**
 * Words that appear in most quotation names and so distinguish nothing. What is
 * left is what a message has to mention for a code to be the right one.
 */
const GENERIC_QUOTE_WORDS = new Set([
  'platts', 'argus', 'the', 'of', 'and', 'cif', 'fob', 'fas', 'cfr',
  'nwe', 'ara', 'med', 'italy', 'black', 'sea', 'ppm', 'max', 'iso',
  'quotation', 'quotations', 'assessment', 'index', 'mean', 's',
]);

/**
 * Only tokens containing a letter survive.
 *
 * A purely numeric token is worthless here and actively harmful: "10" from
 * "Platts CIF NWE ULSD 10 ppm" matched inside the date "14.10.2026" and vouched
 * for a quotation the message never mentions. Every series we hold keeps at
 * least one alphabetic token, which a test asserts.
 */
export function distinctiveQuoteTokens(quoteName: string): string[] {
  return quoteName
    .toLowerCase()
    .split(/[^a-z0-9.]+/)
    .filter(
      (token) => token.length > 1 && /[a-z]/.test(token) && !GENERIC_QUOTE_WORDS.has(token),
    );
}

function escapeForRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Whole-word match. Substring matching is what let a date vouch for a quotation. */
function mentions(text: string, token: string): boolean {
  return new RegExp(`(^|[^a-z0-9])${escapeForRegex(token)}([^a-z0-9]|$)`).test(text);
}

function haystack(evidence: string | null, source: string): string {
  // The evidence span first, falling back to the whole message. A model that
  // quotes a narrow span should not be punished for it, and a code that is
  // nowhere in the message is wrong regardless of what was quoted.
  return `${evidence ?? ''}\n${source}`.replace(/\s+/g, ' ');
}

export type SupportCheck = {
  readonly deal: Deal;
  readonly failures: readonly SupportFailure[];
};

export function checkEvidenceSupport(
  deal: Deal,
  source: string,
  data: ReferenceData,
): SupportCheck {
  const failures: SupportFailure[] = [];
  const copy = structuredClone(deal) as unknown as Record<string, unknown>;

  const drop = (field: string, rule: string, quoted: string): void => {
    failures.push({ field, rule, quoted: quoted.slice(0, 60) });
    const segments = field.split('.');
    let node = copy;
    for (const segment of segments.slice(0, -1)) node = node[segment] as Record<string, unknown>;
    node[segments[segments.length - 1] as string] = {
      value: null,
      evidence: null,
      status: 'ambiguous',
    };
  };

  // --- a hedged or ranged quantity is not a firm quantity ------------------
  const quantity = getField(deal, 'quantity.value');
  if (quantity !== null && quantity.value !== null) {
    const quoted = quantity.evidence ?? '';
    if (HEDGED.test(quoted) || CARGO_RANGE.test(quoted)) {
      drop('quantity.value', 'quantity is hedged or ranged', quoted);
    }
  }

  // --- a quantity with no unit beside it has no unit ------------------------
  const unit = getField(deal, 'quantity.unit');
  if (unit !== null && unit.value !== null) {
    const quoted = unit.evidence ?? '';
    if (!UNIT_TOKEN.test(quoted)) {
      drop('quantity.unit', 'no unit token in the evidence', quoted);
    }
  }

  // --- a statistic nobody wrote down ---------------------------------------
  const statistic = getField(deal, 'pricing.statistic');
  if (statistic !== null && statistic.value !== null) {
    const quoted = (statistic.evidence ?? '').replace(GRADE_NOISE, ' ');
    if (!STATISTIC_TOKEN.test(quoted)) {
      drop('pricing.statistic', 'no statistic word in the evidence', statistic.evidence ?? '');
    }
  }

  // --- the quotation the message names, not the nearest one we hold ---------
  const quote = getField(deal, 'pricing.quote_code');
  if (quote !== null && typeof quote.value === 'string') {
    const name = data.quotesByCode.get(quote.value)?.[0]?.name ?? '';
    const tokens = distinctiveQuoteTokens(name);
    const text = haystack(quote.evidence, source).toLowerCase();
    if (tokens.length > 0 && !tokens.some((token) => mentions(text, token))) {
      drop('pricing.quote_code', 'the message names no part of this quotation', name);
    }
  }

  return { deal: copy as unknown as Deal, failures };
}
