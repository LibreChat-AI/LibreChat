/**
 * @jest-environment jsdom
 */
import { render, screen } from '@testing-library/react';
import { ContentTypes, EModelEndpoint } from 'librechat-data-provider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Agent, ParentSubagentSummary, TMessage } from 'librechat-data-provider';
import type { MessagePartsHost, MessagePartsShare } from '../../../react/host';
import { createMessagesHost } from '../../../__fixtures__/messagesHost';
import { MessagesHostProvider } from '../../../react/messages/host';
import { MessagePartsHostProvider } from '../../../react/host';
import { initEnglish } from '../../../__fixtures__/i18n';
import WakeupRow from '../WakeupRow';

let mockChildren = new Map<string, ParentSubagentSummary>();
jest.mock('../../../react/subagents/parents', () => ({
  ...jest.requireActual('../../../react/subagents/parents'),
  useParentSubagents: () => ({ byThreadId: mockChildren }),
}));

beforeAll(initEnglish);
beforeEach(() => {
  mockChildren = new Map();
});

const BODY = 'One finding.';

const agent = (id: string, name: string): Agent => ({
  id,
  name,
  description: null,
  created_at: 0,
  avatar: null,
  provider: EModelEndpoint.openAI,
  model: 'test',
  model_parameters: {
    temperature: 1,
    maxContextTokens: 4096,
    max_context_tokens: 4096,
    max_output_tokens: 1024,
    top_p: 1,
    frequency_penalty: 0,
    presence_penalty: 0,
  },
});

const child = (overrides: Partial<ParentSubagentSummary> = {}): ParentSubagentSummary => ({
  threadId: 'thread-1',
  parentMessageId: 'parent-1',
  subagentType: 'agent_reviewer',
  subagentKind: 'agent',
  agentId: 'agent_reviewer',
  title: 'Reviewer',
  origin: 'event',
  status: 'completed',
  tasks: [],
  tasksTruncated: false,
  ...overrides,
});

const dispatchMessage: TMessage = {
  messageId: 'dispatch',
  parentMessageId: null,
  conversationId: 'convo-1',
  isCreatedByUser: false,
  text: '',
  sender: 'Outer Parent',
  model: 'agent_outer',
  endpoint: EModelEndpoint.agents,
  content: [
    {
      type: ContentTypes.TOOL_CALL,
      agentId: 'agent_lane',
      tool_call: {
        id: 'call',
        name: 'subagent',
        args: { run_in_background: true },
        output: JSON.stringify({
          background_task_id: 'task-1',
          subagent_thread_id: 'thread-1',
          tool: 'subagent',
          subagent_type: 'self',
          status: 'running',
          message: 'Poll with background_task_id task-1.',
        }),
        subagentIdentity: { subagentKind: 'agent', subagentAgentId: 'agent_lane' },
      },
    },
  ],
};

const partsHost: MessagePartsHost = {
  useMessage: () => ({ messageId: 'wake', isSubmitting: false, isLatestMessage: true }),
  renderMarkdown: ({ content }) => <span>{content}</span>,
  renderImage: () => null,
  renderFilePreview: () => null,
  useSmoothStreaming: () => false,
  useAgent: () => undefined,
  renderAgentIcon: () => null,
  renderAgentAvatar: () => null,
  renderContentParts: () => null,
  useFontSize: () => 'text-base',
  useShowThinking: () => false,
  useAutoExpandTools: () => false,
  useLaTeXParsing: () => false,
  useChatDirection: () => 'ltr',
  useUserTextPreferences: () => ({
    usernameDisplay: true,
    enableUserMsgMarkdown: true,
    collapseLongUserMessages: false,
  }),
  useUser: () => undefined,
  useFileMap: () => undefined,
  useToast: () => () => undefined,
  useSandboxStarting: () => false,
  useToolArtifactClaim: () => [null, () => undefined],
  useSteerEscalating: () => false,
  usePaneConversationId: () => null,
  useLiveAppliedSteer: () => [false, () => undefined],
  useShare: () => ({}),
};

function renderRow({
  agentsMap,
  share = {},
  messages,
  subagentType = 'agent_reviewer',
}: {
  agentsMap?: Record<string, Agent | undefined>;
  share?: MessagePartsShare;
  messages?: TMessage[];
  subagentType?: string;
}): void {
  const queryClient = new QueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <MessagePartsHostProvider host={{ ...partsHost, useShare: () => share }}>
        <MessagesHostProvider host={createMessagesHost({ useGetMessages: () => () => messages })}>
          <WakeupRow
            id="wake"
            task={{
              taskId: 'task-1',
              status: 'completed',
              result: BODY,
              threadId: 'thread-1',
              subagentType,
            }}
            conversationId="convo-1"
            agentsMap={agentsMap}
            icon={null}
            label="ignored"
            footer={null}
            isCreatedByUser
          >
            <p>{BODY}</p>
          </WakeupRow>
        </MessagesHostProvider>
      </MessagePartsHostProvider>
    </QueryClientProvider>,
  );
}

describe('WakeupRow', () => {
  it('labels the row with the known child author and outlines it', () => {
    mockChildren = new Map([['thread-1', child()]]);
    renderRow({ agentsMap: { agent_reviewer: agent('agent_reviewer', 'Reviewer') } });

    expect(screen.getByRole('heading', { name: 'Reviewer' })).toBeVisible();
    expect(screen.getByText(BODY).parentElement).toHaveClass('border', 'border-border-medium');
    expect(screen.getByText(BODY).parentElement).not.toHaveClass('bg-surface-user-message');
  });

  it('takes the author from the dispatch message and the agents map in a shared conversation', () => {
    renderRow({
      agentsMap: { agent_lane: agent('agent_lane', 'Lane Parent') },
      share: { isSharedConvo: true },
      messages: [dispatchMessage],
      subagentType: 'self',
    });

    expect(screen.getByRole('heading', { name: 'Lane Parent' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Outer Parent' })).not.toBeInTheDocument();
  });

  it('falls back to the localized subagent label when no agent is found', () => {
    renderRow({ agentsMap: undefined, subagentType: 'self' });

    expect(screen.getByRole('heading', { name: 'Agent' })).toBeVisible();
  });
});
