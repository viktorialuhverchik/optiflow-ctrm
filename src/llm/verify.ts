#!/usr/bin/env node
/**
 * `pnpm model:verify` — hash the weights and compare against the manifest.
 *
 * Deliberately separate from the eval, because hashing five gigabytes takes
 * seconds and doing it on every run would be a tax on the loop that matters.
 * Run it after a download and before trusting a committed report (D2).
 */
import { loadManifest, modelDownloadCommand, sha256OfFile } from '../io/model-files.js';
import { existsSync, statSync } from 'node:fs';

async function main(): Promise<number> {
  const manifest = loadManifest();
  let failures = 0;

  for (const entry of manifest.models) {
    if (!existsSync(entry.file)) {
      process.stdout.write(
        `MISSING  ${entry.id}  ${entry.file}\n         ${modelDownloadCommand(entry)}\n`,
      );
      failures += 1;
      continue;
    }
    const size = statSync(entry.file).size;
    if (size !== entry.sizeBytes) {
      process.stdout.write(`SIZE     ${entry.id}  ${size} bytes, manifest says ${entry.sizeBytes}\n`);
      failures += 1;
      continue;
    }
    const actual = await sha256OfFile(entry.file);
    if (actual !== entry.sha256) {
      process.stdout.write(`HASH     ${entry.id}  ${actual}\n         manifest ${entry.sha256}\n`);
      failures += 1;
      continue;
    }
    process.stdout.write(`ok       ${entry.id}  ${entry.quantisation}  ${entry.sha256.slice(0, 12)}...\n`);
  }

  return failures === 0 ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  });
