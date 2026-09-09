import { describe, expect, it } from 'vitest';
import { DealSchema, MANDATORY_FIELDS, emptyDeal, getField } from '../domain/schema.js';
import { loadReferenceData } from '../io/reference-files.js';
import { buildDealGrammar } from '../llm/grammar.js';
import { createModelExtractor } from './extractor.js';
import type { CompletionRequest, LlmProvider } from '../llm/provider.js';
import { GREEDY } from '../llm/provider.js';

const data = loadReferenceData('data');

/** A provider that returns a canned answer. No model, so this stays a unit test. */
function cannedProvider(text: string): LlmProvider {
  return {
    describe: () => ({
      provider: 'canned',
      modelId: 'canned',
      modelFile: null,
      sha256: null,
      quantisation: null,
      runtime: 'test',
      runtimeVersion: '0',
      contextSize: 0,
      gpu: null,
      sampling: GREEDY,
    }),
    complete: (_request: CompletionRequest) =>
      Promise.resolve({
        text,
        promptTokens: 0,
        completionTokens: 0,
        generateMs: 0,
        tokensPerSecond: 0,
        stopReason: 'eogToken',
      }),
    dispose: () => Promise.resolve(),
  };
}

/** The shape a mandatory-scope grammar produces: no conditional fields at all. */
function mandatoryOnlyAnswer(): string {
  const full = emptyDeal() as unknown as Record<string, unknown>;
  const keep = new Set(MANDATORY_FIELDS.map((path) => path.split('.')[0]));
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(full)) if (keep.has(key)) out[key] = value;
  delete (out['payment_terms'] as Record<string, unknown>)['shape'];
  delete (out['payment_terms'] as Record<string, unknown>)['days'];
  return JSON.stringify(out);
}

describe('the model extractor', () => {
  it('fills the conditional fields as absent when the grammar omitted them', async () => {
    // Mandatory scope halves the output tokens by not asking for the
    // conditional fields. Downstream code must never have to ask whether a
    // field exists, only whether it has a value.
    const extractor = createModelExtractor({
      provider: cannedProvider(mandatoryOnlyAnswer()),
      referenceData: data,
      scope: 'mandatory',
    });
    const output = await extractor.extract({ caseId: 't', text: 'recap', referenceDate: '2026-08-11' });
    expect(() => DealSchema.parse(output.deal)).not.toThrow();
    expect(getField(output.deal, 'law')).toEqual({ value: null, evidence: null, status: 'absent' });
    expect(getField(output.deal, 'payment_terms.shape')?.value).toBeNull();
  });

  it('records the field scope in its config, so a report says which was run', async () => {
    const extractor = createModelExtractor({
      provider: cannedProvider(JSON.stringify(emptyDeal())),
      referenceData: data,
      scope: 'mandatory',
    });
    expect(extractor.config.detail['field_scope']).toBe('mandatory');
    await extractor.extract({ caseId: 't', text: 'recap', referenceDate: '2026-08-11' });
  });

  it('throws rather than returning a partial object it could not decode', async () => {
    // A deal that looks complete and is not is worse than a failure.
    const extractor = createModelExtractor({
      provider: cannedProvider('not json at all'),
      referenceData: data,
      maxRepairAttempts: 0,
    });
    await expect(
      extractor.extract({ caseId: 't', text: 'recap', referenceDate: '2026-08-11' }),
    ).rejects.toThrow(/could not decode/);
  });

  it('asks about every mandatory field when the model refuses everything', async () => {
    const extractor = createModelExtractor({
      provider: cannedProvider(JSON.stringify(emptyDeal())),
      referenceData: data,
    });
    const output = await extractor.extract({ caseId: 't', text: 'recap', referenceDate: '2026-08-11' });
    expect(output.questions).toHaveLength(MANDATORY_FIELDS.length);
  });

  it('builds a smaller grammar in mandatory scope', () => {
    const codes = { productCodes: data.productCodes, quoteCodes: data.quoteCodes };
    expect(buildDealGrammar(codes, { scope: 'mandatory' }).length).toBeLessThan(
      buildDealGrammar(codes).length,
    );
  });
});
