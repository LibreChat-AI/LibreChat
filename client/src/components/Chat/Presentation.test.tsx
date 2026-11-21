import React from 'react';
import { RecoilRoot, useSetRecoilState } from 'recoil';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  sideChatAtom,
  activeSubagentPanel,
  isSubmittingFamily,
  sideChatBesideAtom,
  sideChatRequestAtom,
  sideChatAvailableAtom,
} from '@librechat/chat/react';
import type { TConversation, TStartupConfig } from 'librechat-data-provider';
import type { SideChat } from '@librechat/chat/react';
import type { JotaiStore } from 'test/harness';
import type { Artifact } from '~/common';
import { prepareUndockedDocument } from '~/components/Artifacts/undockedWindow';
import { undockedArtifacts } from '~/components/Artifacts/state';
import { SubagentIndexHostProvider } from 'test/streamHost';
import { ChatSurfaceHarness } from 'test/harness';
import Presentation from './Presentation';
import store from '~/store';

const renderPresentation = (element: React.ReactElement) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(element, {
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>
        <SubagentIndexHostProvider>{children}</SubagentIndexHostProvider>
      </QueryClientProvider>
    ),
  });
};

const mockArtifactPanelLabel = 'Artifact panel loaded';
const mockOpenArtifactLabel = 'Open Artifact';
const mockChildPanelLabel = 'Child activity panel loaded';
const mockOpenChildLabel = 'Open Child Activity';
const mockSideChatLabel = 'Side chat loaded';
const mockOpenSideChatLabel = 'Open Side Chat';
const mockAskSideChatLabel = 'Ask for a side chat';
let mockSideChatProps: {
  chat: SideChat;
  onClose: () => void;
  onHandedTextTaken: (expected: SideChat) => void;
};
const mockSelectAgentConversationLabel = 'Select Agent Conversation';
const mockStartAgentRunLabel = 'Start Agent Run';
/**
 * The deployment's config, as the server would answer the app's own config query. It does not
 * answer until a test makes it, so the config is unknown, as it is while the page loads.
 */
const mockGetStartupConfig = jest.fn<Promise<Partial<TStartupConfig>>, []>();
const unanswered = () => new Promise<Partial<TStartupConfig>>(() => undefined);
jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      getStartupConfig: () => mockGetStartupConfig(),
    },
  };
});
const mockUseParentSubagentsQuery = jest.fn(
  (_conversationId?: string, _config?: unknown, _isSubmitting?: boolean) => ({
    data: undefined,
    refetch: jest.fn(),
  }),
);

jest.mock('~/components/Artifacts/Artifacts', () => {
  const artifactPanelLabel = 'Artifact panel loaded';
  const testGlobal = globalThis as typeof globalThis & {
    presentationArtifactModuleEvaluations?: number;
  };
  testGlobal.presentationArtifactModuleEvaluations =
    (testGlobal.presentationArtifactModuleEvaluations ?? 0) + 1;
  return {
    __esModule: true,
    default: () => <aside>{artifactPanelLabel}</aside>,
  };
});

jest.mock('@librechat/chat/components', () => {
  const { useParentSubagents } =
    jest.requireActual<typeof import('@librechat/chat/react')>('@librechat/chat/react');
  return {
    ...jest.requireActual<typeof import('@librechat/chat/components')>(
      '@librechat/chat/components',
    ),
    loadSideChatPanel: () =>
      Promise.resolve({
        default: function MockSideChatPanel(props: typeof mockSideChatProps) {
          mockSideChatProps = props;
          const parent = useParentSubagents();
          return (
            <aside>
              {mockSideChatLabel}
              <span data-testid="side-parent">{parent.conversationId}</span>
            </aside>
          );
        },
      }),
    loadSubagentThreadPanel: () =>
      Promise.resolve({
        default: function MockSubagentThreadPanel() {
          const parent = useParentSubagents();
          return (
            <aside>
              {mockChildPanelLabel}
              <span data-testid="panel-parent">{parent.conversationId}</span>
              <input aria-label="Panel draft" />
            </aside>
          );
        },
      }),
  };
});

/** The mocked panel draws no message rows, so it needs no app message hosts. */
jest.mock('~/components/Chat/Messages/hosts', () => ({}));

jest.mock('~/components/Chat/Input/Files/DragDropWrapper', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

jest.mock('~/components/SidePanel', () => ({
  SidePanelGroup: ({ panel, children }: { panel: React.ReactNode; children: React.ReactNode }) => (
    <div data-testid="side-panel-group">
      {children}
      {panel}
    </div>
  ),
}));

jest.mock('~/Providers', () => ({
  ArtifactsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  EditorProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

jest.mock('~/hooks/Artifacts/useArtifactsRegistryLifetime', () => ({
  __esModule: true,
  default: jest.fn(),
}));

jest.mock('~/data-provider', () => ({
  useDeleteFilesMutation: () => ({ mutateAsync: jest.fn() }),
  /** The app's real config query; what it is answered with is set at the data service. */
  useGetStartupConfig: (...args: unknown[]) =>
    jest.requireActual('~/data-provider').useGetStartupConfig(...args),
  useParentSubagentsQuery: (conversationId: string, config?: unknown, isSubmitting?: boolean) =>
    mockUseParentSubagentsQuery(conversationId, config, isSubmitting),
}));

jest.mock('~/hooks', () => ({
  useSetFilesToDelete: () => jest.fn(),
  useLocalize:
    () =>
    (key: string): string =>
      key,
}));

const OpenArtifactPanel = () => {
  const setArtifacts = useSetRecoilState(store.artifactsState);
  const setCurrentArtifactId = useSetRecoilState(store.currentArtifactId);
  const setArtifactsVisible = useSetRecoilState(store.artifactsVisibility);

  const open = () => {
    const artifact: Artifact = {
      id: 'mermaid-artifact',
      type: 'application/vnd.mermaid',
      title: 'Diagram',
      content: 'graph TD\nA-->B',
      lastUpdateTime: 1,
    };
    setArtifacts({ [artifact.id]: artifact });
    setCurrentArtifactId(artifact.id);
    setArtifactsVisible(true);
  };

  return (
    <button type="button" onClick={open}>
      {mockOpenArtifactLabel}
    </button>
  );
};

const OpenSubagentPanel = ({ durable = true }: { durable?: boolean }) => {
  const setConversation = useSetRecoilState(store.conversationByIndex(0));
  const setSelection = useSetAtom(activeSubagentPanel);
  const open = () => {
    setConversation({ conversationId: 'parent-conversation' } as TConversation);
    setSelection({
      host: 'conversation',
      parentConversationId: 'parent-conversation',
      parentMessageId: 'parent-message',
      toolCallId: 'tool-call',
      partIndex: 0,
      subagentType: 'researcher',
      initialProgress: 1,
      isSubmitting: false,
      durable: durable ? { threadId: 'child-thread', taskId: 'background-task' } : undefined,
    });
  };
  return (
    <button type="button" onClick={open}>
      {mockOpenChildLabel}
    </button>
  );
};

const OpenSideChat = () => {
  const setConversation = useSetRecoilState(store.conversationByIndex(0));
  const setSideChat = useSetAtom(sideChatAtom);
  const open = () => {
    setConversation({ conversationId: 'parent-conversation' } as TConversation);
    setSideChat({
      conversation: {
        conversationId: 'side-conversation',
        endpoint: 'agents',
        agent_id: 'agent-1',
      } as TConversation,
    });
  };
  return (
    <button type="button" onClick={open}>
      {mockOpenSideChatLabel}
    </button>
  );
};

const SelectAgentConversation = () => {
  const setConversation = useSetRecoilState(store.conversationByIndex(0));
  return (
    <button
      type="button"
      onClick={() =>
        setConversation({
          conversationId: 'agent-conversation',
          endpoint: 'agents',
          agent_id: 'agent-1',
        } as TConversation)
      }
    >
      {mockSelectAgentConversationLabel}
    </button>
  );
};

const StartAgentRun = () => {
  const setSubmitting = useSetAtom(isSubmittingFamily(0));
  return (
    <button type="button" onClick={() => setSubmitting(true)}>
      {mockStartAgentRunLabel}
    </button>
  );
};

describe('Presentation Artifact loading', () => {
  beforeEach(() => {
    mockGetStartupConfig.mockReset();
    mockGetStartupConfig.mockImplementation(unanswered);
  });

  it('loads the Artifact panel bundle only when the panel is opened', async () => {
    const testGlobal = globalThis as typeof globalThis & {
      presentationArtifactModuleEvaluations?: number;
    };

    renderPresentation(
      <ChatSurfaceHarness>
        <RecoilRoot>
          <Presentation>
            <OpenArtifactPanel />
          </Presentation>
        </RecoilRoot>
      </ChatSurfaceHarness>,
    );

    expect(testGlobal.presentationArtifactModuleEvaluations ?? 0).toBe(0);

    fireEvent.click(screen.getByRole('button', { name: mockOpenArtifactLabel }));

    expect(await screen.findByText(mockArtifactPanelLabel)).toBeInTheDocument();
    expect(testGlobal.presentationArtifactModuleEvaluations).toBe(1);
    expect(mockUseParentSubagentsQuery).toHaveBeenCalledWith('', { enabled: false }, false);
  });

  it('gives the session rail a column of its own, past the side panel', () => {
    renderPresentation(
      <ChatSurfaceHarness>
        <RecoilRoot>
          <Presentation>
            <div />
          </Presentation>
        </RecoilRoot>
      </ChatSurfaceHarness>,
    );

    const slot = screen.getByTestId('session-rail-slot');
    const group = screen.getByTestId('side-panel-group');
    expect(group.nextElementSibling).toBe(slot);
    expect(group).not.toContainElement(slot);
    /** Empty, the column takes no room: it is not a box until a rail is drawn in it. */
    expect(slot).toHaveClass('contents');
    expect(slot).toBeEmptyDOMElement();
  });

  it('loads the parent child index only for Agent conversations', () => {
    renderPresentation(
      <ChatSurfaceHarness>
        <RecoilRoot>
          <Presentation>
            <SelectAgentConversation />
            <StartAgentRun />
          </Presentation>
        </RecoilRoot>
      </ChatSurfaceHarness>,
    );

    expect(mockUseParentSubagentsQuery).toHaveBeenLastCalledWith('', { enabled: false }, false);
    fireEvent.click(screen.getByRole('button', { name: mockSelectAgentConversationLabel }));
    expect(mockUseParentSubagentsQuery).toHaveBeenLastCalledWith(
      'agent-conversation',
      { enabled: true },
      false,
    );
    fireEvent.click(screen.getByRole('button', { name: mockStartAgentRunLabel }));
    expect(mockUseParentSubagentsQuery).toHaveBeenLastCalledWith(
      'agent-conversation',
      { enabled: true },
      true,
    );
  });

  it('keeps durable activity and its draft bound to the original parent after navigation', async () => {
    renderPresentation(
      <ChatSurfaceHarness>
        <RecoilRoot>
          <Presentation>
            <OpenSubagentPanel />
            <SelectAgentConversation />
          </Presentation>
        </RecoilRoot>
      </ChatSurfaceHarness>,
    );
    fireEvent.click(screen.getByRole('button', { name: mockOpenChildLabel }));
    expect(await screen.findByText(mockChildPanelLabel)).toBeInTheDocument();
    const draft = screen.getByLabelText('Panel draft');
    fireEvent.change(draft, { target: { value: 'Keep this guidance.' } });
    fireEvent.click(screen.getByRole('button', { name: mockSelectAgentConversationLabel }));
    expect(screen.getByText(mockChildPanelLabel)).toBeInTheDocument();
    expect(screen.getByTestId('panel-parent')).toHaveTextContent('parent-conversation');
    expect(screen.getByLabelText('Panel draft')).toBe(draft);
    expect(draft).toHaveValue('Keep this guidance.');
  });

  it('clears the durable selection when its authenticated chat host unmounts', async () => {
    let atoms: JotaiStore;
    const view = renderPresentation(
      <ChatSurfaceHarness
        seed={(store) => {
          atoms = store;
        }}
      >
        <RecoilRoot>
          <Presentation>
            <OpenSubagentPanel />
          </Presentation>
        </RecoilRoot>
      </ChatSurfaceHarness>,
    );
    fireEvent.click(screen.getByRole('button', { name: mockOpenChildLabel }));
    expect(await screen.findByText(mockChildPanelLabel)).toBeInTheDocument();
    view.unmount();
    expect(atoms!.get(activeSubagentPanel)).toBeNull();
  });

  it('still closes non-durable activity when leaving its parent chat', async () => {
    renderPresentation(
      <ChatSurfaceHarness>
        <RecoilRoot>
          <Presentation>
            <OpenSubagentPanel durable={false} />
            <SelectAgentConversation />
          </Presentation>
        </RecoilRoot>
      </ChatSurfaceHarness>,
    );
    fireEvent.click(screen.getByRole('button', { name: mockOpenChildLabel }));
    expect(await screen.findByText(mockChildPanelLabel)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: mockSelectAgentConversationLabel }));
    expect(screen.queryByText(mockChildPanelLabel)).not.toBeInTheDocument();
  });

  it('uses one panel slot and lets an opened artifact replace child activity', async () => {
    renderPresentation(
      <ChatSurfaceHarness>
        <RecoilRoot>
          <Presentation>
            <OpenSubagentPanel />
            <OpenArtifactPanel />
          </Presentation>
        </RecoilRoot>
      </ChatSurfaceHarness>,
    );

    fireEvent.click(screen.getByRole('button', { name: mockOpenChildLabel }));
    expect(await screen.findByText(mockChildPanelLabel)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: mockOpenArtifactLabel }));
    expect(await screen.findByText(mockArtifactPanelLabel)).toBeInTheDocument();
    expect(screen.queryByText(mockChildPanelLabel)).not.toBeInTheDocument();
  });

  /* Undocked, the artifacts pane is in its own window and the side panel is
   * free: a child-activity panel opened there has to stay open. */
  it('keeps child activity in the side panel while the artifacts pane is undocked', async () => {
    const detachedDocument = document.implementation.createHTMLDocument('');
    const root = prepareUndockedDocument(document, detachedDocument);
    const detachedWindow = {
      document: detachedDocument,
      closed: false,
      outerWidth: 900,
      outerHeight: 700,
      screenX: 0,
      screenY: 0,
      focus: jest.fn(),
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      close: jest.fn(),
    } as unknown as Window;

    renderPresentation(
      <ChatSurfaceHarness
        seed={(store) => store.set(undockedArtifacts, { window: detachedWindow, root })}
      >
        <RecoilRoot>
          <Presentation>
            <OpenSubagentPanel />
            <OpenArtifactPanel />
          </Presentation>
        </RecoilRoot>
      </ChatSurfaceHarness>,
    );

    fireEvent.click(screen.getByRole('button', { name: mockOpenArtifactLabel }));
    fireEvent.click(screen.getByRole('button', { name: mockOpenChildLabel }));

    expect(await screen.findByText(mockChildPanelLabel)).toBeInTheDocument();
    expect(screen.queryByText(mockArtifactPanelLabel)).not.toBeInTheDocument();
    await waitFor(() =>
      expect(detachedDocument.body.textContent).toContain(mockArtifactPanelLabel),
    );
  });

  it.each(['same', 'different'] as const)(
    'an old pane callback cannot close or consume a newer %s destination handoff',
    async (destination) => {
      let atoms!: JotaiStore;
      renderPresentation(
        <ChatSurfaceHarness
          seed={(store) => {
            atoms = store;
          }}
        >
          <RecoilRoot>
            <Presentation>
              <OpenSideChat />
            </Presentation>
          </RecoilRoot>
        </ChatSurfaceHarness>,
      );
      fireEvent.click(screen.getByRole('button', { name: mockOpenSideChatLabel }));
      await screen.findByText(mockSideChatLabel);
      const conversation = atoms.get(sideChatAtom)!.conversation;
      const captured = mockSideChatProps.chat;
      const consume = mockSideChatProps.onHandedTextTaken;
      const close = mockSideChatProps.onClose;
      act(() => {
        atoms.set(sideChatAtom, {
          conversation: {
            ...conversation,
            conversationId: destination === 'same' ? conversation.conversationId : 'new-side',
          },
          text: 'Same question.',
        });
      });
      const replacement = atoms.get(sideChatAtom)!;
      expect(replacement).not.toBe(captured);
      act(() => {
        consume(captured);
        close();
      });
      expect(atoms.get(sideChatAtom)).toBe(replacement);
      expect(atoms.get(sideChatAtom)?.text).toBe('Same question.');
      act(() => mockSideChatProps.onHandedTextTaken(replacement));
      expect(atoms.get(sideChatAtom)?.text).toBeUndefined();
      act(() => mockSideChatProps.onClose());
      expect(atoms.get(sideChatAtom)).toBeNull();
    },
  );

  it('shows a side chat beside the conversation, with child activity read for its own conversation', async () => {
    renderPresentation(
      <ChatSurfaceHarness>
        <RecoilRoot>
          <Presentation>
            <OpenSideChat />
            <OpenSubagentPanel />
            <SelectAgentConversation />
          </Presentation>
        </RecoilRoot>
      </ChatSurfaceHarness>,
    );
    fireEvent.click(screen.getByRole('button', { name: mockOpenSideChatLabel }));

    expect(await screen.findByText(mockSideChatLabel)).toBeInTheDocument();
    /** Children its agent dispatches belong to the side conversation, not the one beside it. */
    expect(screen.getByTestId('side-parent')).toHaveTextContent('side-conversation');
    expect(mockUseParentSubagentsQuery).toHaveBeenCalledWith(
      'side-conversation',
      { enabled: true },
      false,
    );

    /** One panel at a time: a child's activity opened afterwards takes its place. */
    fireEvent.click(screen.getByRole('button', { name: mockOpenChildLabel }));
    expect(await screen.findByText(mockChildPanelLabel)).toBeInTheDocument();
    expect(screen.queryByText(mockSideChatLabel)).not.toBeInTheDocument();
  });

  it('closes the side chat when the conversation it sits beside changes', async () => {
    renderPresentation(
      <ChatSurfaceHarness>
        <RecoilRoot>
          <Presentation>
            <OpenSideChat />
            <SelectAgentConversation />
          </Presentation>
        </RecoilRoot>
      </ChatSurfaceHarness>,
    );
    fireEvent.click(screen.getByRole('button', { name: mockOpenSideChatLabel }));
    expect(await screen.findByText(mockSideChatLabel)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: mockSelectAgentConversationLabel }));
    await waitFor(() => expect(screen.queryByText(mockSideChatLabel)).not.toBeInTheDocument());
  });

  describe('whether a side chat can be opened', () => {
    const SideChatAvailability = () => (
      <>
        <span data-testid="side-chat-available">{String(useAtomValue(sideChatAvailableAtom))}</span>
        <span data-testid="side-chat-beside">
          {JSON.stringify(useAtomValue(sideChatBesideAtom))}
        </span>
      </>
    );
    const mount = () =>
      renderPresentation(
        <ChatSurfaceHarness>
          <RecoilRoot>
            <SideChatAvailability />
            <Presentation>
              <SelectAgentConversation />
            </Presentation>
          </RecoilRoot>
        </ChatSurfaceHarness>,
      );
    const available = () => screen.getByTestId('side-chat-available').textContent;

    it('is not, until the deployment has answered, and is once it has', async () => {
      let answer: (config: Partial<TStartupConfig>) => void = () => undefined;
      mockGetStartupConfig.mockReturnValue(
        new Promise((resolve) => {
          answer = resolve;
        }),
      );
      mount();
      expect(available()).toBe('false');

      await act(async () => answer({ interface: {} } as Partial<TStartupConfig>));

      await waitFor(() => expect(available()).toBe('true'));
    });

    it('names the chat it would sit beside, and names another once the reader moves', async () => {
      mockGetStartupConfig.mockResolvedValue({ interface: {} } as Partial<TStartupConfig>);
      mount();
      await waitFor(() =>
        expect(screen.getByTestId('side-chat-beside')).toHaveTextContent(
          JSON.stringify({ conversationId: null }),
        ),
      );

      fireEvent.click(screen.getByRole('button', { name: mockSelectAgentConversationLabel }));

      expect(screen.getByTestId('side-chat-beside')).toHaveTextContent(
        JSON.stringify({ conversationId: 'agent-conversation' }),
      );
    });

    it('is not where the deployment turned side chats off', async () => {
      mockGetStartupConfig.mockResolvedValue({
        interface: { sideChat: false },
      } as Partial<TStartupConfig>);
      mount();
      /** The config is in: the answer is no, not merely not yet. */
      await waitFor(() => expect(mockGetStartupConfig).toHaveBeenCalled());
      await act(async () => undefined);

      expect(available()).toBe('false');
      expect(screen.getByTestId('side-chat-beside')).toHaveTextContent('null');
    });
  });

  it('gives the panel slot to a side chat opened while another panel is showing', async () => {
    renderPresentation(
      <ChatSurfaceHarness>
        <RecoilRoot>
          <Presentation>
            <OpenSubagentPanel />
            <OpenArtifactPanel />
            <OpenSideChat />
          </Presentation>
        </RecoilRoot>
      </ChatSurfaceHarness>,
    );

    /** A child's activity holds the slot; the side chat asked for after it takes it. */
    fireEvent.click(screen.getByRole('button', { name: mockOpenChildLabel }));
    expect(await screen.findByText(mockChildPanelLabel)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: mockOpenSideChatLabel }));
    expect(await screen.findByText(mockSideChatLabel)).toBeInTheDocument();
    expect(screen.queryByText(mockChildPanelLabel)).not.toBeInTheDocument();

    /** The same from an artifact, and back: the panel asked for last is the one shown. */
    fireEvent.click(screen.getByRole('button', { name: mockOpenArtifactLabel }));
    expect(await screen.findByText(mockArtifactPanelLabel)).toBeInTheDocument();
    expect(screen.queryByText(mockSideChatLabel)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: mockOpenSideChatLabel }));
    expect(await screen.findByText(mockSideChatLabel)).toBeInTheDocument();
    expect(screen.queryByText(mockArtifactPanelLabel)).not.toBeInTheDocument();
  });

  describe('a side chat still being fetched', () => {
    /** Stands in for a menu that asked to open one and is waiting on its record. */
    const PendingSideChat = () => {
      const [request, setRequest] = useAtom(sideChatRequestAtom);
      return (
        <>
          <button type="button" onClick={() => setRequest({})}>
            {mockAskSideChatLabel}
          </button>
          <span data-testid="side-chat-request">{request == null ? 'none' : 'waiting'}</span>
        </>
      );
    };
    const mount = () =>
      renderPresentation(
        <ChatSurfaceHarness>
          <RecoilRoot>
            <Presentation>
              <PendingSideChat />
              <OpenSubagentPanel />
              <OpenArtifactPanel />
            </Presentation>
          </RecoilRoot>
        </ChatSurfaceHarness>,
      );
    const request = () => screen.getByTestId('side-chat-request').textContent;

    it('is withdrawn when a child’s activity is opened instead', async () => {
      mount();
      fireEvent.click(screen.getByRole('button', { name: mockAskSideChatLabel }));
      expect(request()).toBe('waiting');

      fireEvent.click(screen.getByRole('button', { name: mockOpenChildLabel }));

      expect(await screen.findByText(mockChildPanelLabel)).toBeInTheDocument();
      expect(request()).toBe('none');
    });

    it('is withdrawn when an artifact is opened instead', async () => {
      mount();
      fireEvent.click(screen.getByRole('button', { name: mockAskSideChatLabel }));

      fireEvent.click(screen.getByRole('button', { name: mockOpenArtifactLabel }));

      expect(await screen.findByText(mockArtifactPanelLabel)).toBeInTheDocument();
      expect(request()).toBe('none');
    });

    it('stays asked for over an artifact that was already showing', async () => {
      mount();
      fireEvent.click(screen.getByRole('button', { name: mockOpenArtifactLabel }));
      expect(await screen.findByText(mockArtifactPanelLabel)).toBeInTheDocument();

      /** Asked after the artifact: the side chat is the newest ask, and waits for its record. */
      fireEvent.click(screen.getByRole('button', { name: mockAskSideChatLabel }));

      expect(request()).toBe('waiting');
      expect(screen.getByText(mockArtifactPanelLabel)).toBeInTheDocument();
    });
  });
});
