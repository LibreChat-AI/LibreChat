/**
 * @jest-environment jsdom
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Chat } from '@librechat/chat';
import { createInstance } from 'i18next';
import { ContentTypes } from 'librechat-data-provider';
import { Part, Text } from '@librechat/chat/components';
import { initReactI18next, I18nextProvider } from 'react-i18next';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { Button, Textarea, ThemeProvider, clickHouseTheme } from '@librechat/client';
import { MessageContext, MessagePartIndex, MessagePartsHostProvider } from '@librechat/chat/react';
import type { ChatEvent, TMessage, TMessageContentParts } from 'librechat-data-provider';
import type { ChatState, ChatStream, ChatTransport } from '@librechat/chat';
import type { PartRenderers } from '@librechat/chat/components';
import type { MessagePartsHost } from '@librechat/chat/react';
import type { ReactElement } from 'react';

/**
 * An outside consumer of the package: it reaches LibreChat's chat only through the published
 * entries (`@librechat/chat`, `/react`, `/components`) and the `@librechat/client` theme, with an
 * in-memory transport in place of a server. It grows as the session, message list and composer
 * move into the package.
 */

/** A stream the test feeds frame by frame. */
function createStream(): ChatStream & { push(event: ChatEvent): void } {
  const queued: ChatEvent[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  return {
    push(event) {
      queued.push(event);
      wake?.();
    },
    close() {
      closed = true;
      wake?.();
    },
    async *[Symbol.asyncIterator]() {
      while (true) {
        while (queued.length > 0) {
          yield queued.shift() as ChatEvent;
        }
        if (closed) {
          return;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
  };
}

/** Serves each turn from a stream the test drives. */
function createMemoryTransport(): ChatTransport & { stream?: ReturnType<typeof createStream> } {
  const transport: ChatTransport & { stream?: ReturnType<typeof createStream> } = {
    async sendMessages() {
      transport.stream = createStream();
      return { status: 'stream', stream: transport.stream };
    },
    async reconnectToStream() {
      return null;
    },
    async abort() {
      return { success: true };
    },
  };
  return transport;
}

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

let ids = 0;

/** The consumer's own turn building: the request plus its optimistic user message and reply. */
function createChat(transport: ChatTransport): Chat {
  return new Chat({
    id: 'convo',
    state: createState(),
    transport,
    prepareRequest({ input, messages }) {
      const text = input?.parts.map((part) => part.text).join('') ?? '';
      const parentMessageId = messages[messages.length - 1]?.messageId ?? null;
      const messageId = `user-${++ids}`;
      const responseMessageId = `reply-${ids}`;
      const base = { conversationId: 'convo' };
      const user: TMessage = { ...base, messageId, parentMessageId, isCreatedByUser: true, text };
      const reply: TMessage = {
        ...base,
        messageId: responseMessageId,
        parentMessageId: messageId,
        isCreatedByUser: false,
        text: '',
      };
      return {
        payload: {
          ...base,
          text,
          messageId,
          parentMessageId,
          isContinued: false,
          isTemporary: true,
        },
        messages: (current) => [...current, user, reply],
        responseMessageId,
      };
    },
    /** Cumulative `text` frames fill the reply as it streams; the `final` frame settles it. */
    applyEvent(event, context) {
      if (event.type === 'text') {
        const text = event.data.text ?? event.data.response ?? '';
        context.write(
          context.messages.map((message) =>
            message.messageId === event.data.messageId ? { ...message, text } : message,
          ),
        );
      }
      const response = event.type === 'final' ? event.data.responseMessage : undefined;
      if (response) {
        context.write(
          context.messages.map((message) =>
            message.messageId === response.messageId ? { ...message, ...response } : message,
          ),
        );
      }
    },
  });
}

const host: MessagePartsHost = {
  useMessage: () => ({ messageId: '' }),
  renderMarkdown: ({ content }) => <p>{content}</p>,
  useSmoothStreaming: () => false,
  useAgent: () => undefined,
  renderAgentIcon: () => null,
  useFontSize: () => 'text-base',
  useShowThinking: () => false,
  useAutoExpandTools: () => false,
  useLaTeXParsing: () => false,
  useChatDirection: () => 'auto',
  useUserTextPreferences: () => ({
    enableUserMsgMarkdown: false,
    collapseLongUserMessages: false,
    usernameDisplay: false,
  }),
  useUser: () => undefined,
  useFileMap: () => undefined,
  useToast: () => () => undefined,
  useSandboxStarting: () => false,
  useToolArtifactClaim: () => [null, () => undefined],
  useSteerEscalating: () => false,
  usePaneConversationId: () => null,
  useLiveAppliedSteer: () => [false, () => undefined],
};

const renderers: PartRenderers = {
  parts: {
    [ContentTypes.TEXT]: ({ part, showCursor, isCreatedByUser }) => (
      <Text
        text={typeof part.text === 'string' ? part.text : (part.text?.value ?? '')}
        showCursor={showCursor}
        isCreatedByUser={isCreatedByUser}
      />
    ),
  },
  tools: {},
  defaultTool: () => null,
};

const partsOf = (message: TMessage): TMessageContentParts[] =>
  message.content?.length
    ? message.content
    : [{ type: ContentTypes.TEXT, text: message.text ?? '' }];

function ChatView({ chat }: { chat: Chat }): ReactElement {
  const subscribe = useMemo(() => chat.subscribe.bind(chat), [chat]);
  const messages = useSyncExternalStore(subscribe, () => chat.messages);
  const status = useSyncExternalStore(subscribe, () => chat.status);
  const [text, setText] = useState('');
  const send = () => {
    setText('');
    void chat.sendMessage({ parts: [{ type: 'text', text }] });
  };
  return (
    <MessagePartsHostProvider host={host}>
      <ol aria-label="Messages">
        {messages.map((message) => (
          <li key={message.messageId} aria-label={message.isCreatedByUser ? 'You' : 'Assistant'}>
            <MessageContext.Provider value={{ messageId: message.messageId, isExpanded: false }}>
              {partsOf(message).map((part, index) => (
                <MessagePartIndex key={index} index={index}>
                  <Part
                    part={part}
                    renderers={renderers}
                    isSubmitting={status !== 'ready'}
                    showCursor={false}
                    isCreatedByUser={message.isCreatedByUser}
                  />
                </MessagePartIndex>
              ))}
            </MessageContext.Provider>
          </li>
        ))}
      </ol>
      <p role="status">{status}</p>
      <label htmlFor="composer">Message</label>
      <Textarea id="composer" value={text} onChange={(event) => setText(event.target.value)} />
      <Button type="button" onClick={send}>
        Send
      </Button>
    </MessagePartsHostProvider>
  );
}

function Consumer({ transport }: { transport: ChatTransport }): ReactElement | null {
  const [chat, setChat] = useState<Chat | null>(null);
  useEffect(() => {
    const next = createChat(transport);
    setChat(next);
    return () => next.dispose();
  }, [transport]);
  return chat ? <ChatView chat={chat} /> : null;
}

const i18n = createInstance();
void i18n.use(initReactI18next).init({ lng: 'en', resources: { en: { translation: {} } } });

const renderConsumer = (transport: ChatTransport) =>
  render(
    <I18nextProvider i18n={i18n}>
      <ThemeProvider themeDefinition={clickHouseTheme} persistThemeDefinition={false}>
        <Consumer transport={transport} />
      </ThemeProvider>
    </I18nextProvider>,
  );

describe('a consumer built on the public entries', () => {
  it('sends a turn and streams the reply into the message list', async () => {
    const transport = createMemoryTransport();
    renderConsumer(transport);

    fireEvent.change(await screen.findByLabelText('Message'), { target: { value: 'Hi' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    const list = await screen.findByRole('list', { name: 'Messages' });
    expect(await within(list).findByRole('listitem', { name: 'You' })).toHaveTextContent('Hi');

    await act(async () => {
      transport.stream?.push({ type: 'open' });
      transport.stream?.push({
        type: 'text',
        data: { message: true, text: 'Hel', messageId: 'reply-1' },
      });
    });
    const reply = within(list).getByRole('listitem', { name: 'Assistant' });
    expect(reply).toHaveTextContent('Hel');
    expect(screen.getByRole('status')).toHaveTextContent('streaming');

    await act(async () => {
      transport.stream?.push({
        type: 'text',
        data: { message: true, text: 'Hello there', messageId: 'reply-1' },
      });
    });
    expect(reply).toHaveTextContent('Hello there');

    await act(async () => {
      transport.stream?.push({
        type: 'final',
        data: {
          final: true,
          responseMessage: {
            messageId: 'reply-1',
            parentMessageId: 'user-1',
            conversationId: 'convo',
            isCreatedByUser: false,
            text: 'Hello there.',
          },
        },
      });
      transport.stream?.close();
    });
    expect(await within(list).findByText('Hello there.')).toBeInTheDocument();
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(await screen.findByText('ready')).toBeInTheDocument();
    expect(document.documentElement.style.getPropertyValue('--theme-mono-font-family')).toContain(
      'Inconsolata',
    );
  });
});
