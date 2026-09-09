#!/usr/bin/env node
/**
 * `pnpm extract <file>` — one recap in, one deal object out.
 *
 * The deal goes to stdout as JSON so it can be piped. Everything else, including
 * the questions table and the diagnostics, goes to stderr, because the point of
 * the command is that its stdout is machine-readable (code-style §12).
 */
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { createModelExtractor } from './extract/extractor.js';
import { loadCases } from './io/case-files.js';
import { findModel } from './llm/manifest.js';
import { NodeLlamaProvider } from './llm/node-llama.js';
import { loadManifest, requireModelFile } from './io/model-files.js';
import { loadReferenceData, DEFAULT_DATA_DIR } from './io/reference-files.js';
import { renderTable } from './eval/table.js';

const USAGE = `
usage: pnpm extract <recap file> [options]

  --date <YYYY-MM-DD>  the date to read the message as of. Required unless the
                       file is an eval case, in which case the case supplies it.
  --model <id>         model id from models/manifest.json
  --context <n>        context size override
  --data <dir>         reference data directory
  --json               print only the deal object, no questions table
`.trim();

/** Eval cases carry their own reference date, so reuse it when the path matches. */
function referenceDateFor(path: string, override: string | undefined): string {
  if (override !== undefined) return override;
  try {
    for (const evalCase of loadCases()) {
      if (path.startsWith(evalCase.directory)) return evalCase.meta.reference_date;
    }
  } catch {
    // No case directory, or the file is not a case. Fall through to the error.
  }
  throw new Error(
    'no reference date. Pass --date YYYY-MM-DD: the extractor never reads the system clock (D4).',
  );
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    options: {
      date: { type: 'string' },
      model: { type: 'string', default: 'qwen3-8b-q4km' },
      context: { type: 'string' },
      data: { type: 'string', default: DEFAULT_DATA_DIR },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    allowPositionals: true,
  });

  const path = positionals[0];
  if (values.help === true || path === undefined) {
    process.stdout.write(`${USAGE}\n`);
    return path === undefined && values.help !== true ? 2 : 0;
  }

  const text = readFileSync(path, 'utf8');
  const referenceDate = referenceDateFor(path, values.date);
  const referenceData = loadReferenceData(values.data);
  const entry = findModel(loadManifest(), values.model ?? '');

  process.stderr.write(
    `${JSON.stringify({ event: 'loading', model: entry.id, referenceDate })}\n`,
  );

  const provider = await NodeLlamaProvider.create({
    entry,
    modelPath: requireModelFile(entry),
    ...(values.context === undefined ? {} : { contextSize: Number(values.context) }),
  });

  try {
    const extractor = createModelExtractor({ provider, referenceData });
    const output = await extractor.extract({ caseId: path, text, referenceDate });

    process.stdout.write(`${JSON.stringify(output.deal, null, 2)}\n`);

    if (values.json === true) return 0;

    if (output.questions.length > 0) {
      process.stderr.write(
        `\n${output.questions.length} question(s) back to the trader:\n\n${renderTable(
          [{ header: 'field' }, { header: 'why' }, { header: 'question' }],
          output.questions.map((q) => [q.field, q.reason, q.question]),
        )}\n`,
      );
    } else {
      process.stderr.write('\nNo questions: every mandatory field is stated.\n');
    }

    const d = output.diagnostics;
    process.stderr.write(
      `\n${renderTable(
        [{ header: 'metric' }, { header: 'value', align: 'right' }],
        [
          ['prompt tokens', String(d.promptTokens ?? 0)],
          ['completion tokens', String(d.completionTokens ?? 0)],
          ['repair attempts', String(d.repairAttempts)],
          ['evidence rejections', String(d.evidenceRejections.length)],
          ['duration ms', String(Math.round(d.durationMs))],
        ],
      )}\n`,
    );
    for (const rejection of d.evidenceRejections) {
      process.stderr.write(`  dropped ${rejection}\n`);
    }

    return 0;
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
