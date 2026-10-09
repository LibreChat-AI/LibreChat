import React, { useMemo, useState } from 'react';
import '@testing-library/jest-dom';
import { DndProvider } from 'react-dnd';
import { useForm } from 'react-hook-form';
import { RecoilRoot, useRecoilState } from 'recoil';
import userEvent from '@testing-library/user-event';
import { HTML5Backend } from 'react-dnd-html5-backend';
import { BrowserRouter as Router } from 'react-router-dom';
import { render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  Tools,
  QueryKeys,
  EModelEndpoint,
  mcpServerToggleKey,
  defaultAgentCapabilities,
} from 'librechat-data-provider';
import type { Agent, TConversation } from 'librechat-data-provider';
import type { ChatFormValues } from '~/common';
import { ChatContext, ChatFormProvider } from '~/Providers';
import { AuthContextProvider } from '~/hooks/AuthContext';
import ChatForm from '../ChatForm';
import store from '~/store';

const mockApplySwitches = jest.fn();

/* AutoSizer measures its parent, which is zero in jsdom, and a zero size renders
   no rows at all. */
jest.mock('react-virtualized', () => {
  const actual = jest.requireActual('react-virtualized');
  return {
    ...actual,
    AutoSizer: ({ children }: { children: (size: { width: number }) => React.ReactNode }) =>
      children({ width: 640 }),
  };
});

jest.mock('~/hooks/Generic/useElementSize', () => ({
  __esModule: true,
  default: () => ({ ref: { current: null }, height: 600, width: 0 }),
}));

jest.mock('~/hooks/Roles/useHasAccess', () => ({
  __esModule: true,
  default: () => true,
}));

jest.mock('~/hooks/Agents/useApplyAgentToolSwitches', () => ({
  useApplyAgentToolSwitches: (args: unknown) => mockApplySwitches(args),
}));

const savedAgent: Partial<Agent> = {
  id: 'agent_1',
  tools: [Tools.web_search, Tools.execute_code, 'search_mcp_docs'],
  tool_options: {
    [Tools.web_search]: { user_toggle: 'on' },
    [mcpServerToggleKey('docs')]: { user_toggle: 'off' },
  },
};

let conversation: TConversation;

function Harness() {
  const [files, setFiles] = useRecoilState(store.filesByIndex(0));
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
        isSubmitting: false,
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
      }) as unknown as React.ContextType<typeof ChatContext>,
    [files, setFiles],
  );
  return (
    <ChatFormProvider {...methods}>
      <ChatContext.Provider value={chatHelpers}>
        <ChatForm
          index={0}
          isLandingPage={false}
          speechSettingsInitialized
          footerBelow={false}
          centerFormOnLanding={false}
        />
      </ChatContext.Provider>
    </ChatFormProvider>
  );
}

function renderComposer(agent?: Partial<Agent>) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  queryClient.setQueryData([QueryKeys.endpoints], {
    [conversation.endpoint as string]: { capabilities: defaultAgentCapabilities },
  });
  if (agent && conversation.agent_id) {
    queryClient.setQueryData([QueryKeys.agent, conversation.agent_id], agent);
  }
  return render(
    <QueryClientProvider client={queryClient}>
      <RecoilRoot>
        <Router>
          <AuthContextProvider authConfig={{ loginRedirect: '', test: true }}>
            <DndProvider backend={HTML5Backend}>
              <main>
                <Harness />
              </main>
            </DndProvider>
          </AuthContextProvider>
        </Router>
      </RecoilRoot>
    </QueryClientProvider>,
  );
}

const openPalette = async () => {
  await userEvent.click(await screen.findByTestId('composer-palette-button'));
  return screen.findByRole('dialog', { name: 'Attach and tools' });
};

describe('Composer palette agent switches', () => {
  beforeEach(() => {
    localStorage.clear();
    jest.clearAllMocks();
  });

  it('seeds a saved agent chat and keeps the surface off for an agent without switches', async () => {
    conversation = {
      conversationId: 'convo_1',
      endpoint: EModelEndpoint.agents,
      agent_id: 'agent_1',
    } as TConversation;
    renderComposer(savedAgent);
    await openPalette();

    expect(mockApplySwitches).toHaveBeenCalledWith({
      agent: savedAgent,
      conversationId: 'convo_1',
    });
  });

  it('offers a saved agent chat only its switchable tools', async () => {
    conversation = {
      conversationId: 'convo_1',
      endpoint: EModelEndpoint.agents,
      agent_id: 'agent_1',
    } as TConversation;
    renderComposer(savedAgent);
    const palette = await openPalette();

    expect(await within(palette).findByText('Web Search')).toBeInTheDocument();
    expect(within(palette).queryByText('Run Code')).not.toBeInTheDocument();
    expect(within(palette).queryByText('File Search')).not.toBeInTheDocument();
    expect(within(palette).queryByText('Skills')).not.toBeInTheDocument();
    expect(within(palette).queryByText('Memory')).not.toBeInTheDocument();
    expect(within(palette).queryByText('Artifacts')).not.toBeInTheDocument();
  });

  it('offers no tools for a saved agent without switches', async () => {
    conversation = {
      conversationId: 'convo_1',
      endpoint: EModelEndpoint.agents,
      agent_id: 'agent_1',
    } as TConversation;
    renderComposer({ id: 'agent_1', tools: [Tools.web_search] });
    const palette = await openPalette();

    expect(within(palette).queryByText('Web Search')).not.toBeInTheDocument();
    expect(within(palette).queryByText('Run Code')).not.toBeInTheDocument();
  });

  it('keeps the full tool set for ephemeral chats', async () => {
    conversation = {
      conversationId: 'convo_1',
      endpoint: EModelEndpoint.openAI,
    } as TConversation;
    renderComposer();
    const palette = await openPalette();

    expect(await within(palette).findByText('Web Search')).toBeInTheDocument();
    expect(within(palette).getByText('Run Code')).toBeInTheDocument();
    expect(within(palette).getByText('File Search')).toBeInTheDocument();
  });
});
