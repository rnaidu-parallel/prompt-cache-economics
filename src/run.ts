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
import { PRICING, MODELS, PRICING_PINNED_DATE } from './pricing.js';
import { PLAYER_TURNS, setRunSeed } from './domain.js';
import type { TurnResult } from './providers/types.js';
import { runSession } from './providers/openrouter.js';
import { buildProviderSummary } from './report.js';

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

const pct = (x: number) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`;
const usd = (x: number) => `$${x.toFixed(6)}`;

async function main() {
  console.log(`\nprompt-cache-economics — via OpenRouter — ${TURNS} turns/variant — pricing pinned ${PRICING_PINNED_DATE}`);
  console.log(ONLY ? `(single-model smoke test: ${ONLY})\n` : `(all ${KEYS.length} models)\n`);

  if (!process.env.OPENROUTER_API_KEY) {
    console.log('OPENROUTER_API_KEY not set — add it to .env. Aborting.');
    process.exit(1);
  }
  setRunSeed(Date.now()); // run-unique timestamps so `naive` is an honest cold cache each run

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

    // Full per-turn transcripts (player action + real DM reply + usage + cost) feed the rollup;
    // each variant is compared to ITS OWN no-cache baseline, plus a direct naive→disciplined number.
    const summary = buildProviderSummary(MODELS[key], naive.map(serializeTurn), disciplined.map(serializeTurn), rate);
    const { naive: an, disciplined: ad, disciplinedVsNaive } = summary;

    console.log(`\n■ ${key.toUpperCase()}  (${MODELS[key]})`);
    console.log(`   NAIVE   input ${usd(an.inputCost)} (${pct(an.vsBaseline)} vs its no-cache baseline)  cachedRead=${an.cachedRead} write=${an.cacheWrite}  OR ${usd(an.reportedCost)}`);
    console.log(`   DISCIPL input ${usd(ad.inputCost)} (${pct(ad.vsBaseline)} vs its baseline · ${(disciplinedVsNaive * 100).toFixed(1)}% cheaper than naive)  hit ${(ad.hitRate * 100).toFixed(1)}%  OR ${usd(ad.reportedCost)}`);
    if (an.inputCost > an.baselineInputCost) console.log(`   ⚠ NAIVE COSTS MORE THAN BASE — write premium paid every turn, ${an.cachedRead} reads collected`);
    const reasoning = an.reasoningTokens + ad.reasoningTokens;
    if (reasoning > 0) console.log(`   ⚠ reasoning tokens used: ${reasoning} (expected 0 — reasoning should be disabled)`);

    report.providers[key] = summary;
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
