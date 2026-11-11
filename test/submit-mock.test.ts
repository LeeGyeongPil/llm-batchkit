import { createServer } from 'node:http';
import { appendFileSync, copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mergeResults } from '../src/merge.js';
import { readManifest } from '../src/manifest.js';
import { startMockServer, type MockServer } from '../src/mock/server.js';
import { OpenAIBatchClient } from '../src/openai-batch.js';
import { collect, submit } from '../src/submit.js';
import { cli, fx, makeRun, tmp } from './helpers.js';

let server: MockServer;
const posts = (path: string) => server.routes.filter((r) => r.method === 'POST' && r.path === path);

beforeEach(() => {
  vi.stubEnv('OPENAI_API_KEY', ''); // prove no real key is needed
  vi.stubEnv('OPENAI_BASE_URL', '');
});
afterEach(async () => {
  await server?.close();
  vi.unstubAllEnvs();
});

describe('submit / collect against the practice mock', () => {
  it('uploads each shard once and collects files', async () => {
    server = await startMockServer();
    expect(server.baseUrl.startsWith('http://127.0.0.1:')).toBe(true); // loopback only
    const { manifestPath, dir } = makeRun();

    const first = await cli(['submit', manifestPath, '--base-url', server.baseUrl]);
    expect(first.code).toBe(0);
    expect(first.out).toContain('2 submitted');
    const uploads = posts('/v1/files');
    expect(uploads).toHaveLength(2);
    expect(uploads.map((u) => u.purpose)).toEqual(['batch', 'batch']);
    expect(uploads.map((u) => u.filename)).toEqual(['shard-000.jsonl', 'shard-001.jsonl']);
    expect(uploads[0]!.fileText).toBe(readFileSync(join(dir, 'shard-000.jsonl'), 'utf8')); // multipart carries the shard bytes
    const creates = posts('/v1/batches');
    expect(creates).toHaveLength(2);
    expect(creates.map((c) => [c.endpoint, c.completion_window])).toEqual([['/v1/chat/completions', '24h'], ['/v1/chat/completions', '24h']]);

    const state = JSON.parse(readFileSync(join(dir, 'batches.json'), 'utf8')) as { base_url: string; shards: Record<string, { batch_id: string; input_file_id: string }> };
    expect(Object.keys(state.shards)).toEqual(['shard-000.jsonl', 'shard-001.jsonl']);
    expect(state.shards['shard-000.jsonl']!.batch_id).toMatch(/^batch_mock_/);
    expect(readFileSync(join(dir, 'batches.json'), 'utf8')).not.toMatch(/sk-|Bearer/); // no secrets in the state file

    // idempotent: running submit again does not POST anything
    const again = await cli(['submit', manifestPath, '--base-url', server.baseUrl]);
    expect(again.code).toBe(0);
    expect(again.out).toContain('already submitted');
    expect(again.out).toContain('0 submitted · 2 already submitted');
    expect(posts('/v1/files')).toHaveLength(2);
    expect(posts('/v1/batches')).toHaveLength(2);

    const got = await cli(['collect', manifestPath, '--base-url', server.baseUrl]);
    expect(got.code).toBe(0);
    for (const f of ['shard-000.output.jsonl', 'shard-001.output.jsonl', 'shard-001.error.jsonl']) expect(existsSync(join(dir, f))).toBe(true);
    expect(existsSync(join(dir, 'shard-000.error.jsonl'))).toBe(false); // nothing failed in the error file for shard 0

    // collect is also idempotent: finished batches are not downloaded again
    const getCalls = server.routes.length;
    expect((await cli(['collect', manifestPath, '--base-url', server.baseUrl])).code).toBe(0);
    expect(server.routes.length).toBe(getCalls);
  });

  it('merge after collect matches round1', async () => {
    server = await startMockServer();
    const { manifestPath } = makeRun();
    await cli(['submit', manifestPath, '--base-url', server.baseUrl]);
    await cli(['collect', manifestPath, '--base-url', server.baseUrl]);
    const report = mergeResults(manifestPath);
    expect(report.summary).toEqual({ succeeded: 7, failed: 2, expired: 1, cancelled: 1, missing: 1 });
    const row = (id: string) => report.rows.find((r) => r.custom_id === id)!;
    expect(row('req-004')).toMatchObject({ status: 'failed', code: 400, retryable: false, source: 'shard-000.output.jsonl' }); // a 400 inside the output file
    expect(row('req-011')).toMatchObject({ status: 'failed', code: 500, retryable: true, source: 'shard-001.error.jsonl' });
    expect(row('req-006').status).toBe('missing');
    // the mock builds the text from the uploaded request, and shuffles result order
    expect(row('req-001').text).toBe('[mock] The library opens at 9 and closes at 6 o');
    const out = readFileSync(join(makeRunDir(manifestPath), 'shard-000.output.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).custom_id);
    expect(out).toEqual([...out].sort().reverse());
  });

  it('retry round through the mock ends at succeeded 11 · failed 1', async () => {
    server = await startMockServer();
    const { manifestPath, dir } = makeRun();
    await cli(['submit', manifestPath, '--base-url', server.baseUrl]);
    await cli(['collect', manifestPath, '--base-url', server.baseUrl]);
    const m = await cli(['merge', manifestPath]);
    expect(m.code).toBe(0);
    expect((await cli(['retry', join(dir, 'results.jsonl'), '--out', join(dir, 'retry-1')])).out).toContain('4 to retry · 1 excluded');
    const retryManifest = join(dir, 'retry-1', 'manifest.json');
    expect((await cli(['split', join(dir, 'retry-1', 'input.jsonl'), '--out', join(dir, 'retry-1')])).code).toBe(0);
    await cli(['submit', retryManifest, '--base-url', server.baseUrl]);
    expect((await cli(['collect', retryManifest, '--base-url', server.baseUrl])).code).toBe(0);
    const final = mergeResults(manifestPath);
    expect(final.summary).toEqual({ succeeded: 11, failed: 1 });
    expect(final.rows.find((r) => r.custom_id === 'req-004')).toMatchObject({ status: 'failed', code: 400 });
    // a second retry round has nothing left to pick (idempotent)
    await cli(['merge', manifestPath]);
    expect((await cli(['retry', join(dir, 'results.jsonl'), '--out', join(dir, 'retry-2')])).out).toContain('nothing to retry');
  });

  it('batch-level validation failure maps lines', async () => {
    server = await startMockServer();
    const dir = tmp();
    const dup = join(dir, 'dup.jsonl');
    const line = (text: string) => JSON.stringify({ custom_id: 'a-1', method: 'POST', url: '/v1/chat/completions', body: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: text }] } });
    writeFileSync(dup, `${line('first')}\n${line('second, same custom_id')}\n`);
    const run = join(dir, 'run');
    expect((await cli(['split', dup, '--out', run, '--skip-lint'])).code).toBe(0);
    expect((await cli(['split', dup, '--out', join(dir, 'refused')])).code).toBe(1); // without --skip-lint the lint gate refuses
    const manifest = join(run, 'manifest.json');
    expect((await cli(['submit', manifest, '--base-url', server.baseUrl])).code).toBe(0); // upload itself succeeds
    const got = await cli(['collect', manifest, '--base-url', server.baseUrl]);
    expect(got.code).toBe(1);
    expect(got.out).toContain('line 2 duplicate_custom_id (custom_id a-1)');
    expect(got.out).toContain('failed');
    expect(existsSync(join(run, 'shard-000.output.jsonl'))).toBe(false);
  });

  it('enqueued token budget holds shards', async () => {
    server = await startMockServer();
    const { manifestPath } = makeRun();
    const est0 = readManifest(manifestPath).shards[0]!.est_tokens;
    const first = await cli(['submit', manifestPath, '--base-url', server.baseUrl, '--max-enqueued-tokens', String(est0 + 1)]);
    expect(first.code).toBe(0);
    expect(first.out).toContain('held 1 shard (enqueued token budget)');
    expect(posts('/v1/batches')).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(manifestPath, '..', 'batches.json'), 'utf8')).held).toEqual(['shard-001.jsonl']);

    // before the first batch is collected it still counts as enqueued, so the second shard stays held
    const still = await cli(['submit', manifestPath, '--base-url', server.baseUrl, '--max-enqueued-tokens', String(est0 + 1)]);
    expect(still.out).toContain('held 1 shard');
    expect(posts('/v1/batches')).toHaveLength(1);

    const got = await cli(['collect', manifestPath, '--base-url', server.baseUrl]);
    expect(got.code).toBe(2); // shard-001 not submitted yet
    expect(got.out).toContain('1 shard not submitted yet');
    const rest = await cli(['submit', manifestPath, '--base-url', server.baseUrl, '--max-enqueued-tokens', String(est0 + 1)]);
    expect(rest.out).toContain('1 submitted');
    expect(posts('/v1/batches')).toHaveLength(2);
    expect(posts('/v1/files')).toHaveLength(2); // shard-000 was never uploaded twice
    expect((await cli(['collect', manifestPath, '--base-url', server.baseUrl])).code).toBe(0);
  });

  it('a budget smaller than one shard fails early with a fix', async () => {
    server = await startMockServer();
    const { manifestPath } = makeRun();
    const r = await cli(['submit', manifestPath, '--base-url', server.baseUrl, '--max-enqueued-tokens', '10']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('--max-tokens');
    expect(server.routes).toHaveLength(0);
  });

  it('dry run sends nothing and writes no state', async () => {
    server = await startMockServer();
    const { manifestPath, dir } = makeRun();
    const r = await cli(['submit', manifestPath, '--base-url', server.baseUrl, '--dry-run']);
    expect(r.out).toContain('would submit');
    expect(server.routes).toHaveLength(0);
    expect(existsSync(join(dir, 'batches.json'))).toBe(false);
  });

  it('in-progress batches give exit 2; --wait polls until done', async () => {
    server = await startMockServer({ scenario: { results: {}, pollsBeforeDone: 1 } });
    const { manifestPath, dir } = makeRun();
    await cli(['submit', manifestPath, '--base-url', server.baseUrl]);
    const early = await cli(['collect', manifestPath, '--base-url', server.baseUrl]);
    expect(early.code).toBe(2);
    expect(early.out).toContain('not finished yet');
    const sleeps: number[] = [];
    const done = await collect(manifestPath, { baseUrl: server.baseUrl, wait: true, intervalSeconds: 7, sleep: async (ms) => void sleeps.push(ms) });
    expect(done.exitCode).toBe(0);
    expect(sleeps).toEqual([]); // the earlier collect already consumed the in_progress poll
    expect(done.shards.flatMap((s) => s.downloaded).sort()).toEqual(['shard-000.output.jsonl', 'shard-001.output.jsonl']);
    expect(existsSync(join(dir, 'shard-001.output.jsonl'))).toBe(true);
  });

  it('collect --wait keeps downloaded names across polling rounds', async () => {
    server = await startMockServer({ scenario: { results: {}, pollsBeforeDone: 2 } });
    const { manifestPath } = makeRun();
    await cli(['submit', manifestPath, '--base-url', server.baseUrl]);
    const sleeps: number[] = [];
    const done = await collect(manifestPath, { baseUrl: server.baseUrl, wait: true, intervalSeconds: 7, sleep: async (ms) => void sleeps.push(ms) });
    expect(sleeps).toEqual([7000, 7000]);
    expect(done.exitCode).toBe(0);
    expect(done.shards.map((s) => s.status)).toEqual(['completed', 'completed']);
  });

  it('without a key a non-local endpoint is refused with a fix; local endpoints work', async () => {
    const { manifestPath } = makeRun();
    const r = await cli(['submit', manifestPath, '--base-url', 'https://batch.example.invalid/v1']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('OPENAI_API_KEY');
    expect(r.err).toContain('npm run demo');
  });

  it('anthropic manifests are not submittable yet (clear message)', async () => {
    const dir = tmp();
    const { splitFile } = await import('../src/split.js');
    const { manifestPath } = splitFile(fx('anthropic/requests-ok.json'), { out: dir });
    const r = await cli(['submit', manifestPath, '--base-url', 'http://127.0.0.1:1/v1']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('OpenAI-compatible endpoints only');
  });

  it('refuses to mix base URLs in one batches.json', async () => {
    server = await startMockServer();
    const { manifestPath } = makeRun();
    await cli(['submit', manifestPath, '--base-url', server.baseUrl]);
    const r = await cli(['submit', manifestPath, '--base-url', 'http://127.0.0.1:9/v1']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('belongs to');
    expect(r.err).toContain('fix:');
  });
});

describe('http client', () => {
  it('retries 429 / 5xx with backoff, but not other 4xx', async () => {
    let calls = 0;
    const flaky = createServer((req, res) => {
      calls++;
      if (req.url === '/v1/batches/x') {
        if (calls <= 2) return void res.writeHead(calls === 1 ? 429 : 503).end('slow down');
        return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'x', status: 'completed' }));
      }
      res.writeHead(401).end('nope');
    });
    await new Promise<void>((r) => flaky.listen(0, '127.0.0.1', () => r()));
    const base = `http://127.0.0.1:${(flaky.address() as AddressInfo).port}/v1`;
    try {
      const client = new OpenAIBatchClient({ baseUrl: base, apiKey: 'test-placeholder', backoffMs: 0 }); // gitleaks:allow
      expect((await client.getBatch('x')).status).toBe('completed');
      expect(calls).toBe(3); // 429, 503, then 200
    } catch (e) {
      flaky.closeAllConnections();
      throw e;
    }
    try {
      calls = 0;
      const client = new OpenAIBatchClient({ baseUrl: base, apiKey: 'test-placeholder', backoffMs: 0 }); // gitleaks:allow
      await expect(client.getBatch('other')).rejects.toMatchObject({ code: 'http_error', hint: 'Check OPENAI_API_KEY.' }); // 401 is not retried
      expect(calls).toBe(1);
      calls = 0;
      const always = new OpenAIBatchClient({ baseUrl: base.replace('/v1', '/none'), apiKey: 'test-placeholder', backoffMs: 0, attempts: 2 }); // gitleaks:allow
      await expect(always.getBatch('x')).rejects.toMatchObject({ code: 'http_error' });
    } finally {
      flaky.closeAllConnections();
      await new Promise<void>((r) => flaky.close(() => r()));
    }
  });
});

function makeRunDir(manifestPath: string): string {
  return join(manifestPath, '..');
}

describe('failed batches can be fixed and sent again (Q-1)', () => {
  const line = (id: string, text: string) => JSON.stringify({ custom_id: id, method: 'POST', url: '/v1/chat/completions', body: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: text }] } });

  it('resubmits only the failed shard after the file is fixed, then collect succeeds', async () => {
    server = await startMockServer();
    const dir = tmp();
    const input = join(dir, 'in.jsonl');
    // 4 requests, 2 per shard; the first shard contains a duplicate custom_id, so the provider rejects that batch
    writeFileSync(input, [line('a-1', 'x'), line('a-1', 'dup'), line('b-1', 'y'), line('b-2', 'z')].join('\n') + '\n');
    const run = join(dir, 'run');
    expect((await cli(['split', input, '--out', run, '--skip-lint', '--max-requests', '2'])).code).toBe(0);
    const manifest = join(run, 'manifest.json');
    expect((await cli(['submit', manifest, '--base-url', server.baseUrl])).code).toBe(0);
    expect(posts('/v1/files')).toHaveLength(2);

    const failed = await cli(['collect', manifest, '--base-url', server.baseUrl]);
    expect(failed.code).toBe(1);
    expect(failed.out).toContain('duplicate_custom_id');
    expect(failed.out).toContain('only failed shards are sent again'); // message matches what submit really does
    const failedBatch = (JSON.parse(readFileSync(join(run, 'batches.json'), 'utf8')) as { shards: Record<string, { batch_id: string }> }).shards['shard-000.jsonl']!.batch_id;

    // unchanged failed shard is sent again too (it may have been a transient failure); proves the fix path is taken
    const dry = await cli(['submit', manifest, '--base-url', server.baseUrl, '--dry-run']);
    expect(dry.out).toContain('shard-000.jsonl');
    expect(dry.out).toContain('replaces an earlier batch');
    expect(posts('/v1/files')).toHaveLength(2); // dry run sent nothing

    // fix the shard in place, then submit again
    writeFileSync(join(run, 'shard-000.jsonl'), [line('a-1', 'x'), line('a-2', 'fixed')].join('\n') + '\n');
    // a stray result file next to the failed shard is renamed, never deleted, and never mixed with the new results
    writeFileSync(join(run, 'shard-000.error.jsonl'), 'stale\n');
    const again = await cli(['submit', manifest, '--base-url', server.baseUrl]);
    expect(again.code).toBe(0);
    expect(again.out).toContain('1 submitted · 1 already submitted');
    expect(again.out).toContain(`replaces an earlier batch: failed ${failedBatch}`);
    expect(posts('/v1/files')).toHaveLength(3); // exactly one extra upload; shard-001 not uploaded again
    expect(posts('/v1/files')[2]!.filename).toBe('shard-000.jsonl');
    expect(posts('/v1/batches')).toHaveLength(3);
    const aside = `shard-000.error.replaced-${failedBatch}.jsonl`;
    expect(again.out).toContain(`kept old result files as ${aside}`);
    expect(existsSync(join(run, 'shard-000.error.jsonl'))).toBe(false);
    expect(readFileSync(join(run, aside), 'utf8')).toBe('stale\n');

    const state = JSON.parse(readFileSync(join(run, 'batches.json'), 'utf8')) as { shards: Record<string, { batch_id: string; status: string; history?: { batch_id: string; status: string }[] }> };
    expect(state.shards['shard-000.jsonl']!.batch_id).not.toBe(failedBatch);
    expect(state.shards['shard-000.jsonl']!.history).toMatchObject([{ batch_id: failedBatch, status: 'failed', set_aside: [aside] }]);

    const got = await cli(['collect', manifest, '--base-url', server.baseUrl]);
    expect(got.code).toBe(0);
    expect(existsSync(join(run, 'shard-000.output.jsonl'))).toBe(true);

    // and it is idempotent again: nothing more is sent
    const settled = await cli(['submit', manifest, '--base-url', server.baseUrl]);
    expect(settled.out).toContain('0 submitted · 2 already submitted');
    expect(posts('/v1/files')).toHaveLength(3);
  });

  it('split refuses a folder that already holds submission state unless --force', async () => {
    const { dir } = makeRun();
    writeFileSync(join(dir, 'batches.json'), '{}');
    const refused = await cli(['split', fx('openai/input.jsonl'), '--out', dir, '--max-requests', '6']);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain('already holds submission state');
    expect(refused.err).toContain('fix:');
    expect((await cli(['split', fx('openai/input.jsonl'), '--out', dir, '--max-requests', '6', '--force'])).code).toBe(0);
  });
});

describe('resume after an interrupted submit (Q-2)', () => {
  it('does not upload the shard again when createBatch failed after the upload', async () => {
    const { manifestPath, dir } = makeRun();
    let uploads = 0;
    let creates = 0;
    const fake = {
      uploadFile: async () => ({ id: `file-${++uploads}` }),
      createBatch: async () => {
        creates++;
        if (creates === 1) throw new Error('connection dropped');
        return { id: `batch-${creates}`, status: 'validating' };
      },
    } as unknown as OpenAIBatchClient;
    await expect(submit(manifestPath, { client: fake, baseUrl: 'http://127.0.0.1:1/v1' })).rejects.toThrow('connection dropped');
    expect(uploads).toBe(1);
    const saved = JSON.parse(readFileSync(join(dir, 'batches.json'), 'utf8')) as { shards: Record<string, { input_file_id: string; batch_id: string | null }> };
    expect(saved.shards['shard-000.jsonl']).toMatchObject({ input_file_id: 'file-1', batch_id: null });

    const result = await submit(manifestPath, { client: fake, baseUrl: 'http://127.0.0.1:1/v1' });
    expect(result.submitted).toEqual(['shard-000.jsonl', 'shard-001.jsonl']);
    expect(uploads).toBe(2); // shard-000 reused file-1; only shard-001 was uploaded
    const after = JSON.parse(readFileSync(join(dir, 'batches.json'), 'utf8')) as { shards: Record<string, { input_file_id: string; batch_id: string }> };
    expect(after.shards['shard-000.jsonl']!.input_file_id).toBe('file-1');
  });
});

/**
 * Status first (Q-8): running and finished batches own their requests. Editing their shard file or
 * re-splitting the folder must never upload those requests again by accident (double billing),
 * and must never touch result files that were already downloaded.
 */
describe('running and finished batches are never sent twice (Q-8)', () => {
  type State = { manifest_sha256?: string; shards: Record<string, { batch_id: string; status: string; output_file_id: string | null; history?: Record<string, unknown>[] }> };
  const stateOf = (dir: string): State => JSON.parse(readFileSync(join(dir, 'batches.json'), 'utf8')) as State;
  const snapshot = (dir: string, files: string[]) => Object.fromEntries(files.map((f) => [f, readFileSync(join(dir, f), 'utf8')]));
  const RESULTS = ['shard-000.output.jsonl', 'shard-001.output.jsonl', 'shard-001.error.jsonl'];

  it('(a) a running batch whose shard changed: refused, 0 uploads, finished results kept', async () => {
    server = await startMockServer({ scenario: { results: {}, pollsBeforeDone: 1 } }); // every request ok, one poll in_progress
    const { manifestPath, dir } = makeRun();
    const budget = String(readManifest(manifestPath).shards[0]!.est_tokens + 1);
    // shard-000 alone, run it to completed and download its results
    await cli(['submit', manifestPath, '--base-url', server.baseUrl, '--max-enqueued-tokens', budget]);
    expect((await cli(['collect', manifestPath, '--base-url', server.baseUrl])).code).toBe(2); // in_progress
    expect((await cli(['collect', manifestPath, '--base-url', server.baseUrl])).code).toBe(2); // completed, shard-001 not submitted
    expect(existsSync(join(dir, 'shard-000.output.jsonl'))).toBe(true);
    // now shard-001, which stays in_progress
    expect((await cli(['submit', manifestPath, '--base-url', server.baseUrl, '--max-enqueued-tokens', budget])).out).toContain('1 submitted');
    expect((await cli(['collect', manifestPath, '--base-url', server.baseUrl])).code).toBe(2);
    const before = stateOf(dir);
    expect(before.shards['shard-000.jsonl']!.status).toBe('completed');
    expect(before.shards['shard-001.jsonl']!.status).toBe('in_progress');
    const kept = snapshot(dir, ['shard-000.output.jsonl', 'batches.json']);
    const uploads = posts('/v1/files').length;

    appendFileSync(join(dir, 'shard-001.jsonl'), '\n'); // the smallest possible edit, as in the QA report
    for (const extra of [[], ['--resubmit-changed'], ['--dry-run']]) {
      const r = await cli(['submit', manifestPath, '--base-url', server.baseUrl, ...extra]);
      expect(r.code).toBe(1);
      expect(r.err).toContain('nothing was uploaded');
      expect(r.err).toContain(`shard-001.jsonl changed while ${before.shards['shard-001.jsonl']!.batch_id} is still in_progress`); // the running branch
      expect(r.err).toContain('never sent twice');
    }
    expect(posts('/v1/files')).toHaveLength(uploads); // 0 new uploads
    expect(posts('/v1/batches')).toHaveLength(2);
    expect(snapshot(dir, ['shard-000.output.jsonl', 'batches.json'])).toEqual(kept); // results and state untouched

    // the running batch is still collected normally afterwards
    expect((await cli(['collect', manifestPath, '--base-url', server.baseUrl])).code).toBe(0);
    expect(existsSync(join(dir, 'shard-001.output.jsonl'))).toBe(true);
  });

  it('(b) a completed batch whose shard changed: refused by default, 0 uploads, results kept; --resubmit-changed sends exactly that shard', async () => {
    server = await startMockServer();
    const { manifestPath, dir } = makeRun();
    await cli(['submit', manifestPath, '--base-url', server.baseUrl]);
    expect((await cli(['collect', manifestPath, '--base-url', server.baseUrl])).code).toBe(0);
    const kept = snapshot(dir, [...RESULTS, 'batches.json']);
    const batch0 = stateOf(dir).shards['shard-000.jsonl']!;

    writeFileSync(join(dir, 'shard-000.jsonl'), readFileSync(join(dir, 'shard-000.jsonl'), 'utf8').replace('library', 'museum'));
    const r = await cli(['submit', manifestPath, '--base-url', server.baseUrl]);
    expect(r.code).toBe(1);
    expect(r.err).toContain(`shard-000.jsonl changed after ${batch0.batch_id} completed`); // the finished branch
    expect(r.err).toContain('--resubmit-changed');
    expect(posts('/v1/files')).toHaveLength(2); // 0 new uploads
    expect(posts('/v1/batches')).toHaveLength(2);
    expect(snapshot(dir, [...RESULTS, 'batches.json'])).toEqual(kept);

    // the dry run shows what the explicit option would do, still without sending anything
    const dry = await cli(['submit', manifestPath, '--base-url', server.baseUrl, '--resubmit-changed', '--dry-run']);
    expect(dry.code).toBe(0);
    expect(dry.out).toContain(`shard-000.jsonl  would submit (replaces an earlier batch: changed after completed ${batch0.batch_id})`);
    expect(posts('/v1/files')).toHaveLength(2);

    // explicit opt-in: exactly one upload, old results renamed (not deleted), ids kept in history
    const forced = await cli(['submit', manifestPath, '--base-url', server.baseUrl, '--resubmit-changed']);
    expect(forced.code).toBe(0);
    expect(forced.out).toContain('1 submitted · 1 already submitted');
    expect(posts('/v1/files')).toHaveLength(3);
    expect(posts('/v1/files')[2]!.filename).toBe('shard-000.jsonl');
    const aside = `shard-000.output.replaced-${batch0.batch_id}.jsonl`;
    expect(readFileSync(join(dir, aside), 'utf8')).toBe(kept['shard-000.output.jsonl']);
    expect(existsSync(join(dir, 'shard-000.output.jsonl'))).toBe(false);
    expect(readFileSync(join(dir, 'shard-001.output.jsonl'), 'utf8')).toBe(kept['shard-001.output.jsonl']); // other shard untouched
    expect(stateOf(dir).shards['shard-000.jsonl']!.history).toMatchObject([{ batch_id: batch0.batch_id, status: 'completed', output_file_id: batch0.output_file_id, set_aside: [aside] }]);

    // merge reads the new results only (the renamed file is not a result file), so nothing is counted twice
    expect((await cli(['collect', manifestPath, '--base-url', server.baseUrl])).code).toBe(0);
    const report = mergeResults(manifestPath);
    expect(report.files.some((f) => f.includes('replaced'))).toBe(false);
    expect(report.duplicates).toEqual([]);
    expect(report.rows).toHaveLength(12);
  });

  it('(d) split --force over a finished run is refused, and submit afterwards sends nothing', async () => {
    server = await startMockServer();
    const dir = tmp();
    const run = join(dir, 'run');
    const manifest = join(run, 'manifest.json');
    expect((await cli(['split', fx('openai/input.jsonl'), '--out', run, '--max-requests', '6'])).code).toBe(0);
    await cli(['submit', manifest, '--base-url', server.baseUrl]);
    expect((await cli(['collect', manifest, '--base-url', server.baseUrl])).code).toBe(0);
    const kept = snapshot(run, [...RESULTS, 'batches.json', 'manifest.json', 'shard-000.jsonl', 'shard-001.jsonl']);

    // the exact QA sequence: change the limit and force a re-split into the same folder
    const resplit = await cli(['split', fx('openai/input.jsonl'), '--out', run, '--max-requests', '4', '--force']);
    expect(resplit.code).toBe(1);
    expect(resplit.err).toContain('has running or finished batches (shard-000.output.jsonl');
    expect(resplit.err).toContain('--force would submit their requests twice');
    expect(resplit.err).toContain('new folder');
    expect(existsSync(join(run, 'shard-002.jsonl'))).toBe(false);

    const again = await cli(['submit', manifest, '--base-url', server.baseUrl]);
    expect(again.code).toBe(0);
    expect(again.out).toContain('0 submitted · 2 already submitted');
    expect(posts('/v1/files')).toHaveLength(2); // no request was sent twice
    expect(posts('/v1/batches')).toHaveLength(2);
    expect(snapshot(run, Object.keys(kept))).toEqual(kept);
  });

  it('(d) a re-split copied in by hand is caught by submit itself: changed shards, changed manifest, lost batches', async () => {
    server = await startMockServer();
    const dir = tmp();
    const run = join(dir, 'run');
    const manifest = join(run, 'manifest.json');
    expect((await cli(['split', fx('openai/input.jsonl'), '--out', run, '--max-requests', '6'])).code).toBe(0);
    await cli(['submit', manifest, '--base-url', server.baseUrl]);
    expect((await cli(['collect', manifest, '--base-url', server.baseUrl])).code).toBe(0);
    expect(stateOf(run).manifest_sha256).toMatch(/^[0-9a-f]{64}$/);
    const kept = snapshot(run, [...RESULTS, 'batches.json']);

    // 3 shards of 4 copied over the 2 shards of 6 (what an older --force did)
    const other = join(dir, 'other');
    expect((await cli(['split', fx('openai/input.jsonl'), '--out', other, '--max-requests', '4'])).code).toBe(0);
    for (const f of ['manifest.json', 'shard-000.jsonl', 'shard-001.jsonl', 'shard-002.jsonl']) copyFileSync(join(other, f), join(run, f));
    const r = await cli(['submit', manifest, '--base-url', server.baseUrl]);
    expect(r.code).toBe(1);
    expect(r.err).toContain('shard-000.jsonl changed after');
    expect(r.err).toContain('shard-001.jsonl changed after');
    expect(r.err).toContain('manifest.json changed since 2 batch(es) were created');
    expect(posts('/v1/files')).toHaveLength(2); // shard-002 (requests 9-12, already billed in shard-001) was not sent either
    expect(snapshot(run, [...RESULTS, 'batches.json'])).toEqual(kept);

    // the other direction: 3 finished shards, then a 2-shard manifest leaves shard-002 without a manifest entry
    const run3 = join(dir, 'run3');
    const manifest3 = join(run3, 'manifest.json');
    expect((await cli(['split', fx('openai/input.jsonl'), '--out', run3, '--max-requests', '4'])).code).toBe(0);
    await cli(['submit', manifest3, '--base-url', server.baseUrl]);
    await cli(['collect', manifest3, '--base-url', server.baseUrl]);
    const uploads = posts('/v1/files').length;
    const six = join(dir, 'six');
    await cli(['split', fx('openai/input.jsonl'), '--out', six, '--max-requests', '6']);
    for (const f of ['manifest.json', 'shard-000.jsonl', 'shard-001.jsonl']) copyFileSync(join(six, f), join(run3, f));
    const lost = await cli(['submit', manifest3, '--base-url', server.baseUrl, '--resubmit-changed']); // even the explicit option refuses
    expect(lost.code).toBe(1);
    expect(lost.err).toContain('for shard-002.jsonl, which is no longer in the manifest');
    expect(posts('/v1/files')).toHaveLength(uploads);
  });

  it('split --force still re-splits a folder whose batches all failed (Q-1 path kept)', async () => {
    server = await startMockServer();
    const dir = tmp();
    const line = (id: string) => JSON.stringify({ custom_id: id, method: 'POST', url: '/v1/chat/completions', body: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: id }] } });
    const input = join(dir, 'in.jsonl');
    writeFileSync(input, [line('a-1'), line('a-1'), line('a-3')].join('\n') + '\n');
    const run = join(dir, 'run');
    const manifest = join(run, 'manifest.json');
    await cli(['split', input, '--out', run, '--skip-lint']);
    await cli(['submit', manifest, '--base-url', server.baseUrl]);
    expect((await cli(['collect', manifest, '--base-url', server.baseUrl])).code).toBe(1); // duplicate_custom_id -> failed

    writeFileSync(input, [line('a-1'), line('a-2'), line('a-3')].join('\n') + '\n'); // fix the input itself
    expect((await cli(['split', input, '--out', run])).code).toBe(1); // still needs --force
    expect((await cli(['split', input, '--out', run, '--force'])).code).toBe(0);
    const r = await cli(['submit', manifest, '--base-url', server.baseUrl]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('replaces an earlier batch: failed');
    expect(posts('/v1/files')).toHaveLength(2); // exactly one more upload
    expect((await cli(['collect', manifest, '--base-url', server.baseUrl])).code).toBe(0);
    expect(mergeResults(manifest).summary).toEqual({ succeeded: 3 });
  });
});
