/**
 * Run the benchmark: each provider × {naive, disciplined} × N turns. For every turn we read the
 * provider's NATIVE cache-usage fields, convert to dollars with pinned rates, and compare both
 * variants against the no-cache baseline. Writes results/ and prints a table.
 *
 *   node: `npm run eval`  (needs OPENAI_API_KEY, ANTHROPIC_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY)
 */
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PRICING, MODELS, PRICING_PINNED_DATE, turnCost, type Rate } from './pricing.js';
import type { Variant } from './prompts.js';
import type { TurnResult } from './providers/types.js';
import { runSession as runOpenAI } from './providers/openai.js';
import { runSession as runAnthropic } from './providers/anthropic.js';
import { runSession as runGemini } from './providers/gemini.js';

const TURNS = Number(process.env.TURNS ?? 6);

type ProviderKey = keyof typeof MODELS;
const PROVIDERS: { key: ProviderKey; envKey: string; run: (v: Variant, t: number) => Promise<TurnResult[]> }[] = [
  { key: 'openai', envKey: 'OPENAI_API_KEY', run: runOpenAI },
  { key: 'anthropic', envKey: 'ANTHROPIC_API_KEY', run: runAnthropic },
  { key: 'gemini', envKey: 'GOOGLE_GENERATIVE_AI_API_KEY', run: runGemini },
];

interface Agg {
  uncached: number;
  cachedRead: number;
  cacheWrite: number;
  output: number;
  /** Total distinct prompt (input) tokens = uncached + cachedRead + cacheWrite. */
  promptTokens: number;
  /** Actual input-side $ (what you paid for input, incl. writes). */
  inputCost: number;
  /** No-cache baseline: all prompt tokens at full input rate. */
  baselineInputCost: number;
}

function aggregate(turns: TurnResult[], rate: Rate): Agg {
  const a: Agg = { uncached: 0, cachedRead: 0, cacheWrite: 0, output: 0, promptTokens: 0, inputCost: 0, baselineInputCost: 0 };
  for (const t of turns) {
    const u = t.usage;
    a.uncached += u.uncachedInput;
    a.cachedRead += u.cachedRead;
    a.cacheWrite += u.cacheWrite;
    a.output += u.outputTokens;
    const prompt = u.uncachedInput + u.cachedRead + u.cacheWrite;
    a.promptTokens += prompt;
    // input-side cost only (exclude output so the variant delta is pure cache economics)
    a.inputCost += turnCost({ ...u, outputTokens: 0 }, rate);
    a.baselineInputCost += (prompt * rate.input) / 1_000_000;
  }
  return a;
}

const pct = (x: number) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`;
const usd = (x: number) => `$${x.toFixed(6)}`;

async function main() {
  console.log(`\nprompt-cache-economics — ${TURNS} turns/variant — pricing pinned ${PRICING_PINNED_DATE}\n`);
  const report: any = { runAt: new Date().toISOString(), turns: TURNS, pricingPinned: PRICING_PINNED_DATE, models: MODELS, providers: {} };

  for (const p of PROVIDERS) {
    if (!process.env[p.envKey]) {
      console.log(`• ${p.key.padEnd(10)} SKIPPED — ${p.envKey} not set`);
      continue;
    }
    const rate = PRICING[p.key];
    let naive: TurnResult[], disciplined: TurnResult[];
    try {
      naive = await p.run('naive', TURNS);
      disciplined = await p.run('disciplined', TURNS);
    } catch (err) {
      console.log(`• ${p.key.padEnd(10)} ERROR — ${(err as Error).message}`);
      report.providers[p.key] = { error: (err as Error).message };
      continue;
    }

    const an = aggregate(naive, rate);
    const ad = aggregate(disciplined, rate);
    const baseline = an.baselineInputCost; // same prompt sizes; use naive's as the reference
    const naiveVsBase = (an.inputCost - baseline) / baseline;
    const discVsBase = (ad.inputCost - baseline) / baseline;
    const discHitRate = ad.cachedRead / (ad.promptTokens || 1);

    console.log(`\n■ ${p.key.toUpperCase()}  (${MODELS[p.key]})`);
    console.log(`   no-cache baseline input cost   ${usd(baseline)}`);
    console.log(`   NAIVE   input cost ${usd(an.inputCost)}  (${pct(naiveVsBase)} vs base)  cachedRead=${an.cachedRead}  write=${an.cacheWrite}`);
    console.log(`   DISCIPL input cost ${usd(ad.inputCost)}  (${pct(discVsBase)} vs base)  hitRate=${(discHitRate * 100).toFixed(1)}%`);
    if (an.inputCost > baseline) console.log(`   ⚠ NAIVE COSTS MORE THAN BASE — write premium paid every turn, ${an.cachedRead} reads collected`);

    report.providers[p.key] = {
      model: MODELS[p.key],
      baselineInputCost: baseline,
      naive: { ...an, vsBaseline: naiveVsBase },
      disciplined: { ...ad, vsBaseline: discVsBase, hitRate: discHitRate },
      // Full per-turn transcripts (real DM replies + usage) so the interactive playground and
      // the animated explainer can replay real data with no backend.
      turns: {
        naive: naive.map((t) => ({ turnIndex: t.turnIndex, reply: t.reply, usage: t.usage })),
        disciplined: disciplined.map((t) => ({ turnIndex: t.turnIndex, reply: t.reply, usage: t.usage })),
      },
    };
  }

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const stamp = report.runAt.slice(0, 10);
  const outPath = join(__dirname, '..', 'results', `run-${stamp}.json`);
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`\nwrote ${outPath}\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
