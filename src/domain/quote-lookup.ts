/**
 * Quotation lookup: the whole of `get_price_quote`, with no model in it.
 *
 * The MCP tool is a thin wrapper over this. Pricing a cargo is arithmetic over
 * published data, and a language model has no business anywhere near it
 * (code-style §1).
 */
import Decimal from 'decimal.js';
import { parseIsoDate, type IsoDate } from './brands.js';
import { makeRange, type DateRange } from './dates.js';
import { parseBlRelativePeriod, resolvePricingPeriod, STATISTICS, type Statistic } from './pricing.js';
import { fail, ok, type Result } from './result.js';
import { quotesInWindow, type PriceUnit, type QuoteRow, type ReferenceData } from './references.js';

export type QuoteLookup = {
  readonly quoteCode: string;
  readonly quoteName: string;
  readonly statistic: Statistic;
  readonly window: DateRange;
  readonly value: Decimal;
  readonly unit: PriceUnit;
  readonly quotesUsed: readonly QuoteRow[];
  /** Calendar days in the window with no publication. Weekends are normal. */
  readonly nonPublicationDays: number;
  /** True when the window runs past the end of the data we hold. */
  readonly outsideCoverage: boolean;
};

export function isStatistic(value: string): value is Statistic {
  return (STATISTICS as readonly string[]).includes(value);
}

/**
 * Resolve the `date_or_period` argument.
 *
 * Three forms, and a B/L-relative one needs a B/L date. Refusing without it is
 * the whole point: silently anchoring on today would produce a priced window
 * nobody asked for (B1, D4).
 */
export function resolveWindow(
  dateOrPeriod: string,
  blDate: IsoDate | null,
): Result<DateRange> {
  const text = dateOrPeriod.trim();

  const range = /^(\d{4}-\d{2}-\d{2})\s*(?:\.\.|to)\s*(\d{4}-\d{2}-\d{2})$/.exec(text);
  if (range !== null) {
    const from = parseIsoDate(range[1] ?? '');
    const to = parseIsoDate(range[2] ?? '');
    if (!from.ok) return from;
    if (!to.ok) return to;
    return makeRange(from.value, to.value);
  }

  const single = parseIsoDate(text);
  if (single.ok) return makeRange(single.value, single.value);

  const relative = parseBlRelativePeriod(text);
  if (relative.ok) return resolvePricingPeriod(relative.value, blDate);

  return fail(
    'BAD_PERIOD',
    `"${dateOrPeriod}" is not a date, a date range like 2026-09-11..2026-09-15, or a B/L-relative period like "B/L +0/+3"`,
    { dateOrPeriod },
  );
}

export function lookupQuote(
  data: ReferenceData,
  quoteCode: string,
  dateOrPeriod: string,
  statistic: string,
  blDate: IsoDate | null = null,
): Result<QuoteLookup> {
  if (!isStatistic(statistic)) {
    return fail('BAD_PERIOD', `unknown statistic "${statistic}". Known: ${STATISTICS.join(', ')}`, {
      statistic,
    });
  }

  const window = resolveWindow(dateOrPeriod, blDate);
  if (!window.ok) return window;

  const found = quotesInWindow(data, quoteCode, window.value);
  if (!found.ok) return found;

  const quotes = found.value.quotes;
  const first = quotes[0];
  if (first === undefined) {
    return fail('QUOTE_WINDOW_EMPTY', `no quotations for ${quoteCode} in the window`, { quoteCode });
  }

  // mean_of_high averages the daily highs. mean averages the daily means.
  const column = (quote: QuoteRow): Decimal => {
    switch (statistic) {
      case 'mean':
        return quote.mean;
      case 'high':
      case 'mean_of_high':
        return quote.high;
      case 'low':
        return quote.low;
    }
  };

  const sum = quotes.reduce((acc, quote) => acc.plus(column(quote)), new Decimal(0));

  return ok({
    quoteCode,
    quoteName: first.name,
    statistic,
    window: window.value,
    value: sum.div(quotes.length),
    unit: first.unit,
    quotesUsed: quotes,
    nonPublicationDays: found.value.requestedDays - quotes.length,
    outsideCoverage: found.value.outsideCoverage,
  });
}
