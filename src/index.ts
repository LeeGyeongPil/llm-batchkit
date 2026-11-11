// Public library API. Everything not exported here is internal and may change.
export { lintFile, lintText, type LintOptions, type LintReport } from './lint.js';
export { splitFile, type SplitOptions, type SplitResult } from './split.js';
export { mergeResults, readResultsFile, resultsToCsv, writeResultsJsonl, type MergeOptions, type MergeReport, type ResultRow } from './merge.js';
export { selectRetries, buildOriginalIndex, writeRetryFile, type RetryOptions, type RetrySelection } from './retry.js';
export { classifyLine, type Classified, type Status } from './classify.js';
export { submit, collect, type SubmitOptions, type SubmitResult, type CollectOptions, type CollectResult } from './submit.js';
export { PRESETS, resolveLimits, type Preset, type Limits } from './providers.js';
export { parseSize } from './size.js';
export { BatchkitError } from './errors.js';
export { startMockServer, MOCK_NOTICE, type MockServer } from './mock/server.js';
export { DEFAULT_SCENARIO, parseScenario, type Scenario } from './mock/scenario.js';
export type { Manifest, ShardInfo } from './manifest.js';
export type { Issue, ProviderName } from './types.js';
