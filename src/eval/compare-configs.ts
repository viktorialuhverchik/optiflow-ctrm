#!/usr/bin/env node
/**
 * `pnpm eval:configs <report...>` — the quality against latency against memory
 * table.
 *
 * Part 4 asks for at least two configurations with the trade-off visible. A
 * visible trade-off means the columns have to sit next to each other: a reader
 * choosing between an 8B and a 4B needs the accuracy, the latency and the peak
 * memory in one place, not three reports to hold in their head.
 */
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import type { Report } from './report.js';
import { renderTable, percent, type Column } from './table.js';

function label(report: Report): string {
  const detail = report.extractor.detail;
  if (report.extractor.kind === 'baseline') return report.extractor.name;
  const model = String(detail['model'] ?? '?');
  const scope = String(detail['field_scope'] ?? 'all');
  const context = String(detail['context_size'] ?? '?');
  return `${model} ${scope} ctx${context}`;
}

function main(): number {
  const { positionals } = parseArgs({ allowPositionals: true, options: {} });
  if (positionals.length < 2) {
    process.stdout.write('usage: pnpm eval:configs <report.json> <report.json> [more...]\n');
    return 2;
  }

  const reports = positionals.map((path) => JSON.parse(readFileSync(path, 'utf8')) as Report);
  const columns: Column[] = [
    { header: 'metric' },
    ...reports.map((report) => ({ header: label(report), align: 'right' as const })),
  ];

  const mib = (bytes: number): string => (bytes === 0 ? 'n/a' : (bytes / 1024 / 1024).toFixed(0));
  const seconds = (ms: number): string => (ms / 1000).toFixed(1);
  const perCase = (total: number, cases: number): string =>
    cases === 0 ? '0' : String(Math.round(total / cases));

  const rows: string[][] = [
    ['QUALITY', ...reports.map(() => '')],
    ['field accuracy', ...reports.map((r) => percent(r.scores.summary.accuracy))],
    ['correct abstention', ...reports.map((r) => percent(r.scores.summary.abstentionRate))],
    ['over-refusal', ...reports.map((r) => percent(r.scores.summary.overRefusalRate))],
    ['invented values', ...reports.map((r) => String(r.scores.summary.confidentNonsense))],
    ['silent error, money fields', ...reports.map((r) => percent(r.scores.summary.silentCriticalRate))],
    ['release gate', ...reports.map((r) => (r.scores.summary.gatePassed ? 'PASS' : 'FAIL'))],
    ['extractor failures', ...reports.map((r) => String(r.scores.summary.failures))],
    ['', ...reports.map(() => '')],
    ['LATENCY', ...reports.map(() => '')],
    ['p50 seconds per recap', ...reports.map((r) => seconds(r.timings.p50Ms))],
    ['p95 seconds per recap', ...reports.map((r) => seconds(r.timings.p95Ms))],
    ['whole suite, seconds', ...reports.map((r) => seconds(r.timings.totalMs))],
    ['completion tokens/s', ...reports.map((r) => r.resources.tokensPerSecond.toFixed(1))],
    [
      'completion tokens per recap',
      ...reports.map((r) => perCase(r.resources.completionTokens, r.scores.cases.length)),
    ],
    [
      'prompt tokens per recap',
      ...reports.map((r) => perCase(r.resources.promptTokens, r.scores.cases.length)),
    ],
    ['', ...reports.map(() => '')],
    ['MEMORY', ...reports.map(() => '')],
    ['peak resident MiB', ...reports.map((r) => mib(r.resources.peakRssBytes))],
    [
      'model load seconds',
      ...reports.map((r) => (r.resources.modelLoadMs === null ? 'n/a' : seconds(r.resources.modelLoadMs))),
    ],
  ];

  process.stdout.write(`${renderTable(columns, rows)}\n`);
  return 0;
}

process.exitCode = main();
