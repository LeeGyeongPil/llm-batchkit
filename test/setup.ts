// Pin the output language to English before any test runs, so the existing assertions never depend on the
// machine's LANG. Tests that exercise Korean pass `--lang ko` or their own env explicitly.
process.env.LLM_BATCHKIT_LANG = 'en';
