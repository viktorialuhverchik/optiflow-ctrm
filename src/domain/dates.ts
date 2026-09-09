/**
 * Date handling. Pure, UTC-only, no wall-clock reads (code-style §10).
 *
 * Everything here works on `IsoDate` strings and integer day counts. The
 * `Date` object is used only as an epoch-day calculator inside this module and
 * never escapes it, which keeps local timezone out of the system entirely.
 */
import { daysInMonth, isoDate, parseIsoDate, type IsoDate } from './brands.js';
import { fail, ok, type Result } from './result.js';

export type DateRange = { readonly from: IsoDate; readonly to: IsoDate };

const MS_PER_DAY = 86_400_000;

function toEpochDay(date: IsoDate): number {
  return Date.parse(`${date}T00:00:00Z`) / MS_PER_DAY;
}

function fromEpochDay(day: number): IsoDate {
  const iso = new Date(day * MS_PER_DAY).toISOString().slice(0, 10);
  return isoDate(iso);
}

export function addDays(date: IsoDate, days: number): IsoDate {
  return fromEpochDay(toEpochDay(date) + days);
}

/** Negative when `a` is earlier. Suitable for `Array.prototype.sort`. */
export function compareDates(a: IsoDate, b: IsoDate): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function daysBetween(from: IsoDate, to: IsoDate): number {
  return toEpochDay(to) - toEpochDay(from);
}

export function eachDay(range: DateRange): IsoDate[] {
  const span = daysBetween(range.from, range.to);
  if (span < 0) return [];
  const out: IsoDate[] = [];
  for (let i = 0; i <= span; i += 1) out.push(addDays(range.from, i));
  return out;
}

export function makeRange(from: IsoDate, to: IsoDate): Result<DateRange> {
  if (compareDates(from, to) > 0) {
    return fail('BAD_DATE_RANGE', `range ends before it starts: ${from}..${to}`, { from, to });
  }
  return ok({ from, to });
}

// --------------------------------------------------------------------------
// Parsing the date forms that actually appear in recaps
// --------------------------------------------------------------------------

const MONTHS: ReadonlyMap<string, number> = new Map([
  ['jan', 1], ['january', 1],
  ['feb', 2], ['february', 2],
  ['mar', 3], ['march', 3],
  ['apr', 4], ['april', 4],
  ['may', 5],
  ['jun', 6], ['june', 6],
  ['jul', 7], ['july', 7],
  ['aug', 8], ['august', 8],
  ['sep', 9], ['sept', 9], ['september', 9],
  ['oct', 10], ['october', 10],
  ['nov', 11], ['november', 11],
  ['dec', 12], ['december', 12],
]);

export function monthNumber(name: string): number | null {
  return MONTHS.get(name.trim().toLowerCase()) ?? null;
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

export function fromParts(year: number, month: number, day: number): Result<IsoDate> {
  if (month < 1 || month > 12) {
    return fail('BAD_DATE', `month out of range: ${month}`, { year, month, day });
  }
  if (day < 1 || day > daysInMonth(year, month)) {
    return fail('BAD_DATE', `day out of range for ${year}-${pad(month, 2)}: ${day}`, {
      year,
      month,
      day,
    });
  }
  return parseIsoDate(`${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`);
}

/**
 * A single date as written in a recap. Recognised forms:
 *   2026-08-11        ISO
 *   11.08.2026        European, day first. Ambiguity note below.
 *   11/08/2026        European, day first
 *   11 August 2026    long form
 *   August 11, 2026   US long form
 *
 * Day-first is assumed for the all-numeric forms. Every recap in this business
 * is written in that convention, and the alternative is guessing. Where the
 * value is genuinely ambiguous (`03.04.2026`) the parse still succeeds, so the
 * ambiguity has to be handled by the extractor marking the field `ambiguous`,
 * not silently here. See docs/rules-and-constraints.md B1.
 */
export function parseWrittenDate(text: string): Result<IsoDate> {
  const s = text.trim();

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (iso !== null) return fromParts(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const numeric = /^(\d{1,2})[./](\d{1,2})[./](\d{2}|\d{4})$/.exec(s);
  if (numeric !== null) {
    const year = expandYear(Number(numeric[3]));
    return fromParts(year, Number(numeric[2]), Number(numeric[1]));
  }

  const dayFirst = /^(\d{1,2})\s+([A-Za-z]+)\.?,?\s+(\d{4})$/.exec(s);
  if (dayFirst !== null) {
    const month = monthNumber(dayFirst[2] ?? '');
    if (month === null) return fail('BAD_DATE', `unknown month name: "${dayFirst[2]}"`, { text: s });
    return fromParts(Number(dayFirst[3]), month, Number(dayFirst[1]));
  }

  const monthFirst = /^([A-Za-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(s);
  if (monthFirst !== null) {
    const month = monthNumber(monthFirst[1] ?? '');
    if (month === null) return fail('BAD_DATE', `unknown month name: "${monthFirst[1]}"`, { text: s });
    return fromParts(Number(monthFirst[3]), month, Number(monthFirst[2]));
  }

  return fail('BAD_DATE', `unrecognised date: "${s}"`, { text: s });
}

function expandYear(year: number): number {
  // Two-digit years in recaps are always this century in practice.
  return year < 100 ? 2000 + year : year;
}

/**
 * A laycan as written. Recognised forms:
 *   02-06 September 2026
 *   12-16 September            year supplied by the caller from thread context
 *   1 - 5 Oct 2026
 *   28 September - 2 October 2026   (crosses a month boundary)
 *   2026-09-02..2026-09-06
 *
 * `contextYear` is required rather than defaulted, because inferring a year
 * from the system clock would make the extractor non-deterministic (D4).
 */
export function parseLaycan(text: string, contextYear: number): Result<DateRange> {
  const s = text.trim().replace(/\s+/g, ' ');

  const isoRange = /^(\d{4}-\d{2}-\d{2})\s*(?:\.\.|-|to)\s*(\d{4}-\d{2}-\d{2})$/.exec(s);
  if (isoRange !== null) {
    const from = parseIsoDate(isoRange[1] ?? '');
    const to = parseIsoDate(isoRange[2] ?? '');
    if (!from.ok) return from;
    if (!to.ok) return to;
    return makeRange(from.value, to.value);
  }

  // 28 September - 2 October 2026
  const twoMonths =
    /^(\d{1,2})\s+([A-Za-z]+)\.?\s*(?:-|–|to|\/)\s*(\d{1,2})\s+([A-Za-z]+)\.?(?:\s+(\d{4}))?$/.exec(s);
  if (twoMonths !== null) {
    const fromMonth = monthNumber(twoMonths[2] ?? '');
    const toMonth = monthNumber(twoMonths[4] ?? '');
    if (fromMonth === null || toMonth === null) {
      return fail('BAD_DATE_RANGE', `unknown month name in laycan: "${s}"`, { text: s });
    }
    const year = twoMonths[5] === undefined ? contextYear : Number(twoMonths[5]);
    // "28 December - 3 January" runs over the year end, so the second month
    // belongs to the following year.
    const toYear = toMonth < fromMonth ? year + 1 : year;
    const from = fromParts(year, fromMonth, Number(twoMonths[1]));
    const to = fromParts(toYear, toMonth, Number(twoMonths[3]));
    if (!from.ok) return from;
    if (!to.ok) return to;
    return makeRange(from.value, to.value);
  }

  // 02-06 September 2026  |  12-16 September
  const oneMonth = /^(\d{1,2})\s*(?:-|–|to|\/)\s*(\d{1,2})\s+([A-Za-z]+)\.?(?:\s+(\d{4}))?$/.exec(s);
  if (oneMonth !== null) {
    const month = monthNumber(oneMonth[3] ?? '');
    if (month === null) {
      return fail('BAD_DATE_RANGE', `unknown month name in laycan: "${s}"`, { text: s });
    }
    const year = oneMonth[4] === undefined ? contextYear : Number(oneMonth[4]);
    const from = fromParts(year, month, Number(oneMonth[1]));
    const to = fromParts(year, month, Number(oneMonth[2]));
    if (!from.ok) return from;
    if (!to.ok) return to;
    return makeRange(from.value, to.value);
  }

  return fail('BAD_DATE_RANGE', `unrecognised laycan: "${s}"`, { text: s });
}

/**
 * Half-month laycans: "first half of October", "H2 November", "2H Oct 2026".
 *
 * This is a market convention, not an inference: first half is the 1st to the
 * 15th, second half is the 16th to the last day of the month. It is resolved
 * here rather than by the model, and the convention used is returned so it can
 * be recorded on the deal object and audited (B4, B6).
 */
export type HalfMonth = {
  readonly range: DateRange;
  readonly convention: 'first_half_1_to_15' | 'second_half_16_to_eom';
};

export function parseHalfMonth(text: string, contextYear: number): Result<HalfMonth> {
  const s = text.trim().toLowerCase().replace(/\s+/g, ' ');
  const m =
    /^(?:(first|second|1st|2nd|h1|h2|1h|2h)\s+half\s+of\s+|(h1|h2|1h|2h)\s+)([a-z]+)\.?(?:\s+(\d{4}))?$/.exec(
      s,
    );
  if (m === null) return fail('BAD_DATE_RANGE', `not a half-month expression: "${text}"`, { text });

  const which = (m[1] ?? m[2] ?? '').replace(/\s/g, '');
  const month = monthNumber(m[3] ?? '');
  if (month === null) return fail('BAD_DATE_RANGE', `unknown month name: "${m[3]}"`, { text });
  const year = m[4] === undefined ? contextYear : Number(m[4]);

  const isSecond = which === 'second' || which === '2nd' || which === 'h2' || which === '2h';
  const from = fromParts(year, month, isSecond ? 16 : 1);
  const to = fromParts(year, month, isSecond ? daysInMonth(year, month) : 15);
  if (!from.ok) return from;
  if (!to.ok) return to;
  const range = makeRange(from.value, to.value);
  if (!range.ok) return range;

  return ok({
    range: range.value,
    convention: isSecond ? 'second_half_16_to_eom' : 'first_half_1_to_15',
  });
}
