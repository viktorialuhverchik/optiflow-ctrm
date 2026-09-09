/**
 * Baseline A: refuse everything.
 *
 * Returns null for every field with a question for each. It exists to calibrate
 * the metric, not to be useful. It should score perfectly on the must-abstain
 * class and near zero overall, and the fact that it cannot reach a good
 * headline number is the proof that the scoring cannot be gamed by refusing.
 *
 * It is also the floor for the one number that matters: an extractor that never
 * answers has a silent error rate of zero. Anything that beats it on accuracy
 * has to keep that property.
 */
import { generateQuestions } from '../../domain/questions.js';
import { emptyDeal } from '../../domain/schema.js';
import { emptyDiagnostics, type Extractor, type ExtractionOutput } from '../../extract/types.js';

export function createNullExtractor(): Extractor {
  return {
    config: {
      name: 'null',
      kind: 'baseline',
      detail: {
        description: 'returns null for every field, with a question for each',
        model: null,
        deterministic: 'yes',
      },
    },
    async extract(): Promise<ExtractionOutput> {
      const started = performance.now();
      const deal = emptyDeal();
      return {
        deal,
        questions: generateQuestions(deal),
        diagnostics: emptyDiagnostics(performance.now() - started),
      };
    },
  };
}
