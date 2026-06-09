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

Same tokens, same task, opposite cache behavior. Everything routes through **OpenRouter** (one key),
which reports the **real billed cost** and cached-token counts per call and passes Anthropic
`cache_control` breakpoints through. Models pinned: `openai/gpt-5.4`, `anthropic/claude-sonnet-4.6`,
`google/gemini-3-flash-preview` (reasoning disabled on all three).

## The punchline: same mistake, two different bills

A timestamp at the top of your system prompt — six turns of a dungeon-master session, measured
2026-06-09 via OpenRouter (real billed cost), reasoning disabled:

| Provider | Caching | Naive (timestamp in prefix) | Disciplined (timestamp in tail) |
|---|---|---|---|
| **OpenAI** (`gpt-5.4`) | automatic | **+0%** — 0% cache hit, you just save nothing | **−82%** input cost, ~92% hit |
| **Anthropic** (`claude-sonnet-4.6`) | explicit `cache_control` | **+25%** — a cache *write* every turn, 0 reads → **more than not caching at all** | **−67%** input cost, ~81% hit |

That's the whole point: the *same mistake* silently wastes the discount on OpenAI, and **actively costs
you 25% more** on Anthropic — because Anthropic charges a 1.25× premium to *write* the cache, and a
mutating prefix re-writes it every turn while never collecting a read.

The fix is one discipline, everywhere: **byte-stable static prefix, volatile content last.** Order the
request `tools → system → messages` — most stable first — because caching is a cumulative prefix and a
single changed token early invalidates everything after it.

(Gemini was dropped from the benchmark: its implicit caching didn't surface measurable cache hits through
OpenRouter. The mechanism — implicit reads + an explicit `CachedContent` storage cost — is real, but we
only publish numbers this repo reproduces.)

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
cp .env.example .env    # add OPENROUTER_API_KEY
npm run tokens          # sanity-check the static prefix clears every model's min-cache floor

ONLY=openai TURNS=3 npm run eval   # smoke-test one model first (cheap)
npm run eval                       # full run: 3 models × naive + disciplined, writes results/
```

## Run once, replay forever

The eval writes every player action, every real DM reply, and every usage/cost number to
`results/`. A full run updates `results/latest.json` — **that file is the dataset the website and the
interactive playground replay.** You run the benchmark once (or a couple of times to warm the cache),
commit the JSON, and the site serves real transcripts and real numbers with no backend and no
per-visit API cost. Re-running is only for refreshing the data, never for viewing it.

## Results

Latest run is committed at [`results/latest.json`](results/latest.json) (player actions, real DM replies,
per-turn token split, and OpenRouter's real billed cost — the dataset the site replays). Headline above;
per-turn arc in the JSON shows naive paying full price on a growing history while disciplined warms from
a cold first turn into 80–92% cache hits. Models + pricing pinned 2026-06-09.

## Notes

- Pricing is pinned and grounded against official pages on 2026-06-09 (see `src/pricing.ts`); it **drifts**,
  and OpenRouter reports the real billed cost per call as the ground truth at run time.
- Min-cache floors differ: gpt-5.4 1,024 · Sonnet 4.6 1,024 · Gemini 3 Flash 4,096. The world prompt is
  sized (~5k tokens) to clear all of them so the same prompt is cacheable everywhere.
- Reasoning is disabled on all three models (`reasoning: { enabled: false }`); the run flags any nonzero
  reasoning tokens.
- Caching is best-effort; a cold cache, an eviction, or routing drift can miss. Run twice to warm it.

MIT.
