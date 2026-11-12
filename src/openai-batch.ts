import { BatchkitError, fail } from './errors.js';
import type { Msg } from './i18n.js';

export const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

export interface BatchObject {
  id: string;
  status: string;
  endpoint?: string;
  input_file_id?: string;
  output_file_id?: string | null;
  error_file_id?: string | null;
  errors?: { data?: { code?: string; message?: string; line?: number | null }[] } | null;
  request_counts?: { total: number; completed: number; failed: number };
}

export interface ClientOptions {
  baseUrl: string;
  apiKey: string;
  /** Attempts for 429 / 5xx / network errors (default 3, exponential backoff). */
  attempts?: number;
  /** First backoff delay in ms (default 500). Tests set 0. */
  backoffMs?: number;
}

/** Minimal OpenAI-compatible Batch client on top of the built-in fetch (no SDK dependency). */
export class OpenAIBatchClient {
  private readonly base: string;
  private readonly key: string;
  private readonly attempts: number;
  private readonly backoffMs: number;

  constructor(opts: ClientOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, '');
    this.key = opts.apiKey;
    this.attempts = opts.attempts ?? 3;
    this.backoffMs = opts.backoffMs ?? 500;
  }

  private async request(method: string, path: string, init: { body?: BodyInit; json?: unknown } = {}): Promise<Response> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.key}` };
    let body = init.body;
    if (init.json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(init.json);
    }
    let last: Msg = { key: 'err.http_failed' };
    for (let attempt = 1; attempt <= this.attempts; attempt++) {
      try {
        const res = await fetch(`${this.base}${path}`, { method, headers, ...(body !== undefined ? { body } : {}) });
        if (res.ok) return res;
        const detail = (await res.text()).slice(0, 300);
        last = { key: 'err.http_status', params: { method, path, status: res.status, detail } };
        if (res.status !== 429 && res.status < 500) {
          throw fail('http_error', last.key, last.params, res.status === 401 ? 'err.http_401.hint' : 'err.http_other.hint');
        }
      } catch (e) {
        if (e instanceof BatchkitError) throw e;
        last = { key: 'err.http_failed', params: { method, path, detail: (e as Error).message } };
      }
      if (attempt < this.attempts) await new Promise((r) => setTimeout(r, this.backoffMs * 2 ** (attempt - 1)));
    }
    throw fail('http_error', 'err.http_after', { last, attempts: this.attempts }, 'err.http_retry.hint');
  }

  async uploadFile(filename: string, content: string): Promise<{ id: string }> {
    const form = new FormData();
    form.set('purpose', 'batch');
    form.set('file', new Blob([content], { type: 'application/jsonl' }), filename);
    return (await (await this.request('POST', '/files', { body: form })).json()) as { id: string };
  }

  async createBatch(input: { input_file_id: string; endpoint: string; completion_window: string }): Promise<BatchObject> {
    return (await (await this.request('POST', '/batches', { json: input })).json()) as BatchObject;
  }

  async getBatch(id: string): Promise<BatchObject> {
    return (await (await this.request('GET', `/batches/${encodeURIComponent(id)}`)).json()) as BatchObject;
  }

  async downloadFile(id: string): Promise<string> {
    return await (await this.request('GET', `/files/${encodeURIComponent(id)}/content`)).text();
  }
}

export function isLocalUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
  } catch {
    return false;
  }
}

/** Resolve base URL and API key: option > environment; local mock endpoints accept a placeholder key. */
export function resolveConnection(opts: { baseUrl?: string | undefined }, env: NodeJS.ProcessEnv = process.env): { baseUrl: string; apiKey: string } {
  const baseUrl = opts.baseUrl ?? (env.OPENAI_BASE_URL || DEFAULT_BASE_URL);
  const apiKey = env.OPENAI_API_KEY || (isLocalUrl(baseUrl) ? 'mock-key-not-real' : ''); // gitleaks:allow (placeholder for the local mock)
  if (!apiKey) {
    throw fail('missing_api_key', 'err.missing_api_key', {}, 'err.missing_api_key.hint');
  }
  return { baseUrl, apiKey };
}
