import { describe, expect, it } from 'vitest';
import { isoDate } from './brands.js';
import {
  addDays,
  compareDates,
  daysBetween,
  eachDay,
  makeRange,
  parseHalfMonth,
  parseLaycan,
  parseWrittenDate,
} from './dates.js';
import { expect as unwrap } from './result.js';

describe('date arithmetic', () => {
  it('crosses month and year boundaries', () => {
    expect(addDays(isoDate('2026-08-31'), 1)).toBe('2026-09-01');
    expect(addDays(isoDate('2026-12-31'), 1)).toBe('2027-01-01');
    expect(addDays(isoDate('2026-03-01'), -1)).toBe('2026-02-28');
  });

  it('is stable regardless of the machine timezone', () => {
    // The module works in epoch days and never constructs a local Date, so a
    // date near midnight does not shift.
    expect(addDays(isoDate('2026-01-01'), 0)).toBe('2026-01-01');
    expect(daysBetween(isoDate('2026-09-04'), isoDate('2026-09-07'))).toBe(3);
  });

  it('enumerates a window inclusively at both ends', () => {
    const days = eachDay({ from: isoDate('2026-09-04'), to: isoDate('2026-09-07') });
    expect(days).toEqual(['2026-09-04', '2026-09-05', '2026-09-06', '2026-09-07']);
  });

  it('sorts earliest first', () => {
    expect(compareDates(isoDate('2026-01-01'), isoDate('2026-01-02'))).toBeLessThan(0);
  });

  it('refuses a range that ends before it starts', () => {
    const result = makeRange(isoDate('2026-09-07'), isoDate('2026-09-04'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('BAD_DATE_RANGE');
  });
});

describe('parseWrittenDate', () => {
  it('reads the forms that appear in the supplied recaps', () => {
    expect(unwrap(parseWrittenDate('2026-08-11'), 'iso')).toBe('2026-08-11');
    expect(unwrap(parseWrittenDate('11.08.2026'), 'european')).toBe('2026-08-11');
    expect(unwrap(parseWrittenDate('19.08.2026'), 'european')).toBe('2026-08-19');
    expect(unwrap(parseWrittenDate('11 August 2026'), 'long')).toBe('2026-08-11');
    expect(unwrap(parseWrittenDate('August 11, 2026'), 'us long')).toBe('2026-08-11');
    expect(unwrap(parseWrittenDate('11 Aug 2026'), 'abbreviated')).toBe('2026-08-11');
  });

  it('reads all-numeric dates day first', () => {
    // 03.04.2026 is 3 April, not 4 March. Documented in the module: this is a
    // convention, and a genuinely ambiguous value has to be flagged upstream.
    expect(unwrap(parseWrittenDate('03.04.2026'), 'day first')).toBe('2026-04-03');
  });

  it('rejects rather than guesses', () => {
    expect(parseWrittenDate('next Tuesday').ok).toBe(false);
    expect(parseWrittenDate('11.13.2026').ok).toBe(false);
  });
});

describe('parseLaycan', () => {
  it('reads a same-month laycan with an explicit year', () => {
    expect(unwrap(parseLaycan('02-06 September 2026', 2026), 'recap_01')).toEqual({
      from: '2026-09-02',
      to: '2026-09-06',
    });
  });

  it('takes the year from thread context when the laycan omits it', () => {
    expect(unwrap(parseLaycan('12-16 September', 2026), 'recap_02 amendment')).toEqual({
      from: '2026-09-12',
      to: '2026-09-16',
    });
  });

  it('reads a laycan that crosses a month boundary', () => {
    expect(unwrap(parseLaycan('28 September - 2 October 2026', 2026), 'cross month')).toEqual({
      from: '2026-09-28',
      to: '2026-10-02',
    });
  });

  it('rolls the year over when the second month is earlier than the first', () => {
    expect(unwrap(parseLaycan('28 December - 3 January', 2026), 'cross year')).toEqual({
      from: '2026-12-28',
      to: '2027-01-03',
    });
  });

  it('rejects a laycan it does not recognise', () => {
    expect(parseLaycan('sometime in the autumn', 2026).ok).toBe(false);
    expect(parseLaycan('31-32 September 2026', 2026).ok).toBe(false);
  });
});

describe('parseHalfMonth', () => {
  it('applies the market convention and reports which one it used', () => {
    const second = unwrap(parseHalfMonth('second half of October', 2026), 'recap_03');
    expect(second.range).toEqual({ from: '2026-10-16', to: '2026-10-31' });
    expect(second.convention).toBe('second_half_16_to_eom');

    const first = unwrap(parseHalfMonth('first half of November 2026', 2026), 'h1');
    expect(first.range).toEqual({ from: '2026-11-01', to: '2026-11-15' });
    expect(first.convention).toBe('first_half_1_to_15');
  });

  it('reads the abbreviated forms', () => {
    expect(unwrap(parseHalfMonth('H2 Oct 2026', 2026), 'h2').range).toEqual({
      from: '2026-10-16',
      to: '2026-10-31',
    });
  });

  it('ends a second half on the real last day of a short month', () => {
    expect(unwrap(parseHalfMonth('second half of February 2026', 2026), 'feb').range.to).toBe(
      '2026-02-28',
    );
  });

  it('is not a general date parser', () => {
    expect(parseHalfMonth('02-06 September 2026', 2026).ok).toBe(false);
  });
});
