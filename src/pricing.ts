/**
 * Pinned model IDs + pricing, and the cost / break-even math.
 *
 * Rates are USD per 1,000,000 tokens, retrieved 2026-06-09 from each provider's official
 * pricing page (see notes). RE-VERIFY before publishing — provider rates drift. The benchmark
 * reads the REAL token counts from each API; pricing only converts those counts to dollars.
 *
 * The naive-vs-disciplined headline (input-cost cut) is an INPUT-side story; output rates are
 * included for total cost but the variant delta lives entirely in the cached/uncached split.
 */

export const PRICING_PINNED_DATE = '2026-06-09';

export interface Rate {
  /** $/MTok for ordinary (uncached) input. */
  input: number;
  /** $/MTok for a cache READ (cached input). */
  cachedRead: number;
  /** $/MTok for a 5-minute cache WRITE (Anthropic only). */
  write5m?: number;
  /** $/MTok for a 1-hour cache WRITE (Anthropic only). */
  write1h?: number;
  /** $/MTok per HOUR of explicit-cache storage (Gemini explicit only). */
  storagePerMTokHour?: number;
  /** $/MTok for output. `null` = not pinned yet, verify at run. */
  output: number | null;
}

/** Pinned eval models — cheap tier per provider, all support caching. Verify IDs live at run. */
export const MODELS = {
  openai: 'gpt-5.4-mini',
  anthropic: 'claude-haiku-4-5',
  gemini: 'gemini-2.5-flash',
} as const;

/** Min tokens a prefix must reach to be cacheable, per pinned model (2026-06-09). */
export const MIN_CACHE_TOKENS = {
  openai: 1024,
  anthropic: 4096, // Haiku 4.5 — the highest floor; the world prefix must clear this.
  gemini: 2048,
} as const;

export const PRICING: Record<keyof typeof MODELS, Rate> = {
  // gpt-5.4-mini: automatic caching, 90% read discount, NO write cost.
  openai: { input: 0.75, cachedRead: 0.075, output: 4.5 },
  // claude-haiku-4-5: read 0.1x, 5m write 1.25x, 1h write 2x.
  anthropic: { input: 1.0, cachedRead: 0.1, write5m: 1.25, write1h: 2.0, output: 5.0 },
  // gemini-2.5-flash: read 0.1x, implicit has no storage cost; explicit storage $1/MTok-hr.
  gemini: { input: 0.3, cachedRead: 0.03, storagePerMTokHour: 1.0, output: null /* verify */ },
};

/** Per-turn token usage, normalized across providers. */
export interface TurnUsage {
  /** Uncached input tokens, billed at `input`. */
  uncachedInput: number;
  /** Tokens served from cache, billed at `cachedRead`. */
  cachedRead: number;
  /** Tokens written to cache this turn, billed at the write rate (Anthropic); 0 elsewhere. */
  cacheWrite: number;
  /** Which write rate applies, if any. */
  writeTtl?: '5m' | '1h';
  outputTokens: number;
}

/** Dollars for one turn given its usage and the model's rate. */
export function turnCost(usage: TurnUsage, rate: Rate): number {
  const writeRate = usage.writeTtl === '1h' ? rate.write1h : rate.write5m;
  const out = rate.output ?? 0;
  return (
    (usage.uncachedInput * rate.input +
      usage.cachedRead * rate.cachedRead +
      usage.cacheWrite * (writeRate ?? 0) +
      usage.outputTokens * out) /
    1_000_000
  );
}

/**
 * Anthropic write-premium break-even: how many cache READS of a segment are needed before
 * caching beats paying full input every time. N > (w - 1) / 0.9, where w is the write multiplier.
 * Returns the smallest integer N.
 */
export function anthropicWriteBreakEven(writeMultiple: number): number {
  return Math.max(1, Math.ceil((writeMultiple - 1) / 0.9 + 1e-9));
}

/**
 * Gemini explicit-storage break-even: cache reads PER STORED HOUR needed to beat base rate.
 * reads/hr > storageRate / (0.9 * inputPrice).
 */
export function geminiStorageBreakEvenPerHour(storagePerMTokHour: number, inputPrice: number): number {
  return storagePerMTokHour / (0.9 * inputPrice);
}
