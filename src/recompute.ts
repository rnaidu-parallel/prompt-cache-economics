/**
 * Rebuild the derived aggregates in results/latest.json from its raw per-turn token data, using the
 * current pinned rates and rollup logic. NO API calls — the per-turn tokens/replies are the ground
 * truth; this only re-derives costs and percentages. Run after a pricing or rollup-logic change.
 *
 *   npm run recompute
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PRICING, type MODELS } from './pricing.js';
import { buildProviderSummary } from './report.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const path = join(__dirname, '..', 'results', 'latest.json');
const r = JSON.parse(readFileSync(path, 'utf8'));

for (const key of Object.keys(r.providers) as (keyof typeof MODELS)[]) {
  const p = r.providers[key];
  if (p.error || !p.turns) continue;
  r.providers[key] = buildProviderSummary(p.model, p.turns.naive, p.turns.disciplined, PRICING[key]);
}
r.recomputedAt = new Date().toISOString();
writeFileSync(path, JSON.stringify(r, null, 2));
console.log(`recomputed aggregates in ${path} (no API calls)`);
