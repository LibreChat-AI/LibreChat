import { Provider } from 'jotai';
import { RecoilRoot } from 'recoil';
import copy from 'copy-to-clipboard';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ContentTypes, dataService, EModelEndpoint } from 'librechat-data-provider';
import type { TMessage, TAgentsMap } from 'librechat-data-provider';
import { ShareMessagesProvider } from './ShareMessagesProvider';
import { AgentsMapContext } from '~/Providers/AgentsMapContext';
import { ShareContext } from '~/Providers/ShareContext';
import MessagesView from './MessagesView';

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: { ...actual.dataService, getAIEndpoints: jest.fn().mockResolvedValue({}) },
  };
});

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useAttachments: () => ({ attachments: [], searchResults: [] }),
  useExpandCollapse: jest.requireActual('~/hooks/Messages/useExpandCollapse').default,
  useLazyCollapseBody: jest.requireActual('~/hooks/Messages/useLazyCollapseBody').default,
  ...jest.requireActual('~/hooks/Messages/useCopyToClipboard'),
}));
jest.mock('~/hooks/MCP', () => ({
  useMCPIconMap: () => new Map(),
  useMCPServerNames: () => [],
}));
jest.mock('copy-to-clipboard');
jest.mock('~/components/Chat/Messages/Content/SearchContent', () => ({
  __esModule: true,
  default: ({ message }: { message: TMessage }) => <div>{message.text}</div>,
  rendersMarkdownLite: () => false,
}));
jest.mock('~/components/Chat/Messages/Content/MessageContent', () => ({
  __esModule: true,
  default: ({ text }: { text: string }) => <div>{text}</div>,
}));
jest.mock('~/components/Chat/Messages/Content/MarkdownLite', () => ({
  __esModule: true,
  default: ({ content }: { content: string }) => <div>{content}</div>,
}));
jest.mock('~/components/Chat/Messages/Content/ToolOutput', () => ({
  StackedToolIcons: () => null,
  ToolIcon: () => null,
  getToolIconType: () => '',
  getMCPServerName: () => '',
  OutputRenderer: ({ text }: { text: string }) => <div>{text}</div>,
}));

const prompt = (status = 'completed', subagentType = 'self') =>
  `A detached subagent task has ${status}. Continue the parent task using its durable result below.\n${JSON.stringify(
    {
      background_task_id: 'task',
      subagent_thread_id: 'thread',
      subagent_type: subagentType,
      status,
      result: 'Shared durable result.',
    },
  )}`;

function renderShared(
  text: string,
  content = false,
  dispatch?: TMessage,
  submitted = false,
  agentsMap?: TAgentsMap,
) {
  const wake: TMessage = {
    messageId: 'wake',
    parentMessageId: null,
    conversationId: 'original',
    isCreatedByUser: true,
    isUserSubmitted: submitted,
    text,
    ...(content ? { content: [{ type: ContentTypes.TEXT, text }] } : {}),
  };
  const reply: TMessage = {
    messageId: 'reply',
    parentMessageId: 'wake',
    conversationId: 'original',
    isCreatedByUser: false,
    text: 'Parent continuation.',
    sender: 'Historical Parent',
    endpoint: EModelEndpoint.agents,
    model: 'agent_deleted',
    iconURL: '/historical.png',
  };
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <Provider>
        <RecoilRoot>
          <ShareContext.Provider value={{ isSharedConvo: true, shareId: 'share' }}>
            <AgentsMapContext.Provider value={agentsMap}>
              <ShareMessagesProvider
                messages={[...(dispatch == null ? [] : [dispatch]), wake, reply]}
              >
                <MessagesView messagesTree={[wake]} conversationId="shared-view" />
              </ShareMessagesProvider>
            </AgentsMapContext.Provider>
          </ShareContext.Provider>
        </RecoilRoot>
      </Provider>
    </QueryClientProvider>,
  );
  return queryClient;
}

beforeEach(() => jest.mocked(dataService.getAIEndpoints).mockClear());

it.each([false, true])(
  'renders the actual public self wake-up author and task card (content: %s)',
  (content) => {
    const text = prompt();
    const queryClient = renderShared(text, content);
    expect(screen.getByRole('heading', { name: 'Historical Parent' })).toBeInTheDocument();
    expect(screen.getByRole('img', { hidden: true })).toHaveAttribute('src', '/historical.png');
    expect(screen.getByTestId('message-body')).toHaveClass('border', 'border-border-medium');
    expect(screen.queryByText(text)).not.toBeInTheDocument();
    const toggle = screen.getByRole('button', { name: 'com_ui_wakeup_subagent_completed' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Shared durable result.')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'com_ui_wakeup_view_activity' }),
    ).not.toBeInTheDocument();
    expect(dataService.getAIEndpoints).not.toHaveBeenCalled();
    expect(queryClient.isFetching()).toBe(0);
  },
);

it.each(['error', 'cancelled'])('renders a public subagent %s outcome', (status) => {
  renderShared(prompt(status, 'reviewer'));
  expect(screen.getByRole('heading', { name: 'reviewer' })).toBeInTheDocument();
  expect(
    screen.getByRole('button', {
      name:
        status === 'error' ? 'com_ui_wakeup_subagent_errored' : 'com_ui_wakeup_subagent_cancelled',
    }),
  ).toBeInTheDocument();
});

it('renders background-tool wake-ups as system task cards', () => {
  const text = `A background tool task has finished. Continue using its durable result below.\n${JSON.stringify(
    [
      {
        background_task_id: 'task',
        tool_call_id: 'call',
        tool: 'bash',
        status: 'completed',
        result: 'Tool result.',
      },
    ],
  )}`;
  renderShared(text);
  expect(screen.getByRole('heading', { name: 'com_ui_system_event' })).toBeInTheDocument();
  expect(screen.queryByText(text)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'com_ui_wakeup_task_finished' }));
  expect(screen.getByText('Tool result.')).toBeInTheDocument();
});

it.each([false, true])('keeps an ordinary public user message (content: %s)', (content) => {
  renderShared('Ordinary shared prompt.', content);
  expect(screen.getByText('Ordinary shared prompt.')).toBeInTheDocument();
  expect(screen.queryByTestId('wakeup-panel')).not.toBeInTheDocument();
  expect(
    screen.getByRole('heading', { name: 'com_ui_prompt: com_ui_user', hidden: true }),
  ).toHaveClass('sr-only');
});

it.each([
  ['self', 'graph', 'self'],
  ['agent_research_team', 'graph', 'agent_research_team'],
  ['agent_research_team', undefined, 'agent_research_team'],
  ['self', 'agent', 'Dispatch Parent'],
] as const)('retains persisted shared alias %s with kind %s', (alias, kind, label) => {
  const dispatch: TMessage = {
    messageId: 'dispatch',
    parentMessageId: null,
    conversationId: 'original',
    isCreatedByUser: false,
    text: '',
    sender: 'Dispatch Parent',
    endpoint: EModelEndpoint.agents,
    model: 'agent_deleted',
    iconURL: '/dispatch.png',
    content: [
      {
        type: ContentTypes.TOOL_CALL,
        tool_call: {
          name: 'subagent',
          args: { run_in_background: true },
          output: JSON.stringify({
            background_task_id: 'task',
            subagent_thread_id: 'thread',
            tool: 'subagent',
            subagent_type: alias,
            status: 'running',
            message: 'Poll with background_task_id task.',
          }),
          ...(kind == null
            ? {}
            : {
                subagentIdentity: {
                  subagentKind: kind,
                  subagentAgentId: kind === 'graph' ? `graph:${alias}` : 'agent_deleted',
                },
              }),
        },
      },
    ],
  };
  renderShared(prompt('completed', alias), false, dispatch);
  expect(screen.getByRole('heading', { name: label })).toBeInTheDocument();
  if (kind !== 'agent') {
    expect(screen.queryByRole('heading', { name: 'Dispatch Parent' })).not.toBeInTheDocument();
  } else {
    expect(screen.getByRole('img', { hidden: true })).toHaveAttribute('src', '/dispatch.png');
  }
  expect(screen.queryByRole('heading', { name: 'Historical Parent' })).not.toBeInTheDocument();
  expect(dataService.getAIEndpoints).not.toHaveBeenCalled();
});

it.each(['self', 'reviewer'])(
  'keeps a user-submitted %s wake-up lookalike as a prompt',
  (alias) => {
    const text = prompt('completed', alias);
    renderShared(text, false, undefined, true);
    expect(screen.getByTestId('message-body')).toHaveTextContent(text.replace(/\s+/g, ' '));
    expect(screen.queryByTestId('wakeup-panel')).not.toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'com_ui_prompt: com_ui_user', hidden: true }),
    ).toHaveClass('sr-only');
  },
);

it('attributes a public parallel-lane self-spawn to its validated lane', () => {
  const dispatch: TMessage = {
    messageId: 'dispatch',
    parentMessageId: null,
    conversationId: 'original',
    isCreatedByUser: false,
    text: '',
    sender: 'Outer Parent',
    model: 'agent_outer',
    endpoint: EModelEndpoint.agents,
    iconURL: '/outer.png',
    content: [
      {
        type: ContentTypes.TOOL_CALL,
        agentId: 'agent_lane',
        tool_call: {
          id: 'call',
          name: 'subagent',
          args: { run_in_background: true },
          output: JSON.stringify({
            background_task_id: 'task',
            subagent_thread_id: 'thread',
            tool: 'subagent',
            subagent_type: 'self',
            status: 'running',
            message: 'Poll with background_task_id task.',
          }),
          subagentIdentity: { subagentKind: 'agent', subagentAgentId: 'agent_lane' },
        },
      },
    ],
  };
  renderShared(prompt(), false, dispatch, false, {
    agent_lane: {
      id: 'agent_lane',
      name: 'Lane Parent',
      description: null,
      created_at: 0,
      avatar: { filepath: '/lane.png', source: 'local' },
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
    },
  });
  expect(screen.getByRole('heading', { name: 'Lane Parent' })).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'Outer Parent' })).not.toBeInTheDocument();
  expect(screen.getByRole('img', { hidden: true })).toHaveAttribute('src', '/lane.png');
  expect(dataService.getAIEndpoints).not.toHaveBeenCalled();
});

it('copies only the visible public wake-up result through its real footer', () => {
  const clipboard = jest.mocked(copy);
  clipboard.mockReturnValue(true);
  renderShared(prompt(), true);
  fireEvent.click(screen.getByRole('button', { name: 'com_ui_copy_to_clipboard' }));
  expect(clipboard).toHaveBeenCalledWith('Shared durable result.', expect.anything());
});
