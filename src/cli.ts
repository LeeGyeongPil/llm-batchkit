#!/usr/bin/env node
import { readFileSync, existsSync, realpathSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { BatchkitError } from './errors.js';
import { lintFile } from './lint.js';
import { mergeResults, readResultsFile, resultsToCsv, writeResultsJsonl } from './merge.js';
import { MOCK_NOTICE, startMockServer } from './mock/server.js';
import { DEFAULT_SCENARIO, parseScenario } from './mock/scenario.js';
import { PROVIDER_NAMES } from './providers.js';
import { buildOriginalIndex, selectRetries, writeRetryFile } from './retry.js';
import { formatIssue, formatSummary, painter, plural, table, type Painter } from './report.js';
import { parsePositiveInt, parseSize } from './size.js';
import { splitFile } from './split.js';
import { collect, submit } from './submit.js';
import type { ProviderName } from './types.js';

export interface CliIo {
  out(text: string): void;
  err(text: string): void;
  /** Use ANSI colors (default: real TTY and NO_COLOR unset). */
  color?: boolean;
}

const HELP = `llm-batchkit - lint, split, submit, merge and retry LLM Batch API files

Usage:
  llm-batchkit lint <file> [--provider auto|openai|azure|anthropic] [--max-requests N] [--max-bytes N|200MiB] [--max-tokens N] [--strict] [--json]
  llm-batchkit split <file> --out <dir> [--provider ...] [--max-requests N] [--max-bytes N] [--max-tokens N] [--skip-lint] [--force]
  llm-batchkit submit <dir>/manifest.json [--base-url URL] [--completion-window 24h] [--max-enqueued-tokens N] [--dry-run] [--resubmit-changed]
  llm-batchkit collect <dir>/manifest.json [--base-url URL] [--wait] [--interval 30]
  llm-batchkit merge <dir>/manifest.json [result files...] [--out results.jsonl] [--csv results.csv] [--json]
  llm-batchkit retry <results.jsonl> --out <dir> [--manifest f] [--input original] [--include-4xx] [--only expired,cancelled,missing,failed]
  llm-batchkit mock-server [--port 0] [--scenario file.json]

Exit codes: lint 1 on errors; collect 0 done / 1 a batch failed validation / 2 still running or not submitted;
submit 1 when a shard changed after its batch was created (nothing is uploaded then).
submit/collect need OPENAI_API_KEY (or a local --base-url such as the mock server). Everything else works offline.
`;

class UsageError extends Error {}

/** Most issues of one code printed in the text report. */
const MAX_SHOWN_PER_CODE = 50;

function opts(argv: string[], options: Record<string, { type: 'string' | 'boolean' }>, allowPositionals = true): { values: Record<string, any>; positionals: string[] } {
  try {
    return parseArgs({ args: argv, options, allowPositionals, strict: true }) as { values: Record<string, any>; positionals: string[] };
  } catch (e) {
    throw new UsageError(`${(e as Error).message}\nRun \`llm-batchkit --help\` for usage.`);
  }
}

function positional(values: string[], what: string): string {
  const v = values[0];
  if (!v) throw new UsageError(`Missing ${what}.\nRun \`llm-batchkit --help\` for usage.`);
  return v;
}

function provider(value: string | undefined): ProviderName | 'auto' {
  if (value === undefined || value === 'auto') return 'auto';
  if (!(PROVIDER_NAMES as string[]).includes(value)) {
    throw new UsageError(`--provider must be one of: auto, ${PROVIDER_NAMES.join(', ')} (got "${value}")`);
  }
  return value as ProviderName;
}

function limitOptions(v: Record<string, any>) {
  return {
    maxRequests: parsePositiveInt('--max-requests', v['max-requests'] as string | undefined),
    maxBytes: v['max-bytes'] === undefined ? undefined : parseSize(v['max-bytes'] as string),
    maxTokens: parsePositiveInt('--max-tokens', v['max-tokens'] as string | undefined),
  };
}

const LIMIT_FLAGS = { 'max-requests': { type: 'string' }, 'max-bytes': { type: 'string' }, 'max-tokens': { type: 'string' } } as const;

async function cmdLint(argv: string[], io: CliIo, p: Painter): Promise<number> {
  const { values, positionals } = opts(argv, { provider: { type: 'string' }, ...LIMIT_FLAGS, strict: { type: 'boolean' }, json: { type: 'boolean' } });
  const file = positional(positionals, 'input file');
  const report = lintFile(file, { provider: provider(values.provider), ...limitOptions(values) });
  const failing = report.errors > 0 || (values.strict === true && report.warnings > 0);
  if (values.json) {
    io.out(JSON.stringify({ ...report, ok: !failing }, null, 2) + '\n');
    return failing ? 1 : 0;
  }
  io.out(`${p.bold('lint')} ${file}  ${p.dim(`(provider ${report.provider})`)}\n`);
  if (report.issues.length > 0) {
    // Text output folds long runs of the same code (a non-JSONL file gives one issue per line); --json keeps everything.
    const perCode = new Map<string, number>();
    const shown = report.issues.filter((i) => {
      const n = (perCode.get(i.code) ?? 0) + 1;
      perCode.set(i.code, n);
      return n <= MAX_SHOWN_PER_CODE;
    });
    const rows = shown.map((i) => formatIssue(i, { ...p, red: (s) => s, yellow: (s) => s }));
    const lines = table(['LINE', 'CODE', 'MESSAGE'], rows);
    io.out(`  ${lines[0]}\n`);
    shown.forEach((issue, i) => {
      const [where, code, message] = formatIssue(issue, p);
      const widths = [Math.max(4, ...rows.map((r) => r[0]!.length)), Math.max(4, ...rows.map((r) => r[1]!.length))];
      const pad = (visible: string, shown: string, w: number) => shown + ' '.repeat(Math.max(0, w - visible.length));
      io.out(`  ${pad(rows[i]![0]!, where!, widths[0]!)}  ${pad(rows[i]![1]!, code!, widths[1]!)}  ${message}\n`);
    });
    for (const [code, n] of perCode) {
      if (n > MAX_SHOWN_PER_CODE) io.out(`  ... and ${n - MAX_SHOWN_PER_CODE} more ${code} (use --json to list all)\n`);
    }
  }
  const names = Object.keys(report.models);
  const modelPart = `${plural(names.length, 'model')}${names.length ? ` (${names.join(', ')})` : ''}`;
  const tail = `${plural(report.errors, 'error')}${report.warnings ? ` · ${plural(report.warnings, 'warning')}` : ''}`;
  const line = `${plural(report.requests, 'request')} · ${modelPart} · ${tail}`;
  io.out(`${failing ? p.red(line) : p.green(line)}\n`);
  return failing ? 1 : 0;
}

async function cmdSplit(argv: string[], io: CliIo, p: Painter): Promise<number> {
  const { values, positionals } = opts(argv, { provider: { type: 'string' }, out: { type: 'string' }, ...LIMIT_FLAGS, 'skip-lint': { type: 'boolean' }, force: { type: 'boolean' } });
  const file = positional(positionals, 'input file');
  if (!values.out) throw new UsageError('split needs --out <dir>.\nExample: llm-batchkit split input.jsonl --out run1 --max-requests 5000');
  const { manifest, manifestPath } = splitFile(file, { out: values.out, provider: provider(values.provider), skipLint: values['skip-lint'] === true, force: values.force === true, ...limitOptions(values) });
  const lines = table(['SHARD', 'REQUESTS', 'BYTES', 'EST_TOKENS', 'MODEL'], manifest.shards.map((s) => [s.file, String(s.count), String(s.bytes), String(s.est_tokens), s.model]));
  io.out(`${p.bold('split')} ${file} -> ${values.out}\n`);
  for (const l of lines) io.out(`  ${l}\n`);
  io.out(`${plural(manifest.shards.length, 'shard')} · ${plural(manifest.order.length, 'request')} · manifest: ${manifestPath}\n`);
  return 0;
}

async function cmdSubmit(argv: string[], io: CliIo, p: Painter): Promise<number> {
  const { values, positionals } = opts(argv, { 'base-url': { type: 'string' }, 'completion-window': { type: 'string' }, 'max-enqueued-tokens': { type: 'string' }, 'dry-run': { type: 'boolean' }, 'resubmit-changed': { type: 'boolean' } });
  const manifest = positional(positionals, 'manifest.json');
  const r = await submit(manifest, {
    baseUrl: values['base-url'],
    completionWindow: values['completion-window'],
    maxEnqueuedTokens: parsePositiveInt('--max-enqueued-tokens', values['max-enqueued-tokens']),
    dryRun: values['dry-run'] === true,
    resubmitChanged: values['resubmit-changed'] === true,
  });
  const verb = values['dry-run'] ? 'would submit' : 'submitted';
  for (const f of r.submitted) {
    const reason = r.reasons[f];
    io.out(`  ${f}  ${p.green(verb)}${reason ? p.yellow(` (replaces an earlier batch: ${reason})`) : ''}\n`);
  }
  for (const f of r.alreadySubmitted) io.out(`  ${f}  ${p.dim('already submitted (skipped)')}\n`);
  if (r.setAside.length > 0) io.out(`kept old result files as ${r.setAside.join(', ')} (merge ignores them)\n`);
  for (const f of r.held) io.out(`  ${f}  ${p.yellow('held')}\n`);
  if (r.held.length > 0) {
    io.out(`held ${plural(r.held.length, 'shard')} (enqueued token budget) - run \`collect\`, then \`submit\` again to send them\n`);
  }
  io.out(`${r.submitted.length} ${verb.replace('submitted', 'submitted')} · ${r.alreadySubmitted.length} already submitted · ${r.held.length} held\n`);
  return 0;
}

async function cmdCollect(argv: string[], io: CliIo, p: Painter): Promise<number> {
  const { values, positionals } = opts(argv, { 'base-url': { type: 'string' }, wait: { type: 'boolean' }, interval: { type: 'string' } });
  const manifest = positional(positionals, 'manifest.json');
  const r = await collect(manifest, {
    baseUrl: values['base-url'],
    wait: values.wait === true,
    intervalSeconds: parsePositiveInt('--interval', values.interval),
    onProgress: (line) => io.out(`${p.dim(line)}\n`),
  });
  for (const s of r.shards) {
    const files = s.downloaded.length ? ` -> ${s.downloaded.join(', ')}` : '';
    io.out(`  ${s.file}  ${s.status === 'failed' ? p.red(s.status) : s.status}${files}\n`);
    for (const f of s.failures) io.out(`    ${p.red(f)}\n`);
  }
  if (r.notSubmitted.length > 0) io.out(`${plural(r.notSubmitted.length, 'shard')} not submitted yet - run \`submit\` again\n`);
  const message = r.exitCode === 0 ? 'all batches finished - run `merge` next' : r.exitCode === 1 ? 'a batch failed validation - fix that shard file, then run \`submit\` again (only failed shards are sent again)' : 'not finished yet - run `collect` again later (or use --wait)';
  io.out(`${message}\n`);
  return r.exitCode;
}

async function cmdMerge(argv: string[], io: CliIo, p: Painter): Promise<number> {
  const { values, positionals } = opts(argv, { out: { type: 'string' }, csv: { type: 'string' }, json: { type: 'boolean' } });
  const manifest = positional(positionals, 'manifest.json');
  const files = positionals.slice(1);
  const report = mergeResults(manifest, { files });
  const outPath = values.out ?? join(dirname(manifest), 'results.jsonl');
  mkdirSync(dirname(resolve(outPath)), { recursive: true });
  writeResultsJsonl(report.rows, outPath);
  if (values.csv) {
    mkdirSync(dirname(resolve(values.csv)), { recursive: true });
    writeFileSync(values.csv, resultsToCsv(report.rows));
  }
  if (values.json) {
    const rows = report.rows.map(({ response: _response, ...rest }) => rest);
    io.out(JSON.stringify({ summary: report.summary, failed_codes: report.failedCodes, duplicates: report.duplicates, unknown: report.unknown, skipped_lines: report.skippedLines, files: report.files, results: outPath, rows }, null, 2) + '\n');
    return 0;
  }
  io.out(`${p.bold('merge')} ${plural(report.files.length, 'result file')} -> ${outPath}\n`);
  io.out(`${formatSummary(report.summary, report.failedCodes)}\n`);
  for (const r of report.rows.filter((x) => x.status !== 'succeeded')) {
    io.out(`  ${r.custom_id}  ${p.red(r.status)}  ${r.code ?? '-'}  ${r.source ?? '-'}${r.retryable ? '' : p.dim('  (not retried by default)')}\n`);
  }
  for (const id of report.duplicates) io.out(`duplicate: ${id} (kept first success)\n`);
  if (report.unknown.length > 0) io.out(`unknown custom_id(s) not in manifest: ${report.unknown.join(', ')}\n`);
  if (report.skippedLines > 0) io.out(`skipped ${plural(report.skippedLines, 'unreadable result line')}\n`);
  if (values.csv) io.out(`csv: ${values.csv}\n`);
  return 0;
}

async function cmdRetry(argv: string[], io: CliIo, p: Painter): Promise<number> {
  const { values, positionals } = opts(argv, { out: { type: 'string' }, manifest: { type: 'string' }, input: { type: 'string' }, 'include-4xx': { type: 'boolean' }, only: { type: 'string' } });
  const resultsPath = positional(positionals, 'results.jsonl');
  if (!values.out) throw new UsageError('retry needs --out <dir>.\nExample: llm-batchkit retry run1/results.jsonl --out run1/retry-1');
  const rows = readResultsFile(resultsPath);
  const { selected, excluded } = selectRetries(rows, {
    include4xx: values['include-4xx'] === true,
    only: values.only ? (values.only as string).split(',').map((s: string) => s.trim()).filter(Boolean) : undefined,
  });
  for (const e of excluded) io.out(`  ${e.row.custom_id}  ${p.yellow(e.reason)}\n`);
  if (selected.length === 0) {
    io.out(`nothing to retry${excluded.length ? ` (${excluded.length} excluded)` : ''}\n`);
    return 0;
  }
  const manifestPath = values.manifest ?? (values.input ? undefined : join(dirname(resultsPath), 'manifest.json'));
  if (manifestPath !== undefined && !existsSync(manifestPath)) {
    throw new BatchkitError('original_not_found', `No manifest at ${manifestPath}`, 'Pass --manifest <manifest.json> or --input <original file> so the original request lines can be copied.');
  }
  const { index, provider: prov } = buildOriginalIndex({ ...(manifestPath !== undefined ? { manifestPath } : {}), ...(values.input ? { inputPath: values.input } : {}) });
  const path = writeRetryFile(selected, index, prov, values.out);
  io.out(`${selected.length} to retry · ${excluded.length} excluded\n`);
  io.out(`wrote ${path} (${plural(selected.length, 'request')}, original lines unchanged)\n`);
  return 0;
}

/** Read and validate a --scenario file; every failure becomes a BatchkitError that names the file. */
function loadScenario(path: string): ReturnType<typeof parseScenario> {
  const example = 'See examples/mock-scenario.json.';
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    throw new BatchkitError('cannot_read_file', `Cannot read scenario ${path}: ${(e as Error).message}`, 'Check the path and permissions, or omit --scenario to use the built-in scenario (same as examples/mock-scenario.json).');
  }
  if (text.trim() === '') throw new BatchkitError('invalid_scenario', `Scenario ${path} is empty`, example);
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new BatchkitError('invalid_scenario', `Scenario ${path} is not valid JSON: ${(e as Error).message}`, example);
  }
  try {
    return parseScenario(data);
  } catch (e) {
    if (e instanceof BatchkitError) throw new BatchkitError(e.code, `${path}: ${e.message}`, e.hint);
    throw e;
  }
}

async function cmdMockServer(argv: string[], io: CliIo): Promise<number> {
  const { values } = opts(argv, { port: { type: 'string' }, scenario: { type: 'string' } }, false);
  let port = 0;
  if (values.port !== undefined) {
    if (!/^\d+$/.test(values.port) || Number(values.port) > 65535) throw new UsageError(`--port must be an integer from 0 to 65535 (0 picks a free port), got "${values.port}"`);
    port = Number(values.port);
  }
  const scenario = values.scenario ? loadScenario(values.scenario) : DEFAULT_SCENARIO;
  let server: Awaited<ReturnType<typeof startMockServer>>;
  try {
    server = await startMockServer({ scenario, port });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      throw new BatchkitError('port_in_use', `Port ${port} is already in use`, 'Pass a different --port, or --port 0 to pick a free one.');
    }
    throw e;
  }
  // Install the signal handlers BEFORE announcing the address: whoever reads "listening on" may signal us right away,
  // and a signal that arrives before the handlers exist kills the process (exit code null) instead of stopping it cleanly.
  const stopped = new Promise<void>((done) => {
    process.once('SIGINT', done);
    process.once('SIGTERM', done);
  });
  io.out(`${MOCK_NOTICE}\nlistening on ${server.baseUrl}\nTry: llm-batchkit submit <manifest> --base-url ${server.baseUrl}\nPress Ctrl+C to stop.\n`);
  await stopped;
  await server.close();
  return 0;
}

/** Run the CLI. Returns the exit code instead of exiting, so tests can call it directly. */
export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const p = painter(io.color ?? false);
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case 'lint': return await cmdLint(rest, io, p);
      case 'split': return await cmdSplit(rest, io, p);
      case 'submit': return await cmdSubmit(rest, io, p);
      case 'collect': return await cmdCollect(rest, io, p);
      case 'merge': return await cmdMerge(rest, io, p);
      case 'retry': return await cmdRetry(rest, io, p);
      case 'mock-server': return await cmdMockServer(rest, io);
      case '--version':
      case '-v': {
        const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
        io.out(`${pkg.version}\n`);
        return 0;
      }
      case undefined:
      case '--help':
      case '-h':
      case 'help':
        io.out(HELP);
        return command === undefined ? 64 : 0;
      default:
        io.err(`error: unknown command "${command}"\n${HELP}`);
        return 64;
    }
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(`error: ${e.message}\n`);
      return 64;
    }
    if (e instanceof BatchkitError) {
      io.err(`error: ${e.message}\n${e.hint ? `  fix: ${e.hint}\n` : ''}`);
      return 1;
    }
    throw e;
  }
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isMain()) {
  const color = process.stdout.isTTY === true && !process.env.NO_COLOR;
  runCli(process.argv.slice(2), { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s), color }).then(
    (code) => { process.exitCode = code; },
    (e: Error) => { process.stderr.write(`unexpected error: ${e.stack ?? e.message}\n`); process.exitCode = 70; },
  );
}

// Keep fileURLToPath referenced for bundlers that tree-shake import.meta helpers.
void fileURLToPath;
