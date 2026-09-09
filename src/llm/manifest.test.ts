import { describe, expect, it } from 'vitest';
import { ManifestSchema, findModel } from './manifest.js';

const VALID = {
  models: [
    {
      id: 'qwen3-8b-q4km',
      file: 'models/Qwen3-8B-Q4_K_M.gguf',
      sha256: 'a'.repeat(64),
      sizeBytes: 5027783488,
      source: 'https://huggingface.co/Qwen/Qwen3-8B-GGUF',
      parameters: '8B',
      quantisation: 'Q4_K_M',
      contextSize: 8192,
    },
  ],
};

describe('the model manifest', () => {
  it('accepts a complete entry and defaults the notes', () => {
    const manifest = ManifestSchema.parse(VALID);
    expect(manifest.models[0]?.id).toBe('qwen3-8b-q4km');
    expect(manifest.models[0]?.notes).toBe('');
  });

  it('rejects an entry with no hash, which is the whole point of the file', () => {
    const withoutHash = { models: [{ ...VALID.models[0], sha256: 'not-a-hash' }] };
    expect(() => ManifestSchema.parse(withoutHash)).toThrow();
  });

  it('rejects a manifest with no models', () => {
    expect(() => ManifestSchema.parse({ models: [] })).toThrow();
  });

  it('names the models it knows when asked for one it does not', () => {
    const manifest = ManifestSchema.parse(VALID);
    expect(() => findModel(manifest, 'llama-70b')).toThrow(/qwen3-8b-q4km/);
  });
});
