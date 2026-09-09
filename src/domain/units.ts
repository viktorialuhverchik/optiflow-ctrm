/**
 * Unit conversion (B4).
 *
 * Quantity and price convert in *opposite* directions across the same factor,
 * and getting that backwards is a silent order-of-magnitude error on an
 * invoice. It is spelled out here once and tested both ways:
 *
 *   1 MT of gasoil       = 7.45 bbl          quantity: MT -> BBL multiplies
 *   USD 1/bbl of gasoil  = USD 7.45/MT       price:    /BBL -> /MT multiplies
 *   USD 1/MT of gasoil   = USD 0.134.../bbl  price:    /MT -> /BBL divides
 *
 * Every conversion returns the factor it used so it can be recorded on the deal
 * object and re-checked by a human reading an invoice (B6).
 */
import Decimal from 'decimal.js';
import type { ProductRow, PriceUnit, QuantityUnit } from './references.js';
import { ok, type Result } from './result.js';

export type Conversion = {
  readonly value: Decimal;
  readonly unit: QuantityUnit | PriceUnit;
  /** null when no conversion was needed. */
  readonly factorBblPerMt: Decimal | null;
  readonly productCode: string | null;
};

export function convertQuantity(
  value: Decimal,
  from: QuantityUnit,
  to: QuantityUnit,
  product: ProductRow,
): Result<Conversion> {
  if (from === to) {
    return ok({ value, unit: to, factorBblPerMt: null, productCode: null });
  }
  const factor = product.bblPerMt;
  const converted = from === 'MT' ? value.mul(factor) : value.div(factor);
  return ok({ value: converted, unit: to, factorBblPerMt: factor, productCode: product.code });
}

export function convertPrice(
  value: Decimal,
  from: PriceUnit,
  to: PriceUnit,
  product: ProductRow,
): Result<Conversion> {
  if (from === to) {
    return ok({ value, unit: to, factorBblPerMt: null, productCode: null });
  }
  const factor = product.bblPerMt;
  // Price is per unit, so it scales inversely to the quantity conversion.
  const converted = from === 'USD/BBL' ? value.mul(factor) : value.div(factor);
  return ok({ value: converted, unit: to, factorBblPerMt: factor, productCode: product.code });
}

/** The price unit that corresponds to a quantity unit, e.g. MT -> USD/MT. */
export function priceUnitFor(unit: QuantityUnit): PriceUnit {
  return unit === 'MT' ? 'USD/MT' : 'USD/BBL';
}

/** The quantity unit that corresponds to a price unit, e.g. USD/BBL -> BBL. */
export function quantityUnitFor(unit: PriceUnit): QuantityUnit {
  return unit === 'USD/MT' ? 'MT' : 'BBL';
}
