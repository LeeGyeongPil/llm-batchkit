import type { Status } from './classify.js';
import type { Issue } from './types.js';

export interface Painter {
  red(s: string): string;
  yellow(s: string): string;
  green(s: string): string;
  dim(s: string): string;
  bold(s: string): string;
}

/** ANSI colors; plain text when `enabled` is false (NO_COLOR, pipes, tests). */
export function painter(enabled: boolean): Painter {
  const wrap = (code: number) => (s: string) => (enabled ? `\u001b[${code}m${s}\u001b[0m` : s);
  return { red: wrap(31), yellow: wrap(33), green: wrap(32), dim: wrap(2), bold: wrap(1) };
}

export function table(headers: string[], rows: string[][]): string[] {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const fmt = (cells: string[]): string => cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join('  ').trimEnd();
  return [fmt(headers), ...rows.map(fmt)];
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** `succeeded 7 · failed 2 (400×1, 500×1) · expired 1 · cancelled 1 · missing 1` */
export function formatSummary(summary: Partial<Record<Status, number>>, failedCodes: Record<string, number>): string {
  const parts: string[] = [`succeeded ${summary.succeeded ?? 0}`];
  if (summary.failed) {
    const codes = Object.entries(failedCodes).map(([code, n]) => `${code}×${n}`).join(', ');
    parts.push(`failed ${summary.failed} (${codes})`);
  }
  for (const s of ['expired', 'cancelled', 'missing'] as const) {
    if (summary[s]) parts.push(`${s} ${summary[s]}`);
  }
  return parts.join(' · ');
}

export function formatIssue(issue: Issue, p: Painter): string[] {
  const where = issue.line === 0 ? 'file' : String(issue.line);
  const code = issue.severity === 'error' ? p.red(issue.code) : p.yellow(`${issue.code} (warn)`);
  return [where, code, issue.message];
}
