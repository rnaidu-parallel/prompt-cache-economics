/**
 * Sanity check: is the static world prefix big enough to be cacheable on ALL three providers?
 * The highest floor is Anthropic Haiku 4.5 at 4096 tokens. Real counts come from the eval's
 * usage fields; this is a rough ~chars/4 estimate just to catch an under-sized prefix early.
 *
 *   `npm run tokens`
 */
import { WORLD_PREFIX, TOOLS, PLAYER_TURNS } from './domain.js';
import { MIN_CACHE_TOKENS } from './pricing.js';

const chars = WORLD_PREFIX.length;
const words = WORLD_PREFIX.trim().split(/\s+/).length;
const estTokens = Math.round(chars / 4);
const toolsChars = JSON.stringify(TOOLS).length;
const estToolTokens = Math.round(toolsChars / 4);

console.log(`\nworld prefix:  ${chars} chars  ~${words} words  ~${estTokens} tokens (chars/4 estimate)`);
console.log(`tools:         ${toolsChars} chars  ~${estToolTokens} tokens`);
console.log(`avg player turn: ~${Math.round(PLAYER_TURNS.join(' ').length / PLAYER_TURNS.length / 4)} tokens\n`);

const highestFloor = Math.max(...Object.values(MIN_CACHE_TOKENS));
const prefixEst = estTokens + estToolTokens;
if (prefixEst < highestFloor) {
  console.log(`⚠ estimated prefix ~${prefixEst} tokens is BELOW the highest floor (${highestFloor}, Anthropic Haiku 4.5).`);
  console.log(`  Extend WORLD_PREFIX so it is cacheable everywhere, or pin a model with a lower floor.\n`);
  process.exit(1);
} else {
  console.log(`✓ estimated prefix ~${prefixEst} tokens clears all floors (highest ${highestFloor}). Verify exact counts at run.\n`);
}
