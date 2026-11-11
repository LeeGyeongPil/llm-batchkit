import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mergeResults, resultsToCsv, readResultsFile, writeResultsJsonl } from '../src/merge.js';
import { splitFile } from '../src/split.js';
import { cli, errOf, fx, makeRun, ROUND1, tmp } from './helpers.js';

const RETRY = fx('openai/retry-000.output.jsonl');

describe('merge', () => {
  it('round1 summary and order', () => {
    const { manifestPath } = makeRun();
    const report = mergeResults(manifestPath, { files: ROUND1 });
    expect(report.summary).toEqual({ succeeded: 7, failed: 2, expired: 1, cancelled: 1, missing: 1 });
    expect(report.failedCodes).toEqual({ '400': 1, '500': 1 });
    expect(report.rows.map((r) => r.custom_id)).toEqual(Array.from({ length: 12 }, (_, i) => `req-${String(i + 1).padStart(3, '0')}`));
    const row = (id: string) => report.rows.find((r) => r.custom_id === id)!;
    // classification per branch
    expect(row('req-004')).toMatchObject({ status: 'failed', code: 400, retryable: false, source: 'shard-000.output.jsonl' });
    expect(row('req-011')).toMatchObject({ status: 'failed', code: 500, retryable: true, source: 'shard-001.error.jsonl' });
    expect(row('req-006')).toMatchObject({ status: 'missing', code: null, retryable: true, source: null });
    expect(row('req-009')).toMatchObject({ status: 'expired', code: 'batch_expired', retryable: true });
    expect(row('req-012')).toMatchObject({ status: 'cancelled', code: 'batch_cancelled', retryable: true });
    expect(row('req-001').status).toBe('succeeded');
    expect((row('req-001').response?.body as any).choices[0].message.content).toBe('The library is open 9 to 6 on weekdays.');
    expect(report.duplicates).toEqual([]);
    expect(report.unknown).toEqual([]);
  });

  it('csv export', async () => {
    const { manifestPath, dir } = makeRun();
    const csvPath = join(dir, 'out', 'results.csv');
    const r = await cli(['merge', manifestPath, ...ROUND1, '--csv', csvPath]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('succeeded 7 · failed 2 (400×1, 500×1) · expired 1 · cancelled 1 · missing 1');
    const csv = readFileSync(csvPath, 'utf8').split('\n');
    expect(csv[0]).toBe('custom_id,status,code,retryable,source,text');
    expect(csv[1]).toBe('req-001,succeeded,200,false,shard-000.output.jsonl,The library is open 9 to 6 on weekdays.');
    expect(csv[4]).toBe('req-004,failed,400,false,shard-000.output.jsonl,');
    expect(csv.length).toBe(14); // header + 12 rows + trailing newline
    // quoting
    expect(resultsToCsv([{ custom_id: 'q', status: 'succeeded', code: 200, retryable: false, source: 'f', round: 0, reason: null, text: 'a, "b"\nc' }])).toContain('"a, ""b""\nc"');
  });

  it('writes results.jsonl that read back as the same rows', async () => {
    const { manifestPath, dir } = makeRun();
    const report = mergeResults(manifestPath, { files: ROUND1 });
    writeResultsJsonl(report.rows, join(dir, 'r.jsonl'));
    expect(readResultsFile(join(dir, 'r.jsonl'))).toEqual(report.rows);
    const json = await cli(['merge', manifestPath, ...ROUND1, '--json']);
    expect(JSON.parse(json.out).summary).toEqual({ succeeded: 7, failed: 2, expired: 1, cancelled: 1, missing: 1 });
  });

  it('round2 keeps first success and flags duplicate', () => {
    const { manifestPath } = makeRun();
    const report = mergeResults(manifestPath, { files: [...ROUND1, RETRY] });
    expect(report.summary).toEqual({ succeeded: 11, failed: 1 });
    expect(report.duplicates).toEqual(['req-001']);
    const r1 = report.rows.find((r) => r.custom_id === 'req-001')!;
    expect(r1.source).toBe('shard-000.output.jsonl'); // first success kept
    expect(r1.text).toBe('The library is open 9 to 6 on weekdays.');
    expect(report.rows.find((r) => r.custom_id === 'req-006')).toMatchObject({ status: 'succeeded', source: 'retry-000.output.jsonl' });
    expect(report.rows.find((r) => r.custom_id === 'req-004')).toMatchObject({ status: 'failed', code: 400 });
  });

  it('success wins regardless of file order', () => {
    const { manifestPath } = makeRun();
    const forward = mergeResults(manifestPath, { files: [...ROUND1, RETRY] });
    const reversed = mergeResults(manifestPath, { files: [RETRY, ...[...ROUND1].reverse()] });
    expect(reversed.summary).toEqual(forward.summary);
    expect(reversed.summary.succeeded).toBe(11);
    expect(reversed.rows.find((r) => r.custom_id === 'req-009')?.status).toBe('succeeded'); // expired line came later but loses
  });

  it('without a success the latest round failure remains', () => {
    const { manifestPath, dir } = makeRun();
    const fail = (code: number) => JSON.stringify({ id: 'b', custom_id: 'req-001', response: { status_code: code, body: {} }, error: null }) + '\n';
    writeFileSync(join(dir, 'a.output.jsonl'), fail(500));
    writeFileSync(join(dir, 'b.output.jsonl'), fail(400));
    const ab = mergeResults(manifestPath, { files: [join(dir, 'a.output.jsonl'), join(dir, 'b.output.jsonl')] });
    expect(ab.rows[0]).toMatchObject({ custom_id: 'req-001', code: 400, retryable: false, round: 1 });
    const ba = mergeResults(manifestPath, { files: [join(dir, 'b.output.jsonl'), join(dir, 'a.output.jsonl')] });
    expect(ba.rows[0]).toMatchObject({ code: 500, retryable: true, round: 1 });
  });

  it('unknown ids reported', () => {
    const { manifestPath, dir } = makeRun();
    const extra = join(dir, 'extra.output.jsonl');
    writeFileSync(extra, JSON.stringify({ id: 'x', custom_id: 'zzz-999', response: { status_code: 200, body: {} }, error: null }) + '\nnot json\n{"no":"id"}\n');
    const report = mergeResults(manifestPath, { files: [...ROUND1, extra] });
    expect(report.unknown).toEqual(['zzz-999']);
    expect(report.rows).toHaveLength(12);
    expect(report.rows.some((r) => r.custom_id === 'zzz-999')).toBe(false);
    expect(report.skippedLines).toBe(2);
    expect(report.summary.succeeded).toBe(7);
  });

  it('auto-discovers round 0 files and retry-N folders', () => {
    const { manifestPath, dir } = makeRun();
    for (const f of ['shard-000.output.jsonl', 'shard-001.output.jsonl', 'shard-001.error.jsonl']) copyFileSync(fx('openai', f), join(dir, f));
    expect(mergeResults(manifestPath).summary).toEqual({ succeeded: 7, failed: 2, expired: 1, cancelled: 1, missing: 1 });
    mkdirSync(join(dir, 'retry-1'));
    copyFileSync(RETRY, join(dir, 'retry-1', 'shard-000.output.jsonl'));
    const merged = mergeResults(manifestPath);
    expect(merged.summary).toEqual({ succeeded: 11, failed: 1 });
    expect(merged.rows.find((r) => r.custom_id === 'req-006')).toMatchObject({ source: join('retry-1', 'shard-000.output.jsonl'), round: 1 });
  });

  it('missing result files explain what to do', () => {
    const { manifestPath } = makeRun();
    expect(errOf(() => mergeResults(manifestPath))).toMatchObject({ code: 'no_result_files', hint: expect.stringContaining('collect') });
    expect(() => mergeResults(manifestPath, { files: ['/nope.jsonl'] })).toThrowError(/not found/);
    expect(() => mergeResults('/nope/manifest.json')).toThrowError(/manifest/);
  });

  it('anthropic results', () => {
    const out = tmp();
    const { manifestPath } = splitFile(fx('anthropic/requests-ok.json'), { out });
    const report = mergeResults(manifestPath, { files: [fx('anthropic/results.jsonl')] });
    expect(report.summary).toEqual({ succeeded: 2, failed: 1, expired: 1, missing: 1 });
    expect(report.unknown).toEqual(['doc-006']);
    const row = (id: string) => report.rows.find((r) => r.custom_id === id)!;
    expect(row('doc-003')).toMatchObject({ status: 'failed', code: 'invalid_request_error', retryable: false });
    expect(row('doc-004')).toMatchObject({ status: 'expired', retryable: true });
    expect(row('doc-005')).toMatchObject({ status: 'missing' });
    expect(row('doc-001').text).toBe('The library is open 9 to 6 on weekdays.');
  });
});
