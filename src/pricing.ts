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

/**
 * Pinned eval models, as OpenRouter slugs. We route everything through OpenRouter (one key) and
 * read its reported cost + cached-token counts. Pinned rates below are a cross-check against
 * OpenRouter's real billed cost. Verify slugs live at run (the smoke test will catch a bad slug).
 */
export const MODELS = {
  openai: 'openai/gpt-5.4',
  anthropic: 'anthropic/claude-sonnet-4.6',
} as const;

/** True when this model is an Anthropic route (needs explicit cache_control breakpoints). */
export function isAnthropic(slug: string): boolean {
  return slug.startsWith('anthropic/');
}

/** Min tokens a prefix must reach to be cacheable, per pinned model (2026-06-09). */
export const MIN_CACHE_TOKENS = {
  openai: 1024, // gpt-5.4
  anthropic: 1024, // Sonnet 4.6
} as const;

/*
 * Rates grounded against official pages, retrieved 2026-06-09:
 *   gpt-5.4            — OpenRouter model page (input $2.50 / output $15) + OpenAI pricing
 *                        (cached $0.25 = 90% off, no write cost).
 *   claude-sonnet-4.6  — platform.claude.com/.../about-claude/pricing: base $3, 5m write $3.75,
 *                        1h write $6, cache read $0.30, output $15.
 * OpenRouter also reports the real billed cost per call, which is the ground truth at run.
 */
export const PRICING: Record<keyof typeof MODELS, Rate> = {
  // gpt-5.4: automatic caching, 90% read discount, NO write cost.
  openai: { input: 2.5, cachedRead: 0.25, output: 15 },
  // claude-sonnet-4.6: read 0.1x, 5m write 1.25x, 1h write 2x.
  anthropic: { input: 3.0, cachedRead: 0.3, write5m: 3.75, write1h: 6.0, output: 15 },
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
