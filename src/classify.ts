/**
 * Classify one result line by its CONTENT, never by the file it came from.
 * A 400 can sit in the output file and a 500 in the error file; neither placement is reliable.
 *
 * Failure handling defaults (documented in the README):
 *  - retryable:     expired, cancelled, missing, HTTP 429, HTTP 5xx, Anthropic api_error / overloaded_error / rate_limit_error
 *  - not retryable: other 4xx, `error` objects, Anthropic invalid_request_error and friends
 *  - indeterminate: a line with a custom_id but no recognizable response or error is `failed` with
 *                   code "indeterminate" and is NOT retried automatically (it may already have been billed);
 *                   `retry --include-4xx` picks it up explicitly.
 */
export type Status = 'succeeded' | 'failed' | 'expired' | 'cancelled' | 'missing';

export interface Classified {
  customId: string;
  status: Exclude<Status, 'missing'>;
  code: number | string | null;
  retryable: boolean;
  /** Human readable reason shown by `retry` for excluded rows. */
  reason: string | null;
  text: string;
  body: unknown;
}

const ANTHROPIC_RETRYABLE = new Set(['api_error', 'overloaded_error', 'rate_limit_error']);

function openaiText(body: any): string {
  const chat = body?.choices?.[0]?.message?.content;
  if (typeof chat === 'string') return chat;
  if (Array.isArray(chat)) return chat.map((p: any) => (typeof p?.text === 'string' ? p.text : '')).join('');
  if (typeof body?.choices?.[0]?.text === 'string') return body.choices[0].text;
  if (Array.isArray(body?.output)) {
    return body.output
      .flatMap((o: any) => (Array.isArray(o?.content) ? o.content : []))
      .map((c: any) => (typeof c?.text === 'string' ? c.text : ''))
      .join('');
  }
  return '';
}

function anthropicText(message: any): string {
  if (!Array.isArray(message?.content)) return '';
  return message.content.map((c: any) => (c?.type === 'text' && typeof c.text === 'string' ? c.text : '')).join('');
}

/** Returns null when the line has no usable custom_id (nothing to join it to). */
export function classifyLine(line: any): Classified | null {
  if (line === null || typeof line !== 'object' || typeof line.custom_id !== 'string' || line.custom_id === '') return null;
  const base = { customId: line.custom_id as string, text: '', body: undefined as unknown };

  // Anthropic: {custom_id, result:{type: succeeded|errored|expired|canceled}}
  if (line.result && typeof line.result === 'object') {
    const r = line.result;
    switch (r.type) {
      case 'succeeded':
        return { ...base, status: 'succeeded', code: 200, retryable: false, reason: null, text: anthropicText(r.message), body: r.message };
      case 'expired':
        return { ...base, status: 'expired', code: 'expired', retryable: true, reason: null };
      case 'canceled':
        return { ...base, status: 'cancelled', code: 'canceled', retryable: true, reason: null };
      case 'errored': {
        const type: string = r.error?.error?.type ?? r.error?.type ?? 'error';
        const retryable = ANTHROPIC_RETRYABLE.has(type);
        return { ...base, status: 'failed', code: type, retryable, reason: retryable ? null : `${type} (non-retryable error, use --include-4xx)` };
      }
      default:
        return { ...base, status: 'failed', code: 'indeterminate', retryable: false, reason: 'indeterminate (unrecognized result, use --include-4xx)' };
    }
  }

  // OpenAI / Azure: {custom_id, response:{status_code, body}|null, error:{code,message}|null}
  const errCode: unknown = line.error?.code;
  if (errCode === 'batch_expired') return { ...base, status: 'expired', code: 'batch_expired', retryable: true, reason: null };
  if (errCode === 'batch_cancelled') return { ...base, status: 'cancelled', code: 'batch_cancelled', retryable: true, reason: null };
  if (line.error) {
    const code = typeof errCode === 'string' ? errCode : 'error';
    return { ...base, status: 'failed', code, retryable: false, reason: `${code} (error object, use --include-4xx)` };
  }
  const sc = line.response?.status_code;
  if (typeof sc === 'number') {
    if (sc >= 200 && sc < 300) {
      return { ...base, status: 'succeeded', code: sc, retryable: false, reason: null, text: openaiText(line.response.body), body: line.response.body };
    }
    if (sc === 429 || sc >= 500) return { ...base, status: 'failed', code: sc, retryable: true, reason: null, body: line.response.body };
    return { ...base, status: 'failed', code: sc, retryable: false, reason: `${sc} (client error, use --include-4xx)`, body: line.response.body };
  }
  return { ...base, status: 'failed', code: 'indeterminate', retryable: false, reason: 'indeterminate (no response or error in line, use --include-4xx)' };
}
