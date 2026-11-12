import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { fail } from './errors.js';
import { classifyLine, type Classified, type Status } from './classify.js';
import { readManifest, type Manifest } from './manifest.js';

export interface ResultRow {
  custom_id: string;
  status: Status;
  code: number | string | null;
  retryable: boolean;
  /** Result file the winning line came from (null for missing). */
  source: string | null;
  /** 0 = first submission, N = retry-N, for explicit files the argument index. */
  round: number | null;
  reason: string | null;
  text?: string;
  response?: { status_code: number; body: unknown };
}

export interface MergeReport {
  rows: ResultRow[];
  summary: Partial<Record<Status, number>>;
  /** failed rows grouped by code, e.g. {"400": 1, "500": 1} */
  failedCodes: Record<string, number>;
  /** custom_ids with more than one success (first success was kept). */
  duplicates: string[];
  /** custom_ids found in result files but not in the manifest. */
  unknown: string[];
  /** Result lines that were unparsable or had no custom_id. */
  skippedLines: number;
  files: string[];
}

const RESULT_FILE = /\.(output|error|results)\.jsonl$/;

interface ResultFile {
  path: string;
  label: string;
  round: number;
}

/** Find result files next to the manifest (round 0) and in retry-N/ sub folders (round N). */
export function discoverResultFiles(manifestPath: string): ResultFile[] {
  const dir = dirname(manifestPath);
  const found: ResultFile[] = [];
  const scan = (folder: string, round: number): void => {
    for (const name of readdirSync(folder).sort()) {
      const full = join(folder, name);
      if (RESULT_FILE.test(name) && statSync(full).isFile()) found.push({ path: full, label: relative(dir, full), round });
    }
  };
  scan(dir, 0);
  for (const name of readdirSync(dir).sort()) {
    const m = /^retry-(\d+)$/.exec(name);
    if (m && statSync(join(dir, name)).isDirectory()) scan(join(dir, name), Number(m[1]));
  }
  return found.sort((a, b) => a.round - b.round);
}

interface Candidate {
  c: Classified;
  file: ResultFile;
}

export interface MergeOptions {
  /** Explicit result files, in round order. Default: auto-discover next to the manifest. */
  files?: string[] | undefined;
}

/**
 * Join result files back to the original request order by custom_id.
 * Rules for several rounds: a success always beats a failure (regardless of file order);
 * with several successes the first one (round order, then file name) is kept and the rest are
 * reported as duplicates; with no success the failure from the latest round remains.
 */
export function mergeResults(manifestPath: string, opts: MergeOptions = {}): MergeReport {
  const manifest: Manifest = readManifest(manifestPath);
  let files: ResultFile[];
  if (opts.files && opts.files.length > 0) {
    files = opts.files.map((p, i) => {
      if (!existsSync(p)) throw fail('cannot_read_file', 'err.result_missing', { path: p }, 'err.result_missing.hint');
      return { path: p, label: basename(p), round: i };
    });
  } else {
    files = discoverResultFiles(manifestPath);
    if (files.length === 0) {
      throw fail('no_result_files', 'err.no_result_files', { path: manifestPath }, 'err.no_result_files.hint');
    }
  }

  const known = new Set(manifest.order);
  const candidates = new Map<string, Candidate[]>();
  const unknown = new Set<string>();
  let skipped = 0;
  for (const file of files) {
    for (const raw of readFileSync(file.path, 'utf8').split('\n')) {
      if (raw.trim() === '') continue;
      let obj: unknown;
      try {
        obj = JSON.parse(raw);
      } catch {
        skipped++;
        continue;
      }
      const c = classifyLine(obj);
      if (!c) {
        skipped++;
        continue;
      }
      if (!known.has(c.customId)) {
        unknown.add(c.customId);
        continue;
      }
      const list = candidates.get(c.customId);
      if (list) list.push({ c, file });
      else candidates.set(c.customId, [{ c, file }]);
    }
  }

  const duplicates: string[] = [];
  const rows: ResultRow[] = manifest.order.map((id): ResultRow => {
    const list = candidates.get(id);
    if (!list) {
      return { custom_id: id, status: 'missing', code: null, retryable: true, source: null, round: null, reason: null };
    }
    const successes = list.filter((x) => x.c.status === 'succeeded');
    if (successes.length > 1) duplicates.push(id);
    // Candidates were appended in (round, file, line) order: first success wins, else the latest line.
    const win = successes[0] ?? list[list.length - 1]!;
    const row: ResultRow = {
      custom_id: id,
      status: win.c.status,
      code: win.c.code,
      retryable: win.c.retryable,
      source: win.file.label,
      round: win.file.round,
      reason: win.c.reason,
    };
    if (win.c.status === 'succeeded') {
      row.text = win.c.text;
      row.response = { status_code: typeof win.c.code === 'number' ? win.c.code : 200, body: win.c.body };
    }
    return row;
  });

  const summary: Partial<Record<Status, number>> = {};
  const failedCodes: Record<string, number> = {};
  for (const r of rows) {
    summary[r.status] = (summary[r.status] ?? 0) + 1;
    if (r.status === 'failed') failedCodes[String(r.code)] = (failedCodes[String(r.code)] ?? 0) + 1;
  }
  return {
    rows,
    summary,
    failedCodes,
    duplicates,
    unknown: [...unknown],
    skippedLines: skipped,
    files: files.map((f) => f.label),
  };
}

export function writeResultsJsonl(rows: ResultRow[], path: string): void {
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
}

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const CSV_HEADER = 'custom_id,status,code,retryable,source,text';

export function resultsToCsv(rows: ResultRow[]): string {
  const lines = rows.map((r) => [r.custom_id, r.status, r.code, r.retryable, r.source, r.text ?? ''].map(csvCell).join(','));
  return [CSV_HEADER, ...lines].join('\n') + '\n';
}

export function readResultsFile(path: string): ResultRow[] {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    throw fail('cannot_read_file', 'err.cannot_read', { path, detail: (e as Error).message }, 'err.results_read.hint');
  }
  const rows: ResultRow[] = [];
  text.split('\n').forEach((raw, i) => {
    if (raw.trim() === '') return;
    try {
      const row = JSON.parse(raw);
      if (typeof row.custom_id !== 'string' || typeof row.status !== 'string') throw new Error('missing custom_id/status');
      rows.push(row as ResultRow);
    } catch (e) {
      throw fail('invalid_results', 'err.invalid_results', { path, line: i + 1, detail: (e as Error).message }, 'err.invalid_results.hint');
    }
  });
  return rows;
}
