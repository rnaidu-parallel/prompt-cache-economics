/**
 * Anthropic runner. Caching is EXPLICIT — you mark cache breakpoints with cache_control.
 * A well-meaning dev opts in on BOTH variants; the difference is what they get back:
 *
 *   disciplined — stable prefix → the breakpoints READ (0.1x) every turn after the first.
 *   naive       — the system header mutates every turn → the prefix never matches, so every
 *                 turn is a cache WRITE (1.25x) with ZERO reads. This is the footgun: paying
 *                 the write premium forever, strictly MORE than not caching at all.
 *
 * Breakpoints (≤4): last tool, system, last history message (to extend the cache through
 * history). The current user turn is always uncached.
 *
 * Field shapes to verify at first run: usage.cache_creation_input_tokens /
 * cache_read_input_tokens / input_tokens; and that tool_choice {type:'none'} is accepted.
 */
import Anthropic from '@anthropic-ai/sdk';
import { buildPrompt, type Variant, type Msg } from '../prompts.js';
import { TOOLS } from '../domain.js';
import { MODELS } from '../pricing.js';
import type { TurnResult } from './types.js';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const tools = TOOLS.map((t, i) => ({
  name: t.name,
  description: t.description,
  input_schema: t.parameters as Anthropic.Tool.InputSchema,
  ...(i === TOOLS.length - 1 ? { cache_control: { type: 'ephemeral' as const } } : {}),
}));

export async function runSession(variant: Variant, turns: number): Promise<TurnResult[]> {
  const results: TurnResult[] = [];
  const history: Msg[] = [];

  for (let i = 0; i < turns; i++) {
    const { system, messages } = buildPrompt(variant, i, history);
    const lastHistoryIdx = messages.length - 2; // message just before the current turn

    const resp = await client.messages.create({
      model: MODELS.anthropic,
      max_tokens: 400,
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      tools,
      tool_choice: { type: 'none' },
      messages: messages.map((m, idx) =>
        idx === lastHistoryIdx
          ? { role: m.role, content: [{ type: 'text' as const, text: m.content, cache_control: { type: 'ephemeral' as const } }] }
          : { role: m.role, content: m.content },
      ),
    });

    const u = resp.usage;
    const reply = resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('') || '(the DM gestures for the party to continue)';

    results.push({
      turnIndex: i,
      reply,
      usage: {
        uncachedInput: u.input_tokens, // Anthropic input_tokens = post-breakpoint remainder
        cachedRead: u.cache_read_input_tokens ?? 0,
        cacheWrite: u.cache_creation_input_tokens ?? 0,
        writeTtl: '5m',
        outputTokens: u.output_tokens,
      },
    });

    history.push(messages[messages.length - 1]!, { role: 'assistant', content: reply });
  }

  return results;
}
