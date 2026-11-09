import { RecoilRoot } from 'recoil';
import { useAtomValue } from 'jotai';
import { activeSubagentPanel } from '@librechat/chat/react';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ContentTypes, dataService, EModelEndpoint } from 'librechat-data-provider';
import type { TMessage, TMessageContentParts } from 'librechat-data-provider';
import { ShareMessagesProvider } from './ShareMessagesProvider';
import { ShareContext } from '~/Providers/ShareContext';
import { ChatSurfaceHarness } from 'test/harness';
import MessagesView from './MessagesView';
import '~/Providers/MessagePartsHostContext';
import '~/Providers/MessagesHostContext';

const SHARE_ID = 'share-1';
const CARD = 'com_ui_subagent_complete';

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      getAIEndpoints: jest.fn().mockResolvedValue({}),
      getParentSubagents: jest.fn(),
      getSubagentThread: jest.fn(),
    },
  };
});

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useAttachments: () => ({ attachments: [], searchResults: [] }),
  ...jest.requireActual('~/hooks/Messages/useCopyToClipboard'),
}));
jest.mock('~/hooks/MCP', () => ({
  useMCPIconMap: () => new Map(),
  useMCPServerNames: () => [],
}));
jest.mock('~/components/Chat/Messages/Content/MessageContent', () => ({
  __esModule: true,
  default: ({ text }: { text: string }) => <div>{text}</div>,
}));

type SubagentToolCall = {
  id: string;
  args: Record<string, unknown>;
  output?: string;
  progress: number;
  subagent_content?: TMessageContentParts[];
};

/** The part dispatcher is the one piece replaced: it renders the real card for each child run, with
 *  the props `Part` derives from the shared payload, inside the real share `Message` context. */
jest.mock('~/components/Chat/Messages/Content/SearchContent', () => ({
  __esModule: true,
  rendersMarkdownLite: () => false,
  default: function SharedParts({ message }: { message: TMessage }) {
    const { default: SubagentCall } = jest.requireActual(
      '~/components/Chat/Messages/Content/Parts/SubagentCall',
    );
    const { ContentTypes: Types } = jest.requireActual('librechat-data-provider');
    const calls = (message.content ?? []).flatMap((part) =>
      part?.type === Types.TOOL_CALL
        ? [(part as unknown as { tool_call: SubagentToolCall }).tool_call]
        : [],
    );
    return (
      <>
        {calls.map((call) => (
          <SubagentCall
            key={call.id}
            toolCallId={call.id}
            args={call.args}
            output={call.output ?? ''}
            initialProgress={call.progress}
            persistedContent={call.subagent_content}
          />
        ))}
      </>
    );
  },
}));

/** What the app's shared dialog shows for the card's selection: it belongs to this share. */
function SharedDialog() {
  const selected = useAtomValue(activeSubagentPanel);
  if (selected?.host !== 'share' || selected.shareId !== SHARE_ID) return null;
  return (
    <div role="dialog" aria-label="Shared subagent activity">
      {selected.persistedContent?.map((part, index) =>
        part.type === ContentTypes.TEXT && typeof part.text === 'string' ? (
          <span key={index}>{part.text}</span>
        ) : null,
      )}
      {selected.legacyOutput ? <span>{selected.legacyOutput}</span> : null}
    </div>
  );
}

const childRun = (call: Partial<SubagentToolCall> = {}): TMessageContentParts =>
  ({
    type: ContentTypes.TOOL_CALL,
    tool_call: {
      id: 'call_child',
      name: 'subagent',
      args: { subagent_type: 'researcher', description: 'Review the release.' },
      progress: 1,
      ...call,
    },
  }) as unknown as TMessageContentParts;

/** A shared thread as the share route returns it: every id is the anonymized, share-scoped one. */
function renderShared(content: TMessageContentParts[]) {
  const prompt: TMessage = {
    messageId: 'shared-prompt',
    parentMessageId: null,
    conversationId: 'shared-conversation',
    isCreatedByUser: true,
    text: 'Review the release.',
  };
  const reply: TMessage = {
    messageId: 'shared-reply',
    parentMessageId: 'shared-prompt',
    conversationId: 'shared-conversation',
    isCreatedByUser: false,
    endpoint: EModelEndpoint.agents,
    sender: 'Lia',
    text: '',
    content,
  };
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ChatSurfaceHarness>
        <RecoilRoot>
          <ShareContext.Provider value={{ isSharedConvo: true, shareId: SHARE_ID }}>
            <ShareMessagesProvider messages={[prompt, reply]}>
              <MessagesView messagesTree={[{ ...prompt, children: [reply] }]} conversationId="x" />
            </ShareMessagesProvider>
            <SharedDialog />
          </ShareContext.Provider>
        </RecoilRoot>
      </ChatSurfaceHarness>
    </QueryClientProvider>,
  );
  return queryClient;
}

const expectNoPrivateRead = (queryClient: QueryClient) => {
  expect(dataService.getParentSubagents).not.toHaveBeenCalled();
  expect(dataService.getSubagentThread).not.toHaveBeenCalled();
  expect(queryClient.isFetching()).toBe(0);
};

describe('a child run card on a shared message', () => {
  beforeEach(() => {
    jest.mocked(dataService.getParentSubagents).mockClear();
    jest.mocked(dataService.getSubagentThread).mockClear();
  });

  it('opens the shared activity from the persisted child content without a private read', () => {
    const queryClient = renderShared([
      childRun({ subagent_content: [{ type: ContentTypes.TEXT, text: 'Shared child result.' }] }),
    ]);

    const card = screen.getByRole('button', { name: CARD });
    expect(card).toBeEnabled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    fireEvent.click(card);

    expect(screen.getByRole('dialog')).toHaveTextContent('Shared child result.');
    expectNoPrivateRead(queryClient);
  });

  it('opens the shared activity from a legacy run that only recorded its output', () => {
    const queryClient = renderShared([childRun({ output: 'Legacy child output.' })]);

    fireEvent.click(screen.getByRole('button', { name: CARD }));

    expect(screen.getByRole('dialog')).toHaveTextContent('Legacy child output.');
    expectNoPrivateRead(queryClient);
  });

  it('stays closed for a run with nothing recorded to show', () => {
    const queryClient = renderShared([childRun()]);

    const card = screen.getByRole('button', { name: CARD });
    expect(card).toBeDisabled();
    fireEvent.click(card);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expectNoPrivateRead(queryClient);
  });
});
