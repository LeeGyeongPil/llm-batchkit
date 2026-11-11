import type { Issue, ParsedRequest, ProviderName } from './types.js';

export interface LoadedRequests {
  format: 'jsonl' | 'json';
  requests: ParsedRequest[];
  issues: Issue[];
}

/** Split a buffer into lines without the final empty piece produced by a trailing newline. */
export function splitLines(text: string): string[] {
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function tryParseRequestsDocument(text: string): any[] | null {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith('{')) return null;
  try {
    const doc = JSON.parse(text);
    return Array.isArray(doc?.requests) ? doc.requests : null;
  } catch {
    return null;
  }
}

/** Decide the provider from the file content: `{requests:[...]}` or `{custom_id, params}` lines mean Anthropic. */
export function detectProvider(text: string): ProviderName {
  if (tryParseRequestsDocument(text)) return 'anthropic';
  const first = splitLines(text).find((l) => l.trim() !== '');
  if (first) {
    try {
      const obj = JSON.parse(first);
      if (obj && typeof obj === 'object' && obj.params !== undefined && obj.body === undefined) return 'anthropic';
    } catch {
      /* fall through: a broken first line is reported by lint */
    }
  }
  return 'openai';
}

function toParsed(line: number, raw: string, value: any, provider: ProviderName): ParsedRequest {
  const isAnthropic = provider === 'anthropic';
  const customId = typeof value?.custom_id === 'string' && value.custom_id !== '' ? value.custom_id : null;
  const url = !isAnthropic && typeof value?.url === 'string' ? value.url : null;
  const modelSource = isAnthropic ? value?.params?.model : value?.body?.model;
  return {
    line,
    raw,
    bytes: Buffer.byteLength(raw) + 1,
    value,
    customId,
    url,
    model: typeof modelSource === 'string' ? modelSource : null,
  };
}

/** Parse an input file into requests; syntax problems become issues instead of exceptions. */
export function loadRequests(text: string, provider: ProviderName): LoadedRequests {
  const issues: Issue[] = [];
  const requests: ParsedRequest[] = [];

  const doc = tryParseRequestsDocument(text);
  if (doc) {
    doc.forEach((value, i) => {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        issues.push({ line: i + 1, code: 'invalid_json_line', severity: 'error', message: 'request is not a JSON object' });
        return;
      }
      requests.push(toParsed(i + 1, JSON.stringify(value), value, provider));
    });
    return { format: 'json', requests, issues };
  }

  splitLines(text).forEach((raw, i) => {
    const line = i + 1;
    if (raw.trim() === '') {
      issues.push({ line, code: 'empty_line', severity: 'warn', message: 'blank line (dropped by split)' });
      return;
    }
    let value: any;
    try {
      value = JSON.parse(raw);
    } catch (e) {
      issues.push({ line, code: 'invalid_json_line', severity: 'error', message: (e as Error).message });
      return;
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      issues.push({ line, code: 'invalid_json_line', severity: 'error', message: 'line is not a JSON object' });
      return;
    }
    requests.push(toParsed(line, raw, value, provider));
  });
  return { format: 'jsonl', requests, issues };
}
