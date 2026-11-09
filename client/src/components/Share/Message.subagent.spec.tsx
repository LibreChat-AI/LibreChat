import { useAtom } from 'jotai';
import { RecoilRoot } from 'recoil';
import { activeSubagentPanel } from '@librechat/chat/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SharedSubagentActivityDialog } from '@librechat/chat/components';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Constants, ContentTypes, dataService, EModelEndpoint } from 'librechat-data-provider';
import type {
  FullToolCall,
  PartMetadata,
  TMessage,
  TMessageContentParts,
} from 'librechat-data-provider';
import { ShareMessagesProvider } from './ShareMessagesProvider';
import { ShareContext } from '~/Providers/ShareContext';
import { ChatSurfaceHarness } from 'test/harness';
import MessagesView from './MessagesView';
import '~/components/Chat/Messages/Content/register';
import '~/Providers/MessagePartsHostContext';
import '~/Providers/MessagesHostContext';

const SHARE_ID = 'share-1';
const CARD = 'Ran agent';
const PRIVATE_READS = [
  'getParentSubagents',
  'getSubagentThread',
  'getSubagentTaskContent',
  'getSubagentControlReceipt',
  'getSubagentAttachmentCalls',
  'controlSubagentTask',
] as const;

/** The HTTP boundary: every private subagent endpoint is a spy, so a read from a shared link shows. */
jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      getAIEndpoints: jest.fn().mockResolvedValue({}),
      getParentSubagents: jest.fn(),
      getSubagentThread: jest.fn(),
      getSubagentTaskContent: jest.fn(),
      getSubagentControlReceipt: jest.fn(),
      getSubagentAttachmentCalls: jest.fn(),
      controlSubagentTask: jest.fn(),
    },
  };
});

/** MCP server names come from the server's MCP list endpoint, which is not reachable here. */
jest.mock('~/hooks/MCP', () => ({
  useMCPIconMap: () => new Map(),
  useMCPServerNames: () => [],
}));

/** The shared activity dialog as `ShareView` mounts it, fed by the app's open panel selection. */
function SharedDialog({ messages }: { messages: TMessage[] }) {
  const [selected, setSelected] = useAtom(activeSubagentPanel);
  return (
    <SharedSubagentActivityDialog
      shareId={SHARE_ID}
      messages={messages}
      selected={selected}
      setSelected={setSelected}
    />
  );
}

const childRun = (
  call: Pick<FullToolCall, 'output' | 'subagent_content'> = {},
): TMessageContentParts => {
  const toolCall: FullToolCall & PartMetadata = {
    id: 'call_child',
    name: String(Constants.SUBAGENT),
    args: JSON.stringify({ subagent_type: 'researcher', description: 'Review the release.' }),
    progress: 1,
    ...call,
  };
  return { type: ContentTypes.TOOL_CALL, tool_call: toolCall };
};

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
  const messages = [prompt, reply];
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ChatSurfaceHarness>
        <RecoilRoot>
          <ShareContext.Provider value={{ isSharedConvo: true, shareId: SHARE_ID }}>
            <ShareMessagesProvider messages={messages}>
              <MessagesView messagesTree={[{ ...prompt, children: [reply] }]} conversationId="x" />
            </ShareMessagesProvider>
            <SharedDialog messages={messages} />
          </ShareContext.Provider>
        </RecoilRoot>
      </ChatSurfaceHarness>
    </QueryClientProvider>,
  );
}

const expectNoPrivateRead = () => {
  for (const name of PRIVATE_READS) {
    expect(dataService[name]).not.toHaveBeenCalled();
  }
};

describe('a child run card on a shared message', () => {
  beforeEach(() => {
    for (const name of PRIVATE_READS) {
      jest.mocked(dataService[name]).mockClear();
    }
  });

  it('opens the shared activity from the persisted child content without a private read', async () => {
    renderShared([
      childRun({ subagent_content: [{ type: ContentTypes.TEXT, text: 'Shared child result.' }] }),
    ]);

    const card = screen.getByRole('button', { name: CARD });
    expect(card).toBeEnabled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    fireEvent.click(card);

    expect(await screen.findByRole('dialog')).toHaveTextContent('Shared child result.');
    expectNoPrivateRead();
  });

  it('closes on Escape and returns focus to the card', async () => {
    renderShared([
      childRun({ subagent_content: [{ type: ContentTypes.TEXT, text: 'Shared child result.' }] }),
    ]);
    const card = screen.getByRole('button', { name: CARD });

    fireEvent.click(card);
    fireEvent.keyDown(await screen.findByRole('dialog'), { key: 'Escape' });

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(card).toHaveFocus());
  });

  it('opens the shared activity from a legacy run that only recorded its output', async () => {
    renderShared([childRun({ output: 'Legacy child output.' })]);

    fireEvent.click(screen.getByRole('button', { name: CARD }));

    expect(await screen.findByRole('dialog')).toHaveTextContent('Legacy child output.');
    expectNoPrivateRead();
  });

  it('stays closed for a run with nothing recorded to show', () => {
    renderShared([childRun()]);

    const card = screen.getByRole('button', { name: CARD });
    expect(card).toBeDisabled();
    fireEvent.click(card);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expectNoPrivateRead();
  });
});
