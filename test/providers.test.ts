import { describe, expect, it } from 'vitest';
import { PRESETS, resolveLimits } from '../src/providers.js';
import { parseSize } from '../src/size.js';
import { BatchkitError } from '../src/errors.js';

describe('providers', () => {
  it('presets match documented limits', () => {
    expect(PRESETS.openai).toMatchObject({ maxRequests: 50_000, maxBytes: 209_715_200, singleModel: true, singleUrl: true, maxEmbeddingInputs: 50_000 });
    expect(PRESETS.azure).toMatchObject({ maxRequests: 100_000, maxBytes: 209_715_200, singleModel: true });
    expect(PRESETS.anthropic).toMatchObject({ maxRequests: 100_000, maxBytes: 256_000_000, singleModel: false, requireMaxTokens: true });
    const pattern = PRESETS.anthropic.customIdPattern!;
    expect(pattern.test('doc_001-A')).toBe(true);
    expect(pattern.test('doc.005')).toBe(false);
    expect(pattern.test('x'.repeat(64))).toBe(true);
    expect(pattern.test('x'.repeat(65))).toBe(false);
    expect(pattern.test('')).toBe(false);
  });

  it('overrides win over the preset', () => {
    expect(resolveLimits(PRESETS.openai, { maxRequests: 5 })).toEqual({ maxRequests: 5, maxBytes: 209_715_200, maxTokens: null });
  });

  it('parses sizes with MB (10^6) and MiB (2^20) kept apart', () => {
    expect(parseSize('200MiB')).toBe(209_715_200);
    expect(parseSize('256MB')).toBe(256_000_000);
    expect(parseSize('1200')).toBe(1200);
    expect(parseSize(1200)).toBe(1200);
    expect(() => parseSize('lots')).toThrowError(BatchkitError);
    expect(() => parseSize('0')).toThrowError(/positive/);
  });
});
