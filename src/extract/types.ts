/**
 * The contract every extractor implements: the model-backed one, and the two
 * baselines the eval harness scores it against.
 *
 * The eval runner depends on this interface and on nothing else, which is what
 * lets the harness exist and be trusted before any model is wired up
 * (docs/tasks.md phase 2).
 */
import type { Question } from '../domain/questions.js';
import type { Deal } from '../domain/schema.js';

export type ExtractionRequest = {
  readonly caseId: string;
  readonly text: string;
  /**
   * The date this recap is being read as of, injected rather than read from the
   * clock (D4). Supplies the year for a laycan written without one, and pins
   * anything relative in the text.
   */
  readonly referenceDate: string;
};

export type ExtractionDiagnostics = {
  /** Wall time for the whole extraction, including any repair retry. */
  readonly durationMs: number;
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
  /** How many repair retries fired. Counted separately in the report. */
  readonly repairAttempts: number;
  /** Values dropped because their evidence span was not in the source text. */
  readonly evidenceRejections: readonly string[];
  /** Codes the extractor produced that do not exist in the reference data. */
  readonly unresolvedCodes: readonly string[];
};

export type ExtractionOutput = {
  readonly deal: Deal;
  readonly questions: readonly Question[];
  readonly diagnostics: ExtractionDiagnostics;
};

/**
 * `describe()` returns everything that has to appear in the run report for the
 * result to be reproducible: model file and hash, runtime version, and every
 * sampling parameter, none left to a provider default (D1, D2).
 */
export type ExtractorConfig = {
  readonly name: string;
  readonly kind: 'baseline' | 'model';
  readonly detail: Readonly<Record<string, string | number | null>>;
};

export interface Extractor {
  readonly config: ExtractorConfig;
  extract(request: ExtractionRequest): Promise<ExtractionOutput>;
}

export function emptyDiagnostics(durationMs: number): ExtractionDiagnostics {
  return {
    durationMs,
    promptTokens: null,
    completionTokens: null,
    repairAttempts: 0,
    evidenceRejections: [],
    unresolvedCodes: [],
  };
}
