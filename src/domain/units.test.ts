import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { productCode } from './brands.js';
import type { ProductRow } from './references.js';
import { expect as unwrap } from './result.js';
import { convertPrice, convertQuantity, priceUnitFor, quantityUnitFor } from './units.js';

const gasoil: ProductRow = {
  code: productCode('GO01'),
  name: 'Gasoil 0.1% S',
  typicalSpec: null,
  defaultUnit: 'MT',
  bblPerMt: new Decimal('7.45'),
  densityKgM3: new Decimal('845'),
};

describe('convertQuantity', () => {
  it('multiplies going from tonnes to barrels', () => {
    const result = unwrap(convertQuantity(new Decimal('30000'), 'MT', 'BBL', gasoil), 'mt to bbl');
    expect(result.value.toString()).toBe('223500');
    expect(result.factorBblPerMt?.toString()).toBe('7.45');
  });

  it('divides going from barrels to tonnes', () => {
    const result = unwrap(convertQuantity(new Decimal('223500'), 'BBL', 'MT', gasoil), 'bbl to mt');
    expect(result.value.toString()).toBe('30000');
  });

  it('does nothing and records no factor when the units already match', () => {
    const result = unwrap(convertQuantity(new Decimal('100'), 'MT', 'MT', gasoil), 'noop');
    expect(result.value.toString()).toBe('100');
    expect(result.factorBblPerMt).toBeNull();
  });
});

describe('convertPrice', () => {
  it('multiplies going from per-barrel to per-tonne', () => {
    const result = unwrap(convertPrice(new Decimal('1'), 'USD/BBL', 'USD/MT', gasoil), 'bbl to mt');
    expect(result.value.toString()).toBe('7.45');
  });

  it('divides going from per-tonne to per-barrel', () => {
    const result = unwrap(convertPrice(new Decimal('7.45'), 'USD/MT', 'USD/BBL', gasoil), 'mt to bbl');
    expect(result.value.toString()).toBe('1');
  });

  it('moves in the opposite direction to quantity across the same factor', () => {
    // This is the invariant that stops the classic order-of-magnitude invoice
    // bug: 1 MT priced at X/MT must cost the same as 7.45 bbl priced at X/bbl
    // converted, and the two conversions must not both multiply.
    const quantity = unwrap(convertQuantity(new Decimal('1'), 'MT', 'BBL', gasoil), 'q');
    const price = unwrap(convertPrice(new Decimal('745'), 'USD/MT', 'USD/BBL', gasoil), 'p');
    const total = quantity.value.mul(price.value);
    expect(total.toString()).toBe('745');
  });
});

describe('unit pairing', () => {
  it('maps a quantity unit to its price unit and back', () => {
    expect(priceUnitFor('MT')).toBe('USD/MT');
    expect(priceUnitFor('BBL')).toBe('USD/BBL');
    expect(quantityUnitFor('USD/MT')).toBe('MT');
    expect(quantityUnitFor('USD/BBL')).toBe('BBL');
  });
});
