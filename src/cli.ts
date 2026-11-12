#!/usr/bin/env node
import { readFileSync, existsSync, realpathSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { BatchkitError, errorTexts, fail } from './errors.js';
import { LangOptionError, count, langFromEnv, localizeText, render, resolveLang, stripLangFlag, t, type Lang, type Msg, type Params } from './i18n.js';
import { lintFile } from './lint.js';
import { mergeResults, readResultsFile, resultsToCsv, writeResultsJsonl } from './merge.js';
import { startMockServer } from './mock/server.js';
import { DEFAULT_SCENARIO, parseScenario } from './mock/scenario.js';
import { PROVIDER_NAMES } from './providers.js';
import { buildOriginalIndex, selectRetries, writeRetryFile } from './retry.js';
import { displayWidth, formatIssue, formatSummary, painter, table, type Painter } from './report.js';
import { parsePositiveInt, parseSize } from './size.js';
import { splitFile } from './split.js';
import { collect, submit } from './submit.js';
import type { ProviderName } from './types.js';

export interface CliIo {
  out(text: string): void;
  err(text: string): void;
  /** Use ANSI colors (default: real TTY and NO_COLOR unset). */
  color?: boolean;
  /** Environment used to pick the language (default: process.env). */
  env?: NodeJS.ProcessEnv;
}

/** A command-line mistake (exit 64). Holds a message-table entry so it can be shown in either language. */
class UsageError extends Error {
  readonly msg: Msg;
  constructor(key: string, params: Params = {}) {
    super(t('en', key, params));
    this.msg = { key, params };
  }
}

/** Most issues of one code printed in the text report. */
const MAX_SHOWN_PER_CODE = 50;

function opts(argv: string[], options: Record<string, { type: 'string' | 'boolean' }>, allowPositionals = true): { values: Record<string, any>; positionals: string[] } {
  try {
    return parseArgs({ args: argv, options, allowPositionals, strict: true }) as { values: Record<string, any>; positionals: string[] };
  } catch (e) {
    // The first line is Node's own parseArgs text (English); the usage hint after it is localized.
    throw new UsageError('usage.withHelp', { detail: (e as Error).message, help: { key: 'usage.help' } });
  }
}

function positional(values: string[], what: 'what.input' | 'what.manifest' | 'what.results'): string {
  const v = values[0];
  if (!v) throw new UsageError('usage.missing', { what: { key: what }, help: { key: 'usage.help' } });
  return v;
}

function provider(value: string | undefined): ProviderName | 'auto' {
  if (value === undefined || value === 'auto') return 'auto';
  if (!(PROVIDER_NAMES as string[]).includes(value)) {
    throw new UsageError('usage.provider', { list: PROVIDER_NAMES.join(', '), value });
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

async function cmdLint(argv: string[], io: CliIo, p: Painter, lang: Lang): Promise<number> {
  const { values, positionals } = opts(argv, { provider: { type: 'string' }, ...LIMIT_FLAGS, strict: { type: 'boolean' }, json: { type: 'boolean' } });
  const file = positional(positionals, 'what.input');
  const report = lintFile(file, { provider: provider(values.provider), ...limitOptions(values) });
  const failing = report.errors > 0 || (values.strict === true && report.warnings > 0);
  if (values.json) {
    // Machine-readable output is identical in every language (issue messages stay English).
    io.out(JSON.stringify({ ...report, ok: !failing }, null, 2) + '\n');
    return failing ? 1 : 0;
  }
  io.out(`${p.bold('lint')} ${file}  ${p.dim(t(lang, 'lint.provider', { provider: report.provider }))}\n`);
  if (report.issues.length > 0) {
    // Text output folds long runs of the same code (a non-JSONL file gives one issue per line); --json keeps everything.
    const perCode = new Map<string, number>();
    const shown = report.issues.filter((i) => {
      const n = (perCode.get(i.code) ?? 0) + 1;
      perCode.set(i.code, n);
      return n <= MAX_SHOWN_PER_CODE;
    });
    const rows = shown.map((i) => formatIssue(i, { ...p, red: (s) => s, yellow: (s) => s }, lang));
    const lines = table([t(lang, 'lint.col.line'), t(lang, 'lint.col.code'), t(lang, 'lint.col.message')], rows);
    io.out(`  ${lines[0]}\n`);
    shown.forEach((issue, i) => {
      const [where, code, message] = formatIssue(issue, p, lang);
      const widths = [Math.max(4, ...rows.map((r) => displayWidth(r[0]!))), Math.max(4, ...rows.map((r) => displayWidth(r[1]!)))];
      const pad = (visible: string, shown: string, w: number) => shown + ' '.repeat(Math.max(0, w - displayWidth(visible)));
      io.out(`  ${pad(rows[i]![0]!, where!, widths[0]!)}  ${pad(rows[i]![1]!, code!, widths[1]!)}  ${message}\n`);
    });
    for (const [code, n] of perCode) {
      if (n > MAX_SHOWN_PER_CODE) io.out(`  ${t(lang, 'lint.more', { n: n - MAX_SHOWN_PER_CODE, code })}\n`);
    }
  }
  const names = Object.keys(report.models);
  const modelPart = `${count(lang, names.length, 'unit.model')}${names.length ? ` (${names.join(', ')})` : ''}`;
  const tail = `${count(lang, report.errors, 'unit.error')}${report.warnings ? ` · ${count(lang, report.warnings, 'unit.warning')}` : ''}`;
  const line = `${count(lang, report.requests, 'unit.request')} · ${modelPart} · ${tail}`;
  io.out(`${failing ? p.red(line) : p.green(line)}\n`);
  return failing ? 1 : 0;
}
async function cmdSplit(argv: string[], io: CliIo, p: Painter, lang: Lang): Promise<number> {
  const { values, positionals } = opts(argv, { provider: { type: 'string' }, out: { type: 'string' }, ...LIMIT_FLAGS, 'skip-lint': { type: 'boolean' }, force: { type: 'boolean' } });
  const file = positional(positionals, 'what.input');
  if (!values.out) throw new UsageError('usage.splitOut');
  const { manifest, manifestPath } = splitFile(file, { out: values.out, provider: provider(values.provider), skipLint: values['skip-lint'] === true, force: values.force === true, ...limitOptions(values) });
  const headers = ['split.col.shard', 'split.col.requests', 'split.col.bytes', 'split.col.tokens', 'split.col.model'].map((k) => t(lang, k));
  const lines = table(headers, manifest.shards.map((s) => [s.file, String(s.count), String(s.bytes), String(s.est_tokens), s.model]));
  io.out(`${p.bold('split')} ${file} -> ${values.out}\n`);
  for (const l of lines) io.out(`  ${l}\n`);
  io.out(`${t(lang, 'split.summary', { shards: count(lang, manifest.shards.length, 'unit.shard'), requests: count(lang, manifest.order.length, 'unit.request'), path: manifestPath })}\n`);
  return 0;
}

async function cmdSubmit(argv: string[], io: CliIo, p: Painter, lang: Lang): Promise<number> {
  const { values, positionals } = opts(argv, { 'base-url': { type: 'string' }, 'completion-window': { type: 'string' }, 'max-enqueued-tokens': { type: 'string' }, 'dry-run': { type: 'boolean' }, 'resubmit-changed': { type: 'boolean' } });
  const manifest = positional(positionals, 'what.manifest');
  const r = await submit(manifest, {
    baseUrl: values['base-url'],
    completionWindow: values['completion-window'],
    maxEnqueuedTokens: parsePositiveInt('--max-enqueued-tokens', values['max-enqueued-tokens']),
    dryRun: values['dry-run'] === true,
    resubmitChanged: values['resubmit-changed'] === true,
  });
  const verb = t(lang, values['dry-run'] ? 'submit.verbSubmit' : 'submit.verbDone');
  for (const f of r.submitted) {
    const reason = r.reasons[f];
    io.out(`  ${f}  ${p.green(verb)}${reason ? p.yellow(t(lang, 'submit.replaces', { reason: localizeText(lang, reason) })) : ''}\n`);
  }
  for (const f of r.alreadySubmitted) io.out(`  ${f}  ${p.dim(t(lang, 'submit.already'))}\n`);
  if (r.setAside.length > 0) io.out(`${t(lang, 'submit.setAside', { files: r.setAside.join(', ') })}\n`);
  for (const f of r.held) io.out(`  ${f}  ${p.yellow(t(lang, 'submit.held'))}\n`);
  if (r.held.length > 0) {
    io.out(`${t(lang, 'submit.heldNote', { shards: count(lang, r.held.length, 'unit.shard') })}\n`);
  }
  io.out(`${t(lang, 'submit.summary', { n: r.submitted.length, verb, already: r.alreadySubmitted.length, held: r.held.length })}\n`);
  return 0;
}

async function cmdCollect(argv: string[], io: CliIo, p: Painter, lang: Lang): Promise<number> {
  const { values, positionals } = opts(argv, { 'base-url': { type: 'string' }, wait: { type: 'boolean' }, interval: { type: 'string' } });
  const manifest = positional(positionals, 'what.manifest');
  const r = await collect(manifest, {
    baseUrl: values['base-url'],
    wait: values.wait === true,
    intervalSeconds: parsePositiveInt('--interval', values.interval),
    onProgress: (line) => io.out(`${p.dim(localizeText(lang, line))}\n`),
  });
  for (const s of r.shards) {
    const files = s.downloaded.length ? ` -> ${s.downloaded.join(', ')}` : '';
    io.out(`  ${s.file}  ${s.status === 'failed' ? p.red(s.status) : s.status}${files}\n`);
    for (const f of s.failures) io.out(`    ${p.red(localizeText(lang, f))}\n`);
  }
  if (r.notSubmitted.length > 0) io.out(`${t(lang, 'collect.notSubmitted', { shards: count(lang, r.notSubmitted.length, 'unit.shard') })}\n`);
  io.out(`${t(lang, r.exitCode === 0 ? 'collect.done' : r.exitCode === 1 ? 'collect.failed' : 'collect.running')}\n`);
  return r.exitCode;
}

async function cmdMerge(argv: string[], io: CliIo, p: Painter, lang: Lang): Promise<number> {
  const { values, positionals } = opts(argv, { out: { type: 'string' }, csv: { type: 'string' }, json: { type: 'boolean' } });
  const manifest = positional(positionals, 'what.manifest');
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
  io.out(`${p.bold('merge')} ${t(lang, 'merge.head', { files: count(lang, report.files.length, 'unit.resultFile'), out: outPath })}\n`);
  io.out(`${formatSummary(report.summary, report.failedCodes, lang)}\n`);
  for (const r of report.rows.filter((x) => x.status !== 'succeeded')) {
    io.out(`  ${r.custom_id}  ${p.red(t(lang, `status.${r.status}`))}  ${r.code ?? '-'}  ${r.source ?? '-'}${r.retryable ? '' : p.dim(`  ${t(lang, 'report.notRetried')}`)}\n`);
  }
  for (const id of report.duplicates) io.out(`${t(lang, 'merge.duplicate', { id })}\n`);
  if (report.unknown.length > 0) io.out(`${t(lang, 'merge.unknown', { ids: report.unknown.join(', ') })}\n`);
  if (report.skippedLines > 0) io.out(`${t(lang, 'merge.skipped', { lines: count(lang, report.skippedLines, 'unit.unreadableLine') })}\n`);
  if (values.csv) io.out(`${t(lang, 'merge.csv', { path: values.csv })}\n`);
  return 0;
}

async function cmdRetry(argv: string[], io: CliIo, p: Painter, lang: Lang): Promise<number> {
  const { values, positionals } = opts(argv, { out: { type: 'string' }, manifest: { type: 'string' }, input: { type: 'string' }, 'include-4xx': { type: 'boolean' }, only: { type: 'string' } });
  const resultsPath = positional(positionals, 'what.results');
  if (!values.out) throw new UsageError('usage.retryOut');
  const rows = readResultsFile(resultsPath);
  const { selected, excluded } = selectRetries(rows, {
    include4xx: values['include-4xx'] === true,
    only: values.only ? (values.only as string).split(',').map((s: string) => s.trim()).filter(Boolean) : undefined,
  });
  for (const e of excluded) io.out(`  ${e.row.custom_id}  ${p.yellow(t(lang, 'retry.excluded', { why: localizeText(lang, e.reason.replace(/^excluded: /, '')) }))}\n`);
  if (selected.length === 0) {
    io.out(`${excluded.length ? t(lang, 'retry.nothingExcluded', { n: excluded.length }) : t(lang, 'retry.nothing')}\n`);
    return 0;
  }
  const manifestPath = values.manifest ?? (values.input ? undefined : join(dirname(resultsPath), 'manifest.json'));
  if (manifestPath !== undefined && !existsSync(manifestPath)) {
    throw fail('original_not_found', 'err.original_manifest', { path: manifestPath }, 'err.original_manifest.hint');
  }
  const { index, provider: prov } = buildOriginalIndex({ ...(manifestPath !== undefined ? { manifestPath } : {}), ...(values.input ? { inputPath: values.input } : {}) });
  const path = writeRetryFile(selected, index, prov, values.out);
  io.out(`${t(lang, 'retry.counts', { n: selected.length, excluded: excluded.length })}\n`);
  io.out(`${t(lang, 'retry.wrote', { path, requests: count(lang, selected.length, 'unit.request') })}\n`);
  return 0;
}

/** Read and validate a --scenario file; every failure becomes a BatchkitError that names the file. */
function loadScenario(path: string): ReturnType<typeof parseScenario> {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    throw fail('cannot_read_file', 'err.scenario_read', { path, detail: (e as Error).message }, 'err.scenario_read.hint');
  }
  if (text.trim() === '') throw fail('invalid_scenario', 'err.scenario_empty', { path }, 'err.scenario_shape.hint');
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw fail('invalid_scenario', 'err.scenario_json', { path, detail: (e as Error).message }, 'err.scenario_shape.hint');
  }
  try {
    return parseScenario(data);
  } catch (e) {
    if (e instanceof BatchkitError && e.text) {
      const text = e.text;
      throw new BatchkitError(e.code, `${path}: ${e.message}`, e.hint, { message: { key: 'err.prefixed', params: { path, inner: text.message } }, hint: text.hint });
    }
    if (e instanceof BatchkitError) throw new BatchkitError(e.code, `${path}: ${e.message}`, e.hint);
    throw e;
  }
}

async function cmdMockServer(argv: string[], io: CliIo, lang: Lang): Promise<number> {
  const { values } = opts(argv, { port: { type: 'string' }, scenario: { type: 'string' } }, false);
  let port = 0;
  if (values.port !== undefined) {
    if (!/^\d+$/.test(values.port) || Number(values.port) > 65535) throw new UsageError('usage.port', { value: values.port });
    port = Number(values.port);
  }
  const scenario = values.scenario ? loadScenario(values.scenario) : DEFAULT_SCENARIO;
  let server: Awaited<ReturnType<typeof startMockServer>>;
  try {
    server = await startMockServer({ scenario, port });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      throw fail('port_in_use', 'err.port_in_use', { port }, 'err.port_in_use.hint');
    }
    throw e;
  }
  // Install the signal handlers BEFORE announcing the address: whoever reads "listening on" may signal us right away,
  // and a signal that arrives before the handlers exist kills the process (exit code null) instead of stopping it cleanly.
  const stopped = new Promise<void>((done) => {
    process.once('SIGINT', done);
    process.once('SIGTERM', done);
  });
  // The "listening on <url>" line has the same format in both languages: the demo and the tests parse it.
  const url = server.baseUrl;
  io.out(`${t(lang, 'mock.notice')}\n${t(lang, 'mock.listening', { url })}\n${t(lang, 'mock.try', { url })}\n${t(lang, 'mock.stop')}\n`);
  await stopped;
  await server.close();
  return 0;
}

/** Run the CLI. Returns the exit code instead of exiting, so tests can call it directly. */
export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const p = painter(io.color ?? false);
  const env = io.env ?? process.env;
  let lang: Lang;
  let langError: LangOptionError | undefined;
  try {
    lang = resolveLang(argv, env);
  } catch (e) {
    if (!(e instanceof LangOptionError)) throw e;
    langError = e;
    lang = langFromEnv(env); // report the bad --lang value in the language the environment asks for
  }
  const [command, ...rest] = stripLangFlag(argv);
  try {
    if (langError) throw new UsageError(langError.value === undefined ? 'usage.langMissing' : 'usage.lang', { value: langError.value ?? '' });
    switch (command) {
      case 'lint': return await cmdLint(rest, io, p, lang);
      case 'split': return await cmdSplit(rest, io, p, lang);
      case 'submit': return await cmdSubmit(rest, io, p, lang);
      case 'collect': return await cmdCollect(rest, io, p, lang);
      case 'merge': return await cmdMerge(rest, io, p, lang);
      case 'retry': return await cmdRetry(rest, io, p, lang);
      case 'mock-server': return await cmdMockServer(rest, io, lang);
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
        io.out(t(lang, 'help'));
        return command === undefined ? 64 : 0;
      default:
        io.err(`error: ${t(lang, 'usage.unknownCommand', { command })}\n${t(lang, 'help')}`);
        return 64;
    }
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(`error: ${render(lang, e.msg)}\n`);
      return 64;
    }
    if (e instanceof BatchkitError) {
      const { message, hint } = errorTexts(e, lang);
      io.err(`error: ${message}\n${hint ? `  fix: ${hint}\n` : ''}`);
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
