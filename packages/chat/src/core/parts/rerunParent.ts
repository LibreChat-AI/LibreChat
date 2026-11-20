import { findMessageById } from 'librechat-data-provider';
import type { TMessage } from 'librechat-data-provider';

/**
 * The user turn a rerun would replay, or `undefined` when the message has none.
 *
 * A rerun submits the edited message's parent as the turn's user message, so that
 * parent has to be in the thread and be the user's. Two imported shapes have
 * neither: a reply chained onto another reply, when the empty human message
 * between them was skipped, and a reply the importer left at the root, when the
 * skipped message was the first one. Restored or migrated conversations carry the
 * same shapes.
 *
 * Both editors resolve the parent through this call at render and again at submit,
 * so the action they offer and the submission they run cannot disagree. Unlike the
 * hover row, which also renders where no thread is loaded, an unresolved parent
 * here means absent rather than unknown: an editor only opens over the messages
 * view, where `getMessages` is the whole conversation.
 */
export const findRerunParent = (
  messages: (TMessage | undefined)[] | null | undefined,
  parentMessageId?: string | null,
): TMessage | undefined => {
  const parent = findMessageById(messages, parentMessageId);
  return parent?.isCreatedByUser === true ? parent : undefined;
};
