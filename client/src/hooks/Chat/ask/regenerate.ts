import type { TMessage, TConversation } from 'librechat-data-provider';
import type { TAskFunction } from '~/common';

/** Builds `regenerate`: replays the user message a response answers, with its skills, quotes and reasoning. */
export const createRegenerate =
  (ask: TAskFunction, getMessages: (conversationId?: string | null) => TMessage[] | undefined) =>
  (
    message: Partial<Pick<TMessage, 'messageId' | 'parentMessageId' | 'isCreatedByUser'>>,
    options?: { addedConvo?: TConversation | null },
  ) => {
    const messages = getMessages();
    const parentMessageId =
      message.isCreatedByUser === true ? message.messageId : message.parentMessageId;
    const targetResponseMessageId =
      message.isCreatedByUser === true ? undefined : message.messageId;
    const parentMessage = messages?.find((element) => element.messageId == parentMessageId);

    if (parentMessage && parentMessage.isCreatedByUser) {
      ask(
        { ...parentMessage },
        {
          isRegenerate: true,
          addedConvo: options?.addedConvo ?? undefined,
          targetResponseMessageId,
          /** Carry the original user message's manual skill picks forward
           *  so the regenerated response is primed with the same skills.
           *  The compose-time atom was drained on the first submit; without
           *  this the model sees an unprimed turn even though the pills
           *  still show on the user bubble. */
          overrideManualSkills: parentMessage.manualSkills,
          /** Carry the original user message's quoted excerpts forward so the
           *  regenerated response is sent the same referenced context. */
          overrideQuotes: parentMessage.quotes,
          /** Replay the exact request-scoped reasoning selection used by this turn. */
          overrideReasoning: parentMessage.reasoningOverride ?? null,
        },
      );
    } else {
      console.error(
        'Failed to regenerate the message: parentMessage not found or not created by user.',
      );
    }
  };
