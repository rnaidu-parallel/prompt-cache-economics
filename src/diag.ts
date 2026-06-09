/** Diagnostic: dump the RAW OpenRouter usage object per provider, to find the exact cache fields.
 *  DIAG=anthropic|gemini|openai npm run diag   (sends 2 identical disciplined turns to warm cache) */
import 'dotenv/config';
import { buildPrompt } from './prompts.js';
import { TOOLS } from './domain.js';
import { MODELS, isAnthropic } from './pricing.js';
import type { Msg } from './prompts.js';

const key = (process.env.DIAG ?? 'anthropic') as keyof typeof MODELS;
const model = MODELS[key];
const anthropic = isAnthropic(model);
const tools = TOOLS.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));

function textBlock(text: string, cache = false) {
  return cache ? [{ type: 'text', text, cache_control: { type: 'ephemeral' } }] : text;
}

async function call(turnIndex: number, history: Msg[]) {
  const { system, messages } = buildPrompt('disciplined', turnIndex, history);
  const lastHist = messages.length - 2;
  const apiMessages = [
    { role: 'system', content: textBlock(system, anthropic) },
    ...messages.map((m, i) => ({ role: m.role, content: anthropic && i === lastHist ? textBlock(m.content, true) : m.content })),
  ];
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages: apiMessages, tools, tool_choice: 'none', max_tokens: 200, reasoning: { enabled: false }, usage: { include: true } }),
  });
  const data: any = await res.json();
  if (data.error) { console.log('ERROR', JSON.stringify(data.error)); return { id: null, reply: '' }; }
  console.log(`\n=== ${model} turn ${turnIndex} — raw usage ===`);
  console.log(JSON.stringify(data.usage, null, 2));
  const reply = data.choices?.[0]?.message?.content ?? '';
  // fetch generation metadata for native cache numbers + cost
  if (data.id) {
    await new Promise((r) => setTimeout(r, 800));
    const g = await fetch(`https://openrouter.ai/api/v1/generation?id=${data.id}`, { headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` } });
    if (g.ok) {
      const gd: any = await g.json();
      const d = gd.data ?? {};
      console.log('--- /generation:', JSON.stringify({ native_tokens_prompt: d.native_tokens_prompt, native_tokens_cached: d.native_tokens_cached, native_tokens_completion: d.native_tokens_completion, cache_discount: d.cache_discount, total_cost: d.total_cost }));
    }
  }
  return { id: data.id, reply };
}

const history: Msg[] = [];
const r0 = await call(0, history);
history.push(buildPrompt('disciplined', 0, []).messages.slice(-1)[0]!, { role: 'assistant', content: r0.reply });
await call(1, history);
