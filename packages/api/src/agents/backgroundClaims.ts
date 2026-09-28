import type { AgentTriggerDeliveryMethods, MessageMethods } from '@librechat/data-schemas';
import { BACKGROUND_TOOL_COMPLETION_SOURCE } from './backgroundCompletionWakeup';

/** Reconciles manual polling with the independent automatic-delivery receipt,
 * including polls reconstructed after the process-local registry was lost. */
export async function claimBackgroundToolResult(
  methods: Pick<MessageMethods, 'claimBackgroundToolResults' | 'releaseBackgroundToolResultClaims'>,
  getReceiptClaim: AgentTriggerDeliveryMethods['getAgentBackgroundToolResultClaim'],
  input: Parameters<MessageMethods['claimBackgroundToolResults']>[0],
): ReturnType<MessageMethods['claimBackgroundToolResults']> {
  const lookup = (messageId: string) =>
    getReceiptClaim({
      sourceId: BACKGROUND_TOOL_COMPLETION_SOURCE,
      userId: input.userId,
      conversationId: input.conversationId,
      parentMessageId: messageId,
      taskId: input.taskId,
    });
  if (input.messageId != null) {
    const receiptClaim = await lookup(input.messageId);
    if (receiptClaim != null && receiptClaim.claimId !== input.claimId) {
      return { status: 'claimed', claim: receiptClaim, messageId: input.messageId };
    }
  }
  const messageClaim = await methods.claimBackgroundToolResults(input);
  if (messageClaim.status !== 'acquired') {
    return messageClaim;
  }
  const messageId = input.messageId ?? messageClaim.messageId;
  if (messageId == null) {
    throw new Error('The background result claim has no parent message identity');
  }
  const release = async () => {
    const released = await methods.releaseBackgroundToolResultClaims({
      userId: input.userId,
      conversationId: input.conversationId,
      messageId,
      taskIds: messageClaim.results.map((result) => result.taskId),
      kind: input.kind,
      claimId: input.claimId,
    });
    if (!released) {
      throw new Error('The background result claim could not be released');
    }
  };
  let receiptClaim: Awaited<ReturnType<typeof getReceiptClaim>>;
  try {
    receiptClaim = await lookup(messageId);
  } catch (error) {
    await release();
    throw error;
  }
  if (receiptClaim == null || receiptClaim.claimId === input.claimId) {
    return messageClaim;
  }
  await release();
  return { status: 'claimed', claim: receiptClaim, messageId };
}
