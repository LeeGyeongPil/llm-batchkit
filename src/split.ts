import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { BatchkitError } from './errors.js';
import { detectProvider, loadRequests } from './jsonl.js';
import { lintText, readInputFile } from './lint.js';
import { ownsRequests, readBatchesState, writeJsonAtomic, type Manifest, type ShardInfo } from './manifest.js';
import { PRESETS, resolveLimits } from './providers.js';
import { estimateTokens } from './tokens.js';
import type { ParsedRequest, ProviderName } from './types.js';

export interface SplitOptions {
  out: string;
  provider?: ProviderName | 'auto' | undefined;
  maxRequests?: number | undefined;
  maxBytes?: number | undefined;
  maxTokens?: number | undefined;
  /** Skip the line-level lint gate (the provider may still reject the shard after upload). */
  skipLint?: boolean | undefined;
  /** Write into an output folder that already holds submission state or result files. */
  force?: boolean | undefined;
}

export interface SplitResult {
  manifest: Manifest;
  manifestPath: string;
}

function chunk(reqs: ParsedRequest[], maxRequests: number, maxBytes: number, maxTokens: number | null) {
  const chunks: { reqs: ParsedRequest[]; bytes: number; tokens: number }[] = [];
  let cur = { reqs: [] as ParsedRequest[], bytes: 0, tokens: 0 };
  for (const r of reqs) {
    const t = estimateTokens(r.value);
    const full =
      cur.reqs.length >= maxRequests ||
      cur.bytes + r.bytes > maxBytes ||
      (maxTokens !== null && cur.tokens + t > maxTokens);
    if (cur.reqs.length > 0 && full) {
      chunks.push(cur);
      cur = { reqs: [], bytes: 0, tokens: 0 };
    }
    cur.reqs.push(r);
    cur.bytes += r.bytes;
    cur.tokens += t;
  }
  if (cur.reqs.length > 0) chunks.push(cur);
  return chunks;
}

/**
 * `split --force` may only overwrite shards nobody owns any more: every batch there failed validation
 * and no results came back. Otherwise the new shards would be submitted next to running or finished
 * batches with the same requests, and those requests would be billed twice.
 */
function refuseIfBatchesOwnRequests(out: string, used: string[]): void {
  const owners: string[] = used.filter((f) => f !== 'batches.json'); // result files mean a batch already finished
  const state = used.includes('batches.json') ? readBatchesState(join(out, 'batches.json')) : null;
  for (const [file, s] of Object.entries(state?.shards ?? {})) {
    if (ownsRequests(s)) owners.push(`${file} ${s.batch_id} ${s.status}`);
  }
  if (owners.length > 0) {
    throw new BatchkitError(
      'out_dir_has_batches',
      `${out} has running or finished batches (${owners.join(', ')}); --force would submit their requests twice`,
      'Split into a new folder (for example run2) - each folder is one submission, and merge/retry work per folder. --force only re-splits a folder whose batches all failed validation.',
    );
  }
}

/**
 * Group requests by (endpoint, model), then cut each group into shards that respect the
 * request-count, byte and estimated-token limits. Shards keep original lines byte-for-byte.
 */
export function splitFile(inputPath: string, opts: SplitOptions): SplitResult {
  const text = readInputFile(inputPath);
  const provider: ProviderName =
    opts.provider === undefined || opts.provider === 'auto' ? detectProvider(text) : opts.provider;
  const preset = PRESETS[provider];
  const limits = resolveLimits(preset, opts);

  if (!opts.skipLint) {
    // File-level findings (mixed models, too many requests ...) are exactly what splitting fixes; only line-level errors block.
    const report = lintText(text, { ...opts, provider, name: inputPath });
    const lineErrors = report.issues.filter((i) => i.severity === 'error' && i.line > 0);
    if (lineErrors.length > 0) {
      const first = lineErrors[0]!;
      throw new BatchkitError(
        'lint_failed',
        `${lineErrors.length} line-level error(s); first: line ${first.line} ${first.code} (${first.message})`,
        'Fix them (see `llm-batchkit lint`), or pass --skip-lint to split anyway.',
      );
    }
  }

  const loaded = loadRequests(text, provider);
  const requests = loaded.requests.map((r) => (r.customId === null ? { ...r, customId: `<line ${r.line}>` } : r));
  if (requests.length === 0) {
    throw new BatchkitError('empty_input', `No requests found in ${inputPath}`, 'Check that the file is JSONL (one request per line) or {"requests":[...]}.');
  }

  // A single request bigger than a shard limit can never be placed.
  const tooLarge: string[] = [];
  for (const r of requests) {
    if (r.bytes > limits.maxBytes) tooLarge.push(`line ${r.line}: ${r.bytes} bytes > --max-bytes ${limits.maxBytes}`);
    const t = estimateTokens(r.value);
    if (limits.maxTokens !== null && t > limits.maxTokens) tooLarge.push(`line ${r.line}: ~${t} tokens > --max-tokens ${limits.maxTokens}`);
  }
  if (tooLarge.length > 0) {
    throw new BatchkitError('line_too_large', `line_too_large: ${tooLarge.join('; ')}`, 'Raise the limit or shorten that request; one request cannot be split.');
  }

  // Group by (endpoint, model); Anthropic batches may mix models so they stay in one group.
  const groups = new Map<string, ParsedRequest[]>();
  for (const r of requests) {
    const key = provider === 'anthropic' ? '' : `${r.url ?? ''}\u0000${r.model ?? ''}`;
    const list = groups.get(key);
    if (list) list.push(r);
    else groups.set(key, [r]);
  }

  if (existsSync(opts.out)) {
    // A run folder that was already submitted: new shards would not match batches.json and the result files.
    const used = readdirSync(opts.out).filter((f) => f === 'batches.json' || f === 'results.jsonl' || /\.(output|error)\.jsonl$/.test(f));
    if (used.length > 0 && !opts.force) {
      throw new BatchkitError('out_dir_in_use', `${opts.out} already holds submission state or results (${used.join(', ')})`, 'Split into a new folder (for example run2). To fix a failed batch, edit its shard file there and run submit again. --force re-splits only a folder whose batches all failed validation.');
    }
    if (used.length > 0) refuseIfBatchesOwnRequests(opts.out, used);
  }
  mkdirSync(opts.out, { recursive: true });
  const ext = provider === 'anthropic' ? 'json' : 'jsonl';
  const shards: ShardInfo[] = [];
  for (const group of groups.values()) {
    for (const c of chunk(group, limits.maxRequests, limits.maxBytes, limits.maxTokens)) {
      const file = `shard-${String(shards.length).padStart(3, '0')}.${ext}`;
      const body =
        provider === 'anthropic'
          ? `{"requests":[\n${c.reqs.map((r) => r.raw).join(',\n')}\n]}\n`
          : c.reqs.map((r) => r.raw + '\n').join('');
      writeFileSync(join(opts.out, file), body);
      const first = c.reqs[0]!;
      shards.push({
        file,
        url: provider === 'anthropic' ? '/v1/messages/batches' : (first.url ?? ''),
        model: provider === 'anthropic' ? 'mixed' : (first.model ?? ''),
        count: c.reqs.length,
        bytes: c.bytes,
        est_tokens: c.tokens,
        custom_ids: c.reqs.map((r) => r.customId as string),
      });
    }
  }

  const manifest: Manifest = {
    version: 1,
    provider,
    input_format: loaded.format,
    source: basename(inputPath),
    source_sha256: createHash('sha256').update(text).digest('hex'),
    limits,
    order: [...new Set(requests.map((r) => r.customId as string))],
    shards,
  };
  const manifestPath = join(opts.out, 'manifest.json');
  writeJsonAtomic(manifestPath, manifest);
  return { manifest, manifestPath };
}
