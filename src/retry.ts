import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { BatchkitError } from './errors.js';
import { detectProvider, loadRequests } from './jsonl.js';
import { readManifest } from './manifest.js';
import type { ResultRow } from './merge.js';
import type { ProviderName } from './types.js';

export const RETRY_STATUSES = ['expired', 'cancelled', 'missing', 'failed'] as const;

export interface RetryOptions {
  /** Also retry failed rows that default policy excludes (other 4xx, error objects, indeterminate). */
  include4xx?: boolean | undefined;
  /** Restrict to these statuses (expired, cancelled, missing, failed). */
  only?: string[] | undefined;
}

export interface Excluded {
  row: ResultRow;
  reason: string;
}

export interface RetrySelection {
  selected: ResultRow[];
  excluded: Excluded[];
}

/**
 * Pick the rows worth sending again. Default: expired, cancelled, missing, 429 and 5xx.
 * Succeeded rows are never selected, so re-running after a partial retry only re-picks what still failed.
 */
export function selectRetries(rows: ResultRow[], opts: RetryOptions = {}): RetrySelection {
  const only = opts.only ? new Set(opts.only) : null;
  if (only) {
    for (const s of only) {
      if (!(RETRY_STATUSES as readonly string[]).includes(s)) {
        throw new BatchkitError('invalid_option', `--only: unknown status "${s}"`, `Use a comma-separated subset of: ${RETRY_STATUSES.join(', ')}.`);
      }
    }
  }
  const selected: ResultRow[] = [];
  const excluded: Excluded[] = [];
  for (const row of rows) {
    if (row.status === 'succeeded') continue;
    if (only && !only.has(row.status)) continue;
    if (row.retryable || opts.include4xx) {
      selected.push(row);
    } else {
      excluded.push({ row, reason: `excluded: ${row.reason ?? `${row.code} (not retryable, use --include-4xx)`}` });
    }
  }
  return { selected, excluded };
}

export interface OriginalRequest {
  raw: string;
  value: any;
}

/** Index original request lines by custom_id, from the shards of a manifest or from the original input file. */
export function buildOriginalIndex(source: { manifestPath?: string; inputPath?: string }): { index: Map<string, OriginalRequest>; provider: ProviderName } {
  const index = new Map<string, OriginalRequest>();
  const files: string[] = [];
  let provider: ProviderName = 'openai';
  if (source.manifestPath) {
    const m = readManifest(source.manifestPath);
    provider = m.provider;
    for (const s of m.shards) files.push(join(dirname(source.manifestPath), s.file));
  } else if (source.inputPath) {
    files.push(source.inputPath);
  }
  for (const f of files) {
    if (!existsSync(f)) throw new BatchkitError('original_not_found', `Original request file not found: ${f}`, 'Keep the shard files next to manifest.json or pass --input <original file>.');
    const text = readFileSync(f, 'utf8');
    if (source.inputPath && !source.manifestPath) {
      provider = detectProvider(text);
    }
    for (const r of loadRequests(text, provider).requests) {
      if (r.customId !== null && !index.has(r.customId)) index.set(r.customId, { raw: r.raw, value: r.value });
    }
  }
  return { index, provider };
}

/**
 * Write the re-submission file. Lines are the original request lines, byte for byte
 * (Anthropic: a `{"requests":[...]}` document with the original params).
 */
export function writeRetryFile(selected: ResultRow[], original: Map<string, OriginalRequest>, provider: ProviderName, outDir: string): string {
  const missing = selected.filter((r) => !original.has(r.custom_id)).map((r) => r.custom_id);
  if (missing.length > 0) {
    throw new BatchkitError('original_not_found', `Original request not found for: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ' ...' : ''}`, 'Pass --manifest or --input pointing at the files the results came from.');
  }
  mkdirSync(outDir, { recursive: true });
  if (provider === 'anthropic') {
    const path = join(outDir, 'requests.json');
    const body = `{"requests":[\n${selected.map((r) => original.get(r.custom_id)!.raw).join(',\n')}\n]}\n`;
    writeFileSync(path, body);
    return path;
  }
  const path = join(outDir, 'input.jsonl');
  writeFileSync(path, selected.map((r) => original.get(r.custom_id)!.raw + '\n').join(''));
  return path;
}
