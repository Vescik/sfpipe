import path from 'node:path';

/** Path shown to the user: relative to `from` when possible, always with "/" (also on Windows). */
export function displayPath(from: string, to: string): string {
  return (path.relative(from, to) || to).split(path.sep).join('/');
}

export function formatTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, i) => Math.max(header.length, ...rows.map((row) => (row[i] ?? '').length)));
  const line = (cells: string[]) => cells.map((cell, i) => cell.padEnd(widths[i]!)).join('  ').trimEnd();
  return [line(headers), ...rows.map(line)].join('\n');
}
