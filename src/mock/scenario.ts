import { fail } from '../errors.js';

/**
 * What the practice mock server does with a request on its Nth submission:
 *  ok         -> 200 line in the OUTPUT file
 *  400        -> 400 line in the OUTPUT file (real batches do this too: not every failure lands in the error file)
 *  429, 500   -> failed line in the ERROR file
 *  expired    -> batch_expired line in the ERROR file
 *  cancelled  -> batch_cancelled line in the ERROR file
 *  drop       -> the request appears in no file at all (a "missing" request)
 */
export type Outcome = 'ok' | '400' | '429' | '500' | 'expired' | 'cancelled' | 'drop';
export const OUTCOMES: Outcome[] = ['ok', '400', '429', '500', 'expired', 'cancelled', 'drop'];

export interface Scenario {
  /** custom_id -> outcomes by submission round (round 0, 1, ...); the last entry repeats. Unlisted ids are always `ok`. */
  results: Record<string, Outcome[]>;
  /** How many status polls answer `in_progress` before a batch finishes (default 0 = finished on first poll). */
  pollsBeforeDone?: number;
}

/** Matches examples/mock-scenario.json and the fixtures used in the tests. */
export const DEFAULT_SCENARIO: Scenario = {
  results: {
    'req-004': ['400'],
    'req-006': ['drop', 'ok'],
    'req-009': ['expired', 'ok'],
    'req-011': ['500', 'ok'],
    'req-012': ['cancelled', 'ok'],
  },
};

export function parseScenario(value: unknown): Scenario {
  const v = value as { results?: Record<string, unknown>; pollsBeforeDone?: unknown } | null;
  if (!v || typeof v !== 'object' || !v.results || typeof v.results !== 'object') {
    throw fail('invalid_scenario', 'err.scenario_shape', {}, 'err.scenario_shape.hint');
  }
  const results: Record<string, Outcome[]> = {};
  for (const [id, list] of Object.entries(v.results)) {
    if (!Array.isArray(list) || list.length === 0 || !list.every((o) => OUTCOMES.includes(o as Outcome))) {
      throw fail('invalid_scenario', 'err.scenario_entry', { id, list: OUTCOMES.join(', ') }, 'err.scenario_entry.hint');
    }
    results[id] = list as Outcome[];
  }
  const scenario: Scenario = { results };
  if (typeof v.pollsBeforeDone === 'number') scenario.pollsBeforeDone = v.pollsBeforeDone;
  return scenario;
}
