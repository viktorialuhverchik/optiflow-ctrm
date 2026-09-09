import { describe, expect, it } from 'vitest';
import { percentile } from './report.js';
import { renderTable, percent } from './table.js';

const ESC = String.fromCharCode(27);

describe('percentile', () => {
  it('uses nearest rank', () => {
    expect(percentile([10, 20, 30, 40], 50)).toBe(20);
    expect(percentile([10, 20, 30, 40], 95)).toBe(40);
    expect(percentile([5], 50)).toBe(5);
  });

  it('returns 0 for an empty set rather than NaN', () => {
    expect(percentile([], 50)).toBe(0);
  });

  it('does not mutate the caller array', () => {
    const values = [30, 10, 20];
    percentile(values, 50);
    expect(values).toEqual([30, 10, 20]);
  });
});

describe('renderTable', () => {
  it('pads columns to the widest cell and right-aligns where asked', () => {
    const out = renderTable(
      [{ header: 'name' }, { header: 'n', align: 'right' }],
      [
        ['a', '1'],
        ['longer', '100'],
      ],
    );
    expect(out.split('\n')).toEqual([
      'name      n',
      '------  ---',
      'a         1',
      'longer  100',
    ]);
  });

  it('emits no colour codes, so a piped report diffs cleanly', () => {
    const out = renderTable([{ header: 'x' }], [['y']]);
    expect(out.includes(ESC)).toBe(false);
  });
});

describe('percent', () => {
  it('formats to one decimal place', () => {
    expect(percent(0)).toBe('0.0%');
    expect(percent(1)).toBe('100.0%');
    expect(percent(1 / 3)).toBe('33.3%');
  });
});
