import type { TurnUsage } from '../pricing.js';
import type { Variant } from '../prompts.js';

export interface TurnResult {
  turnIndex: number;
  usage: TurnUsage;
  /** The model's reply text, threaded back into history for the next turn. */
  reply: string;
  /** OpenRouter's reported real billed cost for this call (USD), if available. */
  reportedCost?: number;
  /** Reasoning/thinking tokens the model used this turn — should be 0 (reasoning disabled). */
  reasoningTokens?: number;
}
