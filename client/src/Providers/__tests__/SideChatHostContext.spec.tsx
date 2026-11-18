import React from 'react';
import { RecoilRoot } from 'recoil';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryKeys, EModelEndpoint } from 'librechat-data-provider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type {
  TFile,
  TMessage,
  ChatEvent,
  ChatStreamRequest,
  ChatTransportOptions,
} from 'librechat-data-provider';
import type { Transport } from '~/hooks/Chat/contract';
import { ChatTransportContext, defaultChatTransport } from '../ChatTransportContext';

const mockMessages = jest.fn();
jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      getMessagesByConvoId: (...args: unknown[]) => mockMessages(...args),
    },
  };
});

const mockStreamStatus = jest.fn();
jest.mock('~/data-provider/SSE/queries', () => ({
  ...jest.requireActual('~/data-provider/SSE/queries'),
  fetchStreamStatus: (...args: unknown[]) => mockStreamStatus(...args),
}));

const { appSideChatHost } = jest.requireActual('~/Providers/SideChatHostContext');

const conversation = { conversationId: 'side-conversation', endpoint: EModelEndpoint.agents };

const asked: TMessage = {
  messageId: 'user-1',
  conversationId: 'side-conversation',
  parentMessageId: '00000000-0000-0000-0000-000000000000',
  isCreatedByUser: true,
  text: 'Make a chart.',
} as TMessage;

/** The app's transport with a wire the test drives, and a start and stop it can see. */
function createTransport() {
  const attachments: Array<{ request: ChatStreamRequest; options: ChatTransportOptions }> = [];
  const start = jest.fn();
  const abort = jest.fn(async () => ({ success: true }));
  const transport: Transport = {
    ...defaultChatTransport,
    stream: () => ({
      send: () => undefined,
      reconnectToStream(request, options) {
        attachments.push({ request, options });
        return { closed: false };
      },
    }),
    start,
    abort,
  };
  return { transport, attachments, start, abort };
}

const setup = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const harness = createTransport();
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <RecoilRoot>
      <QueryClientProvider client={client}>
        <ChatTransportContext.Provider value={harness.transport}>
          {children}
        </ChatTransportContext.Provider>
      </QueryClientProvider>
    </RecoilRoot>
  );
  const view = renderHook(() => appSideChatHost.useChat(conversation), { wrapper });
  return { ...view, ...harness, client };
};

describe("the app's side chat host", () => {
  beforeEach(() => {
    mockMessages.mockReset();
    mockStreamStatus.mockReset();
  });

  it('reads the conversation through the ordinary messages route, as a list', async () => {
    mockStreamStatus.mockResolvedValue({ active: false });
    mockMessages.mockResolvedValue([asked]);

    const { result } = setup();

    await waitFor(() => expect(result.current.messages).toEqual([asked]));
    expect(mockMessages).toHaveBeenCalledWith('side-conversation');
    expect(result.current.hasEarlier).toBe(false);
  });

  it('puts what a tool hands back while it runs into the app, as main chat does', async () => {
    mockStreamStatus.mockResolvedValue({
      active: true,
      streamId: 'side-conversation',
      createdAt: 2000,
      generationProtocolVersion: 2,
    });
    mockMessages.mockResolvedValue([asked]);
    const { attachments, client } = setup();
    await waitFor(() => expect(attachments).toHaveLength(1));
    const emit = (event: ChatEvent) => act(() => attachments[0].options.onEvent(event));

    emit({ type: 'open' });
    emit({
      type: 'created',
      data: { created: true, message: asked, turn: { responseMessageId: 'response-1' } },
    } as ChatEvent);
    emit({
      type: 'attachment',
      data: {
        file_id: 'file-1',
        filename: 'chart.png',
        filepath: '/images/user/chart.png',
        type: 'image/png',
        messageId: 'response-1',
        toolCallId: 'call-1',
        conversationId: 'side-conversation',
      },
    } as unknown as ChatEvent);

    /** The app's own file list learns of it, which only the app's handler does. */
    await waitFor(() =>
      expect(client.getQueryData<TFile[]>([QueryKeys.files])).toEqual([
        expect.objectContaining({ file_id: 'file-1', filename: 'chart.png' }),
      ]),
    );
  });

  it('stops a generation through the app, by its conversation and the stream it names', async () => {
    mockStreamStatus.mockResolvedValue({
      active: true,
      streamId: 'side-conversation',
      createdAt: 2000,
      generationProtocolVersion: 2,
    });
    mockMessages.mockResolvedValue([asked]);
    const { result, attachments, abort } = setup();
    await waitFor(() => expect(attachments).toHaveLength(1));
    act(() => attachments[0].options.onEvent({ type: 'open' }));
    act(() =>
      attachments[0].options.onEvent({
        type: 'created',
        data: { created: true, message: asked, turn: { responseMessageId: 'response-1' } },
      } as ChatEvent),
    );
    await waitFor(() => expect(result.current.status).not.toBe('ready'));

    act(() => {
      void result.current.stop().catch(() => undefined);
    });

    await waitFor(() => expect(abort).toHaveBeenCalledTimes(1));
    expect(abort).toHaveBeenCalledWith({
      conversationId: 'side-conversation',
      streamId: 'side-conversation',
      generationCreatedAt: 2000,
    });
  });
});
