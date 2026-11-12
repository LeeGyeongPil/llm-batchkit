import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';
import { runCli } from '../src/cli.js';
import { splitFile } from '../src/split.js';

export const FX = join(import.meta.dirname, 'fixtures');
export const fx = (...parts: string[]): string => join(FX, ...parts);

const dirs: string[] = [];
/** Fresh temp folder, removed after the test file finishes. */
export function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'llm-batchkit-test-'));
  dirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Run the CLI in-process. Pass `env` to choose the language by environment (default: the English pinned by test/setup.ts). */
export async function cli(args: string[], env?: NodeJS.ProcessEnv): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const code = await runCli(args, { out: (s) => (out += s), err: (s) => (err += s), color: false, ...(env ? { env } : {}) });
  return { code, out, err };
}

export const ROUND1 = ['shard-000.output.jsonl', 'shard-001.output.jsonl', 'shard-001.error.jsonl'].map((f) => fx('openai', f));

/** Split the 12-line fixture into two shards of 6 inside a fresh folder. */
export function makeRun(): { dir: string; manifestPath: string } {
  const dir = tmp();
  const { manifestPath } = splitFile(fx('openai/input.jsonl'), { out: dir, maxRequests: 6 });
  return { dir, manifestPath };
}

export const lines = (path: string): string[] => readFileSync(path, 'utf8').split('\n').filter((l) => l !== '');

/** Run `fn` and return the BatchkitError it throws (fails the test if it does not throw). */
export function errOf(fn: () => unknown): { code: string; message: string; hint: string | undefined } {
  try {
    fn();
  } catch (e) {
    const err = e as { code: string; message: string; hint?: string };
    return { code: err.code, message: err.message, hint: err.hint };
  }
  throw new Error('expected the function to throw');
}
