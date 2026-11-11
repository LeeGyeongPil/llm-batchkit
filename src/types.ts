export type ProviderName = 'openai' | 'azure' | 'anthropic';
export type Severity = 'error' | 'warn';

/** One finding from `lint`. `line` is 1-based; 0 means "the file as a whole". */
export interface Issue {
  line: number;
  code: string;
  severity: Severity;
  message: string;
}

/** One request parsed out of an input file, with its original text kept byte-for-byte. */
export interface ParsedRequest {
  line: number;
  /** Original text of the request (one JSONL line, or compact JSON for `{requests:[...]}` files). */
  raw: string;
  /** UTF-8 bytes of `raw` plus the newline that follows it in a shard. */
  bytes: number;
  value: any;
  customId: string | null;
  url: string | null;
  model: string | null;
}
