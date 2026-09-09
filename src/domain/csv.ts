/**
 * Minimal RFC-4180 CSV reader.
 *
 * A dependency was considered and rejected (code-style §14): the two reference
 * files are ours, small, and read once at startup. Quoted fields and escaped
 * quotes are supported anyway so a future file with a comma in a spec string
 * does not silently shift every column.
 */
import { fail, ok, type Result } from './result.js';

export type CsvRow = ReadonlyMap<string, string>;

export function parseCsv(text: string): Result<CsvRow[]> {
  const records = splitRecords(text).filter((r) => r.length > 0 && !(r.length === 1 && r[0] === ''));
  const header = records[0];
  if (header === undefined) {
    return fail('REFERENCE_DATA_INVALID', 'csv is empty');
  }

  const rows: CsvRow[] = [];
  for (let i = 1; i < records.length; i += 1) {
    const record = records[i];
    if (record === undefined) continue;
    if (record.length !== header.length) {
      return fail(
        'REFERENCE_DATA_INVALID',
        `csv row ${i + 1} has ${record.length} fields, header has ${header.length}`,
        { line: i + 1, expected: header.length, actual: record.length },
      );
    }
    const map = new Map<string, string>();
    header.forEach((name, index) => map.set(name, record[index] ?? ''));
    rows.push(map);
  }
  return ok(rows);
}

function splitRecords(text: string): string[][] {
  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let inQuotes = false;

  const normalised = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  for (let i = 0; i < normalised.length; i += 1) {
    const ch = normalised[i];
    if (inQuotes) {
      if (ch === '"') {
        if (normalised[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      record.push(field);
      field = '';
    } else if (ch === '\n') {
      record.push(field);
      records.push(record);
      record = [];
      field = '';
    } else {
      field += ch;
    }
  }
  record.push(field);
  records.push(record);
  return records;
}

/** Required cell. Missing or blank is reference-data corruption, not a recap problem. */
export function cell(row: CsvRow, column: string, line: number): Result<string> {
  const value = row.get(column);
  if (value === undefined || value.trim() === '') {
    return fail('REFERENCE_DATA_INVALID', `missing "${column}" on row ${line}`, { column, line });
  }
  return ok(value.trim());
}

/** Optional cell. Blank is a legitimate value, returned as null. */
export function optionalCell(row: CsvRow, column: string): string | null {
  const value = row.get(column);
  if (value === undefined || value.trim() === '') return null;
  return value.trim();
}
