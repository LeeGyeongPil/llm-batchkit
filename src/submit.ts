import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fail } from './errors.js';
import type { Msg } from './i18n.js';
import { ownsRequests, readBatchesState, readManifest, writeJsonAtomic, type BatchesState, type Manifest, type ShardBatchState } from './manifest.js';
import { OpenAIBatchClient, resolveConnection } from './openai-batch.js';

/** Batch statuses after which nothing changes any more. */
export const TERMINAL = new Set(['completed', 'failed', 'expired', 'cancelled']);

export interface ConnectionOptions {
  baseUrl?: string | undefined;
  /** Test hook: use this client instead of building one from the environment. */
  client?: OpenAIBatchClient | undefined;
}

function openState(manifestPath: string, manifest: Manifest, opts: ConnectionOptions): { client: OpenAIBatchClient; state: BatchesState; statePath: string } {
  if (manifest.provider !== 'openai') {
    throw fail('unsupported_provider', 'err.unsupported_provider', { provider: manifest.provider }, 'err.unsupported_provider.hint');
  }
  const statePath = join(dirname(manifestPath), 'batches.json');
  const existing = readBatchesState(statePath);
  const conn = opts.client ? { baseUrl: opts.baseUrl ?? existing?.base_url ?? '', apiKey: '' } : resolveConnection({ baseUrl: opts.baseUrl ?? existing?.base_url });
  if (existing && opts.baseUrl && existing.base_url !== opts.baseUrl) {
    throw fail('base_url_changed', 'err.base_url_changed', { existing: existing.base_url, requested: opts.baseUrl }, 'err.base_url_changed.hint');
  }
  const client = opts.client ?? new OpenAIBatchClient(conn);
  const state: BatchesState = existing ?? { version: 1, base_url: conn.baseUrl, shards: {}, held: [] };
  return { client, state, statePath };
}

export interface SubmitOptions extends ConnectionOptions {
  completionWindow?: string | undefined;
  /** Provider-side "enqueued token" budget: do not have more estimated tokens in flight than this. */
  maxEnqueuedTokens?: number | undefined;
  dryRun?: boolean | undefined;
  /**
   * Send a shard again although its earlier batch already finished (completed, expired or cancelled)
   * and the shard file changed since. Those requests are billed again. Running batches are never replaced.
   */
  resubmitChanged?: boolean | undefined;
}

export interface SubmitResult {
  submitted: string[];
  /** Subset of `submitted` that replaces an earlier batch: it failed validation, or (with resubmitChanged) it finished and the shard changed. */
  resubmitted: string[];
  /** Why each resubmitted shard was sent again, e.g. "failed batch_1" or "changed after completed batch_1". */
  reasons: Record<string, string>;
  alreadySubmitted: string[];
  held: string[];
  /** Result files of a replaced batch, renamed (never deleted) so they do not mix with the new results. */
  setAside: string[];
  statePath: string;
}

/** What submit does with one shard of the manifest. */
type Decision =
  | { kind: 'new' } // never got a batch (also: upload done but createBatch interrupted)
  | { kind: 'skip' } // has a running or finished batch for the same file content
  | { kind: 'replace'; reason: string }; // failed batch, or finished batch + changed file + resubmitChanged

/**
 * Decide per shard, looking at the batch status first and the file hash second.
 * Collects every unsafe case before anything is uploaded, so a refused submit sends nothing at all.
 */
function decide(manifest: Manifest, state: BatchesState, dir: string, manifestSha: string, opts: SubmitOptions): Map<string, Decision> {
  const decisions = new Map<string, Decision>();
  const running: Msg[] = []; // changed while the provider is still working on it: never replaced
  const finished: Msg[] = []; // changed after results came back: replaced only with --resubmit-changed

  for (const shard of manifest.shards) {
    const prev = state.shards[shard.file];
    if (!prev?.batch_id) {
      decisions.set(shard.file, { kind: 'new' });
      continue;
    }
    // ① A failed batch processed nothing, so sending the shard again cannot bill a request twice.
    if (prev.status === 'failed') {
      decisions.set(shard.file, { kind: 'replace', reason: `failed ${prev.batch_id}` });
      continue;
    }
    // ② Running or finished: the file hash only matters to warn that the edit was not sent.
    const changed = prev.input_sha256 !== undefined && prev.input_sha256 !== sha256File(join(dir, shard.file));
    if (!changed) {
      decisions.set(shard.file, { kind: 'skip' });
    } else if (!TERMINAL.has(prev.status)) {
      running.push({ key: 'err.changed_running', params: { file: shard.file, id: prev.batch_id, status: prev.status } });
    } else if (!opts.resubmitChanged) {
      finished.push({ key: 'err.changed_finished', params: { file: shard.file, id: prev.batch_id, status: prev.status } });
    } else {
      decisions.set(shard.file, { kind: 'replace', reason: `changed after ${prev.status} ${prev.batch_id}` });
    }
  }

  // ③ Batches the manifest no longer mentions (the folder was split again): their requests may now sit in other shards.
  const inManifest = new Set(manifest.shards.map((s) => s.file));
  for (const [file, s] of Object.entries(state.shards)) {
    if (!inManifest.has(file) && ownsRequests(s)) running.push({ key: 'err.not_in_manifest', params: { id: s.batch_id ?? '?', status: s.status, file } });
  }
  // ④ The manifest itself changed (re-split, hand edit) while batches own requests: shards may now overlap them.
  const owners = Object.values(state.shards).filter(ownsRequests);
  if (owners.length > 0 && state.manifest_sha256 !== undefined && state.manifest_sha256 !== manifestSha && !opts.resubmitChanged) {
    finished.push({ key: 'err.manifest_changed', params: { n: owners.length } });
  }

  if (running.length > 0 || finished.length > 0) {
    const problems = [...running, ...finished];
    throw fail('shard_changed', 'err.shard_changed', { problems }, running.length > 0 ? 'err.shard_changed.runningHint' : 'err.shard_changed.finishedHint');
  }
  return decisions;
}

/** Move the result files of a replaced batch out of the way: shard-000.output.jsonl -> shard-000.output.replaced-<batch>.jsonl. */
function setAsideResults(dir: string, file: string, batchId: string): string[] {
  const stem = file.replace(/\.[^.]+$/, '');
  const moved: string[] = [];
  for (const suffix of ['output', 'error']) {
    const from = join(dir, `${stem}.${suffix}.jsonl`);
    if (!existsSync(from)) continue;
    const to = `${stem}.${suffix}.replaced-${batchId}.jsonl`; // merge only reads *.output.jsonl / *.error.jsonl, so this is ignored
    renameSync(from, join(dir, to));
    moved.push(to);
  }
  return moved;
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export async function submit(manifestPath: string, opts: SubmitOptions = {}): Promise<SubmitResult> {
  const manifest = readManifest(manifestPath);
  const dir = dirname(manifestPath);
  const { client, state, statePath } = openState(manifestPath, manifest, opts);
  const manifestSha = sha256File(manifestPath);
  const budget = opts.maxEnqueuedTokens;

  const tooBig = budget === undefined ? undefined : manifest.shards.find((s) => s.est_tokens > budget);
  if (tooBig) {
    throw fail('shard_exceeds_budget', 'err.shard_exceeds_budget', { file: tooBig.file, tokens: tooBig.est_tokens, budget: budget as number }, 'err.shard_exceeds_budget.hint');
  }

  // Tokens still queued on the provider side = shards whose batch is not finished (refresh with `collect`).
  let enqueued = Object.values(state.shards)
    .filter((s) => s.batch_id !== null && !TERMINAL.has(s.status))
    .reduce((sum, s) => sum + s.submitted_est_tokens, 0);

  // Status first: decide every shard (and refuse unsafe cases) before a single byte is uploaded.
  const decisions = decide(manifest, state, dir, manifestSha, opts);
  if (!opts.dryRun) state.manifest_sha256 = manifestSha; // the manifest these batches belong to (checked by the next submit)

  const submitted: string[] = [];
  const resubmitted: string[] = [];
  const reasons: Record<string, string> = {};
  const alreadySubmitted: string[] = [];
  const held: string[] = [];
  const setAside: string[] = [];
  let blocked = false;
  for (const shard of manifest.shards) {
    const decision = decisions.get(shard.file)!;
    let prev = state.shards[shard.file];
    if (decision.kind === 'skip') {
      alreadySubmitted.push(shard.file); // idempotent: a running or finished batch is never uploaded twice
      continue;
    }
    if (blocked || (budget !== undefined && enqueued + shard.est_tokens > budget)) {
      blocked = true; // keep shard order: once one is held, everything after it waits too
      held.push(shard.file);
      continue;
    }
    submitted.push(shard.file);
    if (decision.kind === 'replace') {
      resubmitted.push(shard.file);
      reasons[shard.file] = decision.reason;
    }
    enqueued += shard.est_tokens;
    if (opts.dryRun) continue;

    if (decision.kind === 'replace' && prev?.batch_id) {
      // Keep the old batch (ids and result file ids) in history, and rename - never delete - its result files.
      const old = { batch_id: prev.batch_id, status: prev.status, input_sha256: prev.input_sha256 ?? null, output_file_id: prev.output_file_id, error_file_id: prev.error_file_id };
      const moved = setAsideResults(dir, shard.file, prev.batch_id);
      setAside.push(...moved);
      const history = [...(prev.history ?? []), { ...old, set_aside: moved }];
      prev = { input_file_id: null, batch_id: null, status: 'uploading', output_file_id: null, error_file_id: null, submitted_est_tokens: shard.est_tokens, downloaded: false, history };
      state.shards[shard.file] = prev;
      writeJsonAtomic(statePath, state); // the history survives a crash during the upload below
    }
    const sha = sha256File(join(dir, shard.file));
    const entry: ShardBatchState = prev ?? { input_file_id: null, batch_id: null, status: 'uploading', output_file_id: null, error_file_id: null, submitted_est_tokens: shard.est_tokens, downloaded: false };
    state.shards[shard.file] = entry;
    if (entry.input_sha256 !== undefined && entry.input_sha256 !== sha) entry.input_file_id = null; // edited after an interrupted upload
    entry.input_sha256 = sha;
    if (!entry.input_file_id) {
      entry.input_file_id = (await client.uploadFile(shard.file, readFileSync(join(dir, shard.file), 'utf8'))).id;
      writeJsonAtomic(statePath, state); // remember the upload so a crash before createBatch does not re-upload
    }
    const batch = await client.createBatch({ input_file_id: entry.input_file_id, endpoint: shard.url, completion_window: opts.completionWindow ?? '24h' });
    entry.batch_id = batch.id;
    entry.status = batch.status;
    state.held = held;
    writeJsonAtomic(statePath, state);
  }
  if (!opts.dryRun) {
    state.held = held;
    writeJsonAtomic(statePath, state);
  }
  return { submitted, resubmitted, reasons, alreadySubmitted, held, setAside, statePath };
}

export interface CollectOptions extends ConnectionOptions {
  wait?: boolean | undefined;
  /** Seconds between polls with --wait (default 30). */
  intervalSeconds?: number | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
  onProgress?: ((line: string) => void) | undefined;
}

export interface CollectShard {
  file: string;
  status: string;
  downloaded: string[];
  failures: string[];
}

export interface CollectResult {
  shards: CollectShard[];
  /** 0 all done, 1 a batch failed validation, 2 still running or not yet submitted. */
  exitCode: 0 | 1 | 2;
  notSubmitted: string[];
}

export async function collect(manifestPath: string, opts: CollectOptions = {}): Promise<CollectResult> {
  const manifest = readManifest(manifestPath);
  const dir = dirname(manifestPath);
  const { client, state, statePath } = openState(manifestPath, manifest, opts);
  if (Object.keys(state.shards).length === 0) {
    throw fail('nothing_submitted', 'err.nothing_submitted', {}, 'err.nothing_submitted.hint');
  }
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const infoByFile = new Map<string, CollectShard>(); // survives --wait polling rounds
  for (;;) {
    const shards: CollectShard[] = [];
    const notSubmitted: string[] = [];
    for (const shard of manifest.shards) {
      const entry = state.shards[shard.file];
      if (!entry?.batch_id) {
        notSubmitted.push(shard.file);
        continue;
      }
      const info: CollectShard = infoByFile.get(shard.file) ?? { file: shard.file, status: entry.status, downloaded: [], failures: [] };
      infoByFile.set(shard.file, info);
      info.failures = [];
      shards.push(info);
      if (entry.downloaded) continue; // already fetched on an earlier run

      const batch = await client.getBatch(entry.batch_id);
      entry.status = batch.status;
      info.status = batch.status;
      entry.output_file_id = batch.output_file_id ?? null;
      entry.error_file_id = batch.error_file_id ?? null;

      if (batch.status === 'failed') {
        // Batch-level validation errors refer to line numbers of the uploaded shard; show custom_ids instead.
        for (const e of batch.errors?.data ?? []) {
          const where = typeof e.line === 'number' ? `line ${e.line} ${e.code ?? 'error'} (custom_id ${shard.custom_ids[e.line - 1] ?? '?'})` : `${e.code ?? 'error'}: ${e.message ?? ''}`;
          info.failures.push(e.line != null && typeof e.message === 'string' ? `${where} - ${e.message}` : where);
        }
        if (info.failures.length === 0) info.failures.push('batch failed without error details');
      } else if (batch.status === 'completed' || batch.status === 'expired' || batch.status === 'cancelled') {
        const stem = shard.file.replace(/\.[^.]+$/, '');
        for (const [id, suffix] of [[entry.output_file_id, 'output'], [entry.error_file_id, 'error']] as const) {
          if (!id) continue;
          const name = `${stem}.${suffix}.jsonl`;
          writeFileSync(join(dir, name), await client.downloadFile(id));
          info.downloaded.push(name);
        }
        entry.downloaded = true;
      }
      writeJsonAtomic(statePath, state);
    }

    const failed = shards.some((s) => s.status === 'failed');
    const running = shards.some((s) => !TERMINAL.has(s.status));
    const exitCode: 0 | 1 | 2 = failed ? 1 : running || notSubmitted.length > 0 ? 2 : 0;
    if (opts.wait && running && !failed) {
      opts.onProgress?.(`${shards.filter((s) => !TERMINAL.has(s.status)).length} batch(es) still running; checking again in ${opts.intervalSeconds ?? 30}s`);
      await sleep((opts.intervalSeconds ?? 30) * 1000);
      continue;
    }
    return { shards, exitCode, notSubmitted };
  }
}
