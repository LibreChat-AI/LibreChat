/**
 * @jest-environment jsdom
 */
import { render, screen } from '@testing-library/react';
import type { Agent } from 'librechat-data-provider';
import type { MessagePartsHost, MessagePartsMarkdownProps } from '../../react/host';
import { MessagePartsHostProvider } from '../../react/host';
import AgentUpdate from '../AgentUpdate';
import Text from '../Text';

jest.mock('@librechat/client', () => ({
  ...jest.requireActual('@librechat/client'),
  useLocalize: () => (key: string) => key,
}));

const agent = { id: 'agent-1', name: 'Researcher' } as Agent;

function createHost(enableUserMsgMarkdown = false): MessagePartsHost {
  return {
    useMessage: () => ({ messageId: 'msg-1', isSubmitting: false, isLatestMessage: true }),
    renderMarkdown: ({ content, variant, isLatestMessage }: MessagePartsMarkdownProps) => (
      <div data-testid={`markdown-${variant}`} data-latest={String(isLatestMessage)}>
        {content}
      </div>
    ),
    useSmoothStreaming: () => false,
    useAgent: (agentId) => (agentId === agent.id ? agent : undefined),
    renderAgentIcon: (current) => <span data-testid="agent-icon">{current?.id ?? 'unknown'}</span>,
    useFontSize: () => 'text-base',
    useShowThinking: () => false,
    useAutoExpandTools: () => false,
    useLaTeXParsing: () => false,
    useChatDirection: () => 'ltr',
    useUserTextPreferences: () => ({
      usernameDisplay: false,
      enableUserMsgMarkdown,
      collapseLongUserMessages: false,
    }),
    useUser: () => undefined,
    useFileMap: () => undefined,
    useToast: () => jest.fn(),
    useSandboxStarting: () => false,
    useToolArtifactClaim: () => [null, jest.fn()],
    useSteerEscalating: () => false,
    usePaneConversationId: () => null,
    useLiveAppliedSteer: () => [false, jest.fn()],
  };
}

const renderWith = (host: MessagePartsHost, ui: React.ReactElement) =>
  render(<MessagePartsHostProvider host={host}>{ui}</MessagePartsHostProvider>);

describe('text-like parts read the app through the host', () => {
  it('renders assistant text with the host markdown renderer', () => {
    renderWith(createHost(), <Text text="**hi**" isCreatedByUser={false} showCursor={false} />);
    const markdown = screen.getByTestId('markdown-full');
    expect(markdown).toHaveTextContent('**hi**');
    expect(markdown).toHaveAttribute('data-latest', 'true');
  });

  it('renders user text as lite markdown only when the viewer opted in', () => {
    const { unmount } = renderWith(
      createHost(true),
      <Text text="user *text*" isCreatedByUser showCursor={false} />,
    );
    expect(screen.getByTestId('markdown-lite')).toHaveTextContent('user *text*');
    unmount();

    renderWith(createHost(false), <Text text="user *text*" isCreatedByUser showCursor={false} />);
    expect(screen.queryByTestId('markdown-lite')).not.toBeInTheDocument();
    expect(screen.getByText('user *text*')).toBeInTheDocument();
  });

  it('labels an agent handoff with the host agent and its icon', () => {
    renderWith(createHost(), <AgentUpdate currentAgentId="agent-1" />);
    expect(screen.getByText('Researcher')).toBeInTheDocument();
    expect(screen.getByTestId('agent-icon')).toHaveTextContent('agent-1');
  });

  it('falls back to the generic agent label for an agent the host does not know', () => {
    renderWith(createHost(), <AgentUpdate currentAgentId="agent-2" />);
    expect(screen.getByText('com_ui_agent')).toBeInTheDocument();
    expect(screen.getByTestId('agent-icon')).toHaveTextContent('unknown');
  });

  it('renders nothing without an agent id', () => {
    const { container } = renderWith(createHost(), <AgentUpdate currentAgentId="" />);
    expect(container).toBeEmptyDOMElement();
  });
});
