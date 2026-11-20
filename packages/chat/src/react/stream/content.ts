import { useCallback, useMemo } from 'react';
import { ContentTypes } from 'librechat-data-provider';
import type {
  Text,
  TMessage,
  ImageFile,
  ContentPart,
  PartMetadata,
  ChatContentFrame,
  EventSubmission,
  TMessageContentParts,
} from 'librechat-data-provider';

type TUseContentHandler = {
  setMessages: (messages: TMessage[]) => void;
  getMessages: () => TMessage[] | undefined;
  /** Lets the host cache an image file a content frame carries. */
  onImageFile?: (file: ImageFile & PartMetadata) => void;
};

type TContentHandler = {
  data: ChatContentFrame;
  submission: EventSubmission;
};

/** Applies the Assistants stream's content frames to the response they belong to. */
export type ContentHandlers = {
  contentHandler: (event: TContentHandler) => void;
  /** Call after a sync so stale responses cannot overwrite the synced content. */
  resetContentHandler: () => void;
};

export function useContentHandler({
  setMessages,
  getMessages,
  onImageFile,
}: TUseContentHandler): ContentHandlers {
  const messageMap = useMemo(() => new Map<string, TMessage>(), []);

  /** Reset the message map - call this after sync to prevent stale state from overwriting synced content */
  const resetMessageMap = useCallback(() => {
    messageMap.clear();
  }, [messageMap]);

  const handler = useCallback(
    ({ data, submission }: TContentHandler) => {
      const { type, messageId, thread_id, conversationId, index } = data;
      const _messages = getMessages() ?? [];
      const messages: TMessage[] = [];
      let existingMessage: TMessage | undefined;
      for (const msg of _messages) {
        if (msg.messageId === messageId) {
          existingMessage ??= msg;
          continue;
        }
        messages.push(
          thread_id == null || msg.thread_id === thread_id ? msg : { ...msg, thread_id },
        );
      }
      const userMessage = messages[messages.length - 1] as TMessage | undefined;

      const { initialResponse } = submission;

      let response = messageMap.get(messageId);
      if (!response) {
        const responseBase = existingMessage ?? (initialResponse as TMessage);
        const responseThreadId =
          thread_id ?? responseBase.thread_id ?? (initialResponse as TMessage).thread_id;
        response = {
          ...responseBase,
          parentMessageId: userMessage?.messageId ?? '',
          conversationId,
          messageId,
          ...(responseThreadId != null ? { thread_id: responseThreadId } : {}),
        };
        messageMap.set(messageId, response);
      }

      // TODO: handle streaming for non-text
      /** A frame carries its part under its own type's key, e.g. `text` for a text frame. */
      const parts = data as Partial<Record<ContentTypes, Text | ContentPart | string>>;
      const textPart = parts[ContentTypes.TEXT];
      const part = (
        textPart != null && typeof textPart === 'string' ? { value: textPart } : parts[type]
      ) as ContentPart;

      if (type === ContentTypes.IMAGE_FILE) {
        onImageFile?.(part as ImageFile & PartMetadata);
      }

      /* spreading the content array to avoid mutation */
      response.content = [...(response.content ?? [])];

      response.content[index] = { type, [type]: part } as TMessageContentParts;

      const lastContentPart = response.content[response.content.length - 1];
      const initialContentPart = initialResponse.content?.[0];
      if (
        type !== ContentTypes.TEXT &&
        initialContentPart != null &&
        lastContentPart != null &&
        ((lastContentPart.type === ContentTypes.TOOL_CALL &&
          lastContentPart[ContentTypes.TOOL_CALL]?.progress === 1) ||
          lastContentPart.type === ContentTypes.IMAGE_FILE)
      ) {
        response.content.push(initialContentPart);
      }

      setMessages([...messages, response]);
    },
    [getMessages, messageMap, setMessages, onImageFile],
  );

  return { contentHandler: handler, resetContentHandler: resetMessageMap };
}
