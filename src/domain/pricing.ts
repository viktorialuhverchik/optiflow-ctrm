/**
 * The price formula (B8).
 *
 *   <publication quotation> over <pricing period>, <statistic> +/- <differential>
 *
 * The model never evaluates this. It reports the four parts as written and this
 * module turns them into a number, in Decimal, recording every quotation and
 * every conversion factor that went into the result (B6).
 */
import Decimal from 'decimal.js';
import type { IsoDate } from './brands.js';
import { addDays, makeRange, type DateRange } from './dates.js';
import { fail, ok, type Result, assertNever } from './result.js';
import {
  quotesInWindow,
  type PriceUnit,
  type ProductRow,
  type QuoteRow,
  type ReferenceData,
} from './references.js';
import { convertPrice } from './units.js';

export const STATISTICS = ['mean', 'high', 'low', 'mean_of_high'] as const;
export type Statistic = (typeof STATISTICS)[number];

/**
 * A pricing period, either relative to the Bill of Lading date or an explicit
 * calendar window. Offsets are inclusive on both ends: `BL+0..BL+3` is four
 * calendar days starting on the B/L date itself.
 */
export type PricingPeriod =
  | { readonly kind: 'bl_relative'; readonly fromOffset: number; readonly toOffset: number }
  | { readonly kind: 'explicit'; readonly from: IsoDate; readonly to: IsoDate };

/**
 * Parse the B/L-relative forms traders write.
 *
 *   "B/L +0/+3"   -> 0..3
 *   "B/L -1/+3"   -> -1..3
 *   "BL+0..BL+3"  -> 0..3
 *   "B/L + 3"     -> 1..3   the primer defines this as "the three days after"
 *                           the B/L date, so it excludes the B/L date itself.
 *                           This is the one form where the two readings differ
 *                           and the wrong one shifts every quotation by a day.
 *   "5 days after B/L" -> 1..5
 */
export function parseBlRelativePeriod(text: string): Result<PricingPeriod> {
  const s = text.trim().toLowerCase().replace(/\s+/g, ' ');

  const twoSided = /^b\/?l\s*([+-]\s*\d+)\s*(?:\/|\.\.|to)\s*(?:b\/?l\s*)?([+-]\s*\d+)$/.exec(s);
  if (twoSided !== null) {
    const from = Number((twoSided[1] ?? '').replace(/\s/g, ''));
    const to = Number((twoSided[2] ?? '').replace(/\s/g, ''));
    if (from > to) {
      return fail('BAD_PERIOD', `pricing period runs backwards: "${text}"`, { text });
    }
    return ok({ kind: 'bl_relative', fromOffset: from, toOffset: to });
  }

  const oneSided = /^b\/?l\s*\+\s*(\d+)$/.exec(s);
  if (oneSided !== null) {
    const n = Number(oneSided[1]);
    if (n < 1) return fail('BAD_PERIOD', `"${text}" names no days`, { text });
    return ok({ kind: 'bl_relative', fromOffset: 1, toOffset: n });
  }

  const nDaysAfter = /^(\d+)\s*(?:calendar\s*)?days?\s*(?:after|from|following)\s*b\/?l$/.exec(s);
  if (nDaysAfter !== null) {
    const n = Number(nDaysAfter[1]);
    if (n < 1) return fail('BAD_PERIOD', `"${text}" names no days`, { text });
    return ok({ kind: 'bl_relative', fromOffset: 1, toOffset: n });
  }

  const onBl = /^(?:on\s+)?b\/?l(?:\s*date)?$/.exec(s);
  if (onBl !== null) {
    return ok({ kind: 'bl_relative', fromOffset: 0, toOffset: 0 });
  }

  return fail('BAD_PERIOD', `unrecognised pricing period: "${text}"`, { text });
}

/** Turn a period into calendar dates. A B/L-relative period needs a B/L date. */
export function resolvePricingPeriod(
  period: PricingPeriod,
  blDate: IsoDate | null,
): Result<DateRange> {
  switch (period.kind) {
    case 'explicit':
      return makeRange(period.from, period.to);
    case 'bl_relative': {
      if (blDate === null) {
        // Not an error we can paper over: no B/L date means no pricing window,
        // and inventing one would be exactly the failure this system exists to
        // prevent (B1).
        return fail('BAD_PERIOD', 'pricing period is B/L-relative but no B/L date is known', {
          fromOffset: period.fromOffset,
          toOffset: period.toOffset,
        });
      }
      return makeRange(addDays(blDate, period.fromOffset), addDays(blDate, period.toOffset));
    }
    default:
      return assertNever(period, 'unknown pricing period kind');
  }
}

function statisticValue(quote: QuoteRow, statistic: Statistic): Decimal {
  switch (statistic) {
    case 'mean':
      return quote.mean;
    case 'high':
      return quote.high;
    case 'low':
      return quote.low;
    case 'mean_of_high':
      // The per-day value is the high; "mean of high" is the average of those
      // highs across the window, taken by the caller below.
      return quote.high;
    default:
      return assertNever(statistic, 'unknown statistic');
  }
}

export type PriceFormula = {
  readonly quoteCode: string;
  readonly statistic: Statistic;
  readonly period: PricingPeriod;
  /** Signed. Negative is a discount. Null means "not stated" and blocks pricing. */
  readonly differential: Decimal | null;
  readonly differentialUnit: PriceUnit | null;
};

export type PriceEvaluation = {
  /** Quotation average over the window, before the differential. */
  readonly quoteAverage: Decimal;
  /** Quotation average plus differential, in `unit`. */
  readonly unitPrice: Decimal;
  readonly unit: PriceUnit;
  readonly window: DateRange;
  readonly quotesUsed: readonly QuoteRow[];
  /** Calendar days in the window that had no published quotation. Weekends are normal. */
  readonly nonPublicationDays: number;
  /** True when the window runs past the end of the quotations we hold. */
  readonly outsideCoverage: boolean;
  /** Set when the differential had to be converted into the quotation's unit. */
  readonly differentialFactorBblPerMt: Decimal | null;
};

/**
 * Evaluate the formula.
 *
 * `product` is required only when the differential is quoted in a different
 * unit from the quotation, which is the mixed-unit case the primer warns about.
 */
export function evaluatePriceFormula(
  data: ReferenceData,
  formula: PriceFormula,
  blDate: IsoDate | null,
  product: ProductRow | null,
): Result<PriceEvaluation> {
  if (formula.differential === null || formula.differentialUnit === null) {
    return fail('BAD_PERIOD', 'differential is not stated, so the deal cannot be priced', {
      quoteCode: formula.quoteCode,
    });
  }

  const window = resolvePricingPeriod(formula.period, blDate);
  if (!window.ok) return window;

  const found = quotesInWindow(data, formula.quoteCode, window.value);
  if (!found.ok) return found;

  const quotes = found.value.quotes;
  const first = quotes[0];
  if (first === undefined) {
    return fail('QUOTE_WINDOW_EMPTY', `no quotations for ${formula.quoteCode} in window`, {
      code: formula.quoteCode,
    });
  }
  const quoteUnit = first.unit;
  for (const quote of quotes) {
    if (quote.unit !== quoteUnit) {
      return fail('CURRENCY_MISMATCH', `quotation ${formula.quoteCode} changes unit inside window`, {
        code: formula.quoteCode,
        date: quote.date,
      });
    }
  }

  const sum = quotes.reduce(
    (acc, quote) => acc.plus(statisticValue(quote, formula.statistic)),
    new Decimal(0),
  );
  const quoteAverage = sum.div(quotes.length);

  let differential = formula.differential;
  let differentialFactor: Decimal | null = null;
  if (formula.differentialUnit !== quoteUnit) {
    if (product === null) {
      return fail(
        'UNIT_UNCONVERTIBLE',
        `differential is ${formula.differentialUnit} but the quotation is ${quoteUnit}, and no product is resolved to convert with`,
        { differentialUnit: formula.differentialUnit, quoteUnit },
      );
    }
    const converted = convertPrice(differential, formula.differentialUnit, quoteUnit, product);
    if (!converted.ok) return converted;
    differential = converted.value.value;
    differentialFactor = converted.value.factorBblPerMt;
  }

  return ok({
    quoteAverage,
    unitPrice: quoteAverage.plus(differential),
    unit: quoteUnit,
    window: window.value,
    quotesUsed: quotes,
    nonPublicationDays: found.value.requestedDays - quotes.length,
    outsideCoverage: found.value.outsideCoverage,
    differentialFactorBblPerMt: differentialFactor,
  });
}
