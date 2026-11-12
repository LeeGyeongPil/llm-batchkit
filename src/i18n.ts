// All human-facing text lives in this one file: an English table and a Korean table with the same keys.
// Machine-readable output (--json, JSONL, CSV, manifest.json, batches.json, error/issue codes, HTTP bodies of the
// mock server) and the library return values stay English and are never translated.
import type { Issue } from './types.js';

export type Lang = 'en' | 'ko';
export const LANGS: readonly Lang[] = ['en', 'ko'];

/** A message key plus its parameters. A parameter may itself be a Msg (or a list of them, joined by newlines). */
export interface Msg {
  key: string;
  params?: Params | undefined;
}
/** A list of messages is joined with `sep` (default newline). */
export interface MsgList {
  items: Msg[];
  sep?: string;
}
export type Param = string | number | Msg | Msg[] | MsgList;
export type Params = Record<string, Param>;

const HELP_EN = `llm-batchkit - lint, split, submit, merge and retry LLM Batch API files

Usage:
  llm-batchkit lint <file> [--provider auto|openai|azure|anthropic] [--max-requests N] [--max-bytes N|200MiB] [--max-tokens N] [--strict] [--json]
  llm-batchkit split <file> --out <dir> [--provider ...] [--max-requests N] [--max-bytes N] [--max-tokens N] [--skip-lint] [--force]
  llm-batchkit submit <dir>/manifest.json [--base-url URL] [--completion-window 24h] [--max-enqueued-tokens N] [--dry-run] [--resubmit-changed]
  llm-batchkit collect <dir>/manifest.json [--base-url URL] [--wait] [--interval 30]
  llm-batchkit merge <dir>/manifest.json [result files...] [--out results.jsonl] [--csv results.csv] [--json]
  llm-batchkit retry <results.jsonl> --out <dir> [--manifest f] [--input original] [--include-4xx] [--only expired,cancelled,missing,failed]
  llm-batchkit mock-server [--port 0] [--scenario file.json]

Every command accepts --lang en|ko (output language).
Language order: --lang > LLM_BATCHKIT_LANG > LC_ALL > LC_MESSAGES > LANG (a value starting with "ko" selects Korean, anything else English).

Exit codes: lint 1 on errors; collect 0 done / 1 a batch failed validation / 2 still running or not submitted;
submit 1 when a shard changed after its batch was created (nothing is uploaded then).
submit/collect need OPENAI_API_KEY (or a local --base-url such as the mock server). Everything else works offline.
`;

const HELP_KO = `llm-batchkit - LLM Batch API 파일을 점검(lint)하고, 나누고(split), 제출하고(submit), 병합하고(merge), 재시도(retry)합니다

사용법:
  llm-batchkit lint <file> [--provider auto|openai|azure|anthropic] [--max-requests N] [--max-bytes N|200MiB] [--max-tokens N] [--strict] [--json]
  llm-batchkit split <file> --out <dir> [--provider ...] [--max-requests N] [--max-bytes N] [--max-tokens N] [--skip-lint] [--force]
  llm-batchkit submit <dir>/manifest.json [--base-url URL] [--completion-window 24h] [--max-enqueued-tokens N] [--dry-run] [--resubmit-changed]
  llm-batchkit collect <dir>/manifest.json [--base-url URL] [--wait] [--interval 30]
  llm-batchkit merge <dir>/manifest.json [result files...] [--out results.jsonl] [--csv results.csv] [--json]
  llm-batchkit retry <results.jsonl> --out <dir> [--manifest f] [--input original] [--include-4xx] [--only expired,cancelled,missing,failed]
  llm-batchkit mock-server [--port 0] [--scenario file.json]

모든 명령에서 --lang en|ko (출력 언어)를 받습니다.
언어 결정 순서: --lang > LLM_BATCHKIT_LANG > LC_ALL > LC_MESSAGES > LANG ("ko" 로 시작하는 값이면 한국어, 그 밖에는 영어).

종료 코드: lint 는 오류가 있으면 1, collect 는 0 완료 / 1 배치 검증 실패 / 2 진행 중이거나 제출 전,
submit 은 배치를 만든 뒤 샤드가 바뀌었으면 1 (이때는 아무것도 업로드하지 않습니다).
submit/collect 에는 OPENAI_API_KEY 가 필요합니다 (또는 목 서버 같은 로컬 --base-url). 나머지 명령은 오프라인으로 동작합니다.
`;

const EN = {
  help: HELP_EN,

  // --- usage errors
  'usage.help': 'Run `llm-batchkit --help` for usage.',
  'usage.withHelp': '{detail}\n{help}',
  'usage.missing': 'Missing {what}.\n{help}',
  'what.input': 'input file',
  'what.manifest': 'manifest.json',
  'what.results': 'results.jsonl',
  'usage.splitOut': 'split needs --out <dir>.\nExample: llm-batchkit split input.jsonl --out run1 --max-requests 5000',
  'usage.retryOut': 'retry needs --out <dir>.\nExample: llm-batchkit retry run1/results.jsonl --out run1/retry-1',
  'usage.provider': '--provider must be one of: auto, {list} (got "{value}")',
  'usage.port': '--port must be an integer from 0 to 65535 (0 picks a free port), got "{value}"',
  'usage.lang': '--lang must be one of: en, ko (got "{value}")',
  'usage.langMissing': '--lang needs a value: en or ko',
  'usage.unknownCommand': 'unknown command "{command}"',

  // --- units (singular|plural; {n} is the count)
  'unit.request': '{n} request|{n} requests',
  'unit.model': '{n} model|{n} models',
  'unit.error': '{n} error|{n} errors',
  'unit.warning': '{n} warning|{n} warnings',
  'unit.shard': '{n} shard|{n} shards',
  'unit.resultFile': '{n} result file|{n} result files',
  'unit.unreadableLine': '{n} unreadable result line|{n} unreadable result lines',

  // --- report pieces
  'report.file': 'file',
  'report.warn': 'warn',
  'status.succeeded': 'succeeded',
  'status.failed': 'failed',
  'status.expired': 'expired',
  'status.cancelled': 'cancelled',
  'status.missing': 'missing',
  'report.notRetried': '(not retried by default)',

  // --- lint command
  'lint.provider': '(provider {provider})',
  'lint.more': '... and {n} more {code} (use --json to list all)',
  'lint.col.line': 'LINE',
  'lint.col.code': 'CODE',
  'lint.col.message': 'MESSAGE',

  // --- split command
  'split.col.shard': 'SHARD',
  'split.col.requests': 'REQUESTS',
  'split.col.bytes': 'BYTES',
  'split.col.tokens': 'EST_TOKENS',
  'split.col.model': 'MODEL',
  'split.summary': '{shards} · {requests} · manifest: {path}',

  // --- submit / collect
  'submit.verbSubmit': 'would submit',
  'submit.verbDone': 'submitted',
  'submit.replaces': ' (replaces an earlier batch: {reason})',
  'submit.already': 'already submitted (skipped)',
  'submit.setAside': 'kept old result files as {files} (merge ignores them)',
  'submit.held': 'held',
  'submit.heldNote': 'held {shards} (enqueued token budget) - run `collect`, then `submit` again to send them',
  'submit.summary': '{n} {verb} · {already} already submitted · {held} held',
  'reason.failed': 'failed {id}',
  'reason.changed': 'changed after {status} {id}',
  'collect.notSubmitted': '{shards} not submitted yet - run `submit` again',
  'collect.done': 'all batches finished - run `merge` next',
  'collect.failed': 'a batch failed validation - fix that shard file, then run `submit` again (only failed shards are sent again)',
  'collect.running': 'not finished yet - run `collect` again later (or use --wait)',
  'collect.progress': '{n} batch(es) still running; checking again in {seconds}s',
  'collect.noDetails': 'batch failed without error details',
  'collect.failureLine': 'line {line} {code} (custom_id {id})',

  // --- merge
  'merge.head': '{files} -> {out}',
  'merge.duplicate': 'duplicate: {id} (kept first success)',
  'merge.unknown': 'unknown custom_id(s) not in manifest: {ids}',
  'merge.skipped': 'skipped {lines}',
  'merge.csv': 'csv: {path}',
  'summary.succeeded': 'succeeded {n}',
  'summary.failed': 'failed {n} ({codes})',
  'summary.expired': 'expired {n}',
  'summary.cancelled': 'cancelled {n}',
  'summary.missing': 'missing {n}',

  // --- retry
  'retry.nothing': 'nothing to retry',
  'retry.nothingExcluded': 'nothing to retry ({n} excluded)',
  'retry.counts': '{n} to retry · {excluded} excluded',
  'retry.wrote': 'wrote {path} ({requests}, original lines unchanged)',
  'retry.excluded': 'excluded: {why}',
  'retry.why.nonRetryable': '{code} (non-retryable error, use --include-4xx)',
  'retry.why.indeterminate': 'indeterminate (unrecognized result, use --include-4xx)',
  'retry.why.errorObject': '{code} (error object, use --include-4xx)',
  'retry.why.clientError': '{code} (client error, use --include-4xx)',
  'retry.why.noResponse': 'indeterminate (no response or error in line, use --include-4xx)',
  'retry.why.generic': '{code} (not retryable, use --include-4xx)',

  // --- mock server
  'mock.notice': 'PRACTICE MOCK MODE: a local stand-in for a Batch API (127.0.0.1 only). It does not reproduce real timing, limits, prices or error texts.',
  'mock.listening': 'listening on {url}',
  'mock.try': 'Try: llm-batchkit submit <manifest> --base-url {url}',
  'mock.stop': 'Press Ctrl+C to stop.',

  // --- scripts/demo.mjs
  'demo.s1': '1. catch mistakes BEFORE uploading (this file is broken on purpose)',
  'demo.s2': '2. the real input is clean',
  'demo.s3': '3. split into shards (6 requests each)',
  'demo.s4': '4. submit every shard once',
  'demo.s5': '5. collect output / error files',
  'demo.s6': '6. merge by custom_id (a 400 hides in an output file, req-006 is missing)',
  'demo.s7': '7. pick only what is worth retrying',
  'demo.s8': '8. split the retry file',
  'demo.s9': '9. submit the retry shard',
  'demo.s10': '10. collect the retry results',
  'demo.s11': '11. merge both rounds',
  'demo.ok': 'DEMO OK  succeeded {succeeded} · failed {failed} (400, not retried) · retried {retried}',

  // --- lint issue messages (also the English text of the --json "message" field)
  'lint.invalid_custom_id': 'custom_id {value} must match {pattern}',
  'lint.missing_custom_id': 'custom_id must be a non-empty string',
  'lint.duplicate_custom_id': 'same as line {first}',
  'lint.missing_params': 'params object is required',
  'lint.max_tokens_min': 'params.max_tokens must be >= 1 in a batch',
  'lint.stream_anthropic': 'streaming is not supported in a batch',
  'lint.stream_openai': 'stream must not be true in a batch',
  'lint.missing_model_anthropic': 'params.model is required',
  'lint.missing_model_openai': 'body.model is required',
  'lint.invalid_method': 'method must be "POST", got {value}',
  'lint.invalid_url': 'url must be a path such as /v1/chat/completions, not a full URL',
  'lint.url_body_mismatch': 'body does not look like a {url} request',
  'lint.empty_file': 'no requests found (a provider rejects an empty file)',
  'lint.model_mismatch': '{what} in one file: {list} (split by model first)',
  'lint.what.deployments': 'deployment names',
  'lint.what.models': 'models',
  'lint.url_mismatch': 'endpoints in one file: {list} (one endpoint per batch)',
  'lint.too_many_requests': '{n} requests > limit {limit}',
  'lint.file_too_large': '{n} bytes > limit {limit}',
  'lint.too_many_embedding_inputs': '{n} embedding inputs > limit {limit}',
  'lint.too_many_tokens': '~{n} estimated tokens > limit {limit}',
  'lint.json_detail': '{detail}',
  'lint.request_not_object': 'request is not a JSON object',
  'lint.line_not_object': 'line is not a JSON object',
  'lint.empty_line': 'blank line (dropped by split)',

  // --- error messages (message / hint pairs)
  'err.invalid_provider': 'Unknown provider "{value}"',
  'err.invalid_provider.hint': 'Use one of: auto, openai, azure, anthropic.',
  'err.cannot_read': 'Cannot read {path}: {detail}',
  'err.cannot_read.hint': 'Check the path and permissions.',
  'err.manifest_read': 'Cannot read manifest {path}: {detail}',
  'err.manifest_read.hint': 'Pass the manifest.json written by `llm-batchkit split`.',
  'err.manifest_bad': '{path} is not a llm-batchkit manifest (version 1)',
  'err.manifest_bad.hint': 'Re-run `llm-batchkit split` to create one.',
  'err.state_read.hint': 'Fix or delete batches.json (already uploaded shards would be uploaded again).',
  'err.result_missing': 'Result file not found: {path}',
  'err.result_missing.hint': 'Run `llm-batchkit collect` first or check the path.',
  'err.no_result_files': 'No *.output.jsonl / *.error.jsonl files next to {path}',
  'err.no_result_files.hint': 'Run `llm-batchkit collect` first, or pass the result files explicitly.',
  'err.results_read.hint': 'Pass the results.jsonl written by `llm-batchkit merge`.',
  'err.invalid_results': '{path} line {line} is not a merge result row: {detail}',
  'err.invalid_results.hint': 'Re-create it with `llm-batchkit merge`.',
  'err.http_status': '{method} {path} -> HTTP {status} {detail}',
  'err.http_failed': '{method} {path} failed: {detail}',
  'err.http_after': '{last} (after {attempts} attempts)',
  'err.http_401.hint': 'Check OPENAI_API_KEY.',
  'err.http_other.hint': 'Check the request; this status is not retried.',
  'err.http_retry.hint': 'Run the command again; progress is kept in batches.json.',
  'err.missing_api_key': 'OPENAI_API_KEY is not set',
  'err.missing_api_key.hint': 'Export OPENAI_API_KEY, or try the keyless practice flow: `npm run demo` (uses a local mock server).',
  'err.retry_only': '--only: unknown status "{status}"',
  'err.retry_only.hint': 'Use a comma-separated subset of: {list}.',
  'err.original_file': 'Original request file not found: {path}',
  'err.original_file.hint': 'Keep the shard files next to manifest.json or pass --input <original file>.',
  'err.original_requests': 'Original request not found for: {ids}',
  'err.original_requests.hint': 'Pass --manifest or --input pointing at the files the results came from.',
  'err.original_manifest': 'No manifest at {path}',
  'err.original_manifest.hint': 'Pass --manifest <manifest.json> or --input <original file> so the original request lines can be copied.',
  'err.size_number': 'Invalid size: {value}',
  'err.size_number.hint': 'Use a positive number of bytes, e.g. 1200, 256MB or 200MiB.',
  'err.size_text': 'Invalid size: "{value}"',
  'err.size_text.hint': 'Use a number of bytes with an optional unit: 1200, 256MB, 200MiB.',
  'err.size_positive': 'Size must be positive: "{value}"',
  'err.size_positive.hint': 'Use a positive size.',
  'err.int_option': '{name} must be a positive integer, got "{value}"',
  'err.int_option.hint': 'Example: {name} 1000',
  'err.out_dir_has_batches': '{out} has running or finished batches ({owners}); --force would submit their requests twice',
  'err.out_dir_has_batches.hint': 'Split into a new folder (for example run2) - each folder is one submission, and merge/retry work per folder. --force only re-splits a folder whose batches all failed validation.',
  'err.lint_failed': '{n} line-level error(s); first: line {line} {code} ({message})',
  'err.lint_failed.hint': 'Fix them (see `llm-batchkit lint`), or pass --skip-lint to split anyway.',
  'err.empty_input': 'No requests found in {path}',
  'err.empty_input.hint': 'Check that the file is JSONL (one request per line) or {"requests":[...]}.',
  'err.line_too_large': 'line_too_large: {items}',
  'err.line_too_large.hint': 'Raise the limit or shorten that request; one request cannot be split.',
  'err.too_large_bytes': 'line {line}: {bytes} bytes > --max-bytes {limit}',
  'err.too_large_tokens': 'line {line}: ~{tokens} tokens > --max-tokens {limit}',
  'err.out_dir_in_use': '{out} already holds submission state or results ({used})',
  'err.out_dir_in_use.hint': 'Split into a new folder (for example run2). To fix a failed batch, edit its shard file there and run submit again. --force re-splits only a folder whose batches all failed validation.',
  'err.unsupported_provider': 'submit/collect support OpenAI-compatible endpoints only (manifest provider: {provider})',
  'err.unsupported_provider.hint': 'Azure and Anthropic submission is planned; for now upload the shard files with the vendor tooling and use merge/retry afterwards.',
  'err.base_url_changed': 'batches.json belongs to {existing}, not {requested}',
  'err.base_url_changed.hint': 'Use the same --base-url, or move batches.json away to start a new submission (shards would be uploaded again).',
  'err.shard_changed': 'refusing to submit - nothing was uploaded:\n{problems}',
  'err.shard_changed.runningHint': 'A running batch (or one the manifest lost) is never sent twice. Restore the shard file, or put the edited requests into a new folder (`split ... --out run2`); `collect` the running batch first, or cancel it at the provider.',
  'err.shard_changed.finishedHint': 'Its results are already there. Restore the shard file, or split the edited input into a new folder. To send it again on purpose (the requests are billed again) pass --resubmit-changed.',
  'err.changed_running': '  {file} changed while {id} is still {status}',
  'err.changed_finished': '  {file} changed after {id} {status}',
  'err.not_in_manifest': '  batches.json has {id} ({status}) for {file}, which is no longer in the manifest',
  'err.manifest_changed': '  manifest.json changed since {n} batch(es) were created',
  'err.shard_exceeds_budget': '{file} has ~{tokens} estimated tokens, more than --max-enqueued-tokens {budget}',
  'err.shard_exceeds_budget.hint': 'Split again with a smaller --max-tokens so every shard fits the budget.',
  'err.nothing_submitted': 'batches.json has no submitted shards',
  'err.nothing_submitted.hint': 'Run `llm-batchkit submit <manifest>` first.',
  'err.scenario_shape': 'Scenario must be {"results": {"<custom_id>": ["ok", ...]}}',
  'err.scenario_shape.hint': 'See examples/mock-scenario.json.',
  'err.scenario_entry': 'Scenario entry "{id}" must be a non-empty list of: {list}',
  'err.scenario_entry.hint': 'Fix examples/mock-scenario.json style entries.',
  'err.scenario_read': 'Cannot read scenario {path}: {detail}',
  'err.scenario_read.hint': 'Check the path and permissions, or omit --scenario to use the built-in scenario (same as examples/mock-scenario.json).',
  'err.scenario_empty': 'Scenario {path} is empty',
  'err.scenario_json': 'Scenario {path} is not valid JSON: {detail}',
  'err.prefixed': '{path}: {inner}',
  'err.port_in_use': 'Port {port} is already in use',
  'err.port_in_use.hint': 'Pass a different --port, or --port 0 to pick a free one.',
};

const KO: Record<keyof typeof EN, string> = {
  help: HELP_KO,

  'usage.help': '사용법은 `llm-batchkit --help` 로 확인하십시오.',
  'usage.withHelp': '{detail}\n{help}',
  'usage.missing': '{what}이(가) 지정되지 않았습니다.\n{help}',
  'what.input': '입력 파일',
  'what.manifest': 'manifest.json',
  'what.results': 'results.jsonl',
  'usage.splitOut': 'split 에는 --out <dir> 이 필요합니다.\n예: llm-batchkit split input.jsonl --out run1 --max-requests 5000',
  'usage.retryOut': 'retry 에는 --out <dir> 이 필요합니다.\n예: llm-batchkit retry run1/results.jsonl --out run1/retry-1',
  'usage.provider': '--provider 는 다음 중 하나여야 합니다: auto, {list} (입력값 "{value}")',
  'usage.port': '--port 는 0 이상 65535 이하의 정수여야 합니다 (0 은 빈 포트를 자동 선택). 입력값 "{value}"',
  'usage.lang': '--lang 은 en 또는 ko 여야 합니다 (입력값 "{value}")',
  'usage.langMissing': '--lang 에는 값(en 또는 ko)이 필요합니다',
  'usage.unknownCommand': '알 수 없는 명령 "{command}"',

  'unit.request': '요청 {n}건',
  'unit.model': '모델 {n}개',
  'unit.error': '오류 {n}건',
  'unit.warning': '경고 {n}건',
  'unit.shard': '샤드 {n}개',
  'unit.resultFile': '결과 파일 {n}개',
  'unit.unreadableLine': '읽을 수 없는 결과 줄 {n}개',

  'report.file': '파일',
  'report.warn': '경고',
  'status.succeeded': '성공',
  'status.failed': '실패',
  'status.expired': '만료',
  'status.cancelled': '취소',
  'status.missing': '누락',
  'report.notRetried': '(기본값으로는 재시도하지 않음)',

  'lint.provider': '(제공자 {provider})',
  'lint.more': '... 그 밖에 {code} {n}건 더 있습니다 (전체 목록은 --json 으로 확인하십시오)',
  'lint.col.line': '줄',
  'lint.col.code': '코드',
  'lint.col.message': '메시지',

  'split.col.shard': '샤드',
  'split.col.requests': '요청 수',
  'split.col.bytes': '바이트',
  'split.col.tokens': '추정 토큰',
  'split.col.model': '모델',
  'split.summary': '{shards} · {requests} · manifest: {path}',

  'submit.verbSubmit': '제출 예정',
  'submit.verbDone': '제출함',
  'submit.replaces': ' (이전 배치를 대체합니다: {reason})',
  'submit.already': '이미 제출됨 (건너뜀)',
  'submit.setAside': '이전 결과 파일을 {files} 로 보관했습니다 (merge 는 이 파일을 무시합니다)',
  'submit.held': '보류',
  'submit.heldNote': '{shards}를 보류했습니다 (대기 토큰 한도) - `collect` 를 실행한 뒤 `submit` 을 다시 실행하면 보냅니다',
  'submit.summary': '{verb} {n}건 · 이미 제출 {already}건 · 보류 {held}건',
  'reason.failed': '실패한 배치 {id}',
  'reason.changed': '{status} 상태의 {id} 이후 파일이 변경됨',
  'collect.notSubmitted': '{shards}가 아직 제출되지 않았습니다 - `submit` 을 다시 실행하십시오',
  'collect.done': '모든 배치가 끝났습니다 - 다음으로 `merge` 를 실행하십시오',
  'collect.failed': '배치 검증에 실패했습니다 - 해당 샤드 파일을 고친 뒤 `submit` 을 다시 실행하십시오 (실패한 샤드만 다시 전송됩니다)',
  'collect.running': '아직 끝나지 않았습니다 - 잠시 후 `collect` 를 다시 실행하십시오 (또는 --wait 사용)',
  'collect.progress': '배치 {n}개가 아직 실행 중입니다. {seconds}초 후 다시 확인합니다',
  'collect.noDetails': '오류 상세 없이 배치가 실패했습니다',
  'collect.failureLine': '{line}번째 줄 {code} (custom_id {id})',

  'merge.head': '{files} -> {out}',
  'merge.duplicate': '중복: {id} (먼저 성공한 결과를 유지함)',
  'merge.unknown': 'manifest 에 없는 custom_id: {ids}',
  'merge.skipped': '{lines}를 건너뛰었습니다',
  'merge.csv': 'csv: {path}',
  'summary.succeeded': '성공 {n}',
  'summary.failed': '실패 {n} ({codes})',
  'summary.expired': '만료 {n}',
  'summary.cancelled': '취소 {n}',
  'summary.missing': '누락 {n}',

  'retry.nothing': '재시도할 항목이 없습니다',
  'retry.nothingExcluded': '재시도할 항목이 없습니다 ({n}건 제외)',
  'retry.counts': '재시도 {n}건 · 제외 {excluded}건',
  'retry.wrote': '{path} 를 만들었습니다 ({requests}, 원본 줄은 그대로)',
  'retry.excluded': '제외: {why}',
  'retry.why.nonRetryable': '{code} (재시도할 수 없는 오류, 포함하려면 --include-4xx)',
  'retry.why.indeterminate': 'indeterminate (알 수 없는 결과, 포함하려면 --include-4xx)',
  'retry.why.errorObject': '{code} (오류 객체, 포함하려면 --include-4xx)',
  'retry.why.clientError': '{code} (클라이언트 오류, 포함하려면 --include-4xx)',
  'retry.why.noResponse': 'indeterminate (줄에 응답도 오류도 없음, 포함하려면 --include-4xx)',
  'retry.why.generic': '{code} (재시도 대상이 아님, 포함하려면 --include-4xx)',

  'mock.notice': '연습용 목(mock) 모드: Batch API 를 흉내 내는 로컬 서버입니다 (127.0.0.1 전용). 실제 처리 시간·한도·요금·오류 문구는 재현하지 않습니다.',
  'mock.listening': 'listening on {url}',
  'mock.try': '사용 예: llm-batchkit submit <manifest> --base-url {url}',
  'mock.stop': '종료하려면 Ctrl+C 를 누르십시오.',

  'demo.s1': '1. 업로드하기 전에 실수를 잡습니다 (이 파일은 일부러 망가뜨렸습니다)',
  'demo.s2': '2. 실제 입력 파일은 깨끗합니다',
  'demo.s3': '3. 샤드로 나눕니다 (샤드당 요청 6건)',
  'demo.s4': '4. 샤드를 한 번씩 제출합니다',
  'demo.s5': '5. 출력 파일과 오류 파일을 가져옵니다',
  'demo.s6': '6. custom_id 기준으로 병합합니다 (출력 파일 안에 400 이 숨어 있고 req-006 은 누락됨)',
  'demo.s7': '7. 재시도할 가치가 있는 것만 고릅니다',
  'demo.s8': '8. 재시도 파일을 나눕니다',
  'demo.s9': '9. 재시도 샤드를 제출합니다',
  'demo.s10': '10. 재시도 결과를 가져옵니다',
  'demo.s11': '11. 두 차례의 결과를 병합합니다',
  'demo.ok': '데모 성공  성공 {succeeded} · 실패 {failed} (400, 재시도 안 함) · 재시도 {retried}',

  'lint.invalid_custom_id': 'custom_id {value} 는 {pattern} 형식이어야 합니다',
  'lint.missing_custom_id': 'custom_id 는 비어 있지 않은 문자열이어야 합니다',
  'lint.duplicate_custom_id': '{first}번째 줄과 같습니다',
  'lint.missing_params': 'params 객체가 필요합니다',
  'lint.max_tokens_min': '배치에서는 params.max_tokens 가 1 이상이어야 합니다',
  'lint.stream_anthropic': '배치에서는 스트리밍을 지원하지 않습니다',
  'lint.stream_openai': '배치에서는 stream 을 true 로 둘 수 없습니다',
  'lint.missing_model_anthropic': 'params.model 이 필요합니다',
  'lint.missing_model_openai': 'body.model 이 필요합니다',
  'lint.invalid_method': 'method 는 "POST" 여야 합니다 (현재 {value})',
  'lint.invalid_url': 'url 은 /v1/chat/completions 같은 경로여야 하며 전체 URL 이면 안 됩니다',
  'lint.url_body_mismatch': 'body 가 {url} 요청 형식이 아닌 것 같습니다',
  'lint.empty_file': '요청이 없습니다 (제공자는 빈 파일을 거부합니다)',
  'lint.model_mismatch': '한 파일에 {what}이(가) 섞여 있습니다: {list} (먼저 모델별로 나누십시오)',
  'lint.what.deployments': '배포 이름',
  'lint.what.models': '모델',
  'lint.url_mismatch': '한 파일에 엔드포인트가 섞여 있습니다: {list} (배치 하나에는 엔드포인트 하나만 가능)',
  'lint.too_many_requests': '요청 {n}건 > 한도 {limit}',
  'lint.file_too_large': '{n} 바이트 > 한도 {limit}',
  'lint.too_many_embedding_inputs': '임베딩 입력 {n}개 > 한도 {limit}',
  'lint.too_many_tokens': '추정 토큰 약 {n} > 한도 {limit}',
  'lint.json_detail': '{detail}',
  'lint.request_not_object': '요청이 JSON 객체가 아닙니다',
  'lint.line_not_object': '이 줄은 JSON 객체가 아닙니다',
  'lint.empty_line': '빈 줄입니다 (split 이 제거합니다)',

  'err.invalid_provider': '알 수 없는 제공자 "{value}"',
  'err.invalid_provider.hint': 'auto, openai, azure, anthropic 중 하나를 사용하십시오.',
  'err.cannot_read': '{path} 를 읽을 수 없습니다: {detail}',
  'err.cannot_read.hint': '경로와 권한을 확인하십시오.',
  'err.manifest_read': 'manifest {path} 를 읽을 수 없습니다: {detail}',
  'err.manifest_read.hint': '`llm-batchkit split` 이 만든 manifest.json 을 지정하십시오.',
  'err.manifest_bad': '{path} 는 llm-batchkit manifest(버전 1)가 아닙니다',
  'err.manifest_bad.hint': '`llm-batchkit split` 을 다시 실행해 새로 만드십시오.',
  'err.state_read.hint': 'batches.json 을 고치거나 지우십시오 (이미 업로드한 샤드가 다시 업로드될 수 있습니다).',
  'err.result_missing': '결과 파일을 찾을 수 없습니다: {path}',
  'err.result_missing.hint': '먼저 `llm-batchkit collect` 를 실행하거나 경로를 확인하십시오.',
  'err.no_result_files': '{path} 옆에 *.output.jsonl / *.error.jsonl 파일이 없습니다',
  'err.no_result_files.hint': '먼저 `llm-batchkit collect` 를 실행하거나 결과 파일을 직접 지정하십시오.',
  'err.results_read.hint': '`llm-batchkit merge` 가 만든 results.jsonl 을 지정하십시오.',
  'err.invalid_results': '{path} {line}번째 줄이 merge 결과 행이 아닙니다: {detail}',
  'err.invalid_results.hint': '`llm-batchkit merge` 로 다시 만드십시오.',
  'err.http_status': '{method} {path} -> HTTP {status} {detail}',
  'err.http_failed': '{method} {path} 요청이 실패했습니다: {detail}',
  'err.http_after': '{last} ({attempts}회 시도 후)',
  'err.http_401.hint': 'OPENAI_API_KEY 를 확인하십시오.',
  'err.http_other.hint': '요청을 확인하십시오. 이 상태 코드는 재시도하지 않습니다.',
  'err.http_retry.hint': '명령을 다시 실행하십시오. 진행 상황은 batches.json 에 남아 있습니다.',
  'err.missing_api_key': 'OPENAI_API_KEY 가 설정되어 있지 않습니다',
  'err.missing_api_key.hint': 'OPENAI_API_KEY 를 export 하거나, 키가 필요 없는 연습 흐름을 사용하십시오: `npm run demo` (로컬 목 서버 사용).',
  'err.retry_only': '--only: 알 수 없는 상태 "{status}"',
  'err.retry_only.hint': '다음 중 쉼표로 구분한 부분집합을 사용하십시오: {list}.',
  'err.original_file': '원본 요청 파일을 찾을 수 없습니다: {path}',
  'err.original_file.hint': '샤드 파일을 manifest.json 옆에 두거나 --input <원본 파일> 을 지정하십시오.',
  'err.original_requests': '다음 항목의 원본 요청을 찾을 수 없습니다: {ids}',
  'err.original_requests.hint': '결과가 나온 파일을 가리키도록 --manifest 또는 --input 을 지정하십시오.',
  'err.original_manifest': '{path} 에 manifest 가 없습니다',
  'err.original_manifest.hint': '원본 요청 줄을 복사할 수 있도록 --manifest <manifest.json> 또는 --input <원본 파일> 을 지정하십시오.',
  'err.size_number': '잘못된 크기: {value}',
  'err.size_number.hint': '양수 바이트 수를 사용하십시오. 예: 1200, 256MB, 200MiB.',
  'err.size_text': '잘못된 크기: "{value}"',
  'err.size_text.hint': '단위를 붙일 수 있는 바이트 수를 사용하십시오: 1200, 256MB, 200MiB.',
  'err.size_positive': '크기는 양수여야 합니다: "{value}"',
  'err.size_positive.hint': '양수 크기를 사용하십시오.',
  'err.int_option': '{name} 은(는) 양의 정수여야 합니다 (입력값 "{value}")',
  'err.int_option.hint': '예: {name} 1000',
  'err.out_dir_has_batches': '{out} 에 실행 중이거나 끝난 배치가 있습니다 ({owners}). --force 를 쓰면 같은 요청이 두 번 제출됩니다',
  'err.out_dir_has_batches.hint': '새 폴더(예: run2)로 나누십시오. 폴더 하나가 제출 한 번이며 merge/retry 도 폴더 단위로 동작합니다. --force 는 모든 배치가 검증에 실패한 폴더만 다시 나눕니다.',
  'err.lint_failed': '줄 단위 오류 {n}건, 첫 오류: {line}번째 줄 {code} ({message})',
  'err.lint_failed.hint': '오류를 고치십시오 (`llm-batchkit lint` 참고). 그래도 나누려면 --skip-lint 를 지정하십시오.',
  'err.empty_input': '{path} 에서 요청을 찾을 수 없습니다',
  'err.empty_input.hint': '파일이 JSONL(한 줄에 요청 하나) 또는 {"requests":[...]} 형식인지 확인하십시오.',
  'err.line_too_large': 'line_too_large: {items}',
  'err.line_too_large.hint': '한도를 올리거나 해당 요청을 줄이십시오. 요청 하나는 나눌 수 없습니다.',
  'err.too_large_bytes': '{line}번째 줄: {bytes} 바이트 > --max-bytes {limit}',
  'err.too_large_tokens': '{line}번째 줄: 약 {tokens} 토큰 > --max-tokens {limit}',
  'err.out_dir_in_use': '{out} 에 이미 제출 상태나 결과가 있습니다 ({used})',
  'err.out_dir_in_use.hint': '새 폴더(예: run2)로 나누십시오. 실패한 배치를 고치려면 그 폴더의 샤드 파일을 수정한 뒤 submit 을 다시 실행하십시오. --force 는 모든 배치가 검증에 실패한 폴더만 다시 나눕니다.',
  'err.unsupported_provider': 'submit/collect 는 OpenAI 호환 엔드포인트만 지원합니다 (manifest 제공자: {provider})',
  'err.unsupported_provider.hint': 'Azure 와 Anthropic 제출은 계획 중입니다. 지금은 제공자 도구로 샤드 파일을 업로드한 뒤 merge/retry 를 사용하십시오.',
  'err.base_url_changed': 'batches.json 은 {requested} 가 아니라 {existing} 의 것입니다',
  'err.base_url_changed.hint': '같은 --base-url 을 사용하거나, batches.json 을 옮겨 새 제출을 시작하십시오 (샤드가 다시 업로드됩니다).',
  'err.shard_changed': '제출을 거부합니다 - 아무것도 업로드하지 않았습니다:\n{problems}',
  'err.shard_changed.runningHint': '실행 중인 배치(또는 manifest 에서 잃어버린 배치)는 두 번 전송하지 않습니다. 샤드 파일을 되돌리거나, 수정한 요청을 새 폴더(`split ... --out run2`)에 넣으십시오. 실행 중인 배치는 먼저 `collect` 하거나 제공자 쪽에서 취소하십시오.',
  'err.shard_changed.finishedHint': '결과가 이미 있습니다. 샤드 파일을 되돌리거나, 수정한 입력을 새 폴더로 나누십시오. 의도적으로 다시 보내려면(요청이 다시 과금됩니다) --resubmit-changed 를 지정하십시오.',
  'err.changed_running': '  {file} 이(가) 바뀌었고 {id} 는 아직 {status} 상태입니다',
  'err.changed_finished': '  {file} 이(가) {id} {status} 이후 바뀌었습니다',
  'err.not_in_manifest': '  batches.json 에 {file} 용 {id} ({status})가 있지만, 해당 파일은 더 이상 manifest 에 없습니다',
  'err.manifest_changed': '  배치 {n}개를 만든 뒤 manifest.json 이 바뀌었습니다',
  'err.shard_exceeds_budget': '{file} 의 추정 토큰이 약 {tokens} 로 --max-enqueued-tokens {budget} 보다 큽니다',
  'err.shard_exceeds_budget.hint': '모든 샤드가 한도에 들어가도록 더 작은 --max-tokens 로 다시 나누십시오.',
  'err.nothing_submitted': 'batches.json 에 제출된 샤드가 없습니다',
  'err.nothing_submitted.hint': '먼저 `llm-batchkit submit <manifest>` 를 실행하십시오.',
  'err.scenario_shape': '시나리오는 {"results": {"<custom_id>": ["ok", ...]}} 형식이어야 합니다',
  'err.scenario_shape.hint': 'examples/mock-scenario.json 을 참고하십시오.',
  'err.scenario_entry': '시나리오 항목 "{id}" 는 다음 값으로 이루어진 비어 있지 않은 목록이어야 합니다: {list}',
  'err.scenario_entry.hint': 'examples/mock-scenario.json 과 같은 형식으로 항목을 고치십시오.',
  'err.scenario_read': '시나리오 {path} 를 읽을 수 없습니다: {detail}',
  'err.scenario_read.hint': '경로와 권한을 확인하거나, --scenario 를 생략해 내장 시나리오(examples/mock-scenario.json 과 같음)를 사용하십시오.',
  'err.scenario_empty': '시나리오 {path} 가 비어 있습니다',
  'err.scenario_json': '시나리오 {path} 가 올바른 JSON 이 아닙니다: {detail}',
  'err.prefixed': '{path}: {inner}',
  'err.port_in_use': '포트 {port} 는 이미 사용 중입니다',
  'err.port_in_use.hint': '다른 --port 를 지정하거나, --port 0 으로 빈 포트를 고르십시오.',
};

export type MsgKey = keyof typeof EN;
export const MESSAGES: Record<Lang, Record<string, string>> = { en: EN, ko: KO };

function isMsg(v: unknown): v is Msg {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && 'key' in v;
}

/** Render a message key in a language. Unknown keys fall back to English, then to the key itself. */
export function t(lang: Lang, key: string, params: Params = {}): string {
  const template = MESSAGES[lang][key] ?? MESSAGES.en[key] ?? key;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const v = params[name];
    if (v === undefined) return whole;
    if (Array.isArray(v)) return v.map((m) => t(lang, m.key, m.params)).join('\n');
    if (isMsg(v)) return t(lang, v.key, v.params);
    if (typeof v === 'object') return v.items.map((m) => t(lang, m.key, m.params)).join(v.sep ?? '\n');
    return String(v);
  });
}

export function render(lang: Lang, msg: Msg): string {
  return t(lang, msg.key, msg.params);
}

/** `count(lang, 1, 'unit.request')` -> "1 request" / "요청 1건"; the English table holds `singular|plural`. */
export function count(lang: Lang, n: number, unitKey: string): string {
  const forms = (MESSAGES[lang][unitKey] ?? unitKey).split('|');
  return (forms.length > 1 ? (n === 1 ? forms[0] : forms[1]) : forms[0])!.replace(/\{n\}/g, String(n));
}

// ---------------------------------------------------------------------------------------------------------------
// Language choice
// ---------------------------------------------------------------------------------------------------------------

/** Thrown by `resolveLang` for `--lang <bad value>`; the CLI turns it into a usage error (exit 64). */
export class LangOptionError extends Error {
  readonly value: string | undefined;
  constructor(value: string | undefined) {
    super(value === undefined ? '--lang needs a value: en or ko' : `--lang must be one of: en, ko (got "${value}")`);
    this.name = 'LangOptionError';
    this.value = value;
  }
}

/** Korean when the locale value starts with "ko" (ko, ko_KR.UTF-8, ko-KR ...), otherwise English. */
export function langFromLocale(value: string | undefined): Lang {
  return value !== undefined && value.trim().toLowerCase().startsWith('ko') ? 'ko' : 'en';
}

/** Value of the first `--lang` / `--lang=<v>` in argv (undefined when absent). Stops at `--`. */
function langFlag(argv: readonly string[]): { present: boolean; value: string | undefined } {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--') break;
    if (a === '--lang') return { present: true, value: argv[i + 1] };
    if (a.startsWith('--lang=')) return { present: true, value: a.slice('--lang='.length) };
  }
  return { present: false, value: undefined };
}

/** Language from the environment only: LLM_BATCHKIT_LANG > LC_ALL > LC_MESSAGES > LANG. Empty values are skipped. */
export function langFromEnv(env: NodeJS.ProcessEnv): Lang {
  for (const name of ['LLM_BATCHKIT_LANG', 'LC_ALL', 'LC_MESSAGES', 'LANG']) {
    const v = env[name];
    if (v !== undefined && v.trim() !== '') return langFromLocale(v);
  }
  return 'en';
}

/** Choose the output language: `--lang en|ko` > LLM_BATCHKIT_LANG > LC_ALL > LC_MESSAGES > LANG; otherwise English. */
export function resolveLang(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): Lang {
  const flag = langFlag(argv);
  if (flag.present) {
    if (flag.value === 'en' || flag.value === 'ko') return flag.value;
    throw new LangOptionError(flag.value);
  }
  return langFromEnv(env);
}

/** argv without `--lang <v>` / `--lang=<v>` so the per-command option parser never sees it. */
export function stripLangFlag(argv: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--') {
      out.push(...argv.slice(i));
      break;
    }
    if (a === '--lang') {
      i++;
      continue;
    }
    if (a.startsWith('--lang=')) continue;
    out.push(a);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Lint issues: English text for the data, a (key, params) record on the side for the text report
// ---------------------------------------------------------------------------------------------------------------

const issueMsgs = new WeakMap<Issue, Msg>();

/** Create an Issue whose `message` is the English text; remember the key so the text report can re-render it. */
export function makeIssue(line: number, code: string, severity: Issue['severity'], key: string, params: Params = {}): Issue {
  const issue: Issue = { line, code, severity, message: t('en', key, params) };
  issueMsgs.set(issue, { key, params });
  return issue;
}

/** The message key and parameters behind an issue, for nesting inside another message. */
export function issueMsg(issue: Issue): Msg {
  return issueMsgs.get(issue) ?? { key: 'lint.json_detail', params: { detail: issue.message } };
}

/** Message of an issue in a language (English `message` when the issue was not created by `makeIssue`). */
export function issueMessage(lang: Lang, issue: Issue): string {
  const m = issueMsgs.get(issue);
  return m ? render(lang, m) : issue.message;
}

// ---------------------------------------------------------------------------------------------------------------
// Library strings that were built as English text (retry reasons, submit reasons, collect failures)
// ---------------------------------------------------------------------------------------------------------------

const PATTERNS: Array<[RegExp, (m: RegExpExecArray) => Msg]> = [
  [/^failed (\S+)$/, (m) => ({ key: 'reason.failed', params: { id: m[1]! } })],
  [/^changed after (\S+) (\S+)$/, (m) => ({ key: 'reason.changed', params: { status: m[1]!, id: m[2]! } })],
  [/^(\S+) \(non-retryable error, use --include-4xx\)$/, (m) => ({ key: 'retry.why.nonRetryable', params: { code: m[1]! } })],
  [/^indeterminate \(unrecognized result, use --include-4xx\)$/, () => ({ key: 'retry.why.indeterminate' })],
  [/^(\S+) \(error object, use --include-4xx\)$/, (m) => ({ key: 'retry.why.errorObject', params: { code: m[1]! } })],
  [/^(\S+) \(client error, use --include-4xx\)$/, (m) => ({ key: 'retry.why.clientError', params: { code: m[1]! } })],
  [/^indeterminate \(no response or error in line, use --include-4xx\)$/, () => ({ key: 'retry.why.noResponse' })],
  [/^(\S+) \(not retryable, use --include-4xx\)$/, (m) => ({ key: 'retry.why.generic', params: { code: m[1]! } })],
  [/^(\d+) batch\(es\) still running; checking again in (\d+)s$/, (m) => ({ key: 'collect.progress', params: { n: m[1]!, seconds: m[2]! } })],
  [/^batch failed without error details$/, () => ({ key: 'collect.noDetails' })],
];

/** Translate an English library string (one of the known shapes) into `lang`; anything else is returned unchanged. */
export function localizeText(lang: Lang, english: string): string {
  if (lang === 'en') return english;
  for (const [re, build] of PATTERNS) {
    const m = re.exec(english);
    if (m) return render(lang, build(m));
  }
  const failure = /^line (\d+) (\S+) \(custom_id (.*?)\)( - (.*))?$/.exec(english);
  if (failure) {
    const head = t(lang, 'collect.failureLine', { line: failure[1]!, code: failure[2]!, id: failure[3]! });
    return failure[5] !== undefined ? `${head} - ${failure[5]}` : head;
  }
  return english;
}
