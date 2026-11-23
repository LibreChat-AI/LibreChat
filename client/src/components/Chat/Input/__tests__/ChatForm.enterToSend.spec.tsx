import React, { useMemo, useState } from 'react';
import { getDefaultStore, useAtom } from 'jotai';
import { filesFamily, isSubmittingFamily } from '@librechat/chat/react';
import '@testing-library/jest-dom';
import axios from 'axios';
import { RecoilRoot } from 'recoil';
import { DndProvider } from 'react-dnd';
import { useForm } from 'react-hook-form';
import userEvent from '@testing-library/user-event';
import { HTML5Backend } from 'react-dnd-html5-backend';
import { BrowserRouter as Router } from 'react-router-dom';
import { QueryKeys, EModelEndpoint } from 'librechat-data-provider';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import type { TMessage, TFile, TConversation } from 'librechat-data-provider';
import type { ChatFormValues } from '~/common';
import { createMessageCache } from '~/Providers/ChatHostContext';
import { ChatContext, ChatFormProvider } from '~/Providers';
import { AuthContextProvider } from '~/hooks/AuthContext';
import { SteerHostTestProvider } from 'test/steerHost';
import { startupConfigKey } from '~/data-provider';
import ChatForm from '../ChatForm';

const startupConfig = { interface: { contextUsage: true }, modelSpecs: { list: [] } };
const originalAdapter = axios.defaults.adapter;

beforeEach(() => {
  axios.defaults.adapter = async (config) => {
    if (config.url === '/api/config') {
      return { data: startupConfig, status: 200, statusText: 'OK', headers: {}, config };
    }
    throw new Error('Composer fixture blocks external API requests');
  };
});

afterEach(() => {
  axios.defaults.adapter = originalAdapter;
});

const conversation = {
  conversationId: 'new',
  endpoint: EModelEndpoint.openAI,
  model: 'gpt-4o',
  title: 'New Chat',
} as TConversation;

/**
 * The atom keeps its default (`atomWithLocalStorage('enterToSend', true)`)
 * here: these tests prove the composer follows the `enterToSend` prop ChatView
 * passes it, not the atom it used to read directly, so each value is covered.
 */
function Harness({ enterToSend }: { enterToSend: boolean }) {
  const queryClient = useQueryClient();
  const messageCache = useMemo(() => createMessageCache(queryClient), [queryClient]);
  const [files, setFiles] = useAtom(filesFamily(0));
  const [isSubmitting] = useAtom(isSubmittingFamily(0));
  const [, setFilesLoading] = useState(false);
  const methods = useForm<ChatFormValues>({ defaultValues: { text: '' } });

  const chatHelpers = useMemo(
    () =>
      ({
        index: 0,
        conversation,
        setConversation: () => undefined,
        files,
        setFiles,
        isSubmitting,
        setIsSubmitting: () => undefined,
        filesLoading: false,
        setFilesLoading,
        newConversation: () => undefined,
        handleStopGenerating: () => undefined,
        stopGenerating: () => Promise.resolve(),
        getMessages: (targetConversationId?: string | null) =>
          messageCache.read(targetConversationId ?? conversation.conversationId ?? ''),
        messagesKey: conversation.conversationId ?? '',
        latestMessageId: undefined,
        latestMessageDepth: undefined,
        subscribeMessages: (onChange: () => void) =>
          messageCache.subscribe(conversation.conversationId ?? '', onChange),
        getMessagesRevision: () => messageCache.revision(conversation.conversationId ?? ''),
        useLiveAttachments: () => ({}),
        getMappingOptions: () => ({}),
        feedbackEnabled: false,
        setMessages: (messages: TMessage[]) =>
          messageCache.write(conversation.conversationId ?? '', messages),
        ask: () => undefined,
        regenerate: () => undefined,
        setSiblingIdx: () => undefined,
        abortScroll: false,
        setAbortScroll: () => undefined,
        preset: null,
        setPreset: () => undefined,
        optionSettings: {},
        setOptionSettings: () => undefined,
        handleRegenerate: () => undefined,
        handleContinue: () => undefined,
      }) satisfies React.ContextType<typeof ChatContext>,
    [files, setFiles, isSubmitting, messageCache],
  );

  return (
    <ChatFormProvider {...methods}>
      <ChatContext.Provider value={chatHelpers}>
        <ChatForm
          index={0}
          isLandingPage={false}
          enterToSend={enterToSend}
          footerBelow={false}
          centerFormOnLanding={false}
        />
      </ChatContext.Provider>
    </ChatFormProvider>
  );
}

function renderComposer({ enterToSend }: { enterToSend: boolean }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
  });
  queryClient.setQueryData(startupConfigKey(true), startupConfig);
  queryClient.setQueryData(startupConfigKey(false), startupConfig);
  queryClient.setQueryData<TFile[]>([QueryKeys.files], []);
  queryClient.setQueryData([QueryKeys.endpoints], { [EModelEndpoint.openAI]: { order: 0 } });

  return render(
    <QueryClientProvider client={queryClient}>
      <RecoilRoot>
        <SteerHostTestProvider>
          <Router>
            <AuthContextProvider authConfig={{ loginRedirect: '', test: true }}>
              <DndProvider backend={HTML5Backend}>
                <Harness enterToSend={enterToSend} />
              </DndProvider>
            </AuthContextProvider>
          </Router>
        </SteerHostTestProvider>
      </RecoilRoot>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  getDefaultStore().set(filesFamily(0), new Map());
});

describe('ChatForm enterToSend prop', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test('follows the prop when it disagrees with the persisted default', async () => {
    renderComposer({ enterToSend: false });

    const textarea = await screen.findByTestId('text-input');
    await userEvent.type(textarea, 'hi');

    const hint = document.getElementById('composer-hint-0') as HTMLElement;
    expect(hint).toHaveTextContent('to send');
    expect(hint).toHaveTextContent('for newline');
    expect(hint).not.toHaveTextContent('Enter to send');
  }, 20000);

  test('follows the prop when it agrees with the persisted default', async () => {
    renderComposer({ enterToSend: true });

    const textarea = await screen.findByTestId('text-input');
    await userEvent.type(textarea, 'hi');

    const hint = document.getElementById('composer-hint-0') as HTMLElement;
    expect(hint).toHaveTextContent('Enter to send');
  }, 20000);
});

describe('ChatForm textarea identity', () => {
  /** jsdom lays nothing out; give the draft five rows so the collapse control appears. */
  let scrollHeight: jest.SpyInstance;
  let computedStyle: jest.SpyInstance;

  beforeEach(() => {
    localStorage.clear();
    scrollHeight = jest
      .spyOn(HTMLTextAreaElement.prototype, 'scrollHeight', 'get')
      .mockReturnValue(100);
    const real = window.getComputedStyle.bind(window);
    computedStyle = jest.spyOn(window, 'getComputedStyle').mockImplementation((element) => {
      const style = real(element);
      if (!(element instanceof HTMLTextAreaElement)) {
        return style;
      }
      return new Proxy(style, {
        get: (target, key) => {
          if (key === 'lineHeight') {
            return '20px';
          }
          const value = Reflect.get(target, key, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    });
  });

  afterEach(() => {
    computedStyle.mockRestore();
    scrollHeight.mockRestore();
    getDefaultStore().set(isSubmittingFamily(0), false);
  });

  /** A remount would drop focus, IME composition and the form library's registration. */
  test('keeps the same textarea node across a collapse toggle and a run start', async () => {
    renderComposer({ enterToSend: true });

    const textarea = await screen.findByTestId('text-input');
    await userEvent.type(textarea, 'one{Shift>}{Enter}{/Shift}two');
    expect(textarea).toHaveValue('one\ntwo');

    fireEvent.click(await screen.findByRole('button', { name: 'Collapse Chat' }));
    expect(await screen.findByRole('button', { name: 'Expand Chat' })).toBeInTheDocument();
    expect(screen.getByTestId('text-input')).toBe(textarea);

    act(() => {
      getDefaultStore().set(isSubmittingFamily(0), true);
    });
    expect(screen.getByTestId('text-input')).toBe(textarea);
  }, 20000);
});
