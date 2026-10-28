import React, { useMemo, useState } from 'react';
import { getDefaultStore, useAtom } from 'jotai';
import { filesFamily, isSubmittingFamily } from '@librechat/chat/react';
import '@testing-library/jest-dom';
import { RecoilRoot } from 'recoil';
import { DndProvider } from 'react-dnd';
import { useForm } from 'react-hook-form';
import userEvent from '@testing-library/user-event';
import { HTML5Backend } from 'react-dnd-html5-backend';
import { render, screen } from '@testing-library/react';
import { BrowserRouter as Router } from 'react-router-dom';
import { QueryKeys, EModelEndpoint } from 'librechat-data-provider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TFile, TConversation } from 'librechat-data-provider';
import type { ChatFormValues } from '~/common';
import { ChatContext, ChatFormProvider } from '~/Providers';
import { AuthContextProvider } from '~/hooks/AuthContext';
import { SteerHostTestProvider } from 'test/steerHost';
import ChatForm from '../ChatForm';

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
        stopGenerating: () => undefined,
        getMessages: () => undefined,
        setMessages: () => undefined,
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
      }) as unknown as React.ContextType<typeof ChatContext>,
    [files, setFiles, isSubmitting],
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
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
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
