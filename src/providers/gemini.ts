/**
 * Gemini runner — IMPLICIT caching path (automatic, default-on for 2.5+, no markers, no
 * storage cost, 90% read discount). Apples-to-apples with OpenAI's automatic caching.
 *
 *   disciplined — stable prefix → implicit cache fires, cachedContentTokenCount > 0.
 *   naive       — mutating system header → prefix never matches → 0 cached. Like OpenAI,
 *                 implicit caching can't bill MORE than base; you just save nothing.
 *
 * The OTHER Gemini footgun — EXPLICIT `CachedContent` storage billed per token-hour — is a
 * separate mechanism; we model its break-even in pricing.ts and (TODO) add a focused demo.
 *
 * Field shapes to verify at first run: usageMetadata.cachedContentTokenCount /
 * promptTokenCount / candidatesTokenCount; and toolConfig mode 'NONE'.
 */
import { GoogleGenAI } from '@google/genai';
import { buildPrompt, type Variant, type Msg } from '../prompts.js';
import { TOOLS } from '../domain.js';
import { MODELS } from '../pricing.js';
import type { TurnResult } from './types.js';

const ai = new GoogleGenAI({ apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY });

const functionDeclarations = TOOLS.map((t) => ({
  name: t.name,
  description: t.description,
  parameters: t.parameters as unknown,
}));

function toContents(messages: Msg[]) {
  return messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
}

export async function runSession(variant: Variant, turns: number): Promise<TurnResult[]> {
  const results: TurnResult[] = [];
  const history: Msg[] = [];

  for (let i = 0; i < turns; i++) {
    const { system, messages } = buildPrompt(variant, i, history);

    const resp = await ai.models.generateContent({
      model: MODELS.gemini,
      contents: toContents(messages),
      config: {
        systemInstruction: system,
        tools: [{ functionDeclarations: functionDeclarations as any }],
        toolConfig: { functionCallingConfig: { mode: 'NONE' as any } },
        maxOutputTokens: 400,
      },
    });

    const u = resp.usageMetadata;
    const cachedRead = u?.cachedContentTokenCount ?? 0;
    const promptTokens = u?.promptTokenCount ?? 0;
    const reply = resp.text ?? '(the DM gestures for the party to continue)';

    results.push({
      turnIndex: i,
      reply,
      usage: {
        uncachedInput: promptTokens - cachedRead,
        cachedRead,
        cacheWrite: 0, // implicit caching: no write step, no write cost
        outputTokens: u?.candidatesTokenCount ?? 0,
      },
    });

    history.push(messages[messages.length - 1]!, { role: 'assistant', content: reply });
  }

  return results;
}
