/** Error with a stable machine-readable code and an optional "how to fix it" hint. */
export class BatchkitError extends Error {
  readonly code: string;
  readonly hint: string | undefined;

  constructor(code: string, message: string, hint?: string) {
    super(message);
    this.name = 'BatchkitError';
    this.code = code;
    this.hint = hint;
  }
}
