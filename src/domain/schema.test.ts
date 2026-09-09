import { describe, expect, it } from 'vitest';
import {
  ALL_FIELDS,
  DealSchema,
  MANDATORY_FIELDS,
  MONEY_CRITICAL_FIELDS,
  emptyDeal,
  getField,
} from './schema.js';

describe('the deal schema', () => {
  it('accepts an all-null deal, so abstaining is always representable', () => {
    // If the schema could not express "nothing was stated", constrained
    // decoding would force the model to invent values (B1).
    expect(() => DealSchema.parse(emptyDeal())).not.toThrow();
  });

  it('rejects a value that is not in the field envelope shape', () => {
    const deal = emptyDeal() as unknown as Record<string, unknown>;
    deal['buyer'] = 'Helvig Energy AG';
    expect(DealSchema.safeParse(deal).success).toBe(false);
  });

  it('rejects a status outside the three we defined', () => {
    const deal = emptyDeal();
    const broken = { ...deal, buyer: { value: null, evidence: null, status: 'maybe' } };
    expect(DealSchema.safeParse(broken).success).toBe(false);
  });

  it('rejects a quantity written with thousands separators', () => {
    const deal = emptyDeal();
    const broken = {
      ...deal,
      quantity: {
        ...deal.quantity,
        value: { value: '30,000', evidence: '30,000 MT', status: 'stated' },
      },
    };
    expect(DealSchema.safeParse(broken).success).toBe(false);
  });

  it('rejects a non-Incoterm in the incoterm field', () => {
    const deal = emptyDeal();
    const broken = {
      ...deal,
      delivery_term: {
        ...deal.delivery_term,
        incoterm: { value: 'delivered', evidence: 'delivered Rotterdam', status: 'stated' },
      },
    };
    expect(DealSchema.safeParse(broken).success).toBe(false);
  });
});

describe('the field registries', () => {
  it('lists every mandatory field as a real path in the schema', () => {
    // Guards the contract between schema, question generator and scorer: a
    // mandatory field missing from ALL_FIELDS would never be scored.
    for (const path of MANDATORY_FIELDS) {
      expect(ALL_FIELDS).toContain(path);
    }
  });

  it('lists every money-critical field as a mandatory one', () => {
    for (const path of MONEY_CRITICAL_FIELDS) {
      expect(MANDATORY_FIELDS).toContain(path);
    }
  });

  it('has no duplicates and a stable order', () => {
    expect(new Set(MANDATORY_FIELDS).size).toBe(MANDATORY_FIELDS.length);
    expect(new Set(ALL_FIELDS).size).toBe(ALL_FIELDS.length);
    expect(MANDATORY_FIELDS[0]).toBe('recap_date');
  });

  it('covers the conditional fields too', () => {
    for (const path of ['fx.rate', 'quality_spec', 'inspection.inspector', 'demurrage.rate_per_day', 'law', 'vessel', 'notes']) {
      expect(ALL_FIELDS).toContain(path);
    }
  });
});

describe('getField', () => {
  it('reads a nested field by dotted path', () => {
    const deal = emptyDeal();
    expect(getField(deal, 'pricing.differential.value')).toEqual({
      value: null,
      evidence: null,
      status: 'absent',
    });
  });

  it('returns null for a path that is not a field envelope', () => {
    expect(getField(emptyDeal(), 'pricing')).toBeNull();
    expect(getField(emptyDeal(), 'nope.nope')).toBeNull();
  });
});
