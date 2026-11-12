# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.3.0] - 2026-11-13

### Changed
- The first stderr line of a `BatchkitError` is now `error: [<code>] <message>` (for example `error: [shard_exceeds_budget] ...`), in both languages. The code name is not translated. The `error: ` prefix is kept.
- Unchanged: exit codes (1/64/70), `--json` output, the public API, `BatchkitError` values, usage errors (64) without a code.

### Known issues
- `--help` describes exit code 2 as "still running or not submitted", but `collect` on a folder that was never submitted exits 1 with `error: [nothing_submitted]` (as the README says). The help wording will be corrected in a later release.
- The regression test for error code names covers `cannot_read_file` only; the other codes share the same code path.

## [0.2.0] - 2026-11-12

### Added
- English and Korean output. Every command accepts `--lang en|ko`; without it the language comes from `LLM_BATCHKIT_LANG`, then `LC_ALL`, `LC_MESSAGES`, `LANG` (a value starting with `ko` selects Korean, anything else English). Help, usage errors, `error:`/`fix:` lines, the lint text report, split/submit/collect/merge/retry output, the mock server notice and `npm run demo` are translated from one message table (`src/i18n.ts`).
- `BatchkitError.text` and the exported `resolveLang` / `t` helpers (library). Existing `message`, `hint`, `code` values stay English.
- `README.ko.md` shows real `--lang ko` output.

### Changed
- On a machine whose locale starts with `ko` the text output is now Korean by default. A script that compares the text should pin English with `--lang en` or `LLM_BATCHKIT_LANG=en`.
- Table columns are aligned by terminal width, so Korean headers line up.

### Unchanged
- `--json` output (including each lint issue `message`), library return values, JSONL/CSV/`manifest.json`/`batches.json` formats, issue and error codes, exit codes and the mock server HTTP responses.

## [0.1.2] - 2026-11-11

### Fixed
- `mock-server` now installs its SIGINT/SIGTERM handlers before it prints the `listening on` line. A signal sent the moment the address appeared could kill the process (no exit code) instead of stopping it cleanly with exit 0; this made CI fail on Node 24.

## [0.1.1] - 2026-11-11

### Fixed
- `mock-server --scenario` with a missing, unreadable, empty, non-JSON or wrongly shaped file now exits 1 with `error:` and `fix:` lines that name the file, instead of a stack trace and exit code 70.

## [0.1.0] - 2026-11-11

### Added
- `lint`: line-numbered checks for OpenAI, Azure OpenAI and Anthropic batch input files (duplicate or missing `custom_id`, wrong method or URL, mixed models or endpoints, streaming, request/byte/token limits, empty file), `--json`, `--strict`; text output folds more than 50 issues of one kind.
- `split`: group by endpoint and model, then shard by request count, bytes and estimated tokens; writes a deterministic `manifest.json`. Refuses a folder that already holds `batches.json` or results (`out_dir_in_use`); `--force` re-splits only a folder whose batches all failed validation, never one with running or finished batches (`out_dir_has_batches`).
- `submit` / `collect`: upload shards and create batches on OpenAI-compatible endpoints with `fetch`; `batches.json` makes both commands idempotent; `--max-enqueued-tokens` holds shards; batch-level validation errors are mapped from line numbers to `custom_id`.
- `submit` decides by batch status first: a `failed` batch (rejected by validation) is sent again, fixed or not; running and finished batches are never uploaded again. If their shard file or the manifest changed, `submit` uploads nothing and exits 1; `--resubmit-changed` sends an edited finished shard on purpose (running batches are still refused). Replaced batches stay in the `history` of `batches.json`, and their result files are renamed to `*.replaced-<batch_id>.jsonl`, never deleted.
- `merge`: join output and error files back to input order by content (not by file), several retry rounds, duplicate and unknown id reporting, JSONL and CSV export.
- `retry`: pick expired, cancelled, missing, 429 and 5xx rows (other 4xx excluded unless `--include-4xx`) and write a re-submission file with the original lines.
- `mock-server` and `npm run demo`: a practice mock Batch API on 127.0.0.1 that lints uploads and replays a scenario; an invalid `--port` exits 64 and a port in use gives an error with a fix.
- Library entry point (`import { lintFile, splitFile, mergeResults, selectRetries } from 'llm-batchkit'`).
