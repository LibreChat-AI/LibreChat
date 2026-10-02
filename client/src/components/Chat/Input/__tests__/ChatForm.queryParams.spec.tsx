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
import type { ChatFormValues } from '~/common';
import { ChatTransportContext, defaultChatTransport } from '~/Providers/ChatTransportContext';
import { getNewConversationDraftId, setDraft } from '~/utils/drafts';
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
const transport = { ...defaultChatTransport, listQueued: async () => [] };

function Harness({ conversation }: { conversation: TConversation }) {
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
      handleStopGenerating: () => undefined,
      stopGenerating: () => Promise.resolve(),
      getMessages: () => [],
      messagesKey: 'new',
      latestMessageId: undefined,
      latestMessageDepth: undefined,
      feedbackEnabled: false,
      setMessages: () => undefined,
      ask,
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
    [conversation, files, setFiles, isSubmitting],
  );
  return (
    <ChatFormProvider {...methods}>
      <ChatContext.Provider value={chatHelpers}>
        <ChatForm
          index={0}
          isLandingPage
          showComposerTips={false}
          enterToSend
          autoSendText={-1}
          speechSettingsInitialized={false}
          footerBelow={false}
          centerFormOnLanding={false}
        />
      </ChatContext.Provider>
    </ChatFormProvider>
  );
}

function mountComposer(conversation = initialConversation) {
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
      <RecoilRoot>
        <MemoryRouter
          initialEntries={[
            `/c/${conversation.conversationId}?agent_id=agent_test&q=hi&submit=true`,
          ]}
        >
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
  const view = render(<Harness conversation={conversation} />, { wrapper });
  return { ...view, navigate: (to: string) => navigate(to), getLocation: () => location };
}

describe('ChatForm URL submission', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    localStorage.clear();
  });

  afterEach(() => {
    jest.useRealTimers();
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
