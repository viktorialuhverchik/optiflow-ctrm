#!/usr/bin/env node
/**
 * `pnpm model:smoke` — prove the local model runs, is deterministic, and
 * measure what it costs before any extraction logic is layered on top.
 *
 * Four checks, in order of how much they would invalidate later work:
 *
 *   1. the model loads and answers at all
 *   2. three identical prompts produce three byte-identical answers (D1)
 *   3. a grammar constrains the output shape
 *   4. load time, peak resident memory and tokens per second, recorded
 *
 * Everything printed here goes into the performance table in phase 7, so the
 * numbers are measured rather than estimated.
 */
import { parseArgs } from 'node:util';
import { findModel } from './manifest.js';
import { NodeLlamaProvider } from './node-llama.js';
import { describeAsDetail } from './provider.js';
import { loadManifest, requireModelFile } from '../io/model-files.js';
import { renderTable } from '../eval/table.js';

const SYSTEM =
  'You extract structured data from oil trading messages. Answer with the requested value only.';

const PROMPT =
  'Recap line: "Quantity: 30,000 MT +/- 10% in seller\'s option". ' +
  'What is the quantity value, the unit, and whose option the tolerance is?';

const GRAMMAR_SCHEMA = {
  type: 'object',
  properties: {
    value: { type: ['string', 'null'] },
    unit: { enum: ['MT', 'BBL', null] },
    tolerance_option: { enum: ['seller', 'buyer', null] },
  },
  required: ['value', 'unit', 'tolerance_option'],
} as const;

function mib(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(0)} MiB`;
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      model: { type: 'string', default: 'qwen3-8b-q4km' },
      runs: { type: 'string', default: '3' },
      context: { type: 'string' },
      manifest: { type: 'string', default: 'models/manifest.json' },
    },
  });

  const entry = findModel(loadManifest(values.manifest), values.model ?? '');
  const modelPath = requireModelFile(entry);
  const runs = Number(values.runs);

  process.stderr.write(JSON.stringify({ event: 'loading', model: entry.id, file: modelPath }) + '\n');

  const provider = await NodeLlamaProvider.create({
    entry,
    modelPath,
    ...(values.context === undefined ? {} : { contextSize: Number(values.context) }),
  });

  try {
    const description = provider.describe();
    process.stdout.write(
      `${renderTable(
        [{ header: 'setting' }, { header: 'value' }],
        Object.entries(describeAsDetail(description)).map(([k, v]) => [k, v === null ? 'null' : String(v)]),
      )}\n\n`,
    );

    // --- 1 and 2: does it answer, and is it deterministic -----------------
    const answers: string[] = [];
    const rows: string[][] = [];
    for (let run = 1; run <= runs; run += 1) {
      const result = await provider.complete({
        system: SYSTEM,
        user: PROMPT,
        maxTokens: 128,
      });
      answers.push(result.text);
      rows.push([
        String(run),
        String(result.promptTokens),
        String(result.completionTokens),
        String(Math.round(result.generateMs)),
        result.tokensPerSecond.toFixed(1),
        result.stopReason,
      ]);
    }

    process.stdout.write(
      `${renderTable(
        [
          { header: 'run' },
          { header: 'prompt tok', align: 'right' },
          { header: 'gen tok', align: 'right' },
          { header: 'ms', align: 'right' },
          { header: 'tok/s', align: 'right' },
          { header: 'stop' },
        ],
        rows,
      )}\n\n`,
    );

    const first = answers[0] ?? '';
    const deterministic = answers.every((answer) => answer === first);

    // --- 2b: throughput on a generation long enough to mean something -----
    // The three runs above generate a dozen tokens each, so their tok/s is
    // mostly first-token latency and prompt processing. Throughput needs a long
    // generation to measure, and the performance table in phase 7 needs both.
    const long = await provider.complete({
      system: SYSTEM,
      user:
        'Explain, in about three hundred words, how a Platts-linked price formula with a ' +
        'bill-of-lading pricing period is settled on a physical gasoil cargo.',
      maxTokens: 400,
    });

    // --- 3: does a grammar hold the shape ---------------------------------
    const constrained = await provider.complete({
      system: SYSTEM,
      user: PROMPT,
      maxTokens: 128,
      grammar: { kind: 'json_schema', schema: GRAMMAR_SCHEMA },
    });

    let parsed: unknown = null;
    let parseError: string | null = null;
    try {
      parsed = JSON.parse(constrained.text);
    } catch (error) {
      parseError = error instanceof Error ? error.message : String(error);
    }

    // --- 4: cost ----------------------------------------------------------
    const usage = process.resourceUsage();
    const summary: string[][] = [
      ['model load ms', String(Math.round(provider.loadMetrics.loadMs))],
      ['peak RSS', mib(usage.maxRSS * 1024)],
      ['rss after load', mib(provider.loadMetrics.rssAfterLoadBytes)],
      ['runs', String(runs)],
      ['short-run tok/s', (rows[0]?.[4] ?? '0')],
      ['sustained gen tokens', String(long.completionTokens)],
      ['sustained tok/s', long.tokensPerSecond.toFixed(1)],
      ['sustained ms', String(Math.round(long.generateMs))],
      ['deterministic across runs', deterministic ? 'YES' : 'NO'],
      ['grammar output parses', parseError === null ? 'YES' : `NO: ${parseError}`],
    ];
    process.stdout.write(
      `${renderTable([{ header: 'metric' }, { header: 'value' }], summary)}\n\n`,
    );

    process.stdout.write(`unconstrained answer:\n${first.trim()}\n\n`);
    process.stdout.write(`grammar-constrained answer:\n${constrained.text.trim()}\n`);
    if (parsed !== null) {
      process.stdout.write(`parsed: ${JSON.stringify(parsed)}\n`);
    }

    return deterministic && parseError === null ? 0 : 1;
  } finally {
    await provider.dispose();
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${JSON.stringify({ event: 'error', message })}\n`);
    process.exitCode = 2;
  });
