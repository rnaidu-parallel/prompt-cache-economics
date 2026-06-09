# prompt-cache-economics

Prompt caching is a KV-cache trick with real GPU economics behind it. Used well, it cuts your
input bill by 80–90%. Used carelessly, it can cost you **more than not caching at all** — and the
way it bills you depends on the provider.

This repo is a small, reproducible benchmark that shows exactly that, on a toy dungeon-master agent.
One independent variable: **where the volatile content goes.**

## The experiment

A dungeon master has the perfect shape for caching: a big, byte-stable system prompt (world rules,
lore, tools — about 5k tokens here) and a tiny, changing payload each turn (the player's action and
the in-world time). We run the same six-turn session two ways:

- **naive** — the changing timestamp is glued to the **top** of the system prompt, above the stable
  lore. Every turn the prefix differs, so the cache never matches.
- **disciplined** — the system prompt is the stable lore and nothing else; the timestamp rides in a
  tail wrapper on the latest message. The whole prefix (`tools → system → prior turns`) is reused
  every turn.

Same tokens, same task, opposite cache behavior. We hit each provider's API **directly** and read its
**native** cache-usage fields, then convert to dollars with pinned rates.

## The punchline: same mistake, three different bills

| Provider | Caching | Cache read | A mutating prefix costs you… |
|---|---|---|---|
| **OpenAI** | automatic | 90% off | nothing saved — but never *more* (no write fee) |
| **Anthropic** | explicit `cache_control` | 0.1× | **more than base** — you pay the 1.25–2× *write* premium every turn and collect zero reads |
| **Gemini** | implicit + explicit | 90% off | implicit: nothing saved. explicit: **storage bleed** — billed per token-hour whether you reuse it or not |

The fix is one discipline, everywhere: **byte-stable static prefix, volatile content last.** Order the
request `tools → system → messages` — most stable first — because caching is a cumulative prefix and a
single changed token early invalidates everything after it.

## Why it works (the one-paragraph version)

A transformer builds a **KV cache** — the per-token key/value vectors attention needs — during *prefill*,
the compute-bound pass over your whole prompt. Caching persists that prefill state for a shared prefix, so
a later request with the identical prefix **skips the expensive recompute** and just reads stored KV. You
pay for memory, not math — hence ~10% of the input price. Change one early token and causality invalidates
the whole downstream cache, which is why a timestamp at the top of your system prompt gives you a 0% hit
rate even if 99% of the prompt is unchanged.

## Run it

```bash
npm install
cp .env.example .env   # add OPENAI_API_KEY, ANTHROPIC_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY
npm run tokens         # sanity-check the static prefix clears every provider's min-cache floor
npm run eval           # runs naive + disciplined across all three providers, writes results/
```

The benchmark needs all three keys for the full comparison; it skips any provider whose key is missing.

## Results

_Pending first run — numbers and the generated table land here, with model IDs and run date pinned._

## Notes

- Pricing is pinned (see `src/pricing.ts`) and **drifts** — re-verify against each provider's pricing
  page before trusting the dollar figures. The token counts come straight from the APIs and don't drift.
- Min-cache floors differ: OpenAI 1,024 · Gemini 2.5 2,048 · Anthropic Haiku 4.5 4,096. The world prompt
  is sized to clear all of them so the same prompt is cacheable everywhere.
- Caching is best-effort; a cold cache, an eviction, or routing drift can miss. Run twice to warm it.

MIT.
