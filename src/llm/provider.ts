/**
 * The inference boundary.
 *
 * Everything above this interface is provider-agnostic, which is what makes the
 * configuration comparison in Part 4 possible at all: the eval harness swaps the
 * implementation and nothing else changes.
 *
 * Two rules hold for every implementation.
 *
 * 1. **No sampling parameter is left to a provider default.** Defaults change
 *    between versions and silently invalidate a committed report (D1). Every
 *    knob is set explicitly here and echoed into `describe()`.
 * 2. **`describe()` is the reproducibility record.** Model file, SHA-256,
 *    runtime version, context size and every sampling value. If it is not in
 *    there, the run cannot be repeated (D2).
 */

/** A grammar constrains decoding token by token. Shape only, never truth. */
export type LlmGrammar =
  | { readonly kind: 'gbnf'; readonly source: string }
  | { readonly kind: 'json_schema'; readonly schema: unknown };

export type CompletionRequest = {
  readonly system: string;
  readonly user: string;
  readonly maxTokens: number;
  readonly grammar?: LlmGrammar;
};

export type CompletionResult = {
  readonly text: string;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly generateMs: number;
  readonly tokensPerSecond: number;
  readonly stopReason: string;
};

/**
 * Fixed for the life of a run and printed with every report.
 *
 * `seed` is recorded even though greedy decoding ignores it. A report that omits
 * it invites the reader to assume a default was in play.
 */
export type SamplingConfig = {
  readonly temperature: number;
  readonly topK: number;
  readonly topP: number;
  readonly minP: number;
  readonly seed: number;
  /**
   * Always disabled. A repeat penalty punishes tokens the model has already
   * produced, and structured JSON is nothing but repeated tokens: braces,
   * quotes, commas, the word "value" once per field. Penalising them fights the
   * grammar and corrupts long objects.
   */
  readonly repeatPenalty: false;
};

export const GREEDY: SamplingConfig = {
  temperature: 0,
  topK: 1,
  topP: 1,
  minP: 0,
  seed: 1,
  repeatPenalty: false,
};

export type LlmDescription = {
  readonly provider: string;
  readonly modelId: string;
  readonly modelFile: string | null;
  readonly sha256: string | null;
  readonly quantisation: string | null;
  readonly runtime: string;
  readonly runtimeVersion: string;
  readonly contextSize: number;
  readonly gpu: string | null;
  readonly sampling: SamplingConfig;
};

export interface LlmProvider {
  describe(): LlmDescription;
  complete(request: CompletionRequest): Promise<CompletionResult>;
  /** Frees the model and its context. The harness runs several configs per process. */
  dispose(): Promise<void>;
}

/** Flattened for the report table, which takes scalars only. */
export function describeAsDetail(
  description: LlmDescription,
): Record<string, string | number | null> {
  return {
    provider: description.provider,
    model: description.modelId,
    model_file: description.modelFile,
    sha256: description.sha256,
    quantisation: description.quantisation,
    runtime: `${description.runtime} ${description.runtimeVersion}`,
    gpu: description.gpu,
    context_size: description.contextSize,
    temperature: description.sampling.temperature,
    top_k: description.sampling.topK,
    top_p: description.sampling.topP,
    min_p: description.sampling.minP,
    seed: description.sampling.seed,
    repeat_penalty: 'disabled',
  };
}
