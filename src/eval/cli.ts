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
import { createNullExtractor } from './extractors/null-extractor.js';
import { createRegexExtractor } from './extractors/regex-extractor.js';
import { renderReport } from './report.js';
import { runEval } from './runner.js';
import { loadCases, DEFAULT_CASE_DIR } from '../io/case-files.js';
import { loadReferenceData, DEFAULT_DATA_DIR } from '../io/reference-files.js';
import type { Extractor } from '../extract/types.js';

const USAGE = `
usage: pnpm eval [options]

  --extractor <name>   null | regex        (default: null)
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
  const extractor = buildExtractor(values.extractor ?? 'null', referenceData);

  let cases = loadCases(values.cases);
  if (values.only !== undefined) {
    const needle = values.only;
    cases = cases.filter((c) => c.meta.id.includes(needle));
    if (cases.length === 0) throw new Error(`no case id contains "${needle}"`);
  }

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
}

function buildExtractor(name: string, data: ReturnType<typeof loadReferenceData>): Extractor {
  switch (name) {
    case 'null':
      return createNullExtractor();
    case 'regex':
      return createRegexExtractor(data);
    default:
      throw new Error(`unknown extractor "${name}". Known: null, regex.`);
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
