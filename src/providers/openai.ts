/**
 * OpenAI runner. Caching is AUTOMATIC and prefix-based — no markers. We just send a stable
 * prefix and read `usage.prompt_tokens_details.cached_tokens`. There is no cache-write cost,
 * so OpenAI can never bill MORE than base — a naive (mutating) prefix simply yields 0 cached.
 *
 * Field shapes to verify at first run: `usage.prompt_tokens_details.cached_tokens`.
 */
import OpenAI from 'openai';
import { buildPrompt, type Variant, type Msg } from '../prompts.js';
import { TOOLS } from '../domain.js';
import { MODELS } from '../pricing.js';
import type { TurnResult } from './types.js';

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const tools = TOOLS.map((t) => ({
  type: 'function' as const,
  function: { name: t.name, description: t.description, parameters: t.parameters },
}));

export async function runSession(variant: Variant, turns: number): Promise<TurnResult[]> {
  const results: TurnResult[] = [];
  const history: Msg[] = [];

  for (let i = 0; i < turns; i++) {
    const { system, messages } = buildPrompt(variant, i, history);

    const resp = await client.chat.completions.create({
      model: MODELS.openai,
      messages: [{ role: 'system', content: system }, ...messages.map((m) => ({ role: m.role, content: m.content }))],
      tools,
      tool_choice: 'none', // tools live in the cached prefix, but force narration
      max_completion_tokens: 400,
    });

    const u = resp.usage;
    const cachedRead = u?.prompt_tokens_details?.cached_tokens ?? 0;
    const promptTokens = u?.prompt_tokens ?? 0;
    const reply = resp.choices[0]?.message?.content ?? '(the DM gestures for the party to continue)';

    results.push({
      turnIndex: i,
      reply,
      usage: {
        uncachedInput: promptTokens - cachedRead,
        cachedRead,
        cacheWrite: 0, // OpenAI has no write step / no write cost
        outputTokens: u?.completion_tokens ?? 0,
      },
    });

    // Thread the real exchange into history so the prefix grows byte-stably.
    history.push(messages[messages.length - 1]!, { role: 'assistant', content: reply });
  }

  return results;
}
