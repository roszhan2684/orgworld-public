import type { TaskFamily } from '../types.ts';
import { implRle } from './impl-rle.ts';
import { implExprEval } from './impl-expr-eval.ts';
import { implIntervalMerge } from './impl-interval-merge.ts';
import { implLruCache } from './impl-lru-cache.ts';
import { debugBinarySearch } from './debug-binary-search.ts';
import { debugEventEmitter } from './debug-event-emitter.ts';
import { debugPagination } from './debug-pagination.ts';
import { testParseRange } from './test-parse-range.ts';
import { secSafeJoin } from './sec-safe-join.ts';
import { refactorPricing } from './refactor-pricing.ts';

/** Registry of all EvoOrgBench task families. */
export const FAMILIES: TaskFamily[] = [implRle, implExprEval, implIntervalMerge, implLruCache, debugBinarySearch, debugEventEmitter, debugPagination, testParseRange, secSafeJoin, refactorPricing];

export function familyById(id: string): TaskFamily {
  const f = FAMILIES.find((x) => x.id === id);
  if (!f) throw new Error(`unknown task family ${id}`);
  return f;
}

export function taskById(taskId: string) {
  const [fam, v] = taskId.split('#');
  return familyById(fam!).generate(Number(v));
}
