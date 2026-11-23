import type { DoctorReport } from './run.js';
import type { Status } from './types.js';

export interface Style {
  color: boolean;
}

const SYMBOLS: Record<Status, string> = { ok: '✔', warn: '⚠', error: '✖', skip: '–' };
const COLORS: Record<Status, number> = { ok: 32, warn: 33, error: 31, skip: 90 };

const paint = (style: Style, code: number, text: string) => (style.color ? `\u001b[${code}m${text}\u001b[0m` : text);

function plural(n: number, one: string, few: string, many: string): string {
  if (n === 1) return `${n} ${one}`;
  const lastTwo = n % 100;
  const last = n % 10;
  return last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14) ? `${n} ${few}` : `${n} ${many}`;
}

export function formatReport(report: DoctorReport, style: Style): string {
  const lines: string[] = [];
  for (const group of report.groups) {
    lines.push('', paint(style, 1, group.title));
    const width = Math.max(...group.results.map((r) => r.title.length));
    for (const result of group.results) {
      const symbol = paint(style, COLORS[result.status], SYMBOLS[result.status]);
      const detailLines = (result.detail ?? '').split('\n');
      lines.push(`  ${symbol} ${result.title.padEnd(width)}  ${detailLines[0]}`.trimEnd());
      for (const extra of detailLines.slice(1)) lines.push(`      ${extra}`);
      if (result.hint && result.status !== 'ok') lines.push(paint(style, 90, `      → ${result.hint}`));
    }
  }
  const { ok, warn, error, skip } = report.summary;
  const parts = [
    `${ok} ok`,
    plural(warn, 'ostrzeżenie', 'ostrzeżenia', 'ostrzeżeń'),
    plural(error, 'błąd', 'błędy', 'błędów'),
    plural(skip, 'pominięty', 'pominięte', 'pominiętych'),
  ];
  lines.push('', `Wynik: ${parts.join(' · ')}`);
  return lines.join('\n');
}

/** GitHub Actions workflow commands, so problems show up as annotations on the run. */
export function formatActionsAnnotations(report: DoctorReport): string[] {
  const escape = (text: string) => text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  return report.groups
    .flatMap((g) => g.results)
    .filter((r) => r.status === 'error' || r.status === 'warn')
    .map((r) => {
      const level = r.status === 'error' ? 'error' : 'warning';
      const title = escape(`${r.group}: ${r.title}`).replace(/,/g, '%2C').replace(/:/g, '%3A');
      return `::${level} title=${title}::${escape(r.detail ?? '')}`;
    });
}
