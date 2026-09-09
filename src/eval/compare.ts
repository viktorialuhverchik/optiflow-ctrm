#!/usr/bin/env node
/**
 * `pnpm eval:compare <before.json> <after.json>` — did the change help?
 *
 * Phase 6 is a sequence of hypotheses, and the honest way to run it is to keep a
 * change only when the table improves. Reading two forty-row tables side by side
 * to find out is how a regression gets missed, so this does it mechanically.
 *
 * It reports movement in both directions on purpose. A change that lifts
 * accuracy while adding an invented value is a bad change, and a summary that
 * showed only the accuracy delta would hide that.
 */
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import type { Report } from './report.js';
import type { CaseScore, Outcome } from './score.js';
import { renderTable, percent, type Column } from './table.js';

function load(path: string): Report {
  return JSON.parse(readFileSync(path, 'utf8')) as Report;
}

function outcomesByField(cases: readonly CaseScore[]): Map<string, Outcome> {
  const out = new Map<string, Outcome>();
  for (const score of cases) {
    for (const field of score.fields) out.set(`${score.caseId}|${field.field}`, field.outcome);
  }
  return out;
}

/** Lower is better. Used only to label a move as a gain or a regression. */
const SEVERITY: Record<Outcome, number> = {
  correct: 0,
  correct_abstention: 0,
  unflagged_abstention: 1,
  wrong_abstention: 2,
  wrong_value: 3,
  confident_nonsense: 4,
};

function main(): number {
  const { positionals } = parseArgs({ allowPositionals: true, options: {} });
  const beforePath = positionals[0];
  const afterPath = positionals[1];
  if (beforePath === undefined || afterPath === undefined) {
    process.stdout.write('usage: pnpm eval:compare <before.json> <after.json>\n');
    return 2;
  }

  const before = load(beforePath);
  const after = load(afterPath);

  const headline: Column[] = [
    { header: 'metric' },
    { header: 'before', align: 'right' },
    { header: 'after', align: 'right' },
    { header: 'move', align: 'right' },
  ];

  const b = before.scores.summary;
  const a = after.scores.summary;
  const pct = (x: number, y: number): string[] => [percent(x), percent(y), signed((y - x) * 100, '%')];
  const num = (x: number, y: number): string[] => [String(x), String(y), signed(y - x, '')];

  process.stdout.write(
    `${before.extractor.name} @ ${String(before.extractor.detail['prompt_version'] ?? 'n/a')}` +
      `  ->  ${after.extractor.name} @ ${String(after.extractor.detail['prompt_version'] ?? 'n/a')}\n\n`,
  );

  process.stdout.write(
    `${renderTable(headline, [
      ['field accuracy', ...pct(b.accuracy, a.accuracy)],
      ['correct abstention', ...pct(b.abstentionRate, a.abstentionRate)],
      ['over-refusal', ...pct(b.overRefusalRate, a.overRefusalRate)],
      ['silent error rate', ...pct(b.silentErrorRate, a.silentErrorRate)],
      ['silent, money fields', ...pct(b.silentCriticalRate, a.silentCriticalRate)],
      ['confident nonsense', ...num(b.confidentNonsense, a.confidentNonsense)],
      ['gate violations', ...num(b.gateViolations, a.gateViolations)],
      ['p50 ms', ...num(Math.round(before.timings.p50Ms), Math.round(after.timings.p50Ms))],
    ])}\n\n`,
  );

  // --- what actually moved, field by field --------------------------------
  const beforeFields = outcomesByField(before.scores.cases);
  const afterFields = outcomesByField(after.scores.cases);

  const gains: string[][] = [];
  const regressions: string[][] = [];
  for (const [key, beforeOutcome] of beforeFields) {
    const afterOutcome = afterFields.get(key);
    if (afterOutcome === undefined || afterOutcome === beforeOutcome) continue;
    const [caseId, field] = key.split('|');
    const row = [caseId ?? '', field ?? '', beforeOutcome, '->', afterOutcome];
    if (SEVERITY[afterOutcome] < SEVERITY[beforeOutcome]) gains.push(row);
    else regressions.push(row);
  }

  const movementColumns: Column[] = [
    { header: 'case' },
    { header: 'field' },
    { header: 'before' },
    { header: '' },
    { header: 'after' },
  ];

  process.stdout.write(`GAINS (${gains.length})\n`);
  process.stdout.write(gains.length === 0 ? '  none\n' : `${renderTable(movementColumns, gains)}\n`);
  process.stdout.write(`\nREGRESSIONS (${regressions.length})\n`);
  process.stdout.write(
    regressions.length === 0 ? '  none\n' : `${renderTable(movementColumns, regressions)}\n`,
  );

  // A change is worth keeping when it moves more fields down the severity scale
  // than up it, and never when it adds an invented value.
  const verdict =
    a.confidentNonsense > b.confidentNonsense
      ? 'REJECT: the change invents more values than it did before'
      : gains.length > regressions.length
        ? 'KEEP: more fields improved than regressed'
        : gains.length === regressions.length
          ? 'NEUTRAL: as many fields regressed as improved'
          : 'REJECT: more fields regressed than improved';
  process.stdout.write(`\n${verdict}\n`);
  return 0;
}

function signed(value: number, suffix: string): string {
  const rounded = Math.abs(value) < 0.05 ? 0 : value;
  const formatted = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  return rounded > 0 ? `+${formatted}${suffix}` : `${formatted}${suffix}`;
}

process.exitCode = main();
