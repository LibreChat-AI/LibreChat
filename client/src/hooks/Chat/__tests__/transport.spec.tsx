import React from 'react';
import { RecoilRoot } from 'recoil';
import { MemoryRouter } from 'react-router-dom';
import { QueryKeys } from 'librechat-data-provider';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type {
  ChatEvent,
  TSubmission,
  TConversation,
  ChatTransportOptions,
  ChatTransportRequest,
} from 'librechat-data-provider';
import type { Transport } from '~/hooks/Chat/contract';
import { ChatTransportContext } from '~/Providers/ChatTransportContext';
import useResumableSSE from '~/hooks/SSE/useResumableSSE';
import useChatHelpers from '~/hooks/Chat/useChatHelpers';
import useSSE from '~/hooks/SSE/useSSE';
import store from '~/store';

jest.mock('~/hooks/AuthContext', () => {
  const { createContext } = jest.requireActual('react');
  return {
    AuthContext: createContext(undefined),
    useAuthContext: () => ({ token: 'test-token', isAuthenticated: true }),
  };
});

type StreamCall = { url: string; options: ChatTransportOptions };

/**
 * A transport that records every request and answers from the test, standing in for the
 * network at the contract boundary. `streams` holds each attachment so a test can push events.
 */
function createFakeTransport(overrides: Partial<Transport> = {}) {
  const streams: StreamCall[] = [];
  const sends: (ChatTransportRequest & { options: ChatTransportOptions })[] = [];
  const transport: Transport = {
    stream: jest.fn(() => ({
      send: (request, options) => {
        sends.push({ ...request, options });
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

type SeedState = Parameters<
  NonNullable<React.ComponentProps<typeof RecoilRoot>['initializeState']>
>[0];

function createWrapper(transport: Transport, seed?: (state: SeedState) => void) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  /** The composer's user-key check is not gated by `queriesEnabled`; answer it from cache. */
  queryClient.setQueryData([QueryKeys.name, 'agents'], { expiresAt: '' });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>
          <RecoilRoot
            initializeState={(state) => {
              state.set(store.queriesEnabled, false);
              seed?.(state);
            }}
          >
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

  describe('send (assistants)', () => {
    it('streams the turn through the host transport and closes it on unmount', () => {
      const fake = createFakeTransport();
      const submission = buildSubmission('assistants');
      const helpers = buildChatHelpers();
      const { unmount } = renderHook(() => useSSE(submission, helpers), {
        wrapper: createWrapper(fake.transport),
      });

      expect(fake.transport.stream).toHaveBeenCalledWith({ token: 'test-token' });
      expect(fake.sends).toHaveLength(1);
      expect(fake.sends[0].server).toBe('/api/assistants/v2/chat');
      expect(fake.sends[0].payload).toEqual(expect.objectContaining({ text: 'Hello' }));
      expect(helpers.setIsSubmitting).toHaveBeenCalledWith(true);

      const { signal } = fake.sends[0].options;
      expect(signal.aborted).toBe(false);
      unmount();
      expect(signal.aborted).toBe(true);
    });

    it('writes a stream error from the transport as an error message', () => {
      const fake = createFakeTransport();
      const submission = buildSubmission('assistants');
      const helpers = buildChatHelpers();
      renderHook(() => useSSE(submission, helpers), { wrapper: createWrapper(fake.transport) });

      act(() => fake.sends[0].options.onEvent({ type: 'error', data: undefined }));

      expect(helpers.setIsSubmitting).toHaveBeenLastCalledWith(false);
      const written = helpers.setMessages.mock.calls.flatMap(([messages]) => messages);
      expect(written.some((message: { error?: boolean }) => message.error === true)).toBe(true);
    });
  });

  describe('abort', () => {
    const seedRun = ({ set }: SeedState) => {
      set(store.conversationByIndex(0), {
        conversationId: 'convo-1',
        endpoint: 'agents',
      } as TConversation);
      set(store.activeGenerationCreatedAtByConvoId('convo-1'), 1000);
      set(store.activeGenerationProtocolVersionByConvoId('convo-1'), 2);
    };

    it('stops a resumable generation through the host transport', async () => {
      const fake = createFakeTransport();
      const { result } = renderHook(() => useChatHelpers(0), {
        wrapper: createWrapper(fake.transport, seedRun),
      });

      await act(async () => {
        await result.current.stopGenerating();
      });

      expect(fake.transport.abort).toHaveBeenCalledTimes(1);
      expect((fake.transport.abort as jest.Mock).mock.calls[0][0]).toEqual({
        conversationId: 'convo-1',
        generationCreatedAt: 1000,
      });
    });

    it('settles a rejected stop without throwing to the caller', async () => {
      const failure = Object.assign(new Error('Not found'), { response: { status: 404 } });
      const fake = createFakeTransport({ abort: jest.fn(async () => Promise.reject(failure)) });
      const { result } = renderHook(() => useChatHelpers(0), {
        wrapper: createWrapper(fake.transport, seedRun),
      });

      await act(async () => {
        await expect(result.current.stopGenerating()).resolves.toBeUndefined();
      });
      expect(fake.transport.abort).toHaveBeenCalledTimes(1);
    });

    it('stops an Assistants run through the host transport when its stream is cancelled', async () => {
      const fake = createFakeTransport();
      const submission = buildSubmission('assistants');
      const helpers = buildChatHelpers();
      renderHook(() => useSSE(submission, helpers), { wrapper: createWrapper(fake.transport) });

      await act(async () => {
        fake.sends[0].options.onEvent({ type: 'abort' });
      });

      await waitFor(() => expect(fake.transport.abortRun).toHaveBeenCalledTimes(1));
      expect(fake.transport.abortRun).toHaveBeenCalledWith(
        { endpoint: 'assistants', abortKey: 'convo-1:' },
        { token: 'test-token' },
      );
      await waitFor(() => expect(helpers.setIsSubmitting).toHaveBeenLastCalledWith(false));
    });
  });
});
