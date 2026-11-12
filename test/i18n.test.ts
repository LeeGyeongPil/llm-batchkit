import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LangOptionError, MESSAGES, count, localizeText, resolveLang, stripLangFlag, t } from '../src/i18n.js';
import { lintFile } from '../src/lint.js';
import { cli, fx, makeRun, tmp } from './helpers.js';

const HANGUL = /[가-힣]/;
const placeholders = (s: string): string[] => [...new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!))].sort();

describe('message tables', () => {
  it('English and Korean have exactly the same keys', () => {
    expect(Object.keys(MESSAGES.ko).sort()).toEqual(Object.keys(MESSAGES.en).sort());
  });

  it('every message uses the same {placeholders} in both languages', () => {
    for (const key of Object.keys(MESSAGES.en)) {
      expect(placeholders(MESSAGES.ko[key]!), key).toEqual(placeholders(MESSAGES.en[key]!));
    }
  });

  it('no Korean message is empty, and Korean sentences use the formal polite style (no 해요체 endings)', () => {
    for (const [key, text] of Object.entries(MESSAGES.ko)) {
      expect(text.trim(), key).not.toBe('');
      expect(text, key).not.toMatch(/(해요|세요|어요|아요|예요)(\s|[.!?)]|$)/);
    }
  });

  it('counts use singular/plural in English and a counter word in Korean', () => {
    expect(count('en', 1, 'unit.request')).toBe('1 request');
    expect(count('en', 2, 'unit.request')).toBe('2 requests');
    expect(count('ko', 3, 'unit.request')).toBe('요청 3건');
  });

  it('known English library strings are translated, unknown ones pass through', () => {
    expect(localizeText('ko', 'failed batch_1')).toMatch(HANGUL);
    expect(localizeText('ko', '400 (client error, use --include-4xx)')).toContain('400');
    expect(localizeText('ko', 'something provider specific')).toBe('something provider specific');
    expect(localizeText('en', 'failed batch_1')).toBe('failed batch_1');
  });
});

describe('choosing the language', () => {
  it('--lang beats LLM_BATCHKIT_LANG, which beats LC_ALL, LC_MESSAGES and LANG', () => {
    const env = { LLM_BATCHKIT_LANG: 'ko', LC_ALL: 'en_US.UTF-8', LC_MESSAGES: 'en_US.UTF-8', LANG: 'en_US.UTF-8' };
    expect(resolveLang(['lint', 'f', '--lang', 'en'], env)).toBe('en');
    expect(resolveLang(['lint', 'f', '--lang=en'], env)).toBe('en');
    expect(resolveLang(['lint', 'f'], env)).toBe('ko');
    expect(resolveLang([], { LLM_BATCHKIT_LANG: 'en', LC_ALL: 'ko_KR.UTF-8' })).toBe('en');
    expect(resolveLang([], { LC_ALL: 'ko_KR.UTF-8', LC_MESSAGES: 'en_US.UTF-8', LANG: 'en_US.UTF-8' })).toBe('ko');
    expect(resolveLang([], { LC_MESSAGES: 'ko_KR.UTF-8', LANG: 'en_US.UTF-8' })).toBe('ko');
    expect(resolveLang([], { LANG: 'ko_KR.UTF-8' })).toBe('ko');
  });

  it('is English when nothing asks for Korean, and empty variables are skipped', () => {
    expect(resolveLang([], {})).toBe('en');
    expect(resolveLang([], { LANG: 'C' })).toBe('en');
    expect(resolveLang([], { LANG: 'fr_FR.UTF-8' })).toBe('en');
    expect(resolveLang([], { LLM_BATCHKIT_LANG: '', LANG: 'ko_KR.UTF-8' })).toBe('ko');
  });

  it('rejects an unknown --lang value or a missing one', () => {
    expect(() => resolveLang(['--lang', 'fr'], {})).toThrow(LangOptionError);
    expect(() => resolveLang(['--lang'], {})).toThrow(LangOptionError);
  });

  it('stripLangFlag removes the flag and its value only', () => {
    expect(stripLangFlag(['lint', '--lang', 'ko', 'a.jsonl'])).toEqual(['lint', 'a.jsonl']);
    expect(stripLangFlag(['lint', '--lang=ko', 'a.jsonl', '--', '--lang', 'x'])).toEqual(['lint', 'a.jsonl', '--', '--lang', 'x']);
  });
});

describe('the CLI speaks Korean when asked', () => {
  it('--help in Korean mentions --lang and LLM_BATCHKIT_LANG; English help does too', async () => {
    const ko = await cli(['--help', '--lang', 'ko']);
    expect(ko.code).toBe(0);
    expect(ko.out).toMatch(HANGUL);
    expect(ko.out).toContain('--lang en|ko');
    expect(ko.out).toContain('LLM_BATCHKIT_LANG');
    const en = await cli(['--help']);
    expect(en.out).not.toMatch(HANGUL);
    expect(en.out).toContain('--lang en|ko');
    expect(en.out).toContain('LLM_BATCHKIT_LANG');
  });

  it('every sub-command accepts --lang (even after its own options)', async () => {
    for (const cmd of ['lint', 'split', 'submit', 'collect', 'merge', 'retry']) {
      const r = await cli([cmd, '--lang', 'ko']);
      expect(r.code, cmd).toBe(64);
      expect(r.err, cmd).toMatch(HANGUL);
    }
    expect((await cli(['lint', fx('openai/input.jsonl'), '--lang=ko'])).code).toBe(0);
  });

  it('lint text report: Korean rows, summary and the same exit code', async () => {
    const ko = await cli(['lint', fx('openai/input-bad.jsonl'), '--lang', 'ko']);
    const en = await cli(['lint', fx('openai/input-bad.jsonl'), '--lang', 'en']);
    expect(ko.code).toBe(en.code);
    expect(ko.out).toMatch(HANGUL);
    expect(ko.out).toContain('duplicate_custom_id'); // issue codes are never translated
    expect(ko.out).toMatch(/요청 \d+건 · 모델 \d+개/);
    expect(en.out).not.toMatch(HANGUL);
    expect(en.out).toMatch(/\d+ requests · \d+ models?/);
  });

  it('error: and fix: lines are Korean, the exit code is unchanged', async () => {
    const ko = await cli(['lint', join(tmp(), 'missing.jsonl'), '--lang', 'ko']);
    const en = await cli(['lint', join(tmp(), 'missing.jsonl'), '--lang', 'en']);
    expect(ko.code).toBe(1);
    expect(en.code).toBe(1);
    expect(ko.err).toMatch(/^error: .*읽을 수 없습니다/);
    expect(ko.err).toMatch(/\n {2}fix: .*확인하십시오/);
    expect(en.err).toMatch(/^error: Cannot read /);
    expect(en.err).toContain('  fix: Check the path and permissions.');
  });

  it('usage errors are Korean and exit 64; a bad --lang value is a usage error', async () => {
    const missing = await cli(['split', fx('openai/input.jsonl'), '--lang', 'ko']);
    expect(missing.code).toBe(64);
    expect(missing.err).toContain('--out <dir>');
    expect(missing.err).toMatch(HANGUL);
    const bad = await cli(['lint', 'x', '--lang', 'fr']);
    expect(bad.code).toBe(64);
    expect(bad.err).toMatch(/--lang/);
    const unknown = await cli(['frobnicate', '--lang', 'ko']);
    expect(unknown.code).toBe(64);
    expect(unknown.err).toMatch(HANGUL);
  });

  it('the environment picks the language when --lang is absent, --lang wins over it', async () => {
    const fromEnv = await cli(['--help'], { LANG: 'ko_KR.UTF-8' });
    expect(fromEnv.out).toMatch(HANGUL);
    const flagWins = await cli(['--help', '--lang', 'en'], { LLM_BATCHKIT_LANG: 'ko' });
    expect(flagWins.out).not.toMatch(HANGUL);
    const specific = await cli(['--help'], { LLM_BATCHKIT_LANG: 'en', LC_ALL: 'ko_KR.UTF-8' });
    expect(specific.out).not.toMatch(HANGUL);
  });

  it('split, submit, collect, merge and retry print Korean summaries', async () => {
    const { dir, manifestPath } = makeRun();
    const split = await cli(['split', fx('openai/input.jsonl'), '--out', join(tmp(), 'o'), '--max-requests', '6', '--lang', 'ko']);
    expect(split.code).toBe(0);
    expect(split.out).toMatch(/샤드 2개 · 요청 12건 · manifest: /);
    const dry = await cli(['submit', manifestPath, '--dry-run', '--base-url', 'http://127.0.0.1:9/v1', '--lang', 'ko']);
    expect(dry.out).toMatch(/제출 예정 2건 · 이미 제출 0건 · 보류 0건/);
    const collectNone = await cli(['collect', manifestPath, '--base-url', 'http://127.0.0.1:9/v1', '--lang', 'ko']);
    expect(collectNone.err + collectNone.out).toMatch(HANGUL);
    const merged = await cli(['merge', manifestPath, fx('openai/shard-000.output.jsonl'), fx('openai/shard-001.output.jsonl'), fx('openai/shard-001.error.jsonl'), '--out', join(dir, 'results.jsonl'), '--lang', 'ko']);
    expect(merged.out).toMatch(/성공 \d+/);
    expect(merged.out).toContain('(기본값으로는 재시도하지 않음)');
    const retried = await cli(['retry', join(dir, 'results.jsonl'), '--out', join(dir, 'retry'), '--lang', 'ko']);
    expect(retried.out).toMatch(/제외: /);
    expect(retried.out).toMatch(/재시도 \d+건 · 제외 \d+건/);
  });

  it('--json output is byte-for-byte the same in both languages', async () => {
    for (const file of ['openai/input.jsonl', 'openai/input-bad.jsonl', 'anthropic/requests.json']) {
      const en = await cli(['lint', fx(file), '--json', '--lang', 'en']);
      const ko = await cli(['lint', fx(file), '--json', '--lang', 'ko']);
      expect(ko.out).toBe(en.out);
      expect(ko.code).toBe(en.code);
      expect(ko.out).not.toMatch(HANGUL);
    }
    const { dir, manifestPath } = makeRun();
    const files = ['shard-000.output.jsonl', 'shard-001.output.jsonl', 'shard-001.error.jsonl'].map((f) => fx('openai', f));
    const en = await cli(['merge', manifestPath, ...files, '--json', '--out', join(dir, 'a.jsonl'), '--lang', 'en']);
    const ko = await cli(['merge', manifestPath, ...files, '--json', '--out', join(dir, 'a.jsonl'), '--lang', 'ko']);
    expect(ko.out).toBe(en.out);
  });

  it('library results keep English issue messages whatever the environment says', () => {
    const report = lintFile(fx('openai/input-bad.jsonl'));
    expect(report.issues.every((i) => !HANGUL.test(i.message))).toBe(true);
    expect(t('en', 'lint.duplicate_custom_id', { first: 1 })).toBe('same as line 1');
  });
});

describe('mock-server announces itself in both languages', () => {
  const root = join(import.meta.dirname, '..');

  /** Start the real CLI process, wait for the last announcement line, stop it, return everything it printed. */
  async function announce(args: string[], env: NodeJS.ProcessEnv): Promise<string> {
    const child = spawn('node', [join(root, 'dist', 'cli.js'), 'mock-server', '--port', '0', ...args], { stdio: ['ignore', 'pipe', 'pipe'], env });
    let out = '';
    const exited = new Promise<void>((done) => child.once('exit', () => done()));
    try {
      await new Promise<void>((ready, fail) => {
        const timer = setTimeout(() => fail(new Error(`mock-server did not start: ${out}`)), 20_000);
        child.stdout.on('data', (d: Buffer) => {
          out += d.toString();
          if (out.includes('Ctrl+C')) {
            clearTimeout(timer);
            ready();
          }
        });
        child.once('exit', () => {
          clearTimeout(timer);
          fail(new Error(`mock-server exited early: ${out}`));
        });
      });
      child.kill('SIGTERM');
      await exited;
    } finally {
      child.kill('SIGKILL');
    }
    return out;
  }

  it('prints the same "listening on <url>" line, with the notice in the chosen language', async () => {
    const base = { PATH: process.env.PATH ?? '' };
    const ko = await announce(['--lang', 'ko'], { ...base, LLM_BATCHKIT_LANG: 'en' });
    const en = await announce(['--lang', 'en'], { ...base, LANG: 'ko_KR.UTF-8' });
    const fromEnv = await announce([], { ...base, LLM_BATCHKIT_LANG: 'ko' });
    expect(ko).toMatch(/^연습용 목\(mock\) 모드/);
    expect(fromEnv).toMatch(HANGUL);
    expect(en).toMatch(/^PRACTICE MOCK MODE/);
    expect(en).not.toMatch(HANGUL);
    for (const out of [ko, en, fromEnv]) expect(out).toMatch(/^listening on http:\/\/127\.0\.0\.1:\d+\//m);
  });
});

describe('bad scenario files are reported in Korean too', () => {
  it('names the file and keeps exit code 1', async () => {
    const p = join(tmp(), 'bad.json');
    writeFileSync(p, '{"x":1}');
    const ko = await cli(['mock-server', '--scenario', p, '--lang', 'ko']);
    expect(ko.code).toBe(1);
    expect(ko.err).toContain(p);
    expect(ko.err).toMatch(HANGUL);
  });
});
