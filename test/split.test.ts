import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BatchkitError } from '../src/errors.js';
import { splitFile } from '../src/split.js';
import { cli, fx, tmp } from './helpers.js';

const input = fx('openai/input.jsonl');

describe('split', () => {
  it('count/bytes/tokens caps', () => {
    const byCount = splitFile(input, { out: tmp(), maxRequests: 6 }).manifest;
    expect(byCount.shards.map((s) => s.count)).toEqual([6, 6]);

    const byBytes = splitFile(input, { out: tmp(), maxBytes: 1200 }).manifest;
    expect(byBytes.shards.length).toBeGreaterThanOrEqual(3);
    for (const s of byBytes.shards) expect(s.bytes).toBeLessThanOrEqual(1200);

    const byTokens = splitFile(input, { out: tmp(), maxTokens: 150 }).manifest;
    expect(byTokens.shards.length).toBeGreaterThan(1);
    for (const s of byTokens.shards) expect(s.est_tokens).toBeLessThanOrEqual(150);
    expect(byTokens.limits.maxTokens).toBe(150);
  });

  it('groups by model', () => {
    const { manifest } = splitFile(fx('azure/input.jsonl'), { out: tmp(), provider: 'azure' });
    expect(manifest.shards.map((s) => [s.model, s.count])).toEqual([['my-gpt4o-mini-globalbatch', 2], ['other-deployment', 1]]);
    expect(manifest.order).toEqual(['task-0', 'task-1', 'task-2']);
  });

  it('lossless and ordered', () => {
    const out = tmp();
    const { manifest, manifestPath } = splitFile(input, { out: join(out, 'nested', 'run1'), maxRequests: 5 }); // folder does not exist yet
    expect(existsSync(manifestPath)).toBe(true);
    const joined = manifest.shards.map((s) => readFileSync(join(out, 'nested', 'run1', s.file), 'utf8')).join('');
    expect(joined).toBe(readFileSync(input, 'utf8')); // byte-identical lines in the same order
    expect(manifest.order).toEqual(Array.from({ length: 12 }, (_, i) => `req-${String(i + 1).padStart(3, '0')}`));
    expect(manifest.shards.flatMap((s) => s.custom_ids)).toEqual(manifest.order);
    expect(manifest.source_sha256).toMatch(/^[0-9a-f]{64}$/);
    // deterministic: same input, same manifest
    expect(splitFile(input, { out: tmp(), maxRequests: 5 }).manifest).toEqual(manifest);
  });

  it('line_too_large', async () => {
    expect(() => splitFile(input, { out: tmp(), maxBytes: 100 })).toThrowError(/line_too_large/);
    try {
      splitFile(input, { out: tmp(), maxTokens: 5 });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(BatchkitError);
      expect((e as BatchkitError).code).toBe('line_too_large');
      expect((e as BatchkitError).hint).toMatch(/Raise the limit/);
    }
    const r = await cli(['split', input, '--out', tmp(), '--max-bytes', '100']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('line_too_large');
  });

  it('refuses files with line-level lint errors unless --skip-lint', async () => {
    const bad = fx('openai/input-bad.jsonl');
    const out = tmp();
    expect(() => splitFile(bad, { out })).toThrowError(/lint_failed|line-level/);
    const refused = await cli(['split', bad, '--out', out]);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain('--skip-lint');
    const forced = splitFile(bad, { out, skipLint: true });
    expect(forced.manifest.shards.length).toBeGreaterThan(0);
  });

  it('CLI prints the shard table', async () => {
    const out = tmp();
    const r = await cli(['split', input, '--out', out, '--max-requests', '6']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/shard-000\.jsonl\s+6\s/);
    expect(r.out).toMatch(/shard-001\.jsonl\s+6\s/);
    expect(existsSync(join(out, 'manifest.json'))).toBe(true);
  });

  it('anthropic requests keep their params in {"requests": [...]} shards', () => {
    const out = tmp();
    const { manifest } = splitFile(fx('anthropic/requests-ok.json'), { out, maxRequests: 3 });
    expect(manifest.provider).toBe('anthropic');
    expect(manifest.shards.map((s) => s.count)).toEqual([3, 2]);
    const shard = JSON.parse(readFileSync(join(out, manifest.shards[0]!.file), 'utf8')) as { requests: { custom_id: string }[] };
    expect(shard.requests.map((r) => r.custom_id)).toEqual(['doc-001', 'doc-002', 'doc-003']);
  });
});
