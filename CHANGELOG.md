# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
