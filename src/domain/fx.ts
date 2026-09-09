/**
 * Currency conversion.
 *
 * Everything is ultimately computed in USD. A recap in another currency either
 * names a rate or names a published basis, and there is exactly one hard-coded
 * rate in this system: the USD/AED peg, which the domain primer states.
 * Everything else must come from the recap. An unstated rate is a question,
 * never an assumption (B1).
 *
 * **Direction is the trap here.** "USD/AED 3.6725" and "EUR/USD 1.0920" both
 * look like a rate and mean opposite things. This module never accepts a bare
 * number: it takes the pair as written and applies the market convention that
 * `BASE/QUOTE value` means `value` units of QUOTE per one unit of BASE. A rate
 * whose direction cannot be established is a failure, not a coin flip.
 */
import Decimal from 'decimal.js';
import { fail, ok, type Result } from './result.js';

/** From data/domain_primer.md: "USD/AED is pegged at 3.6725". */
export const AED_PER_USD = new Decimal('3.6725');

export type FxQuote = {
  readonly currency: string;
  /** How many USD one unit of `currency` is worth. */
  readonly usdPerUnit: Decimal;
  readonly source: 'usd' | 'peg' | 'stated';
  /** The rate as written, kept for the audit trail (B6). */
  readonly asWritten: string | null;
};

export type FxPair = {
  readonly base: string;
  readonly quote: string;
  readonly value: Decimal;
};

/** Slash notation: "USD/AED 3.6725", "EUR/USD at 1.0920". */
const PAIR_SLASH = /\b([A-Z]{3})\s*[/]\s*([A-Z]{3})\b[^0-9-]*(-?\d+(?:\.\d+)?)/;

/** Prose notation: "a fixed agreed rate of 1.0852 USD per EUR". */
const PAIR_PROSE = /(\d+(?:\.\d+)?)\s*([A-Z]{3})\s*(?:PER|\/)\s*(?:1\s*)?([A-Z]{3})\b/;

/** Read a directional pair from either notation. */
export function parseFxPair(text: string): Result<FxPair> {
  const upper = text.toUpperCase();

  const prose = PAIR_PROSE.exec(upper);
  if (prose !== null) {
    // "1.0852 USD per EUR" means one EUR costs 1.0852 USD, so EUR is the base.
    const [, raw, quote, base] = prose;
    if (base !== undefined && quote !== undefined && raw !== undefined) {
      const value = new Decimal(raw);
      if (value.lte(0)) {
        return fail('CURRENCY_MISMATCH', `rate must be positive: "${text}"`, { text });
      }
      return ok({ base, quote, value });
    }
  }

  const match = PAIR_SLASH.exec(upper);
  if (match === null) {
    return fail('CURRENCY_MISMATCH', `no currency pair and rate found in "${text}"`, { text });
  }
  const [, base, quote, raw] = match;
  if (base === undefined || quote === undefined || raw === undefined) {
    return fail('CURRENCY_MISMATCH', `incomplete currency pair in "${text}"`, { text });
  }
  const value = new Decimal(raw);
  if (value.lte(0)) {
    return fail('CURRENCY_MISMATCH', `rate must be positive: "${text}"`, { text });
  }
  return ok({ base, quote, value });
}

/** Turn a directional pair into "USD per one unit of `currency`". */
export function usdPerUnitFromPair(pair: FxPair, currency: string): Result<Decimal> {
  // BASE/QUOTE value means: one BASE costs `value` QUOTE.
  if (pair.base === 'USD' && pair.quote === currency) return ok(new Decimal(1).div(pair.value));
  if (pair.base === currency && pair.quote === 'USD') return ok(pair.value);
  return fail(
    'CURRENCY_MISMATCH',
    `${pair.base}/${pair.quote} does not convert ${currency} to USD`,
    { base: pair.base, quote: pair.quote, currency },
  );
}

/**
 * Establish the rate for a deal currency.
 *
 * `statedBasis` is the recap's own words, for example "USD/AED 3.6725" or
 * "ECB EUR/USD fixing on B/L date". A basis that names no number resolves to a
 * failure here, because a published fixing has to be looked up rather than
 * guessed, and this module holds no market data.
 */
export function resolveFx(currency: string, statedBasis: string | null): Result<FxQuote> {
  if (currency === 'USD') {
    return ok({ currency, usdPerUnit: new Decimal(1), source: 'usd', asWritten: null });
  }

  if (statedBasis !== null) {
    const pair = parseFxPair(statedBasis);
    if (pair.ok) {
      const rate = usdPerUnitFromPair(pair.value, currency);
      if (!rate.ok) return rate;
      return ok({ currency, usdPerUnit: rate.value, source: 'stated', asWritten: statedBasis });
    }
  }

  if (currency === 'AED') {
    return ok({
      currency,
      usdPerUnit: new Decimal(1).div(AED_PER_USD),
      source: 'peg',
      asWritten: 'USD/AED pegged at 3.6725',
    });
  }

  return fail(
    'CURRENCY_MISMATCH',
    `no FX rate available for ${currency}; the recap must state one`,
    { currency, statedBasis },
  );
}

export function convertToUsd(amount: Decimal, fx: FxQuote): Decimal {
  return amount.mul(fx.usdPerUnit);
}
