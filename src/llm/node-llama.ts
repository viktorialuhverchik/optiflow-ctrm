/**
 * In-process llama.cpp through node-llama-cpp, the default provider.
 *
 * Chosen over a server because the eval harness needs control of every sampling
 * parameter and the model file identity, with no daemon in the way and no
 * provider defaults to inherit. See the README technology table for the
 * alternatives and what they cost.
 *
 * Thinking mode is off. Qwen3 is a hybrid model and will happily emit a long
 * reasoning block before its answer. Under a grammar that block is illegal, so
 * the model is pushed into producing the object directly, which is both what we
 * want and much cheaper. The soft switch is a `/no_think` marker in the prompt.
 */
import {
  getLlama,
  LlamaChatSession,
  type Llama,
  type LlamaContext,
  type LlamaContextSequence,
  type LlamaModel,
  type LlamaGrammar,
} from 'node-llama-cpp';
import type { ModelEntry } from './manifest.js';
import {
  GREEDY,
  type CompletionRequest,
  type CompletionResult,
  type LlmDescription,
  type LlmProvider,
  type SamplingConfig,
} from './provider.js';

export type NodeLlamaOptions = {
  readonly entry: ModelEntry;
  readonly modelPath: string;
  readonly sampling?: SamplingConfig;
  /** Overrides the manifest, for the context-size comparison in phase 7. */
  readonly contextSize?: number;
  readonly disableThinking?: boolean;
};

export type LoadMetrics = {
  readonly loadMs: number;
  readonly rssAfterLoadBytes: number;
  readonly gpu: string | null;
};

export class NodeLlamaProvider implements LlmProvider {
  readonly #llama: Llama;
  readonly #model: LlamaModel;
  readonly #context: LlamaContext;
  /**
   * One sequence, held for the life of the provider and cleared between calls.
   * Taking a fresh sequence per call exhausts the context's single slot, and
   * allocating more slots would let cases run concurrently, which would make the
   * per-case latency numbers meaningless.
   */
  readonly #sequence: LlamaContextSequence;
  readonly #entry: ModelEntry;
  readonly #modelPath: string;
  readonly #sampling: SamplingConfig;
  readonly #contextSize: number;
  readonly #gpu: string | null;
  readonly #disableThinking: boolean;
  /**
   * One context sequence means one generation at a time.
   *
   * Native function calling runs its tool handlers *during* generation. If a
   * handler calls back into this provider, `clearHistory()` wipes the sequence
   * the outer generation is still using, and both silently produce garbage: the
   * phase 9 demo saw an extraction return eleven spurious refusals instead of
   * three. Silent corruption is the worst possible failure, so re-entry throws.
   */
  #generating = false;
  readonly loadMetrics: LoadMetrics;

  private constructor(parts: {
    llama: Llama;
    model: LlamaModel;
    context: LlamaContext;
    sequence: LlamaContextSequence;
    entry: ModelEntry;
    modelPath: string;
    sampling: SamplingConfig;
    contextSize: number;
    gpu: string | null;
    disableThinking: boolean;
    loadMetrics: LoadMetrics;
  }) {
    this.#llama = parts.llama;
    this.#model = parts.model;
    this.#context = parts.context;
    this.#sequence = parts.sequence;
    this.#entry = parts.entry;
    this.#modelPath = parts.modelPath;
    this.#sampling = parts.sampling;
    this.#contextSize = parts.contextSize;
    this.#gpu = parts.gpu;
    this.#disableThinking = parts.disableThinking;
    this.loadMetrics = parts.loadMetrics;
  }

  static async create(options: NodeLlamaOptions): Promise<NodeLlamaProvider> {
    const sampling = options.sampling ?? GREEDY;
    const contextSize = options.contextSize ?? options.entry.contextSize;

    const started = performance.now();
    const llama = await getLlama();
    const model = await llama.loadModel({ modelPath: options.modelPath });
    const context = await model.createContext({ contextSize, sequences: 1 });
    const sequence = context.getSequence();
    const loadMs = performance.now() - started;

    const gpuNames = await llama.getGpuDeviceNames();
    const gpu = gpuNames.length > 0 ? gpuNames.join(', ') : llama.gpu === false ? 'cpu' : String(llama.gpu);

    return new NodeLlamaProvider({
      llama,
      model,
      context,
      sequence,
      entry: options.entry,
      modelPath: options.modelPath,
      sampling,
      contextSize,
      gpu,
      disableThinking: options.disableThinking ?? true,
      loadMetrics: { loadMs, rssAfterLoadBytes: process.memoryUsage().rss, gpu },
    });
  }

  describe(): LlmDescription {
    return {
      provider: 'node-llama-cpp',
      modelId: this.#entry.id,
      modelFile: this.#modelPath,
      sha256: this.#entry.sha256,
      quantisation: this.#entry.quantisation,
      runtime: 'llama.cpp',
      runtimeVersion: this.#llama.llamaCppRelease.release,
      contextSize: this.#contextSize,
      gpu: this.#gpu,
      sampling: this.#sampling,
    };
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    this.#enterGeneration();
    try {
      return await this.#complete(request);
    } finally {
      this.#generating = false;
    }
  }

  #enterGeneration(): void {
    if (this.#generating) {
      throw new Error(
        're-entrant generation on a single-sequence provider. A tool handler called back into ' +
          'the model while it was still generating. Load a second provider, or gather what the ' +
          'tool needs before generation starts.',
      );
    }
    this.#generating = true;
  }

  async #complete(request: CompletionRequest): Promise<CompletionResult> {
    const grammar = await this.#buildGrammar(request);
    // The sequence is cleared before every call. Carrying chat history between
    // cases would leak one recap into the next, which is a correctness bug
    // disguised as a cache.
    await this.#sequence.clearHistory();
    const session = new LlamaChatSession({
      contextSequence: this.#sequence,
      systemPrompt: request.system,
    });

    const user = this.#disableThinking ? `${request.user}\n\n/no_think` : request.user;
    const promptTokens = this.#model.tokenize(`${request.system}\n${user}`).length;

    const started = performance.now();
    const result = await session.promptWithMeta(user, {
      maxTokens: request.maxTokens,
      temperature: this.#sampling.temperature,
      topK: this.#sampling.topK,
      topP: this.#sampling.topP,
      minP: this.#sampling.minP,
      seed: this.#sampling.seed,
      repeatPenalty: this.#sampling.repeatPenalty,
      ...(grammar === null ? {} : { grammar }),
    });
    const generateMs = performance.now() - started;

    session.dispose();

    const completionTokens = this.#model.tokenize(result.responseText).length;
    return {
      text: result.responseText,
      promptTokens,
      completionTokens,
      generateMs,
      tokensPerSecond: generateMs === 0 ? 0 : (completionTokens / generateMs) * 1000,
      stopReason: result.stopReason,
    };
  }

  /**
   * Native function calling, through the model's own chat template.
   *
   * Kept separate from `complete()` because it is a different mechanism with a
   * different failure surface, and phase 9 measures the two against each other.
   * The template is whatever the GGUF declares, so this is the path a normal MCP
   * client would get by default.
   */
  async completeWithFunctions(
    system: string,
    user: string,
    functions: Record<string, unknown>,
    maxTokens: number,
  ): Promise<{ text: string; generateMs: number }> {
    this.#enterGeneration();
    try {
      return await this.#completeWithFunctions(system, user, functions, maxTokens);
    } finally {
      this.#generating = false;
    }
  }

  async #completeWithFunctions(
    system: string,
    user: string,
    functions: Record<string, unknown>,
    maxTokens: number,
  ): Promise<{ text: string; generateMs: number }> {
    await this.#sequence.clearHistory();
    const session = new LlamaChatSession({
      contextSequence: this.#sequence,
      systemPrompt: system,
    });
    const started = performance.now();
    const text = await session.prompt(user, {
      maxTokens,
      temperature: this.#sampling.temperature,
      topK: this.#sampling.topK,
      topP: this.#sampling.topP,
      minP: this.#sampling.minP,
      seed: this.#sampling.seed,
      repeatPenalty: this.#sampling.repeatPenalty,
      functions: functions as Parameters<LlamaChatSession['prompt']>[1] extends infer O
        ? O extends { functions?: infer F }
          ? F
          : never
        : never,
    });
    session.dispose();
    return { text, generateMs: performance.now() - started };
  }

  async #buildGrammar(request: CompletionRequest): Promise<LlamaGrammar | null> {
    if (request.grammar === undefined) return null;
    if (request.grammar.kind === 'gbnf') {
      return this.#llama.createGrammar({ grammar: request.grammar.source });
    }
    // The JSON-schema path accepts the subset node-llama-cpp can compile to
    // GBNF, which is narrower than JSON Schema. Anything outside it is caught by
    // the Zod parse after decoding (code-style §9).
    return this.#llama.createGrammarForJsonSchema(
      request.grammar.schema as Parameters<Llama['createGrammarForJsonSchema']>[0],
    );
  }

  async dispose(): Promise<void> {
    await this.#sequence.dispose();
    await this.#context.dispose();
    await this.#model.dispose();
    await this.#llama.dispose();
  }
}
