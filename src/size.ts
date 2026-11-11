import { BatchkitError } from './errors.js';

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
      throw new BatchkitError('invalid_size', `Invalid size: ${input}`, 'Use a positive number of bytes, e.g. 1200, 256MB or 200MiB.');
    }
    return Math.floor(input);
  }
  const match = /^\s*(\d+(?:\.\d+)?)\s*([a-zA-Z]*)\s*$/.exec(input);
  const factor = match ? UNITS[(match[2] ?? '').toLowerCase()] : undefined;
  if (!match || factor === undefined) {
    throw new BatchkitError('invalid_size', `Invalid size: "${input}"`, 'Use a number of bytes with an optional unit: 1200, 256MB, 200MiB.');
  }
  const bytes = Math.floor(Number(match[1]) * factor);
  if (bytes <= 0) throw new BatchkitError('invalid_size', `Size must be positive: "${input}"`, 'Use a positive size.');
  return bytes;
}

/** Parse a positive integer option such as `--max-requests`. */
export function parsePositiveInt(name: string, input: string | undefined): number | undefined {
  if (input === undefined) return undefined;
  if (!/^\d+$/.test(input) || Number(input) < 1) {
    throw new BatchkitError('invalid_option', `${name} must be a positive integer, got "${input}"`, `Example: ${name} 1000`);
  }
  return Number(input);
}
