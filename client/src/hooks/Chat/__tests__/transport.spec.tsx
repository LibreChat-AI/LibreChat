import React from 'react';
import { RecoilRoot } from 'recoil';
import { MemoryRouter } from 'react-router-dom';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ChatEvent, ChatTransportOptions, TSubmission } from 'librechat-data-provider';
import type { Transport } from '~/hooks/Chat/contract';
import { ChatTransportContext } from '~/Providers/ChatTransportContext';
import useResumableSSE from '~/hooks/SSE/useResumableSSE';
import store from '~/store';

jest.mock('~/hooks/AuthContext', () => ({
  useAuthContext: () => ({ token: 'test-token', isAuthenticated: true }),
}));

type StreamCall = { url: string; options: ChatTransportOptions };

/**
 * A transport that records every request and answers from the test, standing in for the
 * network at the contract boundary. `streams` holds each attachment so a test can push events.
 */
function createFakeTransport(overrides: Partial<Transport> = {}) {
  const streams: StreamCall[] = [];
  const sends: { server: string; options: ChatTransportOptions }[] = [];
  const transport: Transport = {
    stream: jest.fn(() => ({
      send: (request, options) => {
        sends.push({ server: request.server, options });
      },
      reconnectToStream: (request, options) => {
        streams.push({ url: request.url, options });
        return { closed: false };
      },
    })),
    start: jest.fn(async () => ({
      streamId: 'convo-1',
      conversationId: 'convo-1',
      generationCreatedAt: 1000,
      generationProtocolVersion: 2,
    })),
    abort: jest.fn(async () => ({ success: true })),
    abortRun: jest.fn(async () => new Response(null, { status: 204 })),
    steer: jest.fn(),
    cancelSteer: jest.fn(),
    armSteer: jest.fn(),
    listQueued: jest.fn(async () => []),
    enqueue: jest.fn(),
    cancelQueued: jest.fn(),
    ...overrides,
  };
  const emit = (event: ChatEvent) => streams[streams.length - 1].options.onEvent(event);
  return { transport, streams, sends, emit };
}

function createWrapper(transport: Transport) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>
          <RecoilRoot initializeState={({ set }) => set(store.queriesEnabled, false)}>
            <ChatTransportContext.Provider value={transport}>
              {children}
            </ChatTransportContext.Provider>
          </RecoilRoot>
        </QueryClientProvider>
      </MemoryRouter>
    );
  };
}

const buildSubmission = (endpoint = 'agents') =>
  ({
    conversation: { conversationId: 'convo-1', endpoint },
    userMessage: {
      messageId: 'msg-1',
      conversationId: 'convo-1',
      text: 'Hello',
      isCreatedByUser: true,
      sender: 'User',
      parentMessageId: '00000000-0000-0000-0000-000000000000',
    },
    messages: [],
    isTemporary: false,
    initialResponse: {
      messageId: 'resp-1',
      conversationId: 'convo-1',
      parentMessageId: 'msg-1',
      text: '',
      isCreatedByUser: false,
      sender: 'Assistant',
    },
    endpointOption: { endpoint },
  }) as unknown as TSubmission;

const buildChatHelpers = () => ({
  setMessages: jest.fn(),
  getMessages: jest.fn(() => []),
  setConversation: jest.fn(),
  setIsSubmitting: jest.fn(),
  newConversation: jest.fn(),
});

describe('chat transport boundary', () => {
  describe('send (agents)', () => {
    it('starts the turn and attaches to its stream through the host transport', async () => {
      const fake = createFakeTransport();
      const submission = buildSubmission();
      const helpers = buildChatHelpers();
      renderHook(() => useResumableSSE(submission, helpers), {
        wrapper: createWrapper(fake.transport),
      });

      await waitFor(() => expect(fake.streams).toHaveLength(1));
      expect(fake.transport.start).toHaveBeenCalledTimes(1);
      const [request, options] = (fake.transport.start as jest.Mock).mock.calls[0];
      expect(request.server).toBe('/api/agents/chat/agents');
      expect(request.payload).toEqual(expect.objectContaining({ text: 'Hello' }));
      expect(options.signal).toBeInstanceOf(AbortSignal);
      expect(fake.transport.stream).toHaveBeenCalledWith({ token: 'test-token' });
      expect(fake.streams[0].url).toContain('/api/agents/chat/stream/convo-1');
      expect(fake.streams[0].url).toContain('generationCreatedAt=1000');
    });

    it('reports a rejected start as an error message without attaching a stream', async () => {
      const failure = Object.assign(new Error('Bad request'), {
        response: { status: 400, data: { message: 'Bad request' }, headers: {} },
      });
      const fake = createFakeTransport({ start: jest.fn(async () => Promise.reject(failure)) });
      const submission = buildSubmission();
      const helpers = buildChatHelpers();
      renderHook(() => useResumableSSE(submission, helpers), {
        wrapper: createWrapper(fake.transport),
      });

      await waitFor(() => expect(helpers.setIsSubmitting).toHaveBeenCalledWith(false));
      expect(fake.transport.start).toHaveBeenCalledTimes(1);
      expect(fake.streams).toHaveLength(0);
      const written = helpers.setMessages.mock.calls.flatMap(([messages]) => messages);
      expect(written.some((message: { error?: boolean }) => message.error === true)).toBe(true);
    });
  });
});
