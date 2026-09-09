#!/usr/bin/env node
/**
 * `pnpm eval` — run the whole suite and print a table.
 *
 * Everything the report needs to be reproducible is printed with it: which
 * extractor ran, and for a model extractor its file, hash and sampling
 * parameters (D1, D2). The table goes to stdout so it can be piped; progress
 * and diagnostics go to stderr (code-style §12).
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { createModelExtractor } from '../extract/extractor.js';
import { findModel } from '../llm/manifest.js';
import { NodeLlamaProvider } from '../llm/node-llama.js';
import { loadManifest, requireModelFile } from '../io/model-files.js';
import { createNullExtractor } from './extractors/null-extractor.js';
import { createRegexExtractor } from './extractors/regex-extractor.js';
import { renderReport } from './report.js';
import { runEval } from './runner.js';
import { loadCases, DEFAULT_CASE_DIR } from '../io/case-files.js';
import { loadReferenceData, DEFAULT_DATA_DIR } from '../io/reference-files.js';
import type { Extractor } from '../extract/types.js';

const USAGE = `
usage: pnpm eval [options]

  --extractor <name>   null | regex | model  (default: null)
  --model <id>         model id from models/manifest.json, with --extractor=model
  --context <n>        context size override, for the phase 7 comparison
  --cases <dir>        case directory      (default: ${DEFAULT_CASE_DIR})
  --data <dir>         reference data dir  (default: ${DEFAULT_DATA_DIR})
  --only <substring>   run only cases whose id contains this
  --report <file>      also write the JSON report here
  --quiet              no per-case progress on stderr
`.trim();

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      extractor: { type: 'string', default: 'null' },
      model: { type: 'string', default: 'qwen3-8b-q4km' },
      context: { type: 'string' },
      cases: { type: 'string', default: DEFAULT_CASE_DIR },
      data: { type: 'string', default: DEFAULT_DATA_DIR },
      only: { type: 'string' },
      report: { type: 'string' },
      quiet: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  if (values.help === true) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  const referenceData = loadReferenceData(values.data);
  const built = await buildExtractor(values.extractor ?? 'null', referenceData, {
    modelId: values.model ?? 'qwen3-8b-q4km',
    ...(values.context === undefined ? {} : { contextSize: Number(values.context) }),
  });
  const extractor = built.extractor;

  let cases = loadCases(values.cases);
  if (values.only !== undefined) {
    const needle = values.only;
    cases = cases.filter((c) => c.meta.id.includes(needle));
    if (cases.length === 0) throw new Error(`no case id contains "${needle}"`);
  }

  try {
  const report = await runEval(cases, extractor, (event) => {
    if (values.quiet === true) return;
    process.stderr.write(
      JSON.stringify({ event: 'case', index: event.index + 1, total: event.total, id: event.caseId }) +
        '\n',
    );
  });

  process.stdout.write(`${renderReport(report)}\n`);

  if (values.report !== undefined) {
    mkdirSync(dirname(values.report), { recursive: true });
    writeFileSync(values.report, `${JSON.stringify(report, null, 2)}\n`);
    process.stderr.write(JSON.stringify({ event: 'report_written', path: values.report }) + '\n');
  }

  // Exit non-zero when the release gate fails, so this can gate a build.
  return report.scores.summary.gatePassed ? 0 : 1;
  } finally {
    await built.dispose();
  }
}

type BuiltExtractor = { extractor: Extractor; dispose: () => Promise<void> };

async function buildExtractor(
  name: string,
  data: ReturnType<typeof loadReferenceData>,
  model: { modelId: string; contextSize?: number },
): Promise<BuiltExtractor> {
  const noop = async (): Promise<void> => {};
  switch (name) {
    case 'null':
      return { extractor: createNullExtractor(), dispose: noop };
    case 'regex':
      return { extractor: createRegexExtractor(data), dispose: noop };
    case 'model': {
      const entry = findModel(loadManifest(), model.modelId);
      const provider = await NodeLlamaProvider.create({
        entry,
        modelPath: requireModelFile(entry),
        ...(model.contextSize === undefined ? {} : { contextSize: model.contextSize }),
      });
      return {
        extractor: createModelExtractor({ provider, referenceData: data }),
        dispose: () => provider.dispose(),
      };
    }
    default:
      throw new Error(`unknown extractor "${name}". Known: null, regex, model.`);
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
