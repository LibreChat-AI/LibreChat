import { logger } from '@librechat/data-schemas';
import type { HookCallback } from '@librechat/agents';

/**
 * Graph supersteps a single tool-calling round costs: the tool node that runs the
 * batch, plus the model node that consumes its results. Derived from the agent
 * graph topology (`agentNode -> toolNode -> agentNode`), the same relationship the
 * `com_ui_agent_recursion_limit_info` copy describes to admins and that
 * `SUBAGENT_RECURSION_MULTIPLIER` encodes for child runs.
 */
const STEPS_PER_TOOL_ROUND = 2;

/**
 * Supersteps reserved for the final model call that answers without calling tools.
 * A turn that spends its last step on a tool node produces no answer at all, so the
 * budget must always hold one step back.
 */
const STEPS_RESERVED_FOR_FINAL_ANSWER = 1;

/**
 * Remaining-round count at or below which the model is told to start wrapping up.
 * Three rounds is enough runway to finish a partially gathered answer while being
 * late enough that a normal short turn never sees the notice at all.
 */
const WARN_AT_REMAINING_ROUNDS = 3;

/**
 * Upper bound on the tool-calling rounds still affordable after `roundsUsed` have
 * completed, leaving room for a final answer.
 *
 * An upper bound rather than an exact figure: summarization, handoff and multi-agent
 * routing nodes also consume supersteps but are invisible at the tool boundary, so
 * the real number can only be lower. The notice wording is hedged accordingly, because it
 * exists to convey urgency, and {@link isStepLimitError} still catches the wall.
 */
export function remainingToolRounds(recursionLimit: number, roundsUsed: number): number {
  const spent = roundsUsed * STEPS_PER_TOOL_ROUND + STEPS_RESERVED_FOR_FINAL_ANSWER;
  const affordable = Math.floor((recursionLimit - spent) / STEPS_PER_TOOL_ROUND);
  return Math.max(0, affordable);
}

/**
 * The context injected once the budget is nearly spent. Returned as
 * `additionalContext`, which the SDK consolidates into a single system-flavored
 * message placed immediately before the next model call, the last thing the model
 * reads before deciding whether to call another tool.
 *
 * Graph-state only: nothing here is persisted as message content, so the pressure
 * applies to this turn and does not accumulate across the conversation.
 */
export function buildBudgetNotice(remaining: number): string {
  if (remaining <= 0) {
    return [
      'System notice: this turn has no tool-calling budget left.',
      'Do not call any more tools; another tool call will be cut off before you can use its result.',
      'Write your final answer now from what you already have, and state briefly what remains unresolved.',
    ].join(' ');
  }
  const rounds =
    remaining === 1 ? '1 more tool-calling round' : `about ${remaining} more tool-calling rounds`;
  return [
    `System notice: this turn has ${rounds} left before it is cut off.`,
    'Stop broadening the search and start converging: use what you already have,',
    'make only calls you cannot finish without, and leave room to write the final answer.',
  ].join(' ');
}

export interface StepBudgetHookOptions {
  /** The resolved graph `recursionLimit` this run was invoked with. */
  recursionLimit: number;
}

/**
 * Builds the run-scoped `PostToolBatch` hook that keeps the model aware of its
 * per-turn step budget.
 *
 * Hitting `recursionLimit` mid-turn is recoverable but never good: the user waits
 * for a turn that ends without an answer. Models are poor at tracking how many
 * calls they have made, so the fix is to tell them, counting down over the last
 * few rounds rather than announcing a budget they will ignore while it is ample.
 *
 * Counts tool *rounds*, not tool calls: a parallel batch of six calls is one node
 * execution and costs one step, so per-call counting would overstate consumption
 * six-fold. Empty batches and subagent-scoped events are skipped so only a real
 * root tool round advances the countdown.
 */
export function createStepBudgetHook({
  recursionLimit,
}: StepBudgetHookOptions): HookCallback<'PostToolBatch'> {
  let roundsUsed = 0;

  return async (input) => {
    if (input.agentId != null || input.entries.length === 0) {
      return {};
    }
    roundsUsed += 1;
    const remaining = remainingToolRounds(recursionLimit, roundsUsed);
    if (remaining > WARN_AT_REMAINING_ROUNDS) {
      return {};
    }
    logger.debug(
      `[stepBudget] Tool round ${roundsUsed} of a ${recursionLimit}-step budget; ~${remaining} rounds left, nudging the model to converge.`,
    );
    return { additionalContext: buildBudgetNotice(remaining) };
  };
}
