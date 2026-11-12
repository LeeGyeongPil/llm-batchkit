import type { Status } from './classify.js';
import { count, issueMessage, t, type Lang } from './i18n.js';
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

/** `plural(lang, 1, 'unit.request')` -> "1 request"; kept here so every report goes through the message table. */
export const plural = count;

/** Terminal columns of a string: Hangul, CJK and full-width characters take two columns. */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1;
  return w;
}

/** `s` followed by spaces up to `width` terminal columns. */
export function padDisplay(s: string, width: number): string {
  return s + ' '.repeat(Math.max(0, width - displayWidth(s)));
}

export function table(headers: string[], rows: string[][]): string[] {
  const widths = headers.map((h, i) => Math.max(displayWidth(h), ...rows.map((r) => displayWidth(r[i] ?? ''))));
  const fmt = (cells: string[]): string => cells.map((c, i) => padDisplay(c, widths[i] ?? 0)).join('  ').trimEnd();
  return [fmt(headers), ...rows.map(fmt)];
}

/** `succeeded 7 · failed 2 (400×1, 500×1) · expired 1 · cancelled 1 · missing 1` (or the Korean equivalent). */
export function formatSummary(summary: Partial<Record<Status, number>>, failedCodes: Record<string, number>, lang: Lang = 'en'): string {
  const parts: string[] = [t(lang, 'summary.succeeded', { n: summary.succeeded ?? 0 })];
  if (summary.failed) {
    const codes = Object.entries(failedCodes).map(([code, n]) => `${code}×${n}`).join(', ');
    parts.push(t(lang, 'summary.failed', { n: summary.failed, codes }));
  }
  for (const s of ['expired', 'cancelled', 'missing'] as const) {
    if (summary[s]) parts.push(t(lang, `summary.${s}`, { n: summary[s] as number }));
  }
  return parts.join(' · ');
}

export function formatIssue(issue: Issue, p: Painter, lang: Lang = 'en'): string[] {
  const where = issue.line === 0 ? t(lang, 'report.file') : String(issue.line);
  const code = issue.severity === 'error' ? p.red(issue.code) : p.yellow(`${issue.code} (${t(lang, 'report.warn')})`);
  return [where, code, issueMessage(lang, issue)];
}
