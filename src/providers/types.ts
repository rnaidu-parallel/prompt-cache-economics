import type { TurnUsage } from '../pricing.js';
import type { Variant } from '../prompts.js';

export interface TurnResult {
  turnIndex: number;
  usage: TurnUsage;
  /** The model's reply text, threaded back into history for the next turn. */
  reply: string;
}

export type RunSession = (variant: Variant, turns: number) => Promise<TurnResult[]>;

/** Force narration (no tool calls) so history stays clean text, while tool defs still sit in
 *  the cacheable prefix. Each provider maps this to its own tool_choice = none. */
export const FORCE_NO_TOOLS = true;
