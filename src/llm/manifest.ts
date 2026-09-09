/**
 * The model manifest.
 *
 * Weights are pinned by SHA-256, not by a registry tag (T2). A tag can be
 * repointed at different bytes without notice, which would silently invalidate
 * every committed eval report. The manifest is committed; the .gguf files are
 * not.
 */
import { z } from 'zod';

export const ModelEntrySchema = z.object({
  /** Stable short name used on the command line and in reports. */
  id: z.string().regex(/^[a-z0-9-]+$/),
  file: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  sizeBytes: z.number().int().positive(),
  source: z.string().url(),
  parameters: z.string().min(1),
  quantisation: z.string().min(1),
  /** Context length to load with. Bounded by memory, not by what the model supports. */
  contextSize: z.number().int().positive(),
  notes: z.string().default(''),
});
export type ModelEntry = z.infer<typeof ModelEntrySchema>;

export const ManifestSchema = z.object({
  models: z.array(ModelEntrySchema).min(1),
});
export type Manifest = z.infer<typeof ManifestSchema>;

export function findModel(manifest: Manifest, id: string): ModelEntry {
  const entry = manifest.models.find((model) => model.id === id);
  if (entry === undefined) {
    const known = manifest.models.map((model) => model.id).join(', ');
    throw new Error(`unknown model id "${id}". Known: ${known}`);
  }
  return entry;
}
