import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { startMockServer } from '../src/mock/server.js';
import { cli, fx, tmp } from './helpers.js';

const root = join(import.meta.dirname, '..');

describe('cli', () => {
  it('demo script end to end', () => {
    const env = { ...process.env };
    delete env.OPENAI_API_KEY; // the demo must work without a key
    delete env.OPENAI_BASE_URL;
    const started = Date.now();
    const r = spawnSync('node', [join(root, 'scripts', 'demo.mjs')], { encoding: 'utf8', env, timeout: 60_000 });
    expect(r.status).toBe(0);
    const lines = r.stdout.trim().split('\n');
    expect(lines[0]).toContain('PRACTICE MOCK MODE');
    expect(lines[lines.length - 1]).toBe('DEMO OK  succeeded 11 · failed 1 (400, not retried) · retried 4');
    expect(Date.now() - started).toBeLessThan(60_000);
    expect(r.stdout).toContain('succeeded 7 · failed 2 (400×1, 500×1) · expired 1 · cancelled 1 · missing 1');
  }, 90_000);

  it('help, version and unknown commands', async () => {
    expect((await cli(['--help'])).out).toContain('Usage:');
    expect((await cli([])).code).toBe(64);
    const bad = await cli(['frobnicate']);
    expect(bad.code).toBe(64);
    expect(bad.err).toContain('unknown command');
    const v = await cli(['--version']);
    expect(v.out.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('usage errors name the problem', async () => {
    const r = await cli(['split', fx('openai/input.jsonl')]);
    expect(r.code).toBe(64);
    expect(r.err).toContain('--out');
    const unknownFlag = await cli(['lint', fx('openai/input.jsonl'), '--nope']);
    expect(unknownFlag.code).toBe(64);
    expect(unknownFlag.err).toContain('--help');
  });

  it('NO_COLOR / non-TTY output has no escape codes', async () => {
    expect((await cli(['lint', fx('openai/input-bad.jsonl')])).out).not.toContain('\u001b[');
  });

  it('the package is prepared but not secret-bearing', () => {
    const pkg = JSON.parse(spawnSync('cat', [join(root, 'package.json')], { encoding: 'utf8' }).stdout) as Record<string, any>;
    expect(pkg).toMatchObject({ name: 'llm-batchkit', type: 'module', license: 'MIT', engines: { node: '>=22.12' }, bin: { 'llm-batchkit': 'dist/cli.js' } });
    expect(pkg.dependencies).toBeUndefined(); // zero runtime dependencies
  });
});

describe('cli edge cases', () => {
  it('mock-server rejects a bad port with a short usage error', async () => {
    for (const bad of ['abc', '-1', '70000']) {
      const r = await cli(['mock-server', `--port=${bad}`]);
      expect(r.code).toBe(64);
      expect(r.err).toContain('--port must be an integer from 0 to 65535');
      expect(r.err).not.toContain('    at '); // no stack trace
    }
  });

  it('mock-server reports a port that is already in use with a fix', async () => {
    const busy = await startMockServer();
    try {
      const r = await cli(['mock-server', '--port', String(busy.port)]);
      expect(r.code).toBe(1);
      expect(r.err).toContain('already in use');
      expect(r.err).toContain('--port 0');
    } finally {
      await busy.close();
    }
  });

  // Real subprocess: the stack trace and exit 70 only come from the entry-point rejection handler.
  describe('mock-server --scenario with an unusable file', () => {
    const runScenario = (p: string): ReturnType<typeof spawnSync<string>> =>
      spawnSync('node', [join(root, 'dist', 'cli.js'), 'mock-server', '--scenario', p], { encoding: 'utf8', timeout: 30_000 });

    const expectFriendly = (p: string, r: ReturnType<typeof runScenario>): void => {
      expect(r.status).toBe(1);
      expect(r.stderr.startsWith('error: ')).toBe(true);
      expect(r.stderr).toContain(p);
      expect(r.stderr).toContain('  fix: ');
      expect(r.stderr).not.toContain('    at ');
      expect(r.stderr).not.toContain('unexpected error');
    };

    it('missing file', () => {
      const p = join(tmp(), 'nope.json');
      const r = runScenario(p);
      expectFriendly(p, r);
      expect(r.stderr).toContain('Cannot read scenario');
    });

    it('directory instead of a file', () => {
      const p = tmp();
      const r = runScenario(p);
      expectFriendly(p, r);
      expect(r.stderr).toContain('Cannot read scenario');
    });

    it('unreadable file', (ctx) => {
      if (process.platform === 'win32' || process.getuid?.() === 0) return ctx.skip();
      const p = join(tmp(), 'noread.json');
      writeFileSync(p, '{"results":{}}', { mode: 0o000 });
      chmodSync(p, 0o000);
      const r = runScenario(p);
      expectFriendly(p, r);
      expect(r.stderr).toContain('Cannot read scenario');
    });

    it('invalid JSON', () => {
      const p = join(tmp(), 'bad.json');
      writeFileSync(p, '{bad');
      const r = runScenario(p);
      expectFriendly(p, r);
      expect(r.stderr).toContain('not valid JSON');
    });

    it('empty file', () => {
      const p = join(tmp(), 'empty.json');
      writeFileSync(p, '');
      const r = runScenario(p);
      expectFriendly(p, r);
      expect(r.stderr).toContain('is empty');
    });

    it('valid JSON in the wrong shape', () => {
      const p = join(tmp(), 'schema.json');
      writeFileSync(p, '{"x":1}');
      const r = runScenario(p);
      expectFriendly(p, r);
      expect(r.stderr).toContain('Scenario must be');
    });

    it('a good scenario file still starts and stops cleanly', async () => {
      const child = spawn('node', [join(root, 'dist', 'cli.js'), 'mock-server', '--scenario', join(root, 'examples', 'mock-scenario.json'), '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      const exited = new Promise<number | null>((done) => child.once('exit', (code) => done(code)));
      await new Promise<void>((ready, fail) => {
        const timer = setTimeout(() => fail(new Error('mock-server did not start')), 20_000);
        child.stdout.on('data', (d: Buffer) => {
          out += d.toString();
          if (out.includes('listening on http://127.0.0.1:')) {
            clearTimeout(timer);
            ready();
          }
        });
      });
      child.kill('SIGTERM');
      expect(await exited).toBe(0);
      expect(out).toContain('PRACTICE MOCK MODE');
    }, 40_000);
  });

  it('lint treats an empty file as an error, like split does', async () => {
    const dir = tmp();
    const empty = join(dir, 'empty.jsonl');
    writeFileSync(empty, '');
    const r = await cli(['lint', empty]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('empty_file');
    expect((await cli(['split', empty, '--out', join(dir, 'o')])).code).toBe(1);
  });

  it('lint folds a long run of the same issue in text output but keeps all of them in --json', async () => {
    const dir = tmp();
    const notJsonl = join(dir, 'notes.jsonl');
    writeFileSync(notJsonl, Array.from({ length: 120 }, (_, i) => `this is line ${i}, not json`).join('\n') + '\n');
    const text = await cli(['lint', notJsonl]);
    expect(text.code).toBe(1);
    expect(text.out).toContain('... and 70 more invalid_json_line');
    expect(text.out.split('\n').length).toBeLessThan(70);
    const json = JSON.parse((await cli(['lint', notJsonl, '--json'])).out) as { issues: unknown[] };
    expect(json.issues.length).toBeGreaterThanOrEqual(120);
  });
});
