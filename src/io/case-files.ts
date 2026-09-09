/**
 * The filesystem edge for eval cases. Kept out of src/eval so the scorer and
 * runner stay pure and testable without fixtures on disk (code-style §1).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { buildCase, type EvalCase } from '../eval/case.js';

export const DEFAULT_CASE_DIR = 'data/eval-cases';

export function loadCases(directory: string = DEFAULT_CASE_DIR): EvalCase[] {
  let entries: string[];
  try {
    entries = readdirSync(directory).sort();
  } catch {
    throw new Error(`no eval case directory at "${directory}"`);
  }

  const cases: EvalCase[] = [];
  for (const entry of entries) {
    const path = join(directory, entry);
    if (!statSync(path).isDirectory()) continue;
    cases.push(loadCase(path));
  }

  if (cases.length === 0) throw new Error(`no eval cases found in "${directory}"`);

  const ids = cases.map((c) => c.meta.id);
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
  if (duplicates.length > 0) throw new Error(`duplicate case ids: ${duplicates.join(', ')}`);

  return cases;
}

export function loadCase(directory: string): EvalCase {
  const read = (name: string): string => {
    try {
      return readFileSync(join(directory, name), 'utf8');
    } catch {
      throw new Error(`${directory}: missing ${name}`);
    }
  };

  const meta: unknown = JSON.parse(read('meta.json'));
  const expected: unknown = JSON.parse(read('expected.json'));
  return buildCase(directory, meta, expected, read('input.txt'));
}
