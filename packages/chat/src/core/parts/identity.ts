import { Constants } from 'librechat-data-provider';

/** The message a content renderer is showing, as far as its identity can be followed. */
export type RenderIdentityInput = {
  messageId: string;
  conversationId: string | null | undefined;
  /** Client-only parent anchor carried by one response while its server identities hydrate. */
  ownerId: string | undefined;
  isLatestMessage: boolean;
  isSubmitting: boolean;
  isCreatedByUser: boolean;
};

/** What a renderer instance last showed, and how many responses it has shown before it. */
export type RenderIdentity = Omit<RenderIdentityInput, 'isCreatedByUser'> & {
  /** Rises each time the instance moves to another response. */
  scope: number;
};

const fresh = (next: RenderIdentityInput, scope: number): RenderIdentity => ({
  messageId: next.messageId,
  conversationId: next.conversationId,
  ownerId: next.ownerId,
  isLatestMessage: next.isLatestMessage,
  isSubmitting: next.isSubmitting,
  scope,
});

/**
 * Follows one response through the ids it is known by. A streaming response changes `messageId`
 * twice, when the server creates it and when the saved message replaces it, and a list reuses one
 * renderer instance across siblings; state kept per response must survive the first and reset on
 * the second. While the response continues, `previous` is updated in place and returned;
 * otherwise a new identity with the next `scope` is.
 */
export function advanceRenderIdentity(
  previous: RenderIdentity | null,
  next: RenderIdentityInput,
): RenderIdentity {
  if (previous == null) {
    return fresh(next, 0);
  }
  const { messageId, conversationId, ownerId, isLatestMessage, isSubmitting } = next;
  /** The owner id follows one response through the local-user → created-user re-key and
   *  disappears when the durable response is installed. It is not unique across regenerations,
   *  so only an already-active latest response may use it to retain scope. */
  const startsAnotherRun = !previous.isSubmitting && isSubmitting;
  const continuesConversation =
    previous.conversationId === conversationId ||
    (previous.conversationId === Constants.NEW_CONVO &&
      conversationId != null &&
      conversationId !== Constants.NEW_CONVO);
  const exact =
    previous.messageId === messageId &&
    previous.conversationId === conversationId &&
    (previous.ownerId === ownerId || previous.ownerId == null || ownerId == null);
  const hydrates =
    !next.isCreatedByUser &&
    previous.isSubmitting &&
    previous.isLatestMessage &&
    isLatestMessage &&
    continuesConversation &&
    previous.ownerId != null;
  const created =
    hydrates && isSubmitting && previous.ownerId === ownerId && previous.messageId.endsWith('_');
  const durable =
    hydrates &&
    !isSubmitting &&
    (ownerId == null || ownerId === previous.ownerId) &&
    !messageId.endsWith('_');
  if (startsAnotherRun || !(exact || created || durable)) {
    return fresh(next, previous.scope + 1);
  }
  previous.messageId = messageId;
  previous.conversationId = conversationId;
  previous.ownerId = ownerId ?? previous.ownerId;
  previous.isLatestMessage = isLatestMessage;
  previous.isSubmitting = isSubmitting;
  return previous;
}
