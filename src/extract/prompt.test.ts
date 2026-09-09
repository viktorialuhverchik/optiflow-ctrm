import { describe, expect, it } from 'vitest';
import { loadCases } from '../io/case-files.js';
import { loadReferenceData } from '../io/reference-files.js';
import { SYSTEM_PROMPT, buildUserPrompt } from './prompt.js';

const data = loadReferenceData('data');

describe('the system prompt', () => {
  it('states the rules the grammar cannot express', () => {
    for (const phrase of [
      'Never infer a number',
      'Copy evidence verbatim',
      'latest agreed value wins',
      'One deal per answer',
      'Record units as written',
      'trader shorthand',
    ]) {
      expect(SYSTEM_PROMPT).toContain(phrase);
    }
  });

  it('does not use any eval case as its worked example', () => {
    // A prompt built from a case would make the eval measure recall of the
    // prompt rather than extraction.
    const cases = loadCases('data/eval-cases');
    for (const evalCase of cases) {
      const lines = evalCase.text
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 25);
      for (const line of lines) {
        expect(SYSTEM_PROMPT, `${evalCase.meta.id} leaked into the prompt`).not.toContain(line);
      }
    }
  });

  it('names no counterparty that appears in the eval set', () => {
    for (const name of [
      'Helvig Energy',
      'Nordlint Petrochemicals',
      'Gulfstar Bunkering',
      'Rhine Midstream',
      'Marlin Bunkers',
      'Anatolia Marine',
    ]) {
      expect(SYSTEM_PROMPT).not.toContain(name);
    }
  });
});

describe('buildUserPrompt', () => {
  const prompt = buildUserPrompt('RECAP 01.09.2026\nSeller: Someone', '2026-09-01', data);

  it('injects the reference date rather than reading a clock', () => {
    expect(prompt).toContain('2026-09-01');
    expect(prompt).toContain('Do not use it as any field value');
  });

  it('lists the codes the grammar will allow, with their names', () => {
    expect(prompt).toContain('PLATTS_FOB_MED_ITALY_GASOIL_01');
    expect(prompt).toContain('Platts FOB MED Italy Gasoil 0.1%');
    expect(prompt).toContain('GO01');
  });

  it('says a quotation outside the list is null, not the nearest match', () => {
    expect(prompt).toContain('not on this list');
  });

  it('delimits the message so it cannot be confused with the instructions', () => {
    expect(prompt).toContain('MESSAGE\n---');
  });
});
