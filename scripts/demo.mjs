// Keyless practice run of the whole batch cycle against the local mock server (127.0.0.1).
//   npm run demo
// Steps: lint(bad) -> split -> submit -> collect -> merge -> retry -> split -> submit -> collect -> merge
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCli } from '../dist/cli.js';
import { mergeResults, MOCK_NOTICE, parseScenario, startMockServer } from '../dist/index.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const examples = (f) => join(root, 'examples', f);

// Prove that no key is needed: the demo never reads a real key or talks to the internet.
delete process.env.OPENAI_API_KEY;
delete process.env.OPENAI_BASE_URL;

console.log(MOCK_NOTICE);
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
  const code = await runCli(args, { out: (s) => process.stdout.write(s), err: (s) => process.stdout.write(s), color: false });
  if (code !== expectExit) throw new Error(`step "${title}" exited ${code}, expected ${expectExit}`);
  console.log(`(exit ${code})\n`);
}

try {
  const base = ['--base-url', server.baseUrl];
  await step('1. catch mistakes BEFORE uploading (this file is broken on purpose)', ['lint', examples('openai/input-bad.jsonl')], 1);
  await step('2. the real input is clean', ['lint', examples('openai/input.jsonl')]);
  await step('3. split into shards (6 requests each)', ['split', examples('openai/input.jsonl'), '--out', run1, '--max-requests', '6']);
  await step('4. submit every shard once', ['submit', join(run1, 'manifest.json'), ...base]);
  await step('5. collect output / error files', ['collect', join(run1, 'manifest.json'), ...base]);
  await step('6. merge by custom_id (a 400 hides in an output file, req-006 is missing)', ['merge', join(run1, 'manifest.json')]);
  await step('7. pick only what is worth retrying', ['retry', join(run1, 'results.jsonl'), '--out', retry1]);
  await step('8. split the retry file', ['split', join(retry1, 'input.jsonl'), '--out', retry1]);
  await step('9. submit the retry shard', ['submit', join(retry1, 'manifest.json'), ...base]);
  await step('10. collect the retry results', ['collect', join(retry1, 'manifest.json'), ...base]);
  await step('11. merge both rounds', ['merge', join(run1, 'manifest.json')]);

  const final = mergeResults(join(run1, 'manifest.json'));
  const retried = readFileSync(join(retry1, 'input.jsonl'), 'utf8').trim().split('\n').length;
  const failed400 = final.failedCodes['400'] ?? 0;
  if ((final.summary.succeeded ?? 0) !== 11 || (final.summary.failed ?? 0) !== 1 || failed400 !== 1 || retried !== 4) {
    throw new Error(`unexpected result: ${JSON.stringify(final.summary)} retried=${retried}`);
  }
  console.log(`DEMO OK  succeeded ${final.summary.succeeded} · failed ${final.summary.failed} (400, not retried) · retried ${retried}`);
} finally {
  await server.close();
  if (!process.env.DEMO_KEEP) rmSync(work, { recursive: true, force: true });
}
