/**
 * Branded identifiers (code-style §3).
 *
 * These are all strings. Passing a product code where a quote code belongs is a
 * silent, expensive bug, so the compiler is made to care. Values are constructed
 * only through the validating functions here — never by casting at a call site.
 */
import { fail, ok, type Result } from './result.js';

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

/** Calendar date, `YYYY-MM-DD`, no time, no zone. */
export type IsoDate = Brand<string, 'IsoDate'>;

/** A `quote_code` resolvable against data/price_quotes.csv. */
export type QuoteCode = Brand<string, 'QuoteCode'>;

/** A `product_code` resolvable against data/products.csv. */
export type ProductCode = Brand<string, 'ProductCode'>;

/** A decimal held as text so no value ever passes through a float. */
export type DecimalString = Brand<string, 'DecimalString'>;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DECIMAL = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;
const CODE = /^[A-Z0-9_]+$/;

export function isIsoDate(value: string): value is IsoDate {
  const match = ISO_DATE.exec(value);
  if (match === null) return false;
  const [, y, m, d] = match;
  // noUncheckedIndexedAccess: the regex guarantees these, the compiler does not.
  if (y === undefined || m === undefined || d === undefined) return false;
  const year = Number(y);
  const month = Number(m);
  const day = Number(d);
  if (month < 1 || month > 12) return false;
  return day >= 1 && day <= daysInMonth(year, month);
}

export function parseIsoDate(value: string): Result<IsoDate> {
  if (!isIsoDate(value)) {
    return fail('BAD_DATE', `not a calendar date in YYYY-MM-DD form: "${value}"`, { value });
  }
  return ok(value);
}

/** Throwing constructor. Only for literals we control, such as test fixtures. */
export function isoDate(value: string): IsoDate {
  if (!isIsoDate(value)) throw new Error(`invalid IsoDate literal: "${value}"`);
  return value;
}

export function daysInMonth(year: number, month: number): number {
  // month is 1-based. Day 0 of the next month is the last day of this one.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function isDecimalString(value: string): value is DecimalString {
  return DECIMAL.test(value);
}

export function parseDecimalString(value: string): Result<DecimalString> {
  if (!isDecimalString(value)) {
    return fail('BAD_DECIMAL', `not a plain decimal string: "${value}"`, { value });
  }
  return ok(value);
}

export function decimalString(value: string): DecimalString {
  if (!isDecimalString(value)) throw new Error(`invalid DecimalString literal: "${value}"`);
  return value;
}

export function quoteCode(value: string): QuoteCode {
  if (!CODE.test(value)) throw new Error(`invalid QuoteCode literal: "${value}"`);
  return value as QuoteCode;
}

export function productCode(value: string): ProductCode {
  if (!CODE.test(value)) throw new Error(`invalid ProductCode literal: "${value}"`);
  return value as ProductCode;
}
