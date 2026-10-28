import React, { useMemo, useState } from 'react';
import { getDefaultStore, useAtom } from 'jotai';
import { filesFamily, isSubmittingFamily, resetSubmitting } from '@librechat/chat/react';
import '@testing-library/jest-dom';
import { RecoilRoot } from 'recoil';
import { DndProvider } from 'react-dnd';
import { useForm } from 'react-hook-form';
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

let mockComposerLocked = false;

/** The batch card itself is covered by AskUserQuestionCollapse; this pins only
 *  what ChatForm does with the lock, so the popover renders nothing here. */
jest.mock('~/hooks/Input/useAskAnswerMode', () => ({
  __esModule: true,
  default: () => ({
    active: mockComposerLocked,
    batchMode: mockComposerLocked,
    composerAnswers: false,
    composerLocked: mockComposerLocked,
    popoverVisible: false,
    liveAsk: null,
    draftId: null,
    otherLabel: undefined,
    handleComposerKeyDown: () => false,
  }),
}));

const conversation = {
  conversationId: 'conversation-1',
  endpoint: EModelEndpoint.agents,
  agent_id: 'agent-1',
  title: 'Batch',
} as TConversation;

const draft = Array.from({ length: 30 }, (_, line) => `draft line ${line}`).join('\n');

function Harness() {
  const [files, setFiles] = useAtom(filesFamily(0));
  const [isSubmitting] = useAtom(isSubmittingFamily(0));
  const [, setFilesLoading] = useState(false);
  const methods = useForm<ChatFormValues>({ defaultValues: { text: draft } });

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
        <ChatForm index={0} isLandingPage={false} footerBelow={false} centerFormOnLanding={false} />
      </ChatContext.Provider>
    </ChatFormProvider>
  );
}

function renderComposer() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  queryClient.setQueryData<TFile[]>([QueryKeys.files], []);
  queryClient.setQueryData([QueryKeys.endpoints], { [EModelEndpoint.agents]: { order: 0 } });

  return render(
    <QueryClientProvider client={queryClient}>
      <RecoilRoot>
        <SteerHostTestProvider>
          <Router>
            <AuthContextProvider authConfig={{ loginRedirect: '', test: true }}>
              <DndProvider backend={HTML5Backend}>
                <Harness />
              </DndProvider>
            </AuthContextProvider>
          </Router>
        </SteerHostTestProvider>
      </RecoilRoot>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  resetSubmitting(getDefaultStore());
  getDefaultStore().set(filesFamily(0), new Map());
});

describe('ChatForm behind a batch question', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test('holds a long draft to one line while the batch card owns the composer', async () => {
    mockComposerLocked = true;
    renderComposer();

    const textarea = await screen.findByTestId('text-input');
    expect(textarea).toBeDisabled();
    expect(textarea).toHaveClass('max-h-[3.25rem]');
    expect(textarea).not.toHaveClass('max-h-[45vh]');
  }, 20000);

  test('gives the draft its full height back once the batch releases the composer', async () => {
    mockComposerLocked = false;
    renderComposer();

    const textarea = await screen.findByTestId('text-input');
    expect(textarea).toBeEnabled();
    expect(textarea).toHaveClass('max-h-[45vh]');
    expect(textarea).not.toHaveClass('max-h-[3.25rem]');
  }, 20000);
});
