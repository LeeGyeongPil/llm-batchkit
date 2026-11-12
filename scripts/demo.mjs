// Keyless practice run of the whole batch cycle against the local mock server (127.0.0.1).
//   npm run demo
// Steps: lint(bad) -> split -> submit -> collect -> merge -> retry -> split -> submit -> collect -> merge
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCli } from '../dist/cli.js';
import { mergeResults, parseScenario, resolveLang, startMockServer, t } from '../dist/index.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const examples = (f) => join(root, 'examples', f);

// Prove that no key is needed: the demo never reads a real key or talks to the internet.
delete process.env.OPENAI_API_KEY;
delete process.env.OPENAI_BASE_URL;

// Language: `npm run demo -- --lang ko`, LLM_BATCHKIT_LANG, or the usual LC_ALL / LC_MESSAGES / LANG (Korean only when it starts with "ko").
const lang = resolveLang(process.argv.slice(2), process.env);
const env = { ...process.env, LLM_BATCHKIT_LANG: lang };

console.log(t(lang, 'mock.notice'));
console.log('');

const scenario = parseScenario(JSON.parse(readFileSync(examples('mock-scenario.json'), 'utf8')));
const server = await startMockServer({ scenario });
const work = mkdtempSync(join(tmpdir(), 'llm-batchkit-demo-'));
const run1 = join(work, 'run1');
const retry1 = join(run1, 'retry-1');

// Run one CLI command in-process, echo it like a shell session, and check its exit code.
async function step(title, args, expectExit = 0) {
  console.log(`# ${title}`);
  console.log(`$ llm-batchkit ${args.map((a) => (a.startsWith(work) ? relative(work, a) : a.startsWith(root) ? relative(root, a) : a)).join(' ')}`);
  const code = await runCli(args, { out: (s) => process.stdout.write(s), err: (s) => process.stdout.write(s), color: false, env });
  if (code !== expectExit) throw new Error(`step "${title}" exited ${code}, expected ${expectExit}`);
  console.log(`(exit ${code})\n`);
}

try {
  const base = ['--base-url', server.baseUrl];
  await step(t(lang, 'demo.s1'), ['lint', examples('openai/input-bad.jsonl')], 1);
  await step(t(lang, 'demo.s2'), ['lint', examples('openai/input.jsonl')]);
  await step(t(lang, 'demo.s3'), ['split', examples('openai/input.jsonl'), '--out', run1, '--max-requests', '6']);
  await step(t(lang, 'demo.s4'), ['submit', join(run1, 'manifest.json'), ...base]);
  await step(t(lang, 'demo.s5'), ['collect', join(run1, 'manifest.json'), ...base]);
  await step(t(lang, 'demo.s6'), ['merge', join(run1, 'manifest.json')]);
  await step(t(lang, 'demo.s7'), ['retry', join(run1, 'results.jsonl'), '--out', retry1]);
  await step(t(lang, 'demo.s8'), ['split', join(retry1, 'input.jsonl'), '--out', retry1]);
  await step(t(lang, 'demo.s9'), ['submit', join(retry1, 'manifest.json'), ...base]);
  await step(t(lang, 'demo.s10'), ['collect', join(retry1, 'manifest.json'), ...base]);
  await step(t(lang, 'demo.s11'), ['merge', join(run1, 'manifest.json')]);

  const final = mergeResults(join(run1, 'manifest.json'));
  const retried = readFileSync(join(retry1, 'input.jsonl'), 'utf8').trim().split('\n').length;
  const failed400 = final.failedCodes['400'] ?? 0;
  if ((final.summary.succeeded ?? 0) !== 11 || (final.summary.failed ?? 0) !== 1 || failed400 !== 1 || retried !== 4) {
    throw new Error(`unexpected result: ${JSON.stringify(final.summary)} retried=${retried}`);
  }
  console.log(t(lang, 'demo.ok', { succeeded: final.summary.succeeded ?? 0, failed: final.summary.failed ?? 0, retried }));
} finally {
  await server.close();
  if (!process.env.DEMO_KEEP) rmSync(work, { recursive: true, force: true });
}
