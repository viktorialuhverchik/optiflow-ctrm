/**
 * The second provider: a local server speaking the widely-implemented
 * chat-completions wire format.
 *
 * This exists so phase 7 can compare serving stacks without touching anything
 * above the provider interface. It talks to `llama-server`, LM Studio or an MLX
 * server, all of which run on this machine. T1 still holds: the base URL must be
 * a loopback address, and the constructor refuses anything else rather than
 * trusting the caller to have configured it correctly.
 *
 * Grammar support differs by server, which is exactly the kind of thing the
 * comparison is meant to surface. `llama-server` accepts a raw GBNF grammar and
 * a JSON schema; some others accept only the schema; a few accept neither and
 * fall back to unconstrained decoding, which the report has to say out loud.
 */
import {
  GREEDY,
  type CompletionRequest,
  type CompletionResult,
  type LlmDescription,
  type LlmProvider,
  type SamplingConfig,
} from './provider.js';

export type HttpProviderOptions = {
  /** Must be a loopback address. Nothing here may leave the machine (T1). */
  readonly baseUrl: string;
  readonly modelId: string;
  readonly contextSize: number;
  readonly sampling?: SamplingConfig;
  readonly quantisation?: string;
  readonly sha256?: string;
  readonly timeoutMs?: number;
};

const LOOPBACK = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?(\/|$)/;

type ChatResponse = {
  choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};

export class HttpLlmProvider implements LlmProvider {
  readonly #options: HttpProviderOptions;
  readonly #sampling: SamplingConfig;
  #serverVersion = 'unknown';

  constructor(options: HttpProviderOptions) {
    if (!LOOPBACK.test(options.baseUrl)) {
      throw new Error(
        `refusing a non-loopback inference endpoint "${options.baseUrl}". The extraction path must stay on this machine. See docs/rules-and-constraints.md T1.`,
      );
    }
    this.#options = options;
    this.#sampling = options.sampling ?? GREEDY;
  }

  describe(): LlmDescription {
    return {
      provider: 'http-chat-completions',
      modelId: this.#options.modelId,
      modelFile: null,
      sha256: this.#options.sha256 ?? null,
      quantisation: this.#options.quantisation ?? null,
      runtime: this.#options.baseUrl,
      runtimeVersion: this.#serverVersion,
      contextSize: this.#options.contextSize,
      gpu: null,
      sampling: this.#sampling,
    };
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const body: Record<string, unknown> = {
      model: this.#options.modelId,
      messages: [
        { role: 'system', content: request.system },
        { role: 'user', content: request.user },
      ],
      max_tokens: request.maxTokens,
      temperature: this.#sampling.temperature,
      top_k: this.#sampling.topK,
      top_p: this.#sampling.topP,
      min_p: this.#sampling.minP,
      seed: this.#sampling.seed,
      repeat_penalty: 1.0,
      stream: false,
    };

    if (request.grammar?.kind === 'gbnf') {
      body['grammar'] = request.grammar.source;
    } else if (request.grammar?.kind === 'json_schema') {
      body['response_format'] = {
        type: 'json_schema',
        json_schema: { name: 'deal', strict: true, schema: request.grammar.schema },
      };
    }

    const started = performance.now();
    const response = await fetch(`${this.#options.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.#options.timeoutMs ?? 300_000),
    });
    const generateMs = performance.now() - started;

    if (!response.ok) {
      throw new Error(`inference server returned ${response.status}: ${await response.text()}`);
    }

    const payload = (await response.json()) as ChatResponse;
    const choice = payload.choices?.[0];
    const text = choice?.message?.content ?? '';
    const completionTokens = payload.usage?.completion_tokens ?? 0;

    return {
      text,
      promptTokens: payload.usage?.prompt_tokens ?? 0,
      completionTokens,
      generateMs,
      tokensPerSecond: generateMs === 0 ? 0 : (completionTokens / generateMs) * 1000,
      stopReason: choice?.finish_reason ?? 'unknown',
    };
  }

  /** Best-effort, for the report. A server that does not expose it stays "unknown". */
  async probeVersion(): Promise<void> {
    try {
      const response = await fetch(`${this.#options.baseUrl}/models`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (response.ok) this.#serverVersion = 'reachable';
    } catch {
      this.#serverVersion = 'unreachable';
    }
  }

  async dispose(): Promise<void> {
    // Nothing to free: the server owns the model.
  }
}
