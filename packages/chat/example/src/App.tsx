import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { v4 } from 'uuid';
import { Chat } from '@librechat/chat';
import { Button, Textarea } from '@librechat/client';
import { ContentTypes } from 'librechat-data-provider';
import { Part, Text } from '@librechat/chat/components';
import { MessageContext, MessagePartIndex, MessagePartsHostProvider } from '@librechat/chat/react';
import type { FormEvent, KeyboardEvent, ReactElement } from 'react';
import type { TMessage, TMessageContentParts } from 'librechat-data-provider';
import type { ChatState, ChatStatus, ChatTransport } from '@librechat/chat';
import type { PartRenderers } from '@librechat/chat/components';
import { createMemoryTransport } from './transport';
import { host } from './host';

const CONVERSATION_ID = 'example';

function createState(): ChatState {
  let messages: TMessage[] = [];
  return {
    status: 'ready',
    error: undefined,
    connection: 'idle',
    get messages() {
      return messages;
    },
    replaceMessages(next) {
      messages = next;
    },
  };
}

/** Builds each turn's request and its optimistic user message and reply placeholder. */
function createChat(transport: ChatTransport): Chat {
  return new Chat({
    id: CONVERSATION_ID,
    state: createState(),
    transport,
    prepareRequest({ input, messages }) {
      const text = input?.parts.map((part) => part.text).join('') ?? '';
      const parentMessageId = messages[messages.length - 1]?.messageId ?? null;
      const messageId = v4();
      const responseMessageId = v4();
      const base = { conversationId: CONVERSATION_ID };
      const user: TMessage = { ...base, messageId, parentMessageId, isCreatedByUser: true, text };
      const reply: TMessage = {
        ...base,
        messageId: responseMessageId,
        parentMessageId: messageId,
        isCreatedByUser: false,
        text: '',
        content: [],
      };
      return {
        payload: {
          ...base,
          text,
          messageId,
          parentMessageId,
          responseMessageId,
          isContinued: false,
          isTemporary: true,
        },
        messages: (current) => [...current, user, reply],
        responseMessageId,
      };
    },
  });
}

/** Reads the chat's messages and status, re-rendering on every change. */
function useChatSnapshot(chat: Chat): {
  messages: TMessage[];
  status: ChatStatus;
  error: Error | undefined;
} {
  const subscribe = useMemo(() => chat.subscribe.bind(chat), [chat]);
  const messages = useSyncExternalStore(subscribe, () => chat.messages);
  const status = useSyncExternalStore(subscribe, () => chat.status);
  const error = useSyncExternalStore(subscribe, () => chat.error);
  return { messages, status, error };
}

const textOf = (part: Extract<TMessageContentParts, { type: ContentTypes.TEXT }>): string =>
  typeof part.text === 'string' ? part.text : (part.text?.value ?? '');

const renderers: PartRenderers = {
  parts: {
    [ContentTypes.TEXT]: ({ part, showCursor, isCreatedByUser }) => (
      <Text text={textOf(part)} showCursor={showCursor} isCreatedByUser={isCreatedByUser} />
    ),
  },
  tools: {},
  defaultTool: () => null,
};

const partsOf = (message: TMessage): TMessageContentParts[] =>
  message.content?.length
    ? message.content
    : [{ type: ContentTypes.TEXT, text: message.text ?? '' }];

function Message({
  message,
  isLatest,
  isSubmitting,
}: {
  message: TMessage;
  isLatest: boolean;
  isSubmitting: boolean;
}): ReactElement {
  const context = useMemo(
    () => ({
      messageId: message.messageId,
      conversationId: message.conversationId,
      isExpanded: false,
      isLatestMessage: isLatest,
      isSubmitting: isLatest && isSubmitting,
    }),
    [message.messageId, message.conversationId, isLatest, isSubmitting],
  );
  const parts = partsOf(message);
  const author = message.isCreatedByUser ? 'You' : 'Assistant';
  return (
    <li aria-label={author} className="flex flex-col gap-1">
      <span className="text-text-secondary text-sm font-semibold">{author}</span>
      <MessageContext.Provider value={context}>
        {parts.map((part, index) => (
          <MessagePartIndex key={index} index={index}>
            <Part
              part={part}
              renderers={renderers}
              isLast={index === parts.length - 1}
              isSubmitting={context.isSubmitting}
              showCursor={context.isSubmitting}
              isCreatedByUser={message.isCreatedByUser}
            />
          </MessagePartIndex>
        ))}
      </MessageContext.Provider>
    </li>
  );
}

function Composer({ chat, disabled }: { chat: Chat; disabled: boolean }): ReactElement {
  const [text, setText] = useState('');
  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    const value = text.trim();
    if (!value || disabled) {
      return;
    }
    setText('');
    void chat.sendMessage({ parts: [{ type: 'text', text: value }] }).finally(() => {
      if (chat.error) {
        setText((current) => current || value);
      }
    });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      submit(event);
    }
  };
  return (
    <form onSubmit={submit} className="flex items-end gap-2">
      <label htmlFor="example-composer" className="sr-only">
        Message
      </label>
      <Textarea
        id="example-composer"
        value={text}
        rows={2}
        placeholder="Send a message"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <Button type="submit" disabled={disabled || !text.trim()}>
        Send
      </Button>
    </form>
  );
}

/** A complete chat built only from the package's public entries and a substitute transport. */
export function App({ transport }: { transport?: ChatTransport }): ReactElement | null {
  const [chat, setChat] = useState<Chat | null>(null);
  useEffect(() => {
    const next = createChat(transport ?? createMemoryTransport());
    setChat(next);
    return () => next.dispose();
  }, [transport]);
  return chat ? <ChatView chat={chat} /> : null;
}

function ChatView({ chat }: { chat: Chat }): ReactElement {
  const { messages, status, error } = useChatSnapshot(chat);
  const isSubmitting = status === 'submitted' || status === 'streaming';
  return (
    <MessagePartsHostProvider host={host}>
      <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-4 p-4">
        <h1 className="text-lg font-semibold">@librechat/chat example</h1>
        <ol aria-label="Messages" className="flex flex-1 flex-col gap-4">
          {messages.map((message, index) => (
            <Message
              key={message.messageId}
              message={message}
              isLatest={index === messages.length - 1}
              isSubmitting={isSubmitting}
            />
          ))}
        </ol>
        <p role="status" className="sr-only">
          {isSubmitting ? 'Generating' : ''}
        </p>
        {error ? (
          <p role="alert" className="text-text-destructive text-sm">
            {`The message was not sent: ${error.message}`}
          </p>
        ) : null}
        <Composer chat={chat} disabled={isSubmitting} />
      </main>
    </MessagePartsHostProvider>
  );
}
