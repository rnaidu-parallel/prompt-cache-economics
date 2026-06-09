/**
 * The independent variable: WHERE the volatile content goes.
 *
 * Both builders send the model the exact same information — the world prefix, the running
 * history, the in-world timestamp, and the player's action. The ONLY difference is placement:
 *
 *   naive       — the changing timestamp is glued to the TOP of the system prompt, above the
 *                 byte-stable world lore. Every turn the prefix differs → the cache never hits.
 *   disciplined — the system prompt is the byte-stable world lore and nothing else; the
 *                 timestamp rides in a tail <context> wrapper on the latest user message only.
 *                 The whole prefix (tools → system → prior turns) is reused every turn.
 *
 * Same tokens, same task, opposite cache behavior. That's the whole experiment.
 */

import { WORLD_PREFIX, PLAYER_TURNS, turnContext } from './domain.js';

export interface Msg {
  role: 'user' | 'assistant';
  content: string;
}

export interface BuiltPrompt {
  /** System prompt. Stable across turns for `disciplined`, mutating for `naive`. */
  system: string;
  /** Full message array including the current user turn as the last element. */
  messages: Msg[];
}

export type Variant = 'naive' | 'disciplined';

/**
 * Build the request for a given turn.
 * @param history prior turns (real user actions + the model's real replies), byte-stable.
 */
export function buildPrompt(variant: Variant, turnIndex: number, history: Msg[]): BuiltPrompt {
  const action = PLAYER_TURNS[turnIndex] ?? '(the party waits)';
  const ctx = turnContext(turnIndex);

  if (variant === 'naive') {
    // Footgun: a per-turn line pinned above the stable lore. Realistic mistake — people put
    // "the current time is ..." or session metadata at the very top of the system prompt.
    const system = `Session info — turn ${turnIndex + 1}, ${ctx}\n\n${WORLD_PREFIX}`;
    const userTurn: Msg = { role: 'user', content: action };
    return { system, messages: [...history, userTurn] };
  }

  // Disciplined: system is byte-stable; the timestamp lives in the tail wrapper on the
  // latest user message. Past messages are frozen exactly as they were sent.
  const system = WORLD_PREFIX;
  const userTurn: Msg = { role: 'user', content: `${ctx}\n\n${action}` };
  return { system, messages: [...history, userTurn] };
}
