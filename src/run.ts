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
import { PLAYER_TURNS } from './domain.js';
import type { TurnResult } from './providers/types.js';
import { runSession } from './providers/openrouter.js';

/** Serialize a turn for the committed replay dataset: player action + DM reply + usage + cost. */
function serializeTurn(t: TurnResult) {
  return {
    turnIndex: t.turnIndex,
    playerAction: PLAYER_TURNS[t.turnIndex] ?? null,
    reply: t.reply,
    usage: t.usage,
    reportedCost: t.reportedCost ?? null,
    reasoningTokens: t.reasoningTokens ?? 0,
  };
}

const TURNS = Number(process.env.TURNS ?? 6);
// Smoke-test one model first: `ONLY=openai TURNS=3 npm run eval`. Default: all three.
const ONLY = process.env.ONLY as keyof typeof MODELS | undefined;

type ProviderKey = keyof typeof MODELS;
const ALL_KEYS = Object.keys(MODELS) as ProviderKey[];
const KEYS = ONLY ? ALL_KEYS.filter((k) => k === ONLY) : ALL_KEYS;

interface Agg {
  uncached: number;
  cachedRead: number;
  cacheWrite: number;
  output: number;
  /** Total distinct prompt (input) tokens = uncached + cachedRead + cacheWrite. */
  promptTokens: number;
  /** Actual input-side $ from pinned rates (what you paid for input, incl. writes). */
  inputCost: number;
  /** No-cache baseline: all prompt tokens at full input rate. */
  baselineInputCost: number;
  /** OpenRouter's reported real total cost across turns (USD). */
  reportedCost: number;
  /** Reasoning/thinking tokens used across turns — should be 0. */
  reasoningTokens: number;
}

function aggregate(turns: TurnResult[], rate: Rate): Agg {
  const a: Agg = { uncached: 0, cachedRead: 0, cacheWrite: 0, output: 0, promptTokens: 0, inputCost: 0, baselineInputCost: 0, reportedCost: 0, reasoningTokens: 0 };
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
    a.reportedCost += t.reportedCost ?? 0;
    a.reasoningTokens += t.reasoningTokens ?? 0;
  }
  return a;
}

const pct = (x: number) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`;
const usd = (x: number) => `$${x.toFixed(6)}`;

async function main() {
  console.log(`\nprompt-cache-economics — via OpenRouter — ${TURNS} turns/variant — pricing pinned ${PRICING_PINNED_DATE}`);
  console.log(ONLY ? `(single-model smoke test: ${ONLY})\n` : `(all ${KEYS.length} models)\n`);

  if (!process.env.OPENROUTER_API_KEY) {
    console.log('OPENROUTER_API_KEY not set — add it to .env. Aborting.');
    process.exit(1);
  }

  const report: any = { runAt: new Date().toISOString(), via: 'openrouter', turns: TURNS, pricingPinned: PRICING_PINNED_DATE, models: MODELS, providers: {} };

  for (const key of KEYS) {
    const rate = PRICING[key];
    let naive: TurnResult[], disciplined: TurnResult[];
    try {
      naive = await runSession(key, 'naive', TURNS);
      disciplined = await runSession(key, 'disciplined', TURNS);
    } catch (err) {
      console.log(`• ${key.padEnd(10)} ERROR — ${(err as Error).message}`);
      report.providers[key] = { error: (err as Error).message };
      continue;
    }

    const an = aggregate(naive, rate);
    const ad = aggregate(disciplined, rate);
    const baseline = an.baselineInputCost; // same prompt sizes; use naive's as the reference
    const naiveVsBase = (an.inputCost - baseline) / baseline;
    const discVsBase = (ad.inputCost - baseline) / baseline;
    const discHitRate = ad.cachedRead / (ad.promptTokens || 1);

    console.log(`\n■ ${key.toUpperCase()}  (${MODELS[key]})`);
    console.log(`   no-cache baseline input cost   ${usd(baseline)}  (pinned rates)`);
    console.log(`   NAIVE   input ${usd(an.inputCost)} (${pct(naiveVsBase)} vs base)  cachedRead=${an.cachedRead} write=${an.cacheWrite}  OR-cost ${usd(an.reportedCost)}`);
    console.log(`   DISCIPL input ${usd(ad.inputCost)} (${pct(discVsBase)} vs base)  hitRate=${(discHitRate * 100).toFixed(1)}%  OR-cost ${usd(ad.reportedCost)}`);
    if (an.inputCost > baseline) console.log(`   ⚠ NAIVE COSTS MORE THAN BASE — write premium paid every turn, ${an.cachedRead} reads collected`);
    const reasoning = an.reasoningTokens + ad.reasoningTokens;
    if (reasoning > 0) console.log(`   ⚠ reasoning tokens used: ${reasoning} (expected 0 — reasoning should be disabled)`);

    report.providers[key] = {
      model: MODELS[key],
      baselineInputCost: baseline,
      naive: { ...an, vsBaseline: naiveVsBase },
      disciplined: { ...ad, vsBaseline: discVsBase, hitRate: discHitRate },
      // Full per-turn transcripts (player action + real DM reply + usage + cost) so the
      // interactive playground and the animated explainer replay real data with no backend.
      turns: {
        naive: naive.map(serializeTurn),
        disciplined: disciplined.map(serializeTurn),
      },
    };
  }

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const resultsDir = join(__dirname, '..', 'results');
  const json = JSON.stringify(report, null, 2);

  // Timestamped archive — never clobbers a prior run, so every dataset is preserved.
  const archive = join(resultsDir, `run-${report.runAt.replace(/[:.]/g, '-')}.json`);
  writeFileSync(archive, json);
  console.log(`\nwrote ${archive}`);

  // Stable dataset the website/playground replays — only updated on a FULL run, so a
  // single-model smoke test never overwrites the canonical multi-model dataset.
  if (!ONLY) {
    const latest = join(resultsDir, 'latest.json');
    writeFileSync(latest, json);
    console.log(`updated ${latest}  (this is what the site replays — no need to re-run)`);
  } else {
    console.log(`(smoke test — left results/latest.json untouched)`);
  }
  console.log('');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
