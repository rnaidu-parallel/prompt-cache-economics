/**
 * The independent variable: WHERE the volatile content goes.
 *
 * Both builders send the model the exact same information, layered by volatility:
 *   static prefix (character → rules → output format → world)
 *   + session-stable dynamic suffix (story-so-far + party state)
 *   + the running history
 *   + the in-world timestamp + the player's action.
 * The ONLY difference is placement of the per-turn timestamp:
 *
 *   naive       — the changing timestamp is glued to the TOP of the system prompt, above the
 *                 byte-stable layers. Every turn the prefix differs → the cache never hits.
 *   disciplined — the system prompt is the byte-stable static prefix + the session-stable suffix,
 *                 and nothing per-turn; the timestamp rides in a tail <context> wrapper on the
 *                 latest user message only. The whole prefix (tools → system → prior turns) is
 *                 reused every turn.
 *
 * Same tokens, same task, opposite cache behavior. That's the whole experiment.
 */

import { STATIC_PREFIX, buildDynamicSuffix, SESSION_STATE, PLAYER_TURNS, turnContext } from './domain.js';

/** The full byte-stable system prompt for a session: static prefix + session-stable suffix. */
const STABLE_SYSTEM = `${STATIC_PREFIX}\n\n${buildDynamicSuffix(SESSION_STATE)}`;

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
    // Footgun: a per-turn line pinned above the stable layers. Realistic mistake — people put
    // "the current time is ..." or session metadata at the very top of the system prompt.
    const system = `Session info — turn ${turnIndex + 1}, ${ctx}\n\n${STABLE_SYSTEM}`;
    const userTurn: Msg = { role: 'user', content: action };
    return { system, messages: [...history, userTurn] };
  }

  // Disciplined: system is byte-stable (static prefix + session-stable suffix); the timestamp
  // lives in the tail wrapper on the latest user message. Past messages are frozen as sent.
  const system = STABLE_SYSTEM;
  const userTurn: Msg = { role: 'user', content: `${ctx}\n\n${action}` };
  return { system, messages: [...history, userTurn] };
}
