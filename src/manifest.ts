import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fail } from './errors.js';
import type { Limits } from './providers.js';
import type { ProviderName } from './types.js';

export interface ShardInfo {
  file: string;
  url: string;
  model: string;
  count: number;
  bytes: number;
  est_tokens: number;
  custom_ids: string[];
}

/** Deterministic description of a split run: no timestamps, same input gives the same manifest. */
export interface Manifest {
  version: 1;
  provider: ProviderName;
  input_format: 'jsonl' | 'json';
  source: string;
  source_sha256: string;
  limits: Limits;
  /** custom_ids in original input order (first occurrence). */
  order: string[];
  shards: ShardInfo[];
}

export interface ShardBatchState {
  input_file_id: string | null;
  batch_id: string | null;
  status: string;
  output_file_id: string | null;
  error_file_id: string | null;
  submitted_est_tokens: number;
  downloaded: boolean;
  /** sha256 of the uploaded shard file; a different hash later means the shard was edited. */
  input_sha256?: string;
  /** Earlier batches of this shard that failed or were replaced (with --resubmit-changed). */
  history?: {
    batch_id: string;
    status: string;
    input_sha256: string | null;
    output_file_id?: string | null;
    error_file_id?: string | null;
    /** Result files of that batch, renamed to *.replaced-<batch_id>.jsonl instead of being deleted. */
    set_aside?: string[];
  }[];
}

/** Submission record kept next to the manifest so `submit` and `collect` can resume. */
export interface BatchesState {
  version: 1;
  base_url: string;
  /** sha256 of the manifest.json the batches were created from; a re-split folder is refused while batches own requests. */
  manifest_sha256?: string;
  shards: Record<string, ShardBatchState>;
  held: string[];
}

/**
 * Batches that "own" their requests: still running, or finished with results (completed, expired, cancelled).
 * Their shards must never be sent again by accident - that would bill the same requests twice.
 * Only a `failed` batch (rejected by input validation, nothing processed) gives its shard back.
 */
export function ownsRequests(s: { batch_id: string | null; status: string }): boolean {
  return Boolean(s.batch_id) && s.status !== 'failed';
}

export function writeJsonAtomic(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  renameSync(tmp, path); // never leave a half-written state file behind
}

export function readManifest(path: string): Manifest {
  let parsed: any;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw fail('invalid_manifest', 'err.manifest_read', { path, detail: (e as Error).message }, 'err.manifest_read.hint');
  }
  if (parsed?.version !== 1 || !Array.isArray(parsed.order) || !Array.isArray(parsed.shards)) {
    throw fail('invalid_manifest', 'err.manifest_bad', { path }, 'err.manifest_bad.hint');
  }
  return parsed as Manifest;
}

export function readBatchesState(path: string): BatchesState | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as BatchesState;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw fail('invalid_state', 'err.cannot_read', { path, detail: (e as Error).message }, 'err.state_read.hint');
  }
}
