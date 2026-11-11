import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyLine } from '../src/classify.js';
import { mergeResults, writeResultsJsonl, type ResultRow } from '../src/merge.js';
import { buildOriginalIndex, selectRetries, writeRetryFile } from '../src/retry.js';
import { splitFile } from '../src/split.js';
import { cli, errOf, fx, lines, makeRun, ROUND1, tmp } from './helpers.js';

function round1Rows() {
  const run = makeRun();
  return { ...run, rows: mergeResults(run.manifestPath, { files: ROUND1 }).rows };
}

describe('retry', () => {
  it('default policy picks 4', () => {
    const { rows } = round1Rows();
    const { selected, excluded } = selectRetries(rows);
    expect(selected.map((r) => r.custom_id)).toEqual(['req-006', 'req-009', 'req-011', 'req-012']);
    expect(selected.map((r) => r.status)).toEqual(['missing', 'expired', 'failed', 'cancelled']);
    expect(excluded).toHaveLength(1);
    expect(excluded[0]!.row.custom_id).toBe('req-004');
    expect(excluded[0]!.reason).toBe('excluded: 400 (client error, use --include-4xx)');
  });

  it('include-4xx and only', () => {
    const { rows } = round1Rows();
    expect(selectRetries(rows, { include4xx: true }).selected.map((r) => r.custom_id)).toEqual(['req-004', 'req-006', 'req-009', 'req-011', 'req-012']);
    expect(selectRetries(rows, { include4xx: true }).excluded).toEqual([]);
    expect(selectRetries(rows, { only: ['expired'] }).selected.map((r) => r.custom_id)).toEqual(['req-009']);
    expect(selectRetries(rows, { only: ['expired', 'missing'] }).selected.map((r) => r.custom_id)).toEqual(['req-006', 'req-009']);
    // "failed" still honors the default policy: the 500 is picked, the 400 is not
    expect(selectRetries(rows, { only: ['failed'] }).selected.map((r) => r.custom_id)).toEqual(['req-011']);
    expect(errOf(() => selectRetries(rows, { only: ['bogus'] })).hint).toContain('expired, cancelled, missing, failed');
  });

  it('429 is retryable', () => {
    const c = classifyLine({ custom_id: 'r429', response: { status_code: 429, body: {} }, error: null })!;
    const row: ResultRow = { custom_id: c.customId, status: c.status, code: c.code, retryable: c.retryable, source: 'x', round: 0, reason: c.reason };
    expect(selectRetries([row]).selected.map((r) => r.custom_id)).toEqual(['r429']);
  });

  it('indeterminate rows are excluded by default and only picked explicitly', () => {
    const c = classifyLine({ custom_id: 'weird', response: null, error: null })!;
    const row: ResultRow = { custom_id: c.customId, status: c.status, code: c.code, retryable: c.retryable, source: 'x', round: 0, reason: c.reason };
    const def = selectRetries([row]);
    expect(def.selected).toEqual([]);
    expect(def.excluded[0]!.reason).toContain('indeterminate');
    expect(selectRetries([row], { include4xx: true }).selected).toHaveLength(1);
  });

  it('nothing to retry', async () => {
    const { manifestPath, dir } = makeRun();
    const all = mergeResults(manifestPath, { files: [...ROUND1, fx('openai/retry-000.output.jsonl')] });
    writeResultsJsonl(all.rows, join(dir, 'results.jsonl'));
    // only the 400 is left, so a second retry round must not re-pick anything that already succeeded
    const out = join(dir, 'retry-2');
    const r = await cli(['retry', join(dir, 'results.jsonl'), '--out', out]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('nothing to retry');
    expect(r.out).toContain('req-004');
    expect(existsSync(out)).toBe(false); // no file, no folder
    expect(selectRetries(all.rows).selected).toEqual([]);
  });

  it('writes original lines byte for byte and the CLI reports counts', async () => {
    const { manifestPath, dir, rows } = round1Rows();
    writeResultsJsonl(rows, join(dir, 'results.jsonl'));
    const r = await cli(['retry', join(dir, 'results.jsonl'), '--out', join(dir, 'retry-1')]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('4 to retry · 1 excluded');
    expect(r.out).toContain('excluded: 400 (client error, use --include-4xx)');
    const original = lines(fx('openai/input.jsonl'));
    expect(lines(join(dir, 'retry-1', 'input.jsonl'))).toEqual([original[5], original[8], original[10], original[11]]);
    // the retry file is a valid split input again
    expect(splitFile(join(dir, 'retry-1', 'input.jsonl'), { out: join(dir, 'retry-1') }).manifest.order).toEqual(['req-006', 'req-009', 'req-011', 'req-012']);
    // --include-4xx adds the 400
    const all = await cli(['retry', join(dir, 'results.jsonl'), '--out', join(dir, 'retry-all'), '--include-4xx']);
    expect(all.out).toContain('5 to retry · 0 excluded');
    const only = await cli(['retry', join(dir, 'results.jsonl'), '--out', join(dir, 'retry-exp'), '--only', 'expired']);
    expect(only.out).toContain('1 to retry');
    expect(manifestPath).toBeTruthy();
  });

  it('works from the original input when there is no manifest next to the results', async () => {
    const { rows } = round1Rows();
    const dir = tmp();
    writeResultsJsonl(rows, join(dir, 'results.jsonl'));
    const noHint = await cli(['retry', join(dir, 'results.jsonl'), '--out', join(dir, 'r')]);
    expect(noHint.code).toBe(1);
    expect(noHint.err).toContain('--input');
    const ok = await cli(['retry', join(dir, 'results.jsonl'), '--out', join(dir, 'r'), '--input', fx('openai/input.jsonl')]);
    expect(ok.code).toBe(0);
    expect(lines(join(dir, 'r', 'input.jsonl'))).toHaveLength(4);
  });

  it('anthropic retry keeps params', () => {
    const run = tmp();
    const { manifestPath } = splitFile(fx('anthropic/requests-ok.json'), { out: run });
    const { rows } = mergeResults(manifestPath, { files: [fx('anthropic/results.jsonl')] });
    const { selected, excluded } = selectRetries(rows);
    expect(selected.map((r) => r.custom_id)).toEqual(['doc-004', 'doc-005']);
    expect(excluded.map((e) => e.row.custom_id)).toEqual(['doc-003']);
    expect(excluded[0]!.reason).toContain('invalid_request_error');
    const { index, provider } = buildOriginalIndex({ manifestPath });
    const path = writeRetryFile(selected, index, provider, join(run, 'retry-1'));
    expect(path.endsWith('requests.json')).toBe(true);
    const written = JSON.parse(readFileSync(path, 'utf8')) as { requests: { custom_id: string; params: unknown }[] };
    const original = JSON.parse(readFileSync(fx('anthropic/requests-ok.json'), 'utf8')) as typeof written;
    expect(written.requests.map((r) => r.custom_id)).toEqual(['doc-004', 'doc-005']);
    expect(written.requests).toEqual([original.requests[3], original.requests[4]]);
  });

  it('refuses to guess when an original line is missing', () => {
    const { rows, manifestPath } = round1Rows();
    const { index, provider } = buildOriginalIndex({ manifestPath });
    index.delete('req-009');
    expect(() => writeRetryFile(selectRetries(rows).selected, index, provider, tmp())).toThrowError(/req-009/);
    writeFileSync(join(tmp(), 'x'), '');
  });
});
