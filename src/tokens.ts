/**
 * Rough token estimate: characters / 4 over the prompt-carrying fields of a request.
 * This is an approximation (non-English text usually costs more tokens per character);
 * leave headroom when you set --max-tokens.
 */
export function estimateTokens(request: any): number {
  const payload = request?.body ?? request?.params ?? {};
  let chars = 0;
  for (const key of ['messages', 'input', 'prompt', 'system']) {
    if (payload[key] !== undefined) chars += JSON.stringify(payload[key]).length;
  }
  return Math.max(1, Math.ceil(chars / 4));
}
