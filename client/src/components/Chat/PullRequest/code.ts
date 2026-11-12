import type { TConversation } from 'librechat-data-provider';

/**
 * Only a conversation that ran against an attached code workspace can have a pull request: the
 * workspace is what reports the branch. Everything else never asks, so ordinary chats cost no
 * lookups and show no pull request state at all.
 */
export function isCodeConversation(
  conversation: Pick<TConversation, 'codeEnvironmentMode' | 'codeWorkspaces'> | null | undefined,
): boolean {
  if (conversation == null) return false;
  return (
    conversation.codeEnvironmentMode === 'attached' ||
    (conversation.codeWorkspaces?.length ?? 0) > 0
  );
}
