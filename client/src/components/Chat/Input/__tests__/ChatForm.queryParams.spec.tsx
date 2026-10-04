import React, { useMemo, useState } from 'react';
import { DndProvider } from 'react-dnd';
import { useForm } from 'react-hook-form';
import { RecoilRoot, useRecoilState } from 'recoil';
import { HTML5Backend } from 'react-dnd-html5-backend';
import { QueryKeys, EModelEndpoint } from 'librechat-data-provider';
import { act, render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useNavigate, useLocation } from 'react-router-dom';
import type { TConversation } from 'librechat-data-provider';
import type { Transport } from '~/hooks/Chat/contract';
import type { ChatFormValues } from '~/common';
import { ChatTransportContext, defaultChatTransport } from '~/Providers/ChatTransportContext';
import { getNewConversationDraftId, getDraft, setDraft } from '~/utils/drafts';
import { ChatContext, ChatFormProvider } from '~/Providers';
import { AuthContextProvider } from '~/hooks/AuthContext';
import { startupConfigKey } from '~/data-provider';
import ChatForm from '../ChatForm';
import store from '~/store';

const initialConversation = {
  conversationId: 'new',
  endpoint: EModelEndpoint.openAI,
  model: 'gpt-4o',
  title: 'New Chat',
} as TConversation;

const ask = jest.fn();
const newConversation = jest.fn();
const stopGeneration = jest.fn();
const transport: Transport = {
  ...defaultChatTransport,
  listQueued: async () => [],
  steer: jest.fn(async (params) => ({
    status: 'queued' as const,
    steerId: 'test-steer',
    position: 0,
    conversationId: params.conversationId,
  })),
};

function Harness({
  conversation,
  routePending = false,
  onAsk = ask,
  speechSettingsInitialized = false,
}: {
  conversation: TConversation;
  routePending?: boolean;
  onAsk?: typeof ask;
  speechSettingsInitialized?: boolean;
}) {
  const [files, setFiles] = useRecoilState(store.filesByIndex(0));
  const [isSubmitting] = useRecoilState(store.isSubmittingFamily(0));
  const [, setFilesLoading] = useState(false);
  const methods = useForm<ChatFormValues>({ defaultValues: { text: '' } });
  const chatHelpers = useMemo<React.ContextType<typeof ChatContext>>(
    () => ({
      index: 0,
      conversation,
      setConversation: () => undefined,
      files,
      setFiles,
      isSubmitting,
      setIsSubmitting: () => undefined,
      filesLoading: false,
      setFilesLoading,
      newConversation,
      handleStopGenerating: stopGeneration,
      stopGenerating: () => Promise.resolve(),
      getMessages: () => [],
      messagesKey: 'new',
      latestMessageId: undefined,
      latestMessageDepth: undefined,
      feedbackEnabled: false,
      setMessages: () => undefined,
      ask: onAsk,
      regenerate: () => undefined,
      setSiblingIdx: () => undefined,
      showPopover: false,
      setShowPopover: () => undefined,
      abortScroll: false,
      setAbortScroll: () => undefined,
      preset: null,
      setPreset: () => undefined,
      optionSettings: {},
      setOptionSettings: () => undefined,
      handleRegenerate: () => undefined,
      handleContinue: () => undefined,
    }),
    [conversation, files, setFiles, isSubmitting, onAsk],
  );
  return (
    <ChatFormProvider {...methods}>
      <ChatContext.Provider value={chatHelpers}>
        <ChatForm
          index={0}
          routePending={routePending}
          isLandingPage
          enterToSend
          autoSendText={-1}
          speechSettingsInitialized={speechSettingsInitialized}
          footerBelow={false}
          centerFormOnLanding={false}
        />
      </ChatContext.Provider>
    </ChatFormProvider>
  );
}

function mountComposer(
  conversation = initialConversation,
  {
    pathname = `/c/${conversation.conversationId}`,
    query = 'agent_id=agent_test&q=hi&submit=true',
    routePending = false,
    speechSettingsInitialized = false,
    liveRun = false,
  } = {},
) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity, cacheTime: Infinity },
      mutations: { retry: false },
    },
  });
  queryClient.setQueryData([QueryKeys.files], []);
  queryClient.setQueryData(startupConfigKey(true), { modelSpecs: { list: [] } });
  queryClient.setQueryData(startupConfigKey(false), { modelSpecs: { list: [] } });
  queryClient.setQueryData([QueryKeys.fileConfig], {});
  queryClient.setQueryData([QueryKeys.tokenConfig], {});
  queryClient.setQueryData([QueryKeys.customConfigSpeech], {});
  queryClient.setQueryData([QueryKeys.name, EModelEndpoint.openAI], { expiresAt: '' });
  queryClient.setQueryData([QueryKeys.name, EModelEndpoint.agents], { expiresAt: '' });
  queryClient.setQueryData([QueryKeys.name, EModelEndpoint.assistants], { expiresAt: '' });
  queryClient.setQueryData([QueryKeys.messages, conversation.conversationId], []);
  queryClient.setQueryData([QueryKeys.messages, 'other-chat'], []);
  queryClient.setQueryData([QueryKeys.messages, 'chat-b'], []);
  queryClient.setQueryData([QueryKeys.assistant, EModelEndpoint.assistants, 'asst_test'], {
    id: 'asst_test',
    model: 'gpt-4o',
  });
  queryClient.setQueryData([QueryKeys.toolAuth, 'web_search'], { authenticated: false });
  queryClient.setQueryData([QueryKeys.toolFavorites], []);
  queryClient.setQueryData([QueryKeys.skillStates], {});
  queryClient.setQueryData([QueryKeys.agent, 'agent_test'], {
    id: 'agent_test',
    name: 'Test agent',
    provider: EModelEndpoint.openAI,
    model: 'gpt-4o',
    tools: [],
  });
  queryClient.setQueryData([QueryKeys.endpoints], {
    [EModelEndpoint.openAI]: { order: 0 },
    [EModelEndpoint.agents]: { order: 1 },
  });
  let navigate: ReturnType<typeof useNavigate>;
  let location: ReturnType<typeof useLocation>;
  function NavigationBridge() {
    navigate = useNavigate();
    location = useLocation();
    return null;
  }
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <RecoilRoot
        initializeState={({ set }) => {
          if (liveRun) {
            set(store.isSubmittingFamily(0), true);
            set(store.showStopButtonByIndex(0), true);
            set(store.activeGenerationCreatedAtByConvoId(conversation.conversationId ?? ''), 1000);
            set(
              store.activeGenerationProtocolVersionByConvoId(conversation.conversationId ?? ''),
              2,
            );
          }
          if (speechSettingsInitialized) {
            set(store.engineSTT, 'external');
            set(store.autoTranscribeAudio, false);
          }
        }}
      >
        <MemoryRouter initialEntries={[`${pathname}?${query}`]}>
          <NavigationBridge />
          <AuthContextProvider authConfig={{ loginRedirect: '', test: true }}>
            <ChatTransportContext.Provider value={transport}>
              <DndProvider backend={HTML5Backend}>{children}</DndProvider>
            </ChatTransportContext.Provider>
          </AuthContextProvider>
        </MemoryRouter>
      </RecoilRoot>
    </QueryClientProvider>
  );
  const view = render(
    <Harness
      conversation={conversation}
      routePending={routePending}
      speechSettingsInitialized={speechSettingsInitialized}
    />,
    {
      wrapper,
    },
  );
  return { ...view, navigate: (to: string) => navigate(to), getLocation: () => location };
}

describe('ChatForm URL submission', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    localStorage.clear();
    ask.mockReset();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('processes a queued prompt URL after ordinary conversation navigation without remounting', async () => {
    const source = { ...initialConversation, conversationId: 'source-chat' };
    const view = mountComposer(source, { query: '' });
    await act(async () => jest.advanceTimersByTime(100));
    const destinationAsk = jest.fn();
    await act(async () => {
      view.navigate('/c/new?prompt=queued+words&submit=true');
      view.rerender(<Harness conversation={source} routePending onAsk={destinationAsk} />);
    });
    await act(async () => jest.advanceTimersByTime(100));
    expect(destinationAsk).not.toHaveBeenCalled();
    await act(async () => {
      view.rerender(<Harness conversation={initialConversation} onAsk={destinationAsk} />);
    });
    await act(async () => jest.advanceTimersByTime(100));
    expect(destinationAsk).toHaveBeenCalledTimes(1);
    expect(destinationAsk).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'queued words' }),
      expect.anything(),
    );
    expect(view.getLocation().search).toBe('');
    expect(ask).not.toHaveBeenCalled();
  });

  it('processes a new agent URL once after a previous URL request has completed', async () => {
    const view = mountComposer(initialConversation, { query: 'q=first&submit=true' });
    await act(async () => jest.advanceTimersByTime(100));
    expect(ask).toHaveBeenCalledTimes(1);
    await act(async () => view.navigate('/c/new?agent_id=agent_test&q=second&submit=true'));
    await act(async () => jest.advanceTimersByTime(100));
    expect(screen.getByTestId('text-input')).toHaveValue('second');
    expect(screen.getByText('Sending...')).toBeInTheDocument();
    await act(async () => {
      view.rerender(
        <Harness
          conversation={{
            ...initialConversation,
            endpoint: EModelEndpoint.agents,
            agent_id: 'agent_test',
            model: undefined,
          }}
        />,
      );
    });
    expect(ask).toHaveBeenCalledTimes(2);
    expect(ask).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: 'second' }),
      expect.anything(),
    );
    await act(async () => jest.advanceTimersByTime(4000));
    expect(ask).toHaveBeenCalledTimes(2);
    expect(view.getLocation().search).toBe('');
  });

  it('replaces a pending URL request without replaying its timeout into the new request', async () => {
    const view = mountComposer(initialConversation, {
      query: 'agent_id=missing&q=old&submit=true',
    });
    await act(async () => jest.advanceTimersByTime(100));
    expect(screen.getByTestId('text-input')).toHaveValue('old');
    await act(async () => view.navigate('/c/new?q=new&submit=true'));
    await act(async () => jest.advanceTimersByTime(100));
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ text: 'new' }), expect.anything());
    await act(async () => jest.advanceTimersByTime(4000));
    expect(ask).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/Chat settings could not be applied/)).not.toBeInTheDocument();
    expect(view.getLocation().search).toBe('');
  });

  it.each(['chat-a', 'chat-b'])(
    'waits for route reconciliation while %s remains in the store',
    async (sourceId) => {
      const source = { ...initialConversation, conversationId: sourceId };
      setDraft({ id: sourceId, value: 'source draft' });
      const view = mountComposer(source, {
        pathname: '/c/chat-b',
        query: 'endpoint=openAI&q=hi&submit=true',
        routePending: true,
      });
      await act(async () => jest.advanceTimersByTime(6000));
      expect(ask).not.toHaveBeenCalled();
      expect(newConversation).not.toHaveBeenCalled();
      expect(screen.getByTestId('text-input')).toHaveValue('source draft');
      expect(view.getLocation().search).toContain('q=hi');
      const destinationAsk = jest.fn();
      await act(async () => {
        view.rerender(
          <Harness
            conversation={{ ...initialConversation, conversationId: 'chat-b' }}
            onAsk={destinationAsk}
          />,
        );
      });
      await act(async () => jest.advanceTimersByTime(100));
      expect(destinationAsk).toHaveBeenCalledTimes(1);
      expect(destinationAsk).toHaveBeenCalledWith(
        expect.objectContaining({ text: 'hi' }),
        expect.anything(),
      );
      expect(ask).not.toHaveBeenCalled();
      expect(getDraft(sourceId)).toBe('source draft');
    },
  );

  it.each(['', 'old draft'])(
    'persists an unsent URL prompt over settled draft %p',
    async (oldDraft) => {
      const source = { ...initialConversation, conversationId: 'source-chat' };
      setDraft({ id: source.conversationId, value: oldDraft });
      const view = mountComposer(source, { query: 'q=hi' });
      await act(async () => jest.advanceTimersByTime(100));
      expect(screen.getByTestId('text-input')).toHaveValue('hi');
      expect(getDraft(source.conversationId)).toBe('hi');
      await act(async () => {
        view.navigate('/c/other-chat');
        view.rerender(
          <Harness conversation={{ ...initialConversation, conversationId: 'other-chat' }} />,
        );
      });
      await act(async () => {
        view.navigate('/c/source-chat');
        view.rerender(<Harness conversation={source} />);
      });
      expect(screen.getByTestId('text-input')).toHaveValue('hi');
      expect(ask).not.toHaveBeenCalled();
    },
  );

  it.each(['timeout', 'refusal'])(
    'persists a URL prompt after %s without native input',
    async (outcome) => {
      setDraft({ id: getNewConversationDraftId(), value: 'old draft' });
      const source =
        outcome === 'refusal'
          ? {
              ...initialConversation,
              endpoint: EModelEndpoint.agents,
              agent_id: 'agent_test',
              model: undefined,
            }
          : initialConversation;
      if (outcome === 'refusal') {
        ask.mockReturnValueOnce(false);
      }
      const view = mountComposer(source);
      await act(async () => jest.advanceTimersByTime(100));
      if (outcome === 'timeout') {
        await act(async () => jest.advanceTimersByTime(3000));
      }
      expect(screen.getByTestId('text-input')).toHaveValue('hi');
      expect(getDraft(getNewConversationDraftId())).toBe('hi');
      await act(async () => {
        view.navigate('/c/other-chat');
        view.rerender(
          <Harness conversation={{ ...initialConversation, conversationId: 'other-chat' }} />,
        );
      });
      await act(async () => {
        view.navigate('/c/new');
        view.rerender(<Harness conversation={source} />);
      });
      expect(screen.getByTestId('text-input')).toHaveValue('hi');
      expect(ask).toHaveBeenCalledTimes(outcome === 'refusal' ? 1 : 0);
    },
  );

  it('holds live-run composer actions during URL preparation while leaving Stop available', async () => {
    mountComposer(
      { ...initialConversation, conversationId: 'existing-live-chat' },
      {
        query: 'endpoint=openAI&model=unavailable-model&q=hi&submit=true',
        liveRun: true,
      },
    );
    await act(async () => jest.advanceTimersByTime(100));
    expect(screen.getByText('Sending...')).toBeInTheDocument();
    expect(screen.getByTestId('text-input')).toHaveValue('hi');
    expect(screen.getByTestId('during-run-send-button')).toBeDisabled();
    expect(screen.queryByTestId('interrupt-steer-button')).not.toBeInTheDocument();
    const stop = screen.getByRole('button', { name: 'Stop generating' });
    expect(stop).toBeEnabled();
    await act(async () => {
      fireEvent.click(screen.getByTestId('during-run-send-button'));
      fireEvent.submit(screen.getByTestId('text-input').closest('form') as HTMLFormElement);
      fireEvent.keyDown(screen.getByTestId('text-input'), {
        key: 'Enter',
        ctrlKey: true,
        shiftKey: true,
      });
    });
    expect(transport.steer).not.toHaveBeenCalled();
    expect(ask).not.toHaveBeenCalled();
    expect(screen.getByTestId('text-input')).toHaveValue('hi');
    await act(async () => fireEvent.click(stop));
    expect(stopGeneration).toHaveBeenCalledTimes(1);
    expect(transport.steer).not.toHaveBeenCalled();
  });

  it('disables the microphone while URL settings are preparing and re-enables it on timeout', async () => {
    mountComposer(initialConversation, { speechSettingsInitialized: true });
    expect(screen.getByRole('button', { name: 'Use microphone' })).not.toBeDisabled();
    await act(async () => jest.advanceTimersByTime(100));
    expect(screen.getByRole('button', { name: 'Use microphone' })).toBeDisabled();
    expect(screen.getByText('Sending...')).toBeInTheDocument();
    await act(async () => jest.advanceTimersByTime(3000));
    expect(screen.getByRole('button', { name: 'Use microphone' })).not.toBeDisabled();
    expect(screen.getByTestId('text-input')).toHaveValue('hi');
    expect(ask).not.toHaveBeenCalled();
  });

  it('disables recording send during URL preparation without disabling stop', async () => {
    const recorderDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'MediaRecorder');
    const devicesDescriptor = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
    const audioContextDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'AudioContext');
    const tracks: jest.Mock[] = [];
    class TestRecorder extends EventTarget {
      static isTypeSupported = () => true;

      state: RecordingState = 'inactive';

      start() {
        this.state = 'recording';
      }

      stop() {
        this.state = 'inactive';
        this.dispatchEvent(new Event('stop'));
      }
    }
    class TestAudioContext {
      state: AudioContextState = 'running';

      close() {
        this.state = 'closed';
        return Promise.resolve();
      }

      createMediaStreamSource() {
        return { connect: () => undefined };
      }

      createAnalyser() {
        return { fftSize: 1024, getByteTimeDomainData: (buffer: Uint8Array) => buffer.fill(128) };
      }
    }
    Object.defineProperty(globalThis, 'MediaRecorder', { configurable: true, value: TestRecorder });
    Object.defineProperty(globalThis, 'AudioContext', {
      configurable: true,
      value: TestAudioContext,
    });
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: async () => {
          const stop = jest.fn();
          tracks.push(stop);
          return { getTracks: () => [{ stop }] };
        },
      },
    });
    setDraft({ id: getNewConversationDraftId(), value: 'unsent draft' });
    const view = mountComposer(initialConversation, { speechSettingsInitialized: true });
    try {
      await act(async () =>
        fireEvent.click(screen.getByRole('button', { name: 'Use microphone' })),
      );
      expect(screen.getByRole('button', { name: 'Stop' })).not.toBeDisabled();
      expect(screen.getByRole('button', { name: 'Send message' })).not.toBeDisabled();
      await act(async () => jest.advanceTimersByTime(100));
      expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Stop' })).not.toBeDisabled();
      await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Stop' })));
      expect(tracks[0]).toHaveBeenCalledTimes(1);
      expect(ask).not.toHaveBeenCalled();
    } finally {
      view.unmount();
      if (recorderDescriptor)
        Object.defineProperty(globalThis, 'MediaRecorder', recorderDescriptor);
      else Reflect.deleteProperty(globalThis, 'MediaRecorder');
      if (devicesDescriptor) Object.defineProperty(navigator, 'mediaDevices', devicesDescriptor);
      else Reflect.deleteProperty(navigator, 'mediaDevices');
      if (audioContextDescriptor)
        Object.defineProperty(globalThis, 'AudioContext', audioContextDescriptor);
      else Reflect.deleteProperty(globalThis, 'AudioContext');
    }
  });

  it('shows the prompt and Sending status while blocking duplicate manual sends', async () => {
    mountComposer();
    await act(async () => jest.advanceTimersByTime(100));
    expect(screen.getByTestId('text-input')).toHaveValue('hi');
    expect(screen.getByTestId('text-input')).toBeDisabled();
    expect(screen.getByTestId('send-button')).toBeDisabled();
    expect(screen.getByText('Sending...')).toHaveAttribute('role', 'status');
    await act(async () => {
      fireEvent.submit(screen.getByTestId('text-input').closest('form') as HTMLFormElement);
    });
    expect(ask).not.toHaveBeenCalled();
  });

  it('keeps the draft and explains a timeout instead of sending to a different agent', async () => {
    mountComposer();
    await act(async () => jest.advanceTimersByTime(100));
    await act(async () => jest.advanceTimersByTime(3000));
    expect(screen.getByTestId('text-input')).toHaveValue('hi');
    expect(screen.getByText(/Chat settings could not be applied/)).toHaveAttribute(
      'role',
      'status',
    );
    expect(ask).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.submit(screen.getByTestId('text-input').closest('form') as HTMLFormElement);
    });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/Chat settings could not be applied/)).not.toBeInTheDocument();
  });

  it.each(['', 'unrelated saved message'])(
    'preserves the URL prompt when the new conversation restores draft %p',
    async (savedText) => {
      setDraft({ id: getNewConversationDraftId(), value: savedText });
      const view = mountComposer({
        ...initialConversation,
        conversationId: 'existing-assistants-chat',
        endpoint: EModelEndpoint.assistants,
        assistant_id: 'asst_test',
      });
      await act(async () => jest.advanceTimersByTime(100));
      expect(screen.getByTestId('text-input')).toHaveValue('hi');
      view.rerender(
        <Harness
          conversation={{
            ...initialConversation,
            endpoint: EModelEndpoint.agents,
            agent_id: 'agent_test',
            model: undefined,
          }}
        />,
      );
      await act(async () => Promise.resolve());
      expect(ask).toHaveBeenCalledTimes(1);
      expect(ask).toHaveBeenCalledWith(expect.objectContaining({ text: 'hi' }), expect.anything());
    },
  );

  it.each([EModelEndpoint.openAI, EModelEndpoint.agents])(
    'cancels the URL request when navigating to another %s chat',
    async (endpoint) => {
      setDraft({ id: 'other-chat', value: 'destination draft' });
      const view = mountComposer();
      await act(async () => jest.advanceTimersByTime(100));
      await act(async () => {
        view.navigate('/c/other-chat');
        view.rerender(
          <Harness
            conversation={{
              ...initialConversation,
              conversationId: 'other-chat',
              endpoint,
              ...(endpoint === EModelEndpoint.agents ? { agent_id: 'agent_test' } : {}),
            }}
          />,
        );
      });
      expect(screen.getByTestId('text-input')).toHaveValue('destination draft');
      expect(screen.getByTestId('text-input')).not.toBeDisabled();
      expect(screen.queryByText('Sending...')).not.toBeInTheDocument();
      expect(ask).not.toHaveBeenCalled();
      await act(async () => jest.advanceTimersByTime(4000));
      expect(screen.getByTestId('text-input')).toHaveValue('destination draft');
      expect(screen.queryByText(/Chat settings could not be applied/)).not.toBeInTheDocument();
      expect(ask).not.toHaveBeenCalled();
    },
  );

  it.each(['', 'original unsent draft'])(
    'preserves the departing chat draft %p when a URL prompt starts another chat',
    async (sourceDraft) => {
      const sourceConversation = {
        ...initialConversation,
        conversationId: 'existing-chat',
        endpoint: EModelEndpoint.assistants,
        assistant_id: 'asst_test',
      };
      setDraft({ id: sourceConversation.conversationId, value: sourceDraft });
      const view = mountComposer(sourceConversation);
      expect(screen.getByTestId('text-input')).toHaveValue(sourceDraft);
      await act(async () => jest.advanceTimersByTime(100));
      expect(screen.getByTestId('text-input')).toHaveValue('hi');
      await act(async () => {
        view.navigate('/c/new?agent_id=agent_test&q=hi&submit=true');
        view.rerender(
          <Harness
            conversation={{
              ...initialConversation,
              endpoint: EModelEndpoint.agents,
              agent_id: 'agent_test',
              model: undefined,
            }}
          />,
        );
      });
      expect(ask).toHaveBeenCalledWith(expect.objectContaining({ text: 'hi' }), expect.anything());
      expect(getDraft(sourceConversation.conversationId) ?? '').toBe(sourceDraft);
      await act(async () => {
        view.navigate('/c/existing-chat');
        view.rerender(<Harness conversation={sourceConversation} />);
      });
      expect(screen.getByTestId('text-input')).toHaveValue(sourceDraft);
    },
  );

  it('preserves the source draft if the URL request is cancelled before its switch completes', async () => {
    const sourceConversation = {
      ...initialConversation,
      conversationId: 'existing-chat',
      endpoint: EModelEndpoint.assistants,
      assistant_id: 'asst_test',
    };
    setDraft({ id: sourceConversation.conversationId, value: 'original unsent draft' });
    setDraft({ id: 'other-chat', value: 'destination draft' });
    const view = mountComposer(sourceConversation);
    await act(async () => jest.advanceTimersByTime(100));
    await act(async () => {
      view.navigate('/c/other-chat');
      view.rerender(
        <Harness conversation={{ ...initialConversation, conversationId: 'other-chat' }} />,
      );
    });
    expect(screen.getByTestId('text-input')).toHaveValue('destination draft');
    expect(getDraft(sourceConversation.conversationId)).toBe('original unsent draft');
    expect(ask).not.toHaveBeenCalled();
    await act(async () => jest.advanceTimersByTime(4000));
    expect(getDraft(sourceConversation.conversationId)).toBe('original unsent draft');
  });

  it.each([null, 'project-one'])(
    'submits changed settings in an existing conversation with project %p',
    async (chatProjectId) => {
      const conversation = {
        ...initialConversation,
        conversationId: 'existing-chat',
        chatProjectId,
      };
      const view = mountComposer(conversation, {
        query: 'endpoint=openAI&model=gpt-4.1&q=hi&submit=true',
      });
      await act(async () => jest.advanceTimersByTime(100));
      expect(newConversation).toHaveBeenCalledWith(
        expect.objectContaining({
          template: expect.objectContaining({ conversationId: 'existing-chat', chatProjectId }),
          preset: expect.objectContaining({ model: 'gpt-4.1' }),
        }),
      );
      expect(screen.getByTestId('text-input')).toHaveValue('hi');
      expect(screen.getByText('Sending...')).toBeInTheDocument();
      expect(ask).not.toHaveBeenCalled();
      await act(async () => {
        view.rerender(<Harness conversation={{ ...conversation, model: 'gpt-4.1' }} />);
      });
      expect(ask).toHaveBeenCalledTimes(1);
      expect(ask).toHaveBeenCalledWith(expect.objectContaining({ text: 'hi' }), expect.anything());
      expect(view.getLocation().pathname).toBe('/c/existing-chat');
      expect(view.getLocation().search).toBe('');
      await act(async () => jest.advanceTimersByTime(4000));
      expect(ask).toHaveBeenCalledTimes(1);
      expect(screen.queryByText(/Chat settings could not be applied/)).not.toBeInTheDocument();
    },
  );

  it('retains timeout guidance for unapplied settings in an existing project conversation', async () => {
    const conversation = {
      ...initialConversation,
      conversationId: 'existing-chat',
      chatProjectId: 'project-one',
    };
    const view = mountComposer(conversation, {
      query: 'endpoint=openAI&model=gpt-4.1&q=hi&submit=true',
    });
    await act(async () => jest.advanceTimersByTime(100));
    expect(screen.getByText('Sending...')).toBeInTheDocument();
    await act(async () => jest.advanceTimersByTime(3000));
    expect(screen.getByTestId('text-input')).toHaveValue('hi');
    expect(screen.getByText(/Chat settings could not be applied/)).toBeInTheDocument();
    expect(getDraft(conversation.conversationId)).toBe('hi');
    expect(view.getLocation().search).toBe('');
    expect(ask).not.toHaveBeenCalled();
  });

  it('cancels when the existing conversation project changes before settings apply', async () => {
    const conversation = {
      ...initialConversation,
      conversationId: 'existing-chat',
      chatProjectId: 'project-one',
    };
    const view = mountComposer(conversation, {
      query: 'endpoint=openAI&model=gpt-4.1&q=hi&submit=true',
    });
    await act(async () => jest.advanceTimersByTime(100));
    expect(screen.getByText('Sending...')).toBeInTheDocument();
    await act(async () => {
      view.rerender(
        <Harness
          conversation={{ ...conversation, model: 'gpt-4.1', chatProjectId: 'project-two' }}
        />,
      );
    });
    expect(screen.queryByText('Sending...')).not.toBeInTheDocument();
    expect(ask).not.toHaveBeenCalled();
    await act(async () => jest.advanceTimersByTime(4000));
    expect(screen.queryByText(/Chat settings could not be applied/)).not.toBeInTheDocument();
    expect(view.getLocation().search).toContain('submit=true');
    expect(ask).not.toHaveBeenCalled();
  });

  it('clears settled setup guidance when leaving for another chat', async () => {
    setDraft({ id: 'other-chat', value: 'destination draft' });
    const view = mountComposer();
    await act(async () => jest.advanceTimersByTime(3100));
    expect(screen.getByText(/Chat settings could not be applied/)).toBeInTheDocument();
    await act(async () => {
      view.navigate('/c/other-chat');
      view.rerender(
        <Harness conversation={{ ...initialConversation, conversationId: 'other-chat' }} />,
      );
    });
    expect(screen.getByTestId('text-input')).toHaveValue('destination draft');
    expect(screen.queryByText(/Chat settings could not be applied/)).not.toBeInTheDocument();
    expect(ask).not.toHaveBeenCalled();
  });

  it('allows its own URL-preserving switch from an existing chat to a new one', async () => {
    const view = mountComposer({
      ...initialConversation,
      conversationId: 'existing-chat',
      endpoint: EModelEndpoint.assistants,
      assistant_id: 'asst_test',
    });
    await act(async () => jest.advanceTimersByTime(100));
    await act(async () => {
      view.navigate('/c/new?agent_id=agent_test&q=hi&submit=true');
      view.rerender(
        <Harness
          conversation={{
            ...initialConversation,
            endpoint: EModelEndpoint.agents,
            agent_id: 'agent_test',
            model: undefined,
          }}
        />,
      );
    });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ text: 'hi' }), expect.anything());
  });

  it.each(['', 'unrelated saved draft'])(
    'submits across the inherited project rewrite with destination draft %p',
    async (savedText) => {
      setDraft({ id: getNewConversationDraftId(), value: savedText });
      const view = mountComposer({
        ...initialConversation,
        conversationId: 'existing-chat',
        chatProjectId: 'project-one',
        endpoint: EModelEndpoint.assistants,
        assistant_id: 'asst_test',
      });
      await act(async () => jest.advanceTimersByTime(100));
      expect(newConversation).toHaveBeenCalledWith(
        expect.objectContaining({
          template: expect.objectContaining({ chatProjectId: 'project-one' }),
        }),
      );
      await act(async () => {
        view.navigate('/c/new?agent_id=agent_test&q=hi&submit=true&projectId=project-one');
        view.rerender(
          <Harness
            conversation={{
              ...initialConversation,
              endpoint: EModelEndpoint.agents,
              agent_id: 'agent_test',
              model: undefined,
              chatProjectId: 'project-one',
            }}
          />,
        );
      });
      expect(ask).toHaveBeenCalledTimes(1);
      expect(ask).toHaveBeenCalledWith(expect.objectContaining({ text: 'hi' }), expect.anything());
      expect(view.getLocation().search).toBe('?projectId=project-one');
      await act(async () => jest.advanceTimersByTime(4000));
      expect(ask).toHaveBeenCalledTimes(1);
      expect(screen.queryByText(/Chat settings could not be applied/)).not.toBeInTheDocument();
    },
  );

  it('preserves the inherited project during setup-timeout URL cleanup', async () => {
    const view = mountComposer({
      ...initialConversation,
      conversationId: 'existing-chat',
      chatProjectId: 'project-one',
      endpoint: EModelEndpoint.assistants,
      assistant_id: 'asst_test',
    });
    await act(async () => jest.advanceTimersByTime(100));
    await act(async () => {
      view.navigate('/c/new?agent_id=agent_test&q=hi&submit=true&projectId=project-one');
      view.rerender(
        <Harness conversation={{ ...initialConversation, chatProjectId: 'project-one' }} />,
      );
    });
    expect(screen.getByText('Sending...')).toBeInTheDocument();
    await act(async () => jest.advanceTimersByTime(3000));
    expect(screen.getByTestId('text-input')).toHaveValue('hi');
    expect(screen.getByText(/Chat settings could not be applied/)).toBeInTheDocument();
    expect(view.getLocation().search).toBe('?projectId=project-one');
    expect(ask).not.toHaveBeenCalled();
  });

  it('rejects an unrelated project rewrite even when it retains the submission query', async () => {
    const view = mountComposer({
      ...initialConversation,
      conversationId: 'existing-chat',
      chatProjectId: 'project-one',
      endpoint: EModelEndpoint.assistants,
      assistant_id: 'asst_test',
    });
    await act(async () => jest.advanceTimersByTime(100));
    setDraft({ id: getNewConversationDraftId(), value: 'destination draft' });
    await act(async () => {
      view.navigate('/c/new?agent_id=agent_test&q=hi&submit=true&projectId=project-two');
      view.rerender(
        <Harness
          conversation={{
            ...initialConversation,
            endpoint: EModelEndpoint.agents,
            agent_id: 'agent_test',
            model: undefined,
            chatProjectId: 'project-two',
          }}
        />,
      );
    });
    expect(screen.getByTestId('text-input')).toHaveValue('destination draft');
    expect(screen.getByTestId('text-input')).not.toBeDisabled();
    await act(async () => jest.advanceTimersByTime(4000));
    expect(view.getLocation().search).toContain('projectId=project-two');
    expect(screen.getByTestId('text-input')).toHaveValue('destination draft');
    expect(ask).not.toHaveBeenCalled();
  });

  it('sends the visible prompt once when the requested agent reaches the conversation', async () => {
    const view = mountComposer();
    await act(async () => jest.advanceTimersByTime(100));
    view.rerender(
      <Harness
        conversation={{
          ...initialConversation,
          endpoint: EModelEndpoint.agents,
          agent_id: 'agent_test',
          model: undefined,
        }}
      />,
    );
    await act(async () => Promise.resolve());
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ text: 'hi' }), expect.anything());
    expect(screen.queryByText('Sending...')).not.toBeInTheDocument();
    await act(async () => jest.advanceTimersByTime(4000));
    expect(ask).toHaveBeenCalledTimes(1);
  });
});
