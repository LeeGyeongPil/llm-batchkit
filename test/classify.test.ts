import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { classifyLine } from '../src/classify.js';
import { fx } from './helpers.js';

const fixtureLines = (name: string): Record<string, any> => {
  const byId: Record<string, any> = {};
  for (const l of readFileSync(fx(name), 'utf8').split('\n').filter(Boolean)) {
    const o = JSON.parse(l);
    byId[o.custom_id] = o;
  }
  return byId;
};

describe('classify', () => {
  it('status by content not by file', () => {
    const out = fixtureLines('openai/shard-000.output.jsonl');
    const err = fixtureLines('openai/shard-001.error.jsonl');
    // a 400 inside an OUTPUT file is a failure, and is not retryable
    expect(classifyLine(out['req-004'])).toMatchObject({ status: 'failed', code: 400, retryable: false });
    expect(classifyLine(out['req-004'])?.reason).toBe('400 (client error, use --include-4xx)');
    // a 500 inside an ERROR file is a failure and is retryable
    expect(classifyLine(err['req-011'])).toMatchObject({ status: 'failed', code: 500, retryable: true });
    expect(classifyLine(err['req-009'])).toMatchObject({ status: 'expired', code: 'batch_expired', retryable: true });
    expect(classifyLine(err['req-012'])).toMatchObject({ status: 'cancelled', code: 'batch_cancelled', retryable: true });
    const ok = classifyLine(out['req-001']);
    expect(ok).toMatchObject({ status: 'succeeded', code: 200, retryable: false });
    expect(ok?.text).toBe('The library is open 9 to 6 on weekdays.');
  });

  it('429 and 5xx are retryable, other 4xx are not', () => {
    const line = (status_code: number) => ({ custom_id: 'x', response: { status_code, body: {} }, error: null });
    expect(classifyLine(line(429))).toMatchObject({ status: 'failed', code: 429, retryable: true });
    expect(classifyLine(line(503))).toMatchObject({ status: 'failed', code: 503, retryable: true });
    expect(classifyLine(line(422))).toMatchObject({ status: 'failed', code: 422, retryable: false });
    expect(classifyLine(line(401))).toMatchObject({ status: 'failed', retryable: false });
  });

  it('error objects are failed and not retried by default', () => {
    const c = classifyLine({ custom_id: 'x', response: null, error: { code: 'invalid_prompt', message: 'nope' } });
    expect(c).toMatchObject({ status: 'failed', code: 'invalid_prompt', retryable: false });
    expect(c?.reason).toContain('--include-4xx');
  });

  it('indeterminate lines default to failed + not retried', () => {
    const c = classifyLine({ custom_id: 'x', response: null, error: null });
    expect(c).toMatchObject({ status: 'failed', code: 'indeterminate', retryable: false });
    expect(c?.reason).toContain('indeterminate');
    expect(classifyLine({ custom_id: 'x', response: { status_code: 'oops' } })).toMatchObject({ code: 'indeterminate', retryable: false });
    expect(classifyLine({ custom_id: 'x', result: { type: 'mystery' } })).toMatchObject({ code: 'indeterminate', retryable: false });
  });

  it('lines without a custom_id cannot be joined', () => {
    expect(classifyLine({ response: { status_code: 200 } })).toBeNull();
    expect(classifyLine({ custom_id: '' })).toBeNull();
    expect(classifyLine('text')).toBeNull();
    expect(classifyLine(null)).toBeNull();
  });

  it('anthropic result types', () => {
    const r = fixtureLines('anthropic/results.jsonl');
    expect(classifyLine(r['doc-001'])).toMatchObject({ status: 'succeeded', text: 'The library is open 9 to 6 on weekdays.' });
    expect(classifyLine(r['doc-003'])).toMatchObject({ status: 'failed', code: 'invalid_request_error', retryable: false });
    expect(classifyLine(r['doc-004'])).toMatchObject({ status: 'expired', retryable: true });
    expect(classifyLine(r['doc-006'])).toMatchObject({ status: 'cancelled', retryable: true });
    const errored = (type: string) => ({ custom_id: 'x', result: { type: 'errored', error: { type: 'error', error: { type, message: 'm' } } } });
    expect(classifyLine(errored('api_error'))).toMatchObject({ status: 'failed', code: 'api_error', retryable: true });
    expect(classifyLine(errored('overloaded_error'))).toMatchObject({ retryable: true });
    expect(classifyLine(errored('rate_limit_error'))).toMatchObject({ retryable: true });
    expect(classifyLine(errored('authentication_error'))).toMatchObject({ retryable: false });
  });
});
