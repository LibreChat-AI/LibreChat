import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { useAtomValue, getDefaultStore } from 'jotai';
import { QueryKeys, request } from 'librechat-data-provider';
import { act, renderHook, waitFor } from '@testing-library/react';
import { RecoilRoot, useRecoilValue, useSetRecoilState } from 'recoil';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type {
  TEnqueueAgentQueuedTurnRequest,
  TSubmission,
  TConversation,
  ChatTransportOptions,
  ChatTransportRequest,
} from 'librechat-data-provider';
import type { MutableSnapshot } from 'recoil';
import type { StreamStatusResponse } from '~/data-provider';
import type { ChatContract } from '~/hooks/Chat/contract';
import type { Transport } from '~/hooks/Chat/contract';
import type { PendingSteer } from '~/hooks/Chat/queue';
import { queuedMessagesByConvoId, resetQueueFamilies } from '~/hooks/Chat/queue';
import { ChatTransportContext } from '~/Providers/ChatTransportContext';
import { ChatContext, useChatContext } from '~/Providers/ChatContext';
import { startupConfigKey } from '~/data-provider/Endpoints/queries';
import { useSteerReclaim } from '~/hooks/Chat/useSteerCancel';
import useSteerEscalate from '~/hooks/Chat/useSteerEscalate';
import useResumableSSE from '~/hooks/SSE/useResumableSSE';
import useResumeOnLoad from '~/hooks/SSE/useResumeOnLoad';
import useChatHelpers from '~/hooks/Chat/useChatHelpers';
import { resumeRequestsAtom } from '~/hooks/Chat/resume';
import useSteering from '~/hooks/Chat/useSteering';
import { useChat } from '~/hooks/Chat/facade';
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
 * network at the contract boundary. `streams` and `sends` keep each connection's options, so a
 * test can push events through `onEvent` or watch its `signal`.
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
  return { transport, streams, sends };
}

function createWrapper(
  transport: Transport,
  seed?: (state: MutableSnapshot) => void,
  seedCache?: (queryClient: QueryClient) => void,
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  /** The composer's user-key check is not gated by `queriesEnabled`; answer it from cache. */
  queryClient.setQueryData([QueryKeys.name, 'agents'], { expiresAt: '' });
  seedCache?.(queryClient);
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

const seedSteerableRun = ({ set }: MutableSnapshot) => {
  set(store.conversationByIndex(0), {
    conversationId: 'convo-1',
    endpoint: 'agents',
  } as TConversation);
  set(store.activeGenerationCreatedAtByConvoId('convo-1'), 1000);
  set(store.activeGenerationProtocolVersionByConvoId('convo-1'), 2);
};

/** The running turn: queued follow-ups chain off its in-flight response. */
const seedLiveBranch = (queryClient: QueryClient) =>
  queryClient.setQueryData(
    [QueryKeys.messages, 'convo-1'],
    [
      { ...buildSubmission().userMessage },
      {
        messageId: 'resp-1',
        conversationId: 'convo-1',
        parentMessageId: 'msg-1',
        text: '',
        isCreatedByUser: false,
        sender: 'Assistant',
      },
    ],
  );

const renderSteering = (transport: Transport) =>
  renderHook(
    () => ({
      steering: useSteering({
        consumeDraft: jest.fn(),
        index: 0,
        conversationId: 'convo-1',
        conversation: { conversationId: 'convo-1', endpoint: 'agents' } as TConversation,
        isSubmitting: true,
        answerModeActive: false,
        sendNow: jest.fn(),
        stopGenerating: jest.fn(),
      }),
      queue: useAtomValue(queuedMessagesByConvoId('convo-1')),
    }),
    { wrapper: createWrapper(transport, seedSteerableRun, seedLiveBranch) },
  );

beforeEach(() => resetQueueFamilies());

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
    const seedRun = ({ set }: MutableSnapshot) => {
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

  describe('steer', () => {
    it('sends a steer to the running generation through the host transport', async () => {
      const fake = createFakeTransport({
        steer: jest.fn(async () => ({
          status: 'queued' as const,
          steerId: 'steer-1',
          position: 0,
          conversationId: 'convo-1',
          generationProtocolVersion: 2,
        })),
      });
      const { result } = renderSteering(fake.transport);

      act(() => {
        expect(result.current.steering.steerFromComposer('fold this in')).toBe(true);
      });

      await waitFor(() => expect(fake.transport.steer).toHaveBeenCalledTimes(1));
      expect((fake.transport.steer as jest.Mock).mock.calls[0][0]).toEqual(
        expect.objectContaining({
          conversationId: 'convo-1',
          generationCreatedAt: 1000,
          text: 'fold this in',
        }),
      );
      expect(result.current.queue).toEqual([]);
    });

    it('keeps a refused steer as a queued turn', async () => {
      const refusal = Object.assign(new Error('Steering unsupported'), {
        response: { status: 409, data: { code: 'STEER_UNSUPPORTED' } },
      });
      const fake = createFakeTransport({ steer: jest.fn(async () => Promise.reject(refusal)) });
      const { result } = renderSteering(fake.transport);

      act(() => {
        result.current.steering.steerFromComposer('do not lose me');
      });

      await waitFor(() =>
        expect(result.current.queue).toEqual([expect.objectContaining({ text: 'do not lose me' })]),
      );
      expect(fake.transport.steer).toHaveBeenCalledTimes(1);
    });
  });

  describe('steer controls', () => {
    const pendingSteer: PendingSteer = {
      steerId: 'steer-1',
      text: 'fold this in',
      status: 'pending',
      createdAt: 1,
    };
    const seedPendingSteer = (snapshot: MutableSnapshot) => {
      seedSteerableRun(snapshot);
      snapshot.set(store.pendingSteersByConvoId('convo-1'), [pendingSteer]);
    };

    it('withdraws a waiting steer through the host transport', async () => {
      const fake = createFakeTransport({ cancelSteer: jest.fn(async () => ({ removed: true })) });
      const { result } = renderHook(
        () => ({
          reclaim: useSteerReclaim('convo-1'),
          pending: useRecoilValue(store.pendingSteersByConvoId('convo-1')),
        }),
        { wrapper: createWrapper(fake.transport, seedPendingSteer) },
      );

      let outcome = '';
      await act(async () => {
        outcome = await result.current.reclaim(pendingSteer);
      });

      expect(outcome).toBe('reclaimed');
      expect((fake.transport.cancelSteer as jest.Mock).mock.calls[0][0]).toEqual({
        conversationId: 'convo-1',
        steerId: 'steer-1',
        generationCreatedAt: 1000,
      });
      expect(result.current.pending).toEqual([]);
    });

    it('escalates a waiting steer to an interrupt through the host transport', async () => {
      const fake = createFakeTransport({
        armSteer: jest.fn(async () => ({
          armed: true,
          preemptRevision: 1,
          generationProtocolVersion: 2,
        })),
      });
      const { result } = renderHook(
        () => ({
          escalate: useSteerEscalate('convo-1'),
          pending: useRecoilValue(store.pendingSteersByConvoId('convo-1')),
        }),
        { wrapper: createWrapper(fake.transport, seedPendingSteer) },
      );

      act(() => result.current.escalate({ steerId: 'steer-1' }));

      await waitFor(() =>
        expect(result.current.pending).toEqual([
          expect.objectContaining({ steerId: 'steer-1', preempt: true }),
        ]),
      );
      expect((fake.transport.armSteer as jest.Mock).mock.calls[0][0]).toEqual({
        conversationId: 'convo-1',
        steerId: 'steer-1',
        generationCreatedAt: 1000,
      });
    });
  });

  describe('queue', () => {
    const receiptFor = (input: TEnqueueAgentQueuedTurnRequest, status = 'queued' as const) => ({
      ...input,
      queuedTurnId: 'queued-turn-1',
      status,
      revision: 0,
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
    });

    it('reads, adds and withdraws server queued turns through the host transport', async () => {
      const fake = createFakeTransport({
        enqueue: jest.fn(async (input: TEnqueueAgentQueuedTurnRequest) => receiptFor(input)),
        cancelQueued: jest.fn(async () => ({
          ...receiptFor({} as TEnqueueAgentQueuedTurnRequest),
          status: 'cancelled' as const,
        })),
      });
      const { result } = renderSteering(fake.transport);

      await waitFor(() => expect(fake.transport.listQueued).toHaveBeenCalled());
      expect((fake.transport.listQueued as jest.Mock).mock.calls[0][0]).toBe('convo-1');

      await act(async () => {
        expect(result.current.steering.queueFromComposer('after this run')).toBe(true);
      });

      await waitFor(() => expect(fake.transport.enqueue).toHaveBeenCalledTimes(1));
      expect((fake.transport.enqueue as jest.Mock).mock.calls[0][0]).toEqual(
        expect.objectContaining({ conversationId: 'convo-1', text: 'after this run' }),
      );
      await waitFor(() =>
        expect(result.current.queue[0].server).toEqual(
          expect.objectContaining({ id: 'queued-turn-1' }),
        ),
      );

      let discarded = false;
      await act(async () => {
        discarded = await result.current.steering.discardQueued(result.current.queue[0]);
      });
      expect(discarded).toBe(true);
      expect(fake.transport.cancelQueued).toHaveBeenCalledWith({
        conversationId: 'convo-1',
        queuedTurnId: 'queued-turn-1',
      });
    });

    it('keeps a turn queued locally when the server has no queue', async () => {
      const unsupported = Object.assign(new Error('Not found'), { response: { status: 404 } });
      const fake = createFakeTransport({
        enqueue: jest.fn(async () => Promise.reject(unsupported)),
      });
      const { result } = renderSteering(fake.transport);

      await act(async () => {
        result.current.steering.queueFromComposer('hold me here');
      });

      await waitFor(() => expect(fake.transport.enqueue).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(result.current.queue[0]?.server).toBeUndefined());
      expect(result.current.queue).toEqual([expect.objectContaining({ text: 'hold me here' })]);
    });
  });

  describe('resume', () => {
    /** The host builds the pane's chat contract, as the chat view does. */
    function ChatHost({ children }: { children: React.ReactNode }) {
      const helpers: ChatContract = useChatHelpers(0, 'convo-1');
      return <ChatContext.Provider value={helpers}>{children}</ChatContext.Provider>;
    }

    /** The resume-on-load path and the stream hook a chat view mounts, read through `useChat`. */
    const useResumablePane = () => {
      const helpers = useChatContext();
      useResumeOnLoad('convo-1', helpers.getMessages, 0, true);
      const submission = useRecoilValue(store.submissionByIndex(0));
      useResumableSSE(submission, helpers, false, 0);
      const showConversation = useSetRecoilState(store.conversationByIndex(0));
      return { ...useChat(), showConversation };
    };

    const seedConversation = ({ set }: MutableSnapshot) =>
      set(store.conversationByIndex(0), {
        conversationId: 'convo-1',
        endpoint: 'agents',
      } as TConversation);

    let status: StreamStatusResponse;
    /** A running job as the status route reports it, with the turn it answers. */
    const runningStatus = (): StreamStatusResponse => ({
      active: true,
      streamId: 'convo-1',
      status: 'running',
      createdAt: 2000,
      generationProtocolVersion: 2,
      resumeState: {
        runSteps: [],
        aggregatedContent: [],
        userMessage: {
          messageId: 'msg-1',
          parentMessageId: '00000000-0000-0000-0000-000000000000',
          conversationId: 'convo-1',
          text: 'Hello',
        },
        responseMessageId: 'resp-1',
        conversationId: 'convo-1',
      } as StreamStatusResponse['resumeState'],
    });
    const statusReads = () =>
      (request.get as jest.Mock).mock.calls.filter(([url]) => String(url).includes('/status/'))
        .length;

    beforeEach(() => {
      status = { active: false };
      /** The status read is the server's answer to "is anything running"; the stream itself
       *  comes from the fake transport. */
      jest
        .spyOn(request, 'get')
        .mockImplementation(async (url: string) =>
          url.includes('/api/agents/chat/status/') ? status : [],
        );
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    /** Resume waits for the startup config, which decides a rebuilt turn's retention. */
    const seedStartupConfig = (queryClient: QueryClient) => {
      queryClient.setQueryData(startupConfigKey(false), {});
      /** The turn the running generation answers, as history holds it on reload. */
      queryClient.setQueryData([QueryKeys.messages, 'convo-1'], [buildSubmission().userMessage]);
    };

    const renderPane = (
      transport: Transport,
      seed: (snapshot: MutableSnapshot) => void = seedConversation,
    ) => {
      const Wrapper = createWrapper(transport, seed, seedStartupConfig);
      return renderHook(useResumablePane, {
        wrapper: ({ children }) => (
          <Wrapper>
            <ChatHost>{children}</ChatHost>
          </Wrapper>
        ),
      });
    };

    it('reattaches to a running generation through the host transport', async () => {
      const fake = createFakeTransport();
      const { result } = renderPane(fake.transport);
      await waitFor(() => expect(statusReads()).toBe(1));
      expect(fake.streams).toHaveLength(0);

      status = runningStatus();
      await act(async () => {
        await result.current.resumeStream();
      });

      await waitFor(() => expect(fake.streams).toHaveLength(1));
      expect(fake.transport.stream).toHaveBeenCalledWith({ token: 'test-token' });
      expect(fake.streams[0].url).toContain('/api/agents/chat/stream/convo-1');
      expect(fake.streams[0].url).toContain('resume=true');
      expect(fake.streams[0].url).toContain('generationCreatedAt=2000');
      expect(fake.transport.start).not.toHaveBeenCalled();
    });

    it('re-reads the status and stays detached when nothing is running', async () => {
      const fake = createFakeTransport();
      const { result } = renderPane(fake.transport);
      await waitFor(() => expect(statusReads()).toBe(1));

      await act(async () => {
        await result.current.resumeStream();
      });

      await waitFor(() => expect(statusReads()).toBe(2));
      expect(fake.streams).toHaveLength(0);
      expect(result.current.status).toBe('ready');
    });

    it('holds a request until the pane has loaded the conversation the route names', async () => {
      const store$ = getDefaultStore();
      const fake = createFakeTransport();
      /** The pane still shows the Assistants conversation it is navigating away from. */
      const { result } = renderPane(fake.transport, ({ set }) =>
        set(store.conversationByIndex(0), {
          conversationId: 'assistants-convo',
          endpoint: 'assistants',
        } as TConversation),
      );
      status = runningStatus();

      await act(async () => {
        await result.current.resumeStream();
      });
      expect([...store$.get(resumeRequestsAtom)]).toEqual(['convo-1']);
      expect(fake.streams).toHaveLength(0);

      act(() =>
        result.current.showConversation({
          conversationId: 'convo-1',
          endpoint: 'agents',
        } as TConversation),
      );

      await waitFor(() => expect(fake.streams).toHaveLength(1));
      expect(fake.streams[0].url).toContain('resume=true');
      expect([...store$.get(resumeRequestsAtom)]).toEqual([]);
    });

    it("answers its own conversation's request and leaves another pane's pending", async () => {
      const store = getDefaultStore();
      const fake = createFakeTransport();
      const { result } = renderPane(fake.transport);
      await waitFor(() => expect(statusReads()).toBe(1));

      await act(async () => {
        /** Another pane asks in the same tick, before any effect runs. */
        store.set(resumeRequestsAtom, (pending) => new Set(pending).add('convo-2'));
        await result.current.resumeStream();
      });

      await waitFor(() => expect(statusReads()).toBe(2));
      expect([...store.get(resumeRequestsAtom)]).toEqual(['convo-2']);
      store.set(resumeRequestsAtom, new Set<string>());
    });

    it('reports a reattached stream that fails as an error', async () => {
      const fake = createFakeTransport();
      const { result } = renderPane(fake.transport);
      await waitFor(() => expect(statusReads()).toBe(1));
      status = runningStatus();
      await act(async () => {
        await result.current.resumeStream();
      });
      await waitFor(() => expect(fake.streams).toHaveLength(1));

      /** The run ends with the error, and the teardown re-reads the status to confirm it. */
      status = { active: false, status: 'error', createdAt: 2000, generationProtocolVersion: 2 };
      act(() =>
        fake.streams[0].options.onEvent({ type: 'error', data: { message: 'Generation failed' } }),
      );

      await waitFor(() => expect(result.current.status).toBe('error'));
      expect(result.current.error?.message).toContain('Generation failed');
    });
  });
});
