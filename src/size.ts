import { fail } from './errors.js';

const UNITS: Record<string, number> = {
  '': 1,
  b: 1,
  kb: 1000,
  mb: 1000 ** 2,
  gb: 1000 ** 3,
  kib: 1024,
  mib: 1024 ** 2,
  gib: 1024 ** 3,
};

/**
 * Parse a byte size such as `1200`, `256MB` (10^6 based) or `200MiB` (2^20 based).
 * The two spellings are kept apart on purpose: providers quote "200 MB" but enforce 209,715,200 bytes.
 */
export function parseSize(input: string | number): number {
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input <= 0) {
      throw fail('invalid_size', 'err.size_number', { value: String(input) }, 'err.size_number.hint');
    }
    return Math.floor(input);
  }
  const match = /^\s*(\d+(?:\.\d+)?)\s*([a-zA-Z]*)\s*$/.exec(input);
  const factor = match ? UNITS[(match[2] ?? '').toLowerCase()] : undefined;
  if (!match || factor === undefined) {
    throw fail('invalid_size', 'err.size_text', { value: input }, 'err.size_text.hint');
  }
  const bytes = Math.floor(Number(match[1]) * factor);
  if (bytes <= 0) throw fail('invalid_size', 'err.size_positive', { value: input }, 'err.size_positive.hint');
  return bytes;
}

/** Parse a positive integer option such as `--max-requests`. */
export function parsePositiveInt(name: string, input: string | undefined): number | undefined {
  if (input === undefined) return undefined;
  if (!/^\d+$/.test(input) || Number(input) < 1) {
    throw fail('invalid_option', 'err.int_option', { name, value: input }, 'err.int_option.hint');
  }
  return Number(input);
}
