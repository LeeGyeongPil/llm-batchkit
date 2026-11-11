import { describe, expect, it } from 'vitest';
import { BatchkitError } from '../src/errors.js';
import { lintFile, lintText } from '../src/lint.js';
import { cli, fx } from './helpers.js';
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';

const codes = (r: { issues: { line: number; code: string }[] }): string[] => r.issues.map((i) => `${i.line}:${i.code}`);

describe('lint', () => {
  it('openai bad file reports 11 line-numbered issues', () => {
    const report = lintFile(fx('openai/input-bad.jsonl'));
    expect(report.provider).toBe('openai');
    expect(codes(report).sort()).toEqual(
      ['2:duplicate_custom_id', '3:missing_custom_id', '4:url_body_mismatch', '6:invalid_json_line', '7:invalid_method', '8:empty_line', '9:invalid_url', '10:missing_model', '11:stream_not_allowed', '0:model_mismatch', '0:url_mismatch'].sort(),
    );
    // classification fields: the blank line is only a warning, everything else is an error
    expect(report.issues.find((i) => i.code === 'empty_line')?.severity).toBe('warn');
    expect(report.issues.filter((i) => i.severity === 'error')).toHaveLength(10);
    expect(report.issues.find((i) => i.code === 'duplicate_custom_id')?.message).toBe('same as line 1');
    expect(report.ok).toBe(false);
  });

  it('good file passes and the CLI prints the summary line with exit 0', async () => {
    const report = lintFile(fx('openai/input.jsonl'));
    expect(report).toMatchObject({ requests: 12, errors: 0, warnings: 0, ok: true, models: { 'gpt-4o-mini': 12 } });
    const r = await cli(['lint', fx('openai/input.jsonl')]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('12 requests · 1 model (gpt-4o-mini) · 0 errors');
  });

  it('bad file: CLI exit code 1 and --json carries the issues', async () => {
    const r = await cli(['lint', fx('openai/input-bad.jsonl'), '--json']);
    expect(r.code).toBe(1);
    const json = JSON.parse(r.out) as { issues: { line: number; code: string }[]; ok: boolean };
    expect(codes(json)).toContain('2:duplicate_custom_id');
    expect(codes(json)).toContain('0:url_mismatch');
    expect(json.ok).toBe(false);
  });

  it('built CLI exits 1 on the bad file and 0 on the good file (child process)', () => {
    const bin = join(import.meta.dirname, '..', 'dist', 'cli.js');
    const bad = spawnSync('node', [bin, 'lint', fx('openai/input-bad.jsonl'), '--json'], { encoding: 'utf8' });
    expect(bad.status).toBe(1);
    expect(JSON.parse(bad.stdout).issues).toHaveLength(11);
    expect(execFileSync('node', [bin, 'lint', fx('openai/input.jsonl')], { encoding: 'utf8' })).toContain('0 errors');
  });

  it('counts embedding inputs (array length, or 1 for a string)', () => {
    const report = lintFile(fx('openai/embeddings-input.jsonl'));
    expect(report.embeddingInputs).toBe(6);
    expect(report.errors).toBe(0);
  });

  it('azure deployment mismatch', () => {
    const report = lintFile(fx('azure/input.jsonl'), { provider: 'azure' });
    const issue = report.issues.find((i) => i.code === 'model_mismatch');
    expect(issue).toMatchObject({ line: 0, severity: 'error' });
    expect(issue?.message).toContain('deployment names');
    expect(issue?.message).toContain('other-deployment');
  });

  it('anthropic id pattern and banned params', () => {
    const report = lintFile(fx('anthropic/requests.json'));
    expect(report.provider).toBe('anthropic'); // detected from {"requests": [...]}
    expect(codes(report).sort()).toEqual(['3:max_tokens_min', '5:invalid_custom_id', '5:stream_not_allowed']);
    expect(report.models).toEqual({ 'claude-haiku-4-5-20251001': 4, 'claude-sonnet-4-5-20250929': 1 }); // mixing is allowed
    expect(lintFile(fx('anthropic/requests-ok.json')).errors).toBe(0);
  });

  it('50001 lines: openai error, azure ok', () => {
    const line = (i: number) => JSON.stringify({ custom_id: `c-${i}`, method: 'POST', url: '/v1/chat/completions', body: { model: 'm', messages: [{ role: 'user', content: 'x' }] } });
    const text = Array.from({ length: 50_001 }, (_, i) => line(i)).join('\n') + '\n';
    const openai = lintText(text, { provider: 'openai' });
    expect(openai.issues.find((i) => i.code === 'too_many_requests')).toMatchObject({ line: 0, severity: 'error' });
    expect(codes(lintText(text, { provider: 'azure' }))).not.toContain('0:too_many_requests');
  });

  it('--max-requests / --max-bytes / --max-tokens override the preset', () => {
    const text = lintFile(fx('openai/input.jsonl'));
    expect(text.requests).toBe(12);
    expect(codes(lintFile(fx('openai/input.jsonl'), { maxRequests: 5 }))).toEqual(['0:too_many_requests']);
    expect(codes(lintFile(fx('openai/input.jsonl'), { maxBytes: 1000 }))).toEqual(['0:file_too_large']);
    expect(codes(lintFile(fx('openai/input.jsonl'), { maxTokens: 100 }))).toEqual(['0:too_many_tokens']);
  });

  it('warnings alone exit 0; --strict makes them fail', async () => {
    const text = '{"custom_id":"a","method":"POST","url":"/v1/chat/completions","body":{"model":"m","messages":[]}}\n\n';
    const report = lintText(text);
    expect(report).toMatchObject({ errors: 0, warnings: 1 });
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const f = join(mkdtempSync(join(tmpdir(), 'bk-')), 'warn.jsonl');
    writeFileSync(f, text);
    expect((await cli(['lint', f])).code).toBe(0);
    expect((await cli(['lint', f, '--strict'])).code).toBe(1);
  });

  it('errors explain how to fix: missing file, bad provider, bad flags', async () => {
    expect(() => lintFile('/nonexistent/file.jsonl')).toThrowError(BatchkitError);
    try {
      lintFile('/nonexistent/file.jsonl');
    } catch (e) {
      expect((e as BatchkitError).code).toBe('cannot_read_file');
      expect((e as BatchkitError).hint).toMatch(/path/);
    }
    const missing = await cli(['lint', '/nonexistent/file.jsonl']);
    expect(missing.code).toBe(1);
    expect(missing.err).toContain('fix:');
    expect((await cli(['lint', fx('openai/input.jsonl'), '--provider', 'gemini'])).code).toBe(64);
    expect((await cli(['lint'])).code).toBe(64);
    expect((await cli(['lint', fx('openai/input.jsonl'), '--max-requests', 'abc'])).code).toBe(1);
  });
});
