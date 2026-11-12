import { render, t, type Lang, type Msg, type Params } from './i18n.js';

/** Where the CLI finds the message table entries to show this error in another language. */
export interface ErrorText {
  message: Msg;
  hint?: Msg | undefined;
}

/** Error with a stable machine-readable code and an optional "how to fix it" hint. `message` and `hint` are English. */
export class BatchkitError extends Error {
  readonly code: string;
  readonly hint: string | undefined;
  /** Message-table keys of `message` / `hint`, so the CLI can print them in the chosen language. */
  readonly text: ErrorText | undefined;

  constructor(code: string, message: string, hint?: string, text?: ErrorText) {
    super(message);
    this.name = 'BatchkitError';
    this.code = code;
    this.hint = hint;
    this.text = text;
  }
}

/** Build a BatchkitError from message-table keys (English text is rendered from the table). */
export function fail(code: string, key: string, params: Params = {}, hintKey?: string, hintParams: Params = params): BatchkitError {
  const text: ErrorText = { message: { key, params }, ...(hintKey ? { hint: { key: hintKey, params: hintParams } } : {}) };
  return new BatchkitError(code, t('en', key, params), hintKey ? t('en', hintKey, hintParams) : undefined, text);
}

/** The error as `[message, hint]` in a language. */
export function errorTexts(e: BatchkitError, lang: Lang): { message: string; hint: string | undefined } {
  if (!e.text) return { message: e.message, hint: e.hint };
  return { message: render(lang, e.text.message), hint: e.text.hint ? render(lang, e.text.hint) : undefined };
}
