import { v4 } from 'uuid';
import { useQueryClient } from '@tanstack/react-query';
import { responseParentMessageId } from '@librechat/chat';
import { QueryKeys, ContentTypes, tMessageSchema } from 'librechat-data-provider';
import type {
  TMessage,
  TConversation,
  EventSubmission,
  TMessageContentParts,
} from 'librechat-data-provider';
import type { ConvoTitleState } from '~/utils/convos';
import type { TResData } from '~/common';
import {
  hasRealTitle,
  findConvoInAllQueries,
  findManualConvoTitleInAllQueries,
  preserveStreamedContentIdentity,
  isEmptyContentPart,
  getPartKeyIndex,
} from '~/utils';

const CONNECTION_ERROR_TEXT = 'Error connecting to server, try refreshing the page.';

/**
 * The parts the in-flight response has streamed so far: the transcript's tail (a user row there
 * means no response was placed), without the holes an interrupted stream leaves. Whether anything
 * streamed is judged without the slots that never received content (a comparison run's
 * `type: ''` placeholders, a text or think part opened before its first delta), but once something
 * did, those slots stay: a placeholder is what keeps a comparison lane's layout and attribution
 * when only the other lane produced output. The parts carry the render identity they streamed
 * under, as the final path stamps it, so the settled row does not remount.
 */
const getStreamedContent = (message?: TMessage): TMessageContentParts[] => {
  if (message == null || message.isCreatedByUser === true) {
    return [];
  }
  const streamed = message.content ?? [];
  const parts = streamed.filter((part): part is TMessageContentParts => part != null);
  if (!parts.some((part) => !isEmptyContentPart(part))) {
    return [];
  }
  return preserveStreamedContentIdentity(streamed, parts) ?? parts;
};

/** Keys the appended failure past every key the kept parts render under, physical or stamped. */
const appendErrorPart = (
  content: TMessageContentParts[],
  errorText: string,
): TMessageContentParts[] => {
  const keyIndex = content.reduce(
    (next, part, idx) => Math.max(next, getPartKeyIndex(part, idx) + 1),
    0,
  );
  const errorPart: TMessageContentParts = { type: ContentTypes.ERROR, error: errorText };
  return [
    ...content,
    keyIndex === content.length ? errorPart : { ...errorPart, streamedIndex: keyIndex },
  ];
};

/**
 * A failure that lands after the run has streamed keeps what streamed and takes the failure as
 * one more part, the way the server records a failure inside a run; one that lands before
 * anything streamed is the whole row.
 */
export const createErrorMessage = ({
  errorMetadata,
  getMessages,
  submission,
  error,
}: {
  getMessages: () => TMessage[] | undefined;
  errorMetadata?: Partial<TMessage>;
  submission: EventSubmission;
  error?: Error | unknown;
}): TMessage => {
  const currentMessages = getMessages();
  const latestMessage = currentMessages?.[currentMessages.length - 1];
  const text = submission.initialResponse.text.length > 45 ? submission.initialResponse.text : '';
  const errorText =
    (errorMetadata?.text || text || (error as Error | undefined)?.message) ??
    'Error cancelling request';
  const streamedContent = getStreamedContent(latestMessage);
  if (latestMessage?.conversationId && latestMessage.messageId && streamedContent.length > 0) {
    /** The row keeps the envelope it streamed under (author, model, icon, creation time) and
     *  takes from the failure only what describes the failure: a server payload names `System`
     *  as its sender and the schema dates a fresh envelope now, neither of which applies to a
     *  response that is merely gaining a part. */
    const errorMessage: TMessage = {
      ...latestMessage,
      ...(errorMetadata?.metadata != null
        ? { metadata: { ...latestMessage.metadata, ...errorMetadata.metadata } }
        : {}),
      error: undefined,
      text: '',
      content: appendErrorPart(streamedContent, errorText),
    };
    const parentMessageId = responseParentMessageId(
      submission.initialResponse,
      submission.userMessage,
      submission.isRegenerate,
    );
    if (parentMessageId && parentMessageId !== errorMessage.parentMessageId) {
      errorMessage.parentMessageId = parentMessageId;
    }
    return errorMessage;
  }
  if (errorMetadata) {
    return errorMetadata as TMessage;
  }
  return tMessageSchema.parse({
    ...submission,
    ...submission.initialResponse,
    text: errorText,
    unfinished: !!text.length,
    error: true,
  }) as TMessage;
};

export interface ErrorTurn {
  conversationId: string;
  errorResponse: TMessage;
  /** The conversation must be rebuilt: it never learned its id, the transport failed, or the
   *  server named a conversation the new-chat route has not navigated to. */
  recover: boolean;
}

/** Builds the row a failed turn leaves in the transcript and names the conversation it belongs to. */
type SettledErrorReadState = {
  lastResponseAt: string;
  lastResponseMessageId?: string;
  updatedAt?: string;
};

/**
 * A persisted terminal error still carries the server's winning reply stamp in its nested
 * conversation snapshot. Pairing the error messages cache object with that stamp before the list
 * update lets `useConversationSeen` acknowledge the reply the user just watched fail, instead of
 * leaving a dot on a conversation they are looking at.
 */
export const resolveSettledErrorReadState = ({
  data,
  submission,
  conversationId,
}: {
  data?: TResData;
  submission: EventSubmission;
  conversationId: string;
}): SettledErrorReadState | undefined => {
  if (submission.isTemporary === true || !data || !conversationId) {
    return undefined;
  }
  const settledConversation = data.conversation;
  const lastResponseAt = settledConversation?.lastResponseAt;
  if (typeof lastResponseAt !== 'string' || lastResponseAt.length === 0) {
    return undefined;
  }
  return {
    lastResponseAt,
    lastResponseMessageId:
      typeof settledConversation.lastResponseMessageId === 'string'
        ? settledConversation.lastResponseMessageId
        : undefined,
    updatedAt:
      typeof settledConversation.updatedAt === 'string' ? settledConversation.updatedAt : undefined,
  };
};

export const resolveErrorTurn = ({
  data,
  submission,
  getMessages,
  isNewConversationRoute,
}: {
  data?: TResData;
  submission: EventSubmission;
  getMessages: () => TMessage[] | undefined;
  isNewConversationRoute: boolean;
}): ErrorTurn => {
  const { userMessage, initialResponse } = submission;
  const parentMessageId = responseParentMessageId(
    initialResponse,
    userMessage,
    submission.isRegenerate,
  );
  const conversationId =
    userMessage.conversationId ?? submission.conversation?.conversationId ?? '';

  const parseErrorResponse = (payload: TResData | Partial<TMessage>): TMessage => {
    const metadata = payload['responseMessage'] ?? payload;
    const errorMessage: Partial<TMessage> = {
      ...initialResponse,
      ...metadata,
      error: true,
      parentMessageId,
    };

    if (errorMessage.messageId === undefined || errorMessage.messageId === '') {
      errorMessage.messageId = v4();
    }

    return tMessageSchema.parse(errorMessage) as TMessage;
  };
  const build = (errorMetadata: TMessage): TMessage =>
    createErrorMessage({ errorMetadata, getMessages, submission });

  if (!data) {
    const convoId = conversationId || `_${v4()}`;
    return {
      conversationId: convoId,
      recover: true,
      errorResponse: build(
        parseErrorResponse({ text: CONNECTION_ERROR_TEXT, ...submission, conversationId: convoId }),
      ),
    };
  }

  const receivedConvoId = data.conversationId ?? '';
  if (!conversationId && !receivedConvoId) {
    return {
      conversationId: `_${v4()}`,
      recover: true,
      errorResponse: build(parseErrorResponse(data)),
    };
  }
  if (!receivedConvoId) {
    return { conversationId, recover: false, errorResponse: build(parseErrorResponse(data)) };
  }
  return {
    conversationId: receivedConvoId,
    recover: isNewConversationRoute,
    errorResponse: build(
      tMessageSchema.parse({
        ...data,
        error: true,
        parentMessageId,
      }) as TMessage,
    ),
  };
};

export const getConvoTitle = ({
  queryClient,
  currentTitle,
  conversationId,
  titleSetByUser,
  titleRevision,
  authoritative = false,
}: {
  queryClient: ReturnType<typeof useQueryClient>;
  currentTitle?: string | null;
  conversationId?: string | null;
  titleSetByUser?: boolean;
  titleRevision?: number;
  authoritative?: boolean;
}): ConvoTitleState => {
  const incoming = { title: currentTitle ?? null, titleSetByUser, titleRevision };
  if (!conversationId) {
    return incoming;
  }
  const cached = queryClient.getQueryData<TConversation>([QueryKeys.conversation, conversationId]);
  const owned = findManualConvoTitleInAllQueries(queryClient, conversationId, incoming);
  const listed = owned ? undefined : findConvoInAllQueries(queryClient, conversationId);
  let selected = owned;
  if (!selected) {
    if (authoritative && hasRealTitle(incoming.title)) {
      selected = incoming;
    } else if (hasRealTitle(cached?.title)) {
      selected = cached;
    } else if (hasRealTitle(listed?.title)) {
      selected = listed;
    } else {
      selected = incoming;
    }
  }
  return {
    title: selected?.title ?? null,
    titleSetByUser: selected?.titleSetByUser,
    titleRevision: selected?.titleRevision,
  };
};
