/**
 * Pure rollup logic shared by `run.ts` (after live calls) and `recompute.ts` (from saved per-turn
 * data, no API). Keeping it pure means the published aggregates can always be re-derived from the
 * raw token counts in results/, which is the ground truth.
 */
import { turnCost, type Rate } from './pricing.js';
import type { TurnUsage } from './pricing.js';

export interface RawTurn {
  turnIndex: number;
  playerAction?: string | null;
  reply?: string;
  usage: TurnUsage;
  reportedCost?: number | null;
  reasoningTokens?: number;
}

export interface Agg {
  uncached: number;
  cachedRead: number;
  cacheWrite: number;
  output: number;
  /** Total distinct prompt (input) tokens = uncached + cachedRead + cacheWrite. */
  promptTokens: number;
  /** Actual input-side $ from pinned rates (incl. cache writes). */
  inputCost: number;
  /** No-cache baseline for THESE prompts: all prompt tokens at full input rate. */
  baselineInputCost: number;
  /** OpenRouter's reported real total cost across turns (USD). */
  reportedCost: number;
  /** Reasoning/thinking tokens used across turns — should be 0. */
  reasoningTokens: number;
}

export function aggregate(turns: RawTurn[], rate: Rate): Agg {
  const a: Agg = { uncached: 0, cachedRead: 0, cacheWrite: 0, output: 0, promptTokens: 0, inputCost: 0, baselineInputCost: 0, reportedCost: 0, reasoningTokens: 0 };
  for (const t of turns) {
    const u = t.usage;
    a.uncached += u.uncachedInput;
    a.cachedRead += u.cachedRead;
    a.cacheWrite += u.cacheWrite;
    a.output += u.outputTokens;
    const prompt = u.uncachedInput + u.cachedRead + u.cacheWrite;
    a.promptTokens += prompt;
    a.inputCost += turnCost({ ...u, outputTokens: 0 }, rate); // input-side only; variant delta is pure cache
    a.baselineInputCost += (prompt * rate.input) / 1_000_000;
    a.reportedCost += t.reportedCost ?? 0;
    a.reasoningTokens += t.reasoningTokens ?? 0;
  }
  return a;
}

/** Full per-provider summary. Each variant is compared to ITS OWN no-cache baseline, plus a direct
 *  naive→disciplined comparison (the "just move the timestamp" number). */
export function buildProviderSummary(model: string, naive: RawTurn[], disciplined: RawTurn[], rate: Rate) {
  const an = aggregate(naive, rate);
  const ad = aggregate(disciplined, rate);
  const naiveVsBaseline = (an.inputCost - an.baselineInputCost) / an.baselineInputCost;
  const discVsBaseline = (ad.inputCost - ad.baselineInputCost) / ad.baselineInputCost;
  const hitRate = ad.cachedRead / (ad.promptTokens || 1);
  const disciplinedVsNaive = an.inputCost > 0 ? (an.inputCost - ad.inputCost) / an.inputCost : 0;
  return {
    model,
    naive: { ...an, vsBaseline: naiveVsBaseline },
    disciplined: { ...ad, vsBaseline: discVsBaseline, hitRate },
    disciplinedVsNaive, // disciplined input cost is this fraction cheaper than naive
    turns: { naive, disciplined },
  };
}
