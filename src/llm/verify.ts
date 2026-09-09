#!/usr/bin/env node
/**
 * `pnpm model:verify` — hash the weights and compare against the manifest.
 *
 * Deliberately separate from the eval, because hashing five gigabytes takes
 * seconds and doing it on every run would be a tax on the loop that matters.
 * Run it after a download and before trusting a committed report (D2).
 */
import { existsSync, statSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { loadManifest, modelDownloadCommand, sha256OfFile } from '../io/model-files.js';
import { findModel } from './manifest.js';

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { model: { type: 'string' } } });
  const manifest = loadManifest();

  // Only one model is required to run the system; the second exists for the
  // configuration comparison. Without this filter, a reviewer who sensibly
  // skipped the optional download gets a non-zero exit from a command that
  // found nothing wrong with what they actually have.
  const models =
    values.model === undefined ? manifest.models : [findModel(manifest, values.model)];

  let failures = 0;

  for (const entry of models) {
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

  if (failures > 0 && values.model === undefined) {
    process.stdout.write(
      '\nOnly qwen3-8b-q4km is needed to run the system. The 4B is optional and is\n' +
        'used for the configuration comparison only. To check just the one you have:\n' +
        '  pnpm model:verify --model qwen3-8b-q4km\n',
    );
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
