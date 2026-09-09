import { describe, expect, it } from 'vitest';
import { MANDATORY_FIELDS } from '../domain/schema.js';
import { buildCase, sortCases, type EvalCase } from './case.js';

const META = {
  id: 'test-case',
  title: 'A case',
  class: 'clean',
  reference_date: '2026-08-11',
  source: 'invented',
  notes: '',
};

function fullExpected(overrides: Record<string, string | null> = {}) {
  const fields: Record<string, string | null> = {};
  for (const path of MANDATORY_FIELDS) fields[path] = null;
  return { fields: { ...fields, ...overrides } };
}

describe('buildCase', () => {
  it('accepts a well-formed case', () => {
    const built = buildCase('memory', META, fullExpected({ buyer: 'Helvig Energy AG' }), 'recap');
    expect(built.meta.id).toBe('test-case');
    expect(built.expected.get('buyer')).toBe('Helvig Energy AG');
    expect(built.expected.get('currency')).toBeNull();
  });

  it('rejects a field path that is not in the schema', () => {
    // A typo would otherwise score silently as a permanent miss.
    const expected = fullExpected();
    expected.fields['pricing.differential.amount'] = '-12.50';
    expect(() => buildCase('memory', META, expected, 'recap')).toThrow(/not in the schema/);
  });

  it('rejects a case that leaves a mandatory field unstated', () => {
    const expected = fullExpected();
    delete expected.fields['pricing.differential.value'];
    expect(() => buildCase('memory', META, expected, 'recap')).toThrow(/missing mandatory fields/);
  });

  it('rejects a JSON number where a decimal string belongs', () => {
    // 30000 and "30000" survive a round trip differently once a float is
    // involved, so the format allows only strings.
    const expected = fullExpected() as unknown as { fields: Record<string, unknown> };
    expected.fields['quantity.value'] = 30000;
    expect(() => buildCase('memory', META, expected, 'recap')).toThrow();
  });

  it('rejects an unknown case class', () => {
    expect(() => buildCase('memory', { ...META, class: 'tricky' }, fullExpected(), 'recap')).toThrow();
  });

  it('rejects an empty input', () => {
    expect(() => buildCase('memory', META, fullExpected(), '   ')).toThrow(/empty/);
  });

  it('rejects a reference date that is not a calendar date format', () => {
    expect(() =>
      buildCase('memory', { ...META, reference_date: '11.08.2026' }, fullExpected(), 'recap'),
    ).toThrow();
  });
});

describe('sortCases', () => {
  it('orders by id so two runs produce identical reports', () => {
    const make = (id: string): EvalCase => buildCase(id, { ...META, id }, fullExpected(), 'recap');
    const ordered = sortCases([make('c-third'), make('a-first'), make('b-second')]);
    expect(ordered.map((c) => c.meta.id)).toEqual(['a-first', 'b-second', 'c-third']);
  });
});
