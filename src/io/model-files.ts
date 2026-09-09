/**
 * The filesystem edge for model weights: read the manifest, verify the bytes.
 *
 * Hashing five gigabytes takes a few seconds, so it is not done on every run.
 * `pnpm model:verify` does it deliberately, and the eval records the hash from
 * the manifest so a report always names the bytes it claims to have used.
 */
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { ManifestSchema, type Manifest, type ModelEntry } from '../llm/manifest.js';

export const DEFAULT_MANIFEST = 'models/manifest.json';

export function modelDownloadCommand(entry: ModelEntry): string {
  return downloadHint(entry);
}

export function loadManifest(path: string = DEFAULT_MANIFEST): Manifest {
  if (!existsSync(path)) {
    throw new Error(`no model manifest at "${path}". See the README for the download step.`);
  }
  return ManifestSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

export function modelIsPresent(entry: ModelEntry): boolean {
  return existsSync(entry.file) && statSync(entry.file).size === entry.sizeBytes;
}

function downloadHint(entry: ModelEntry): string {
  const url = `${entry.source}/resolve/main/${entry.file.split('/').pop() ?? ''}`;
  return `curl -L -o ${entry.file} ${url}`;
}

export function requireModelFile(entry: ModelEntry): string {
  if (!existsSync(entry.file)) {
    throw new Error(
      `model "${entry.id}" is not downloaded. Expected ${entry.file}.\n  ${downloadHint(entry)}\nThen: pnpm model:verify`,
    );
  }
  const actual = statSync(entry.file).size;
  if (actual !== entry.sizeBytes) {
    throw new Error(
      `model "${entry.id}" is ${actual} bytes, manifest says ${entry.sizeBytes}. Download is incomplete or the file changed.`,
    );
  }
  return entry.file;
}

export async function sha256OfFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(path);
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest('hex');
}
