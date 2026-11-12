import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { t } from '../i18n.js';
import { loadRequests } from '../jsonl.js';
import { lintText } from '../lint.js';
import { DEFAULT_SCENARIO, type Outcome, type Scenario } from './scenario.js';

/** Banner shown wherever the mock is used: it is a teaching aid, not the real service. */
export const MOCK_NOTICE = t('en', 'mock.notice');

export interface RouteLog {
  method: string;
  path: string;
  purpose?: string;
  filename?: string;
  fileText?: string;
  endpoint?: string;
  completion_window?: string;
}

export interface MockServer {
  /** Base URL including /v1, e.g. http://127.0.0.1:41234/v1 */
  baseUrl: string;
  port: number;
  routes: RouteLog[];
  close(): Promise<void>;
}

export interface MockOptions {
  scenario?: Scenario;
  /** 0 picks a free port. The server always binds 127.0.0.1. */
  port?: number;
}

interface StoredBatch {
  id: string;
  endpoint: string;
  inputFileId: string;
  window: string;
  final: 'completed' | 'failed';
  errors: { code: string; line: number | null; message: string }[];
  outputFileId: string | null;
  errorFileId: string | null;
  total: number;
  failed: number;
  polls: number;
}

function parseMultipart(body: Buffer, contentType: string): { fields: Record<string, string>; filename?: string; fileText?: string } {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType);
  const fields: Record<string, string> = {};
  let filename: string | undefined;
  let fileText: string | undefined;
  if (!boundary) return { fields };
  const marker = `--${boundary[1] ?? boundary[2]}`;
  for (const part of body.toString('utf8').split(marker)) {
    const split = part.indexOf('\r\n\r\n');
    if (split < 0) continue;
    const head = part.slice(0, split);
    const content = part.slice(split + 4).replace(/\r\n$/, '');
    const name = /name="([^"]+)"/.exec(head)?.[1];
    const fn = /filename="([^"]*)"/.exec(head)?.[1];
    if (fn !== undefined) {
      filename = fn;
      fileText = content;
    } else if (name) {
      fields[name] = content;
    }
  }
  return { fields, ...(filename !== undefined ? { filename } : {}), ...(fileText !== undefined ? { fileText } : {}) };
}

function lastUserText(body: any): string {
  const msgs: any[] = Array.isArray(body?.messages) ? body.messages : [];
  const user = [...msgs].reverse().find((m) => m?.role === 'user');
  const c = user?.content ?? body?.input ?? body?.prompt ?? '';
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p: any) => (typeof p === 'string' ? p : (p?.text ?? ''))).join(' ');
  return JSON.stringify(c);
}

/** Start the practice mock. It really lints uploaded shards and really applies the scenario per submission round. */
export async function startMockServer(opts: MockOptions = {}): Promise<MockServer> {
  const scenario = opts.scenario ?? DEFAULT_SCENARIO;
  const files = new Map<string, { name: string; text: string }>();
  const batches = new Map<string, StoredBatch>();
  const rounds = new Map<string, number>(); // custom_id -> how many times it was submitted
  const routes: RouteLog[] = [];
  let fileSeq = 0;
  let batchSeq = 0;
  let lineSeq = 0;

  const send = (res: ServerResponse, status: number, payload: unknown, type = 'application/json'): void => {
    res.writeHead(status, { 'content-type': type });
    res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
  };

  function buildBatch(inputFileId: string, endpoint: string, window: string): StoredBatch {
    const id = `batch_mock_${++batchSeq}`;
    const text = files.get(inputFileId)!.text;
    // Provider-side validation happens AFTER upload: the batch goes validating -> failed with line numbers.
    const lint = lintText(text, { provider: 'openai' });
    const bad = lint.issues.filter((i) => i.severity === 'error');
    const base = { id, endpoint, inputFileId, window, polls: 0 };
    if (bad.length > 0) {
      return { ...base, final: 'failed', errors: bad.map((i) => ({ code: i.code, line: i.line > 0 ? i.line : null, message: i.message })), outputFileId: null, errorFileId: null, total: 0, failed: 0 };
    }
    const requests = loadRequests(text, 'openai').requests;
    const out: string[] = [];
    const err: string[] = [];
    for (const r of [...requests].reverse()) { // results come back in a different order than the input
      const cid = r.customId!;
      const round = rounds.get(cid) ?? 0;
      const plan = scenario.results[cid];
      const outcome: Outcome = plan ? (plan[Math.min(round, plan.length - 1)] as Outcome) : 'ok';
      const n = String(++lineSeq).padStart(4, '0');
      const errBody = (message: string, type: string) => ({ error: { message, type, param: null, code: null } });
      switch (outcome) {
        case 'ok':
          out.push(JSON.stringify({ id: `batch_req_${n}`, custom_id: cid, response: { status_code: 200, request_id: `req_${n}`, body: { id: `chatcmpl-${n}`, object: 'chat.completion', model: r.model, choices: [{ index: 0, message: { role: 'assistant', content: `[mock] ${lastUserText(r.value.body).slice(0, 40)}` }, finish_reason: 'stop' }] } }, error: null }));
          break;
        case '400':
          out.push(JSON.stringify({ id: `batch_req_${n}`, custom_id: cid, response: { status_code: 400, request_id: `req_${n}`, body: errBody('Invalid value (mock scenario).', 'invalid_request_error') }, error: null }));
          break;
        case '429':
        case '500': {
          const code = Number(outcome);
          err.push(JSON.stringify({ id: `batch_req_${n}`, custom_id: cid, response: { status_code: code, request_id: `req_${n}`, body: errBody(code === 429 ? 'Rate limit (mock).' : 'Server error (mock).', code === 429 ? 'rate_limit_error' : 'server_error') }, error: null }));
          break;
        }
        case 'expired':
          err.push(JSON.stringify({ id: `batch_req_${n}`, custom_id: cid, response: null, error: { code: 'batch_expired', message: 'This request could not be executed before the completion window expired.' } }));
          break;
        case 'cancelled':
          err.push(JSON.stringify({ id: `batch_req_${n}`, custom_id: cid, response: null, error: { code: 'batch_cancelled', message: 'This request was cancelled because the batch was cancelled.' } }));
          break;
        case 'drop':
          break; // appears nowhere: the caller has to notice it is missing
      }
      rounds.set(cid, round + 1);
    }
    const store = (lines: string[], label: string): string | null => {
      if (lines.length === 0) return null;
      const fid = `file-${label}-${++fileSeq}`;
      files.set(fid, { name: `${id}.${label}.jsonl`, text: lines.join('\n') + '\n' });
      return fid;
    };
    return { ...base, final: 'completed', errors: [], outputFileId: store(out, 'out'), errorFileId: store(err, 'err'), total: requests.length, failed: err.length };
  }

  function view(b: StoredBatch): Record<string, unknown> {
    const done = b.polls >= (scenario.pollsBeforeDone ?? 0);
    const status = done ? b.final : 'in_progress';
    return {
      id: b.id,
      object: 'batch',
      endpoint: b.endpoint,
      input_file_id: b.inputFileId,
      completion_window: b.window,
      status,
      output_file_id: done ? b.outputFileId : null,
      error_file_id: done ? b.errorFileId : null,
      errors: done && b.final === 'failed' ? { object: 'list', data: b.errors } : null,
      request_counts: { total: b.total, completed: b.total - b.failed, failed: b.failed },
    };
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    const path = (req.url ?? '').split('?')[0]!;
    const log: RouteLog = { method: req.method ?? '', path };
    routes.push(log);

    if (req.method === 'POST' && path === '/v1/files') {
      const mp = parseMultipart(body, String(req.headers['content-type'] ?? ''));
      if (mp.fields.purpose !== undefined) log.purpose = mp.fields.purpose;
      if (mp.filename !== undefined) log.filename = mp.filename;
      if (mp.fileText !== undefined) log.fileText = mp.fileText;
      if (mp.fields.purpose !== 'batch' || mp.fileText === undefined) {
        return send(res, 400, { error: { message: 'purpose=batch and a file part are required (mock)', type: 'invalid_request_error' } });
      }
      const id = `file-in-${++fileSeq}`;
      files.set(id, { name: mp.filename ?? 'upload.jsonl', text: mp.fileText });
      return send(res, 200, { id, object: 'file', bytes: Buffer.byteLength(mp.fileText), purpose: 'batch', filename: mp.filename, status: 'processed' });
    }
    if (req.method === 'POST' && path === '/v1/batches') {
      const p = JSON.parse(body.toString('utf8') || '{}');
      log.endpoint = p.endpoint;
      log.completion_window = p.completion_window;
      if (!files.has(p.input_file_id)) return send(res, 404, { error: { message: `No such file: ${p.input_file_id}`, type: 'invalid_request_error' } });
      const batch = buildBatch(p.input_file_id, p.endpoint, p.completion_window);
      batches.set(batch.id, batch);
      return send(res, 200, { id: batch.id, object: 'batch', endpoint: batch.endpoint, input_file_id: batch.inputFileId, completion_window: batch.window, status: 'validating', output_file_id: null, error_file_id: null });
    }
    const batchMatch = /^\/v1\/batches\/([^/]+)$/.exec(path);
    if (req.method === 'GET' && batchMatch) {
      const b = batches.get(batchMatch[1]!);
      if (!b) return send(res, 404, { error: { message: 'No such batch (mock)', type: 'invalid_request_error' } });
      const v = view(b);
      b.polls++;
      return send(res, 200, v);
    }
    const fileMatch = /^\/v1\/files\/([^/]+)\/content$/.exec(path);
    if (req.method === 'GET' && fileMatch) {
      const f = files.get(fileMatch[1]!);
      if (!f) return send(res, 404, { error: { message: 'No such file (mock)', type: 'invalid_request_error' } });
      return send(res, 200, f.text, 'application/octet-stream');
    }
    return send(res, 404, { error: { message: `no mock route for ${req.method} ${path}` } });
  }

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((e: Error) => send(res, 500, { error: { message: e.message } }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    port,
    routes,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections(); // keep-alive sockets would otherwise hold the process open
      }),
  };
}
