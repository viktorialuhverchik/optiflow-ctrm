#!/usr/bin/env node
/**
 * `pnpm eval:rescore <report...>` — recompute a report's summary from the
 * per-field outcomes it already stores.
 *
 * The scorer gained a metric partway through phase 6, which would otherwise
 * have made the six committed reports incomparable or forced six more model
 * runs at forty seconds a case. Every input the summary needs is already in the
 * report: expected, actual, outcome, flagged and money-critical, per field. This
 * re-derives the aggregate from that.
 *
 * It re-scores stored model output. It does not re-run the model, and it cannot
 * change what the model said.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import type { Report } from './report.js';
import { summarise, summariseByClass, type CaseScore } from './score.js';

function main(): number {
  const { positionals } = parseArgs({ allowPositionals: true, options: {} });
  if (positionals.length === 0) {
    process.stdout.write('usage: pnpm eval:rescore <report.json> [more...]\n');
    return 2;
  }

  for (const path of positionals) {
    const report = JSON.parse(readFileSync(path, 'utf8')) as Report;
    const cases: CaseScore[] = report.scores.cases.map((score) => ({
      ...score,
      silentCriticalError: score.fields.some(
        (f) =>
          f.moneyCritical &&
          (f.outcome === 'wrong_value' || f.outcome === 'confident_nonsense') &&
          !f.flagged,
      ),
    }));

    const rescored: Report = {
      ...report,
      // Older reports predate the resources block. Fill it in as absent rather
      // than fabricating numbers nobody measured.
      resources: report.resources ?? {
        peakRssBytes: 0,
        modelLoadMs: null,
        promptTokens: 0,
        completionTokens: 0,
        tokensPerSecond: 0,
        repairAttempts: 0,
        evidenceRejections: 0,
      },
      scores: {
        summary: summarise(cases),
        byClass: Object.fromEntries(summariseByClass(cases)),
        cases,
      },
    };
    writeFileSync(path, `${JSON.stringify(rescored, null, 2)}\n`);
    process.stdout.write(
      `${path}: accuracy ${(rescored.scores.summary.accuracy * 100).toFixed(1)}%, ` +
        `silent money ${(rescored.scores.summary.silentCriticalRate * 100).toFixed(1)}%, ` +
        `gate ${rescored.scores.summary.gatePassed ? 'pass' : 'fail'}\n`,
    );
  }
  return 0;
}

process.exitCode = main();
