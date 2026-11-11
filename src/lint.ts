import { readFileSync } from 'node:fs';
import { BatchkitError } from './errors.js';
import { detectProvider, loadRequests } from './jsonl.js';
import { PRESETS, resolveLimits, type Limits } from './providers.js';
import { estimateTokens } from './tokens.js';
import type { Issue, ProviderName } from './types.js';

export interface LintOptions {
  /** `auto` (default) detects the provider from the file content. */
  provider?: ProviderName | 'auto' | undefined;
  maxRequests?: number | undefined;
  maxBytes?: number | undefined;
  maxTokens?: number | undefined;
  /** Name shown in reports. */
  name?: string | undefined;
}

export interface LintReport {
  file: string;
  provider: ProviderName;
  requests: number;
  bytes: number;
  models: Record<string, number>;
  urls: Record<string, number>;
  embeddingInputs: number;
  estTokens: number;
  limits: Limits;
  issues: Issue[];
  errors: number;
  warnings: number;
  ok: boolean;
}

/** Which request-body shape each OpenAI-style endpoint expects (used for `url_body_mismatch`). */
const ENDPOINT_BODY: Record<string, (body: any) => boolean> = {
  '/v1/chat/completions': (b) => Array.isArray(b?.messages),
  '/v1/responses': (b) => b?.input !== undefined,
  '/v1/embeddings': (b) => b?.input !== undefined && b?.messages === undefined,
  '/v1/completions': (b) => b?.prompt !== undefined,
  '/v1/moderations': (b) => b?.input !== undefined,
};

function resolveProvider(requested: LintOptions['provider'], text: string): ProviderName {
  if (requested === undefined || requested === 'auto') return detectProvider(text);
  if (!(requested in PRESETS)) {
    throw new BatchkitError('invalid_provider', `Unknown provider "${requested}"`, 'Use one of: auto, openai, azure, anthropic.');
  }
  return requested;
}

/** Lint file content. Pure function: no file system access. */
export function lintText(text: string, opts: LintOptions = {}): LintReport {
  const provider = resolveProvider(opts.provider, text);
  const preset = PRESETS[provider];
  const limits = resolveLimits(preset, opts);
  const loaded = loadRequests(text, provider);
  const issues: Issue[] = [...loaded.issues];
  const add = (line: number, code: string, message: string, severity: Issue['severity'] = 'error'): void => {
    issues.push({ line, code, severity, message });
  };

  const seen = new Map<string, number>();
  const models = new Map<string, number>();
  const urls = new Map<string, number>();
  let embeddingInputs = 0;
  let estTokens = 0;

  for (const req of loaded.requests) {
    const { line, value } = req;
    estTokens += estimateTokens(value);

    // custom_id: the only link between a request and its (unordered) result.
    if (preset.customIdPattern) {
      if (typeof value.custom_id !== 'string' || !preset.customIdPattern.test(value.custom_id)) {
        add(line, 'invalid_custom_id', `custom_id ${JSON.stringify(value.custom_id)} must match ${preset.customIdPattern}`);
      }
    } else if (req.customId === null) {
      add(line, 'missing_custom_id', 'custom_id must be a non-empty string');
    }
    if (req.customId !== null) {
      const first = seen.get(req.customId);
      if (first !== undefined) add(line, 'duplicate_custom_id', `same as line ${first}`);
      else seen.set(req.customId, line);
    }

    if (provider === 'anthropic') {
      if (value.params === null || typeof value.params !== 'object') {
        add(line, 'missing_params', 'params object is required');
        continue;
      }
      if (!(typeof value.params.max_tokens === 'number' && value.params.max_tokens >= 1)) {
        add(line, 'max_tokens_min', 'params.max_tokens must be >= 1 in a batch');
      }
      if (value.params.stream === true) add(line, 'stream_not_allowed', 'streaming is not supported in a batch');
      if (req.model === null) add(line, 'missing_model', 'params.model is required');
      else models.set(req.model, (models.get(req.model) ?? 0) + 1);
      continue;
    }

    // OpenAI / Azure line format
    if (value.method !== 'POST') add(line, 'invalid_method', `method must be "POST", got ${JSON.stringify(value.method)}`);
    if (req.url === null || !req.url.startsWith('/')) {
      add(line, 'invalid_url', 'url must be a path such as /v1/chat/completions, not a full URL');
    } else {
      urls.set(req.url, (urls.get(req.url) ?? 0) + 1);
      const check = ENDPOINT_BODY[req.url];
      if (check && !check(value.body)) add(line, 'url_body_mismatch', `body does not look like a ${req.url} request`);
      if (req.url === '/v1/embeddings') {
        embeddingInputs += Array.isArray(value.body?.input) ? value.body.input.length : 1;
      }
    }
    if (req.model === null) add(line, 'missing_model', 'body.model is required');
    else models.set(req.model, (models.get(req.model) ?? 0) + 1);
    if (value.body?.stream === true) add(line, 'stream_not_allowed', 'stream must not be true in a batch');
  }

  // File-level rules (line 0).
  if (loaded.requests.length === 0) {
    add(0, 'empty_file', 'no requests found (a provider rejects an empty file)');
  }
  if (preset.singleModel && models.size > 1) {
    const what = provider === 'azure' ? 'deployment names' : 'models';
    add(0, 'model_mismatch', `${what} in one file: ${[...models.keys()].join(', ')} (split by model first)`);
  }
  if (preset.singleUrl && urls.size > 1) {
    add(0, 'url_mismatch', `endpoints in one file: ${[...urls.keys()].join(', ')} (one endpoint per batch)`);
  }
  const bytes = Buffer.byteLength(text);
  if (loaded.requests.length > limits.maxRequests) {
    add(0, 'too_many_requests', `${loaded.requests.length} requests > limit ${limits.maxRequests}`);
  }
  if (bytes > limits.maxBytes) add(0, 'file_too_large', `${bytes} bytes > limit ${limits.maxBytes}`);
  if (preset.maxEmbeddingInputs !== null && embeddingInputs > preset.maxEmbeddingInputs) {
    add(0, 'too_many_embedding_inputs', `${embeddingInputs} embedding inputs > limit ${preset.maxEmbeddingInputs}`);
  }
  if (limits.maxTokens !== null && estTokens > limits.maxTokens) {
    add(0, 'too_many_tokens', `~${estTokens} estimated tokens > limit ${limits.maxTokens}`);
  }

  // Line-level issues first (by line), file-level issues last.
  issues.sort((a, b) => (a.line === 0 ? Infinity : a.line) - (b.line === 0 ? Infinity : b.line));
  const errors = issues.filter((i) => i.severity === 'error').length;
  return {
    file: opts.name ?? '<input>',
    provider,
    requests: loaded.requests.length,
    bytes,
    models: Object.fromEntries(models),
    urls: Object.fromEntries(urls),
    embeddingInputs,
    estTokens,
    limits,
    issues,
    errors,
    warnings: issues.length - errors,
    ok: errors === 0,
  };
}

export function readInputFile(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (e) {
    throw new BatchkitError('cannot_read_file', `Cannot read ${path}: ${(e as Error).message}`, 'Check the path and permissions.');
  }
}

export function lintFile(path: string, opts: LintOptions = {}): LintReport {
  return lintText(readInputFile(path), { ...opts, name: opts.name ?? path });
}
