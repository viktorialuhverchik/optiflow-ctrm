import { describe, expect, it } from 'vitest';
import { HttpLlmProvider } from './http-openai-compat.js';

describe('HttpLlmProvider', () => {
  it('accepts a loopback endpoint', () => {
    expect(
      () => new HttpLlmProvider({ baseUrl: 'http://127.0.0.1:8080/v1', modelId: 'q', contextSize: 8192 }),
    ).not.toThrow();
    expect(
      () => new HttpLlmProvider({ baseUrl: 'http://localhost:1234/v1', modelId: 'q', contextSize: 8192 }),
    ).not.toThrow();
  });

  it('refuses an endpoint that leaves the machine', () => {
    // T1 is enforced at the constructor, not left to whoever writes the config.
    for (const url of [
      'https://example.com/v1',
      'http://192.168.1.10:8080/v1',
      'http://127.0.0.1.evil.example/v1',
    ]) {
      expect(() => new HttpLlmProvider({ baseUrl: url, modelId: 'q', contextSize: 8192 })).toThrow(
        /non-loopback/,
      );
    }
  });

  it('reports every sampling parameter it will send', () => {
    const provider = new HttpLlmProvider({
      baseUrl: 'http://127.0.0.1:8080/v1',
      modelId: 'qwen3-8b-q4km',
      contextSize: 8192,
    });
    const description = provider.describe();
    expect(description.sampling.temperature).toBe(0);
    expect(description.sampling.repeatPenalty).toBe(false);
    expect(description.contextSize).toBe(8192);
  });
});
