import { describe, expect, it } from 'vitest';
import { cell, optionalCell, parseCsv } from './csv.js';
import { expect as unwrap } from './result.js';

describe('parseCsv', () => {
  it('reads a plain file', () => {
    const rows = unwrap(parseCsv('a,b\n1,2\n3,4\n'), 'plain');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.get('a')).toBe('1');
    expect(rows[1]?.get('b')).toBe('4');
  });

  it('keeps a comma inside a quoted field instead of shifting every column', () => {
    const rows = unwrap(parseCsv('code,spec\nGO01,"ISO 8217, EN 590"\n'), 'quoted');
    expect(rows[0]?.get('spec')).toBe('ISO 8217, EN 590');
  });

  it('unescapes a doubled quote', () => {
    const rows = unwrap(parseCsv('code,note\nX,"he said ""ok"""\n'), 'escaped');
    expect(rows[0]?.get('note')).toBe('he said "ok"');
  });

  it('handles CRLF line endings', () => {
    const rows = unwrap(parseCsv('a,b\r\n1,2\r\n'), 'crlf');
    expect(rows[0]?.get('b')).toBe('2');
  });

  it('fails loudly on a ragged row rather than filling blanks', () => {
    const result = parseCsv('a,b\n1\n');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('REFERENCE_DATA_INVALID');
  });

  it('fails on an empty file', () => {
    expect(parseCsv('').ok).toBe(false);
  });
});

describe('cell access', () => {
  const rows = unwrap(parseCsv('a,b\n1,\n'), 'fixture');
  const row = rows[0];

  it('treats a blank required cell as reference-data corruption', () => {
    if (row === undefined) throw new Error('fixture');
    expect(cell(row, 'b', 2).ok).toBe(false);
    expect(unwrap(cell(row, 'a', 2), 'a')).toBe('1');
  });

  it('treats a blank optional cell as null', () => {
    if (row === undefined) throw new Error('fixture');
    expect(optionalCell(row, 'b')).toBeNull();
  });
});
