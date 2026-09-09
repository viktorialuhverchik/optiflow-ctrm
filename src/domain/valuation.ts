/**
 * Provisional deal value.
 *
 * A provisional invoice is raised before the pricing period closes, using an
 * estimate. The estimate is an assumption, and an assumption that is not written
 * down on the invoice is indistinguishable from an invented number, so every
 * result here carries the assumptions that produced it.
 *
 * All of it is Decimal, and none of it is ever done by a model (code-style §1).
 */
import Decimal from 'decimal.js';
import type { IsoDate } from './brands.js';
import type { DateRange } from './dates.js';
import { convertToUsd, type FxQuote } from './fx.js';
import { fail, ok, type Result } from './result.js';
import type { PriceUnit, ProductRow, QuantityUnit, QuoteRow } from './references.js';
import { convertQuantity, quantityUnitFor } from './units.js';

export type ValuationAssumption = {
  readonly kind: 'bl_date_estimated' | 'window_incomplete' | 'unit_converted' | 'fx_source';
  readonly detail: string;
};

export type ProvisionalValue = {
  /** Quotation average over the window, in the quotation's own unit. */
  readonly quoteAverage: Decimal;
  readonly unitPrice: Decimal;
  readonly unitPriceUnit: PriceUnit;
  /** Quantity restated into the unit the price is quoted in, if they differed. */
  readonly pricedQuantity: Decimal;
  readonly pricedQuantityUnit: QuantityUnit;
  readonly valueInDealCurrency: Decimal;
  readonly dealCurrency: string;
  readonly valueUsd: Decimal;
  readonly window: DateRange;
  readonly quotesUsed: readonly QuoteRow[];
  readonly assumptions: readonly ValuationAssumption[];
};

export type ValuationInput = {
  readonly quoteAverage: Decimal;
  readonly quoteUnit: PriceUnit;
  readonly differential: Decimal;
  readonly differentialUnit: PriceUnit;
  readonly quantity: Decimal;
  readonly quantityUnit: QuantityUnit;
  readonly product: ProductRow | null;
  readonly fx: FxQuote;
  readonly window: DateRange;
  readonly quotesUsed: readonly QuoteRow[];
  readonly blDateEstimatedFrom: IsoDate | null;
  readonly nonPublicationDays: number;
  /**
   * How many days inside the window actually published. Passed explicitly
   * rather than taken from `quotesUsed.length`, because a caller that has the
   * average but not the individual rows would otherwise report that nothing
   * published at all.
   */
  readonly publishedDays: number;
};

export function computeProvisionalValue(input: ValuationInput): Result<ProvisionalValue> {
  const assumptions: ValuationAssumption[] = [];

  if (input.blDateEstimatedFrom !== null) {
    assumptions.push({
      kind: 'bl_date_estimated',
      detail: `No bill of lading has been issued. The pricing window is anchored on ${input.blDateEstimatedFrom}, the first day of the laycan. The final invoice will move if the vessel loads on another day.`,
    });
  }

  // --- differential into the quotation's unit ------------------------------
  let differential = input.differential;
  if (input.differentialUnit !== input.quoteUnit) {
    if (input.product === null) {
      return fail(
        'UNIT_UNCONVERTIBLE',
        `the differential is ${input.differentialUnit} and the quotation is ${input.quoteUnit}, with no product resolved to convert with`,
      );
    }
    const factor = input.product.bblPerMt;
    differential =
      input.differentialUnit === 'USD/BBL' ? differential.mul(factor) : differential.div(factor);
    assumptions.push({
      kind: 'unit_converted',
      detail: `The differential was quoted in ${input.differentialUnit} against a ${input.quoteUnit} assessment, converted at ${factor.toString()} bbl per tonne from products.csv.`,
    });
  }

  const unitPrice = input.quoteAverage.plus(differential);

  // --- quantity into the unit the price is quoted in -----------------------
  const pricedUnit = quantityUnitFor(input.quoteUnit);
  let pricedQuantity = input.quantity;
  if (input.quantityUnit !== pricedUnit) {
    if (input.product === null) {
      return fail(
        'UNIT_UNCONVERTIBLE',
        `the quantity is in ${input.quantityUnit} and the price is per ${pricedUnit}, with no product resolved to convert with`,
      );
    }
    const converted = convertQuantity(input.quantity, input.quantityUnit, pricedUnit, input.product);
    if (!converted.ok) return converted;
    pricedQuantity = converted.value.value;
    assumptions.push({
      kind: 'unit_converted',
      detail: `Quantity was agreed in ${input.quantityUnit} and the price is per ${pricedUnit}, converted at ${input.product.bblPerMt.toString()} bbl per tonne from products.csv.`,
    });
  }

  if (input.nonPublicationDays > 0) {
    assumptions.push({
      kind: 'window_incomplete',
      detail: `${input.publishedDays} quotation(s) published inside a ${input.nonPublicationDays + input.publishedDays}-day window. Weekends and holidays do not publish, so the average is over the days that did.`,
    });
  }

  assumptions.push({
    kind: 'fx_source',
    detail:
      input.fx.source === 'usd'
        ? 'The deal is in USD, so no conversion applies.'
        : `USD conversion at ${input.fx.usdPerUnit.toDecimalPlaces(6).toString()} USD per ${input.fx.currency}, from ${input.fx.asWritten ?? input.fx.source}.`,
  });

  // The quotation and the differential are both USD, so the gross is USD and
  // the deal-currency figure is the conversion back out of it.
  const valueUsd = unitPrice.mul(pricedQuantity);
  const valueInDealCurrency = input.fx.usdPerUnit.isZero()
    ? valueUsd
    : valueUsd.div(input.fx.usdPerUnit);

  return ok({
    quoteAverage: input.quoteAverage,
    unitPrice,
    unitPriceUnit: input.quoteUnit,
    pricedQuantity,
    pricedQuantityUnit: pricedUnit,
    valueInDealCurrency,
    dealCurrency: input.fx.currency,
    valueUsd: convertToUsd(valueInDealCurrency, input.fx),
    window: input.window,
    quotesUsed: input.quotesUsed,
    assumptions,
  });
}
