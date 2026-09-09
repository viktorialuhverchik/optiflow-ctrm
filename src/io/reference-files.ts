/**
 * The filesystem edge for reference data. Kept out of src/domain so that layer
 * stays pure and unit-testable without fixtures on disk (code-style §1).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildReferenceData, type ReferenceData } from '../domain/references.js';

export const DEFAULT_DATA_DIR = 'data';

export function loadReferenceData(dataDir: string = DEFAULT_DATA_DIR): ReferenceData {
  const products = readFileSync(join(dataDir, 'products.csv'), 'utf8');
  const quotes = readFileSync(join(dataDir, 'price_quotes.csv'), 'utf8');
  const result = buildReferenceData(products, quotes);
  if (!result.ok) {
    // Corrupt reference data is a programmer/ops error, not a recap problem.
    throw new Error(`reference data invalid: [${result.error.code}] ${result.error.message}`);
  }
  return result.value;
}
