/**
 * Plain-text tables for the eval report.
 *
 * Hand-rolled rather than a dependency (code-style §14): it is thirty lines,
 * it has no colour codes to strip when the output is piped to a file, and the
 * column alignment stays under our control so two runs diff cleanly.
 */
export type Column = {
  readonly header: string;
  readonly align?: 'left' | 'right';
};

export function renderTable(columns: readonly Column[], rows: readonly (readonly string[])[]): string {
  const widths = columns.map((column, index) =>
    Math.max(column.header.length, ...rows.map((row) => (row[index] ?? '').length)),
  );

  const line = (cells: readonly string[]): string =>
    cells
      .map((cell, index) => {
        const width = widths[index] ?? cell.length;
        return columns[index]?.align === 'right' ? cell.padStart(width) : cell.padEnd(width);
      })
      .join('  ')
      .trimEnd();

  const separator = widths.map((width) => '-'.repeat(width)).join('  ');

  return [line(columns.map((c) => c.header)), separator, ...rows.map(line)].join('\n');
}

export function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export function count(value: number): string {
  return String(value);
}
