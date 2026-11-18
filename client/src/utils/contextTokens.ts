import type { TConversation, TPreset } from 'librechat-data-provider';

type ModelSelection = Pick<Partial<TPreset>, 'endpoint' | 'model' | 'agent_id'>;

/**
 * After the first turn the server saves the model's resolved context budget as the
 * conversation's `maxContextTokens`, so it would be resent for any model the conversation later
 * switches to. When the deployment enables `resetMaxContextTokensOnModelSwitch`, a switch to a
 * different endpoint, model or agent drops it, and the next turn resolves the new model's budget.
 */
export function shouldResetMaxContextTokens({
  enabled,
  conversation,
  target,
}: {
  enabled?: boolean;
  conversation: TConversation | null;
  target: ModelSelection;
}): boolean {
  if (enabled !== true || conversation?.maxContextTokens == null) {
    return false;
  }
  if ((target.endpoint ?? null) !== (conversation.endpoint ?? null)) {
    return true;
  }
  if ((target.model ?? null) !== (conversation.model ?? null)) {
    return true;
  }
  return target.agent_id != null && target.agent_id !== conversation.agent_id;
}
