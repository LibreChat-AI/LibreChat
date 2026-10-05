import type { TMessage } from 'librechat-data-provider';
import { filterPersistableAbortContent } from '~/stream/abortContent';

type ResponseClient = {
  responseMessageId?: string;
  contentParts?: unknown[];
  buildResponseMetadata?(): TMessage['metadata'];
};
type MessageContext = {
  userId: string;
  isTemporary?: boolean;
  expiredAt?: Date | string | null;
  interfaceConfig?: object;
};

/** A terminal error must retain images already emitted by the same invocation. */
export async function preserveNativeErrorResponse(
  {
    client,
    context,
    conversationId,
    userMessage,
    responseFields,
    errorText,
    saveMessage,
  }: {
    client?: ResponseClient | null;
    context: MessageContext;
    conversationId: string;
    userMessage?: Partial<TMessage> | null;
    responseFields: { sender?: string; endpoint?: string; model?: string; iconURL?: string };
    errorText: string;
    saveMessage(
      context: MessageContext,
      message: object,
      options: { context: string },
    ): Promise<unknown>;
  },
  fallback: () => Promise<void>,
): Promise<void> {
  const metadata = client?.buildResponseMetadata?.();
  const content = filterPersistableAbortContent(client?.contentParts);
  if (
    !metadata?.nativeSignatures ||
    !client?.responseMessageId ||
    !userMessage?.messageId ||
    !content.length
  ) {
    return fallback();
  }
  const options = { context: 'native response interrupted after emitted output' };
  if (userMessage.isCreatedByUser === true) {
    const parent = await saveMessage(
      context,
      { ...userMessage, conversationId, user: context.userId },
      options,
    );
    if (!parent) throw new Error('Native response parent could not be persisted.');
  }
  const response = await saveMessage(
    context,
    {
      ...responseFields,
      messageId: client.responseMessageId,
      parentMessageId: userMessage.messageId,
      conversationId,
      user: context.userId,
      content,
      metadata,
      text: errorText,
      error: true,
      unfinished: true,
      isCreatedByUser: false,
    },
    options,
  );
  if (!response) throw new Error('Received native response could not be persisted.');
}
