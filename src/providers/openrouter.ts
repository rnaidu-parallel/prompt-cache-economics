/**
 * One runner for all three models, via OpenRouter (single key). We use plain fetch so we have
 * full control over OpenRouter's extensions: `usage:{include:true}` (returns real billed cost +
 * cached-token counts), `reasoning:{enabled:false}` (no thinking tokens), and per-message
 * `cache_control` breakpoints (required for Anthropic routes; auto/implicit for the rest).
 *
 * For each turn we read:
 *   - usage.prompt_tokens / completion_tokens
 *   - usage.prompt_tokens_details.cached_tokens          (cache reads)
 *   - usage.cache_creation_input_tokens                  (Anthropic writes, when present)
 *   - usage.cost                                         (OpenRouter's actual bill — ground truth)
 *   - usage.completion_tokens_details.reasoning_tokens   (should be 0)
 */
import { buildPrompt, type Variant, type Msg } from '../prompts.js';
import { TOOLS } from '../domain.js';
import { MODELS, isAnthropic } from '../pricing.js';
import type { TurnResult } from './types.js';

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

const tools = TOOLS.map((t) => ({
  type: 'function' as const,
  function: { name: t.name, description: t.description, parameters: t.parameters },
}));

type ModelKey = keyof typeof MODELS;

/** OpenAI-compat content with an optional Anthropic cache_control breakpoint. */
function textBlock(text: string, cache = false) {
  return cache ? [{ type: 'text', text, cache_control: { type: 'ephemeral' } }] : text;
}

export async function runSession(modelKey: ModelKey, variant: Variant, turns: number): Promise<TurnResult[]> {
  const model = MODELS[modelKey];
  const anthropic = isAnthropic(model);
  const results: TurnResult[] = [];
  const history: Msg[] = [];

  for (let i = 0; i < turns; i++) {
    const { system, messages } = buildPrompt(variant, i, history);
    const lastHistoryIdx = messages.length - 2; // message just before the current turn

    // System + last history message get cache_control breakpoints on Anthropic routes only.
    const apiMessages = [
      { role: 'system', content: textBlock(system, anthropic) },
      ...messages.map((m, idx) => ({
        role: m.role,
        content: anthropic && idx === lastHistoryIdx ? textBlock(m.content, true) : m.content,
      })),
    ];

    const body = {
      model,
      messages: apiMessages,
      tools,
      tool_choice: 'none',
      max_tokens: 400,
      reasoning: { enabled: false }, // no thinking tokens on any route
      usage: { include: true }, // ask OpenRouter for cost + cache accounting
    };

    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'X-Title': 'prompt-cache-economics',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(`${model} ${variant} turn ${i}: HTTP ${res.status} ${await res.text()}`);
    }
    const data: any = await res.json();
    if (data.error) throw new Error(`${model} ${variant} turn ${i}: ${JSON.stringify(data.error)}`);

    const u = data.usage ?? {};
    const cachedRead = u.prompt_tokens_details?.cached_tokens ?? 0;
    const cacheWrite = u.cache_creation_input_tokens ?? u.prompt_tokens_details?.cache_creation_tokens ?? 0;
    const promptTokens = u.prompt_tokens ?? 0;
    const reply = data.choices?.[0]?.message?.content ?? '(the DM gestures for the party to continue)';

    results.push({
      turnIndex: i,
      reply,
      reportedCost: typeof u.cost === 'number' ? u.cost : undefined,
      reasoningTokens: u.completion_tokens_details?.reasoning_tokens ?? 0,
      usage: {
        uncachedInput: Math.max(0, promptTokens - cachedRead - cacheWrite),
        cachedRead,
        cacheWrite,
        writeTtl: anthropic ? '5m' : undefined,
        outputTokens: u.completion_tokens ?? 0,
      },
    });

    history.push(messages[messages.length - 1]!, { role: 'assistant', content: reply });
  }

  return results;
}
