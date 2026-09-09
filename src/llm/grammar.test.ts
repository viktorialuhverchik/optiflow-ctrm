import { describe, expect, it } from 'vitest';
import { loadReferenceData } from '../io/reference-files.js';
import { ALL_FIELDS } from '../domain/schema.js';
import { assertGrammarCoversSchema, buildDealGrammar, grammarFieldPaths } from './grammar.js';

const data = loadReferenceData('data');
const codes = { productCodes: data.productCodes, quoteCodes: data.quoteCodes };
const grammar = buildDealGrammar(codes);

describe('the deal grammar', () => {
  it('covers exactly the fields the schema defines', () => {
    expect(() => assertGrammarCoversSchema()).not.toThrow();
    expect(grammarFieldPaths().sort()).toEqual([...ALL_FIELDS].sort());
  });

  it('makes null a legal value for every field', () => {
    // The single most important property in the file. Without it, constrained
    // decoding forces the model to invent a differential (B1).
    const valueRules = grammar.split('\n').filter((line) => line.startsWith('v-'));
    expect(valueRules.length).toBeGreaterThan(0);
    for (const rule of valueRules) {
      expect(rule, rule).toContain('"null"');
    }
  });

  it('restricts quote and product codes to the reference data', () => {
    // An invented code stops being a failure mode rather than becoming a
    // validation error after the fact.
    expect(grammar).toContain('PLATTS_FOB_MED_ITALY_GASOIL_01');
    expect(grammar).toContain('GO01');
    expect(grammar).not.toContain('PLATTS_CIF_NWE_GASOLINE');
  });

  it('gives numeric fields their own rule rather than free text', () => {
    // The smoke test had the model return "30,000" for a quantity under a
    // free-string grammar. A separator is where a parse becomes another number.
    expect(grammar).toMatch(/decimal ::= .*"-"\?/);
    expect(grammar).toContain('v-decimal ::= decimal | "null"');
    const quantityRule = grammar.split('\n').find((l) => l.startsWith('f-quantity-value '));
    expect(quantityRule).toContain('v-decimal');
  });

  it('names rules with hyphens only, because llama.cpp stops a rule name at an underscore', () => {
    for (const line of grammar.split('\n')) {
      const name = line.split(' ::=')[0] ?? '';
      expect(name, line).not.toContain('_');
    }
  });

  it('gives dates their own rule', () => {
    const laycanRule = grammar.split('\n').find((l) => l.startsWith('f-delivery-window-from '));
    expect(laycanRule).toContain('v-isodate');
  });

  it('restricts the Incoterm field to the seven Incoterms plus null', () => {
    const incoterm = grammar.split('\n').find((l) => l.startsWith('f-delivery-term-incoterm '));
    const valueRuleName = incoterm?.match(/"\{\\"value\\":" (\S+)/)?.[1];
    const valueRule = grammar.split('\n').find((l) => l.startsWith(`${valueRuleName} `));
    expect(valueRule).toContain('FOB');
    expect(valueRule).toContain('DDP');
    expect(valueRule).toContain('"null"');
    expect(valueRule).not.toContain('delivered');
  });

  it('emits minified JSON, because whitespace is output the model pays for', () => {
    expect(grammar).not.toMatch(/ws\s*::=/);
    expect(grammar).toContain('"{\\"value\\":"');
  });

  it('drops the conditional fields in mandatory scope', () => {
    const compact = buildDealGrammar(codes, { scope: 'mandatory' });
    expect(compact).toContain('f-recap-date');
    expect(compact).toContain('f-pricing-differential-value');
    // Conditional fields and the objects that held only conditional fields.
    for (const rule of ['f-law', 'f-vessel', 'f-notes', 'o-fx', 'o-demurrage', 'o-inspection']) {
      expect(compact.split('\n').some((l) => l.startsWith(`${rule} `)), rule).toBe(false);
    }
    expect(compact.length).toBeLessThan(grammar.length);
  });

  it('keeps a partially mandatory object, minus its conditional members', () => {
    const compact = buildDealGrammar(codes, { scope: 'mandatory' });
    const payment = compact.split('\n').find((l) => l.startsWith('o-payment-terms '));
    expect(payment).toContain('as_written');
    expect(payment).not.toContain('late_interest_pct_pa');
  });

  it('refuses to build when the reference data has no codes', () => {
    expect(() => buildDealGrammar({ productCodes: [], quoteCodes: [] })).toThrow();
  });
});
