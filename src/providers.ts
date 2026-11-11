import type { ProviderName } from './types.js';

/**
 * Provider presets. Limits verified against the vendor docs on 2026-11-11:
 *  - OpenAI   https://developers.openai.com/api/docs/guides/batch.md
 *  - Azure    https://learn.microsoft.com/azure/foundry/openai/quotas-limits
 *             https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/batch
 *  - Anthropic https://platform.claude.com/docs/en/build-with-claude/batch-processing
 * Limits change; every value can be overridden with --max-requests / --max-bytes.
 */
export interface Preset {
  name: ProviderName;
  maxRequests: number;
  maxBytes: number;
  /** All requests of one file/shard must use the same `body.model` (deployment name on Azure). */
  singleModel: boolean;
  /** All requests of one file/shard must use the same endpoint `url`. */
  singleUrl: boolean;
  customIdPattern: RegExp | null;
  maxEmbeddingInputs: number | null;
  requireMaxTokens: boolean;
}

export const PRESETS: Record<ProviderName, Preset> = {
  openai: {
    name: 'openai',
    maxRequests: 50_000,
    maxBytes: 209_715_200, // "200 MB" in the docs is 200 MiB in practice (see the error text in the community thread)
    singleModel: true,
    singleUrl: true,
    customIdPattern: null,
    maxEmbeddingInputs: 50_000,
    requireMaxTokens: false,
  },
  azure: {
    name: 'azure',
    maxRequests: 100_000,
    maxBytes: 209_715_200,
    singleModel: true,
    singleUrl: true,
    customIdPattern: null,
    maxEmbeddingInputs: null,
    requireMaxTokens: false,
  },
  anthropic: {
    name: 'anthropic',
    maxRequests: 100_000,
    maxBytes: 256_000_000, // docs say "256 MB" without a unit; the conservative 10^6 reading is used
    singleModel: false,
    singleUrl: false,
    customIdPattern: /^[a-zA-Z0-9_-]{1,64}$/,
    maxEmbeddingInputs: null,
    requireMaxTokens: true,
  },
};

export const PROVIDER_NAMES = Object.keys(PRESETS) as ProviderName[];

export interface LimitOverrides {
  maxRequests?: number | undefined;
  maxBytes?: number | undefined;
  maxTokens?: number | undefined;
}

export interface Limits {
  maxRequests: number;
  maxBytes: number;
  maxTokens: number | null;
}

export function resolveLimits(preset: Preset, overrides: LimitOverrides = {}): Limits {
  return {
    maxRequests: overrides.maxRequests ?? preset.maxRequests,
    maxBytes: overrides.maxBytes ?? preset.maxBytes,
    maxTokens: overrides.maxTokens ?? null,
  };
}
