import { Constants, fromUIMessage } from 'librechat-data-provider';
import type { TMessage, UIMessage } from 'librechat-data-provider';

/** Ids on the active branch: the contract's tail and its ancestors. */
const getActiveBranch = (byId: Map<string, TMessage>, tailId: string | undefined) => {
  const branch = new Set<string>();
  let id: string | null | undefined = tailId;
  while (id != null && !branch.has(id)) {
    branch.add(id);
    id = byId.get(id)?.parentMessageId;
  }
  return branch;
};

/**
 * The stored messages `next` writes back over `current`, keeping the stored fields the UI view
 * omits. A message with no stored counterpart joins the chat under the message before it, or
 * under the active branch's tail when the message before it is on another branch, unless its
 * metadata names a parent. A message keeps the conversation it is stored under.
 */
export const toStoredMessages = (
  next: UIMessage[],
  current: TMessage[],
  latestMessageId: string | undefined,
  chatId: string | undefined,
): TMessage[] => {
  const byId = new Map(current.map((message) => [message.messageId, message]));
  const branch = getActiveBranch(byId, latestMessageId);
  const conversationId = chatId === Constants.NEW_CONVO ? null : (chatId ?? null);
  let previous: { id: string; joined: boolean } | null = null;
  return next.map((view) => {
    const base = byId.get(view.id);
    const message = fromUIMessage(view, base);
    message.conversationId = base ? base.conversationId : conversationId;
    if (!base && view.metadata?.parentMessageId === undefined) {
      message.parentMessageId =
        previous == null || previous.joined ? (previous?.id ?? null) : (latestMessageId ?? null);
    }
    previous = { id: message.messageId, joined: !base || branch.has(message.messageId) };
    return message;
  });
};
