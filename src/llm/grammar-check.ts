#!/usr/bin/env node
/**
 * `pnpm grammar:check` — hand the generated grammar to llama.cpp and print it.
 *
 * Kept out of the unit suite because it needs the native binding, which the unit
 * tests must not require. A grammar that fails to compile is a hard stop, so it
 * is worth a command of its own rather than being discovered mid-eval.
 */
import { getLlama } from 'node-llama-cpp';
import { buildDealGrammar } from './grammar.js';
import { loadReferenceData } from '../io/reference-files.js';
import { DealSchema, emptyDeal } from '../domain/schema.js';

async function main(): Promise<number> {
  const data = loadReferenceData('data');
  const source = buildDealGrammar({
    productCodes: data.productCodes,
    quoteCodes: data.quoteCodes,
  });

  const llama = await getLlama();
  try {
    await llama.createGrammar({ grammar: source });
  } catch (error) {
    process.stderr.write(`grammar failed to compile: ${String(error)}\n`);
    process.stdout.write(source);
    return 1;
  }

  // The all-null object is the abstention path. If it did not round-trip
  // through the schema the extractor could not refuse anything.
  const minified = JSON.stringify(emptyDeal());
  DealSchema.parse(JSON.parse(minified));

  process.stdout.write(`grammar compiles. ${source.split('\n').length} rules, ${source.length} bytes.\n`);
  process.stdout.write(`all-null deal serialises to ${minified.length} bytes and re-parses.\n`);
  await llama.dispose();
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  });
