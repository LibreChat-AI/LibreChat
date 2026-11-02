/**
 * @jest-environment jsdom
 */
import { render, screen, within } from '@testing-library/react';
import { ContentTypes, EModelEndpoint } from 'librechat-data-provider';
import type { TConversation, TMessage } from 'librechat-data-provider';
import type { ContentPartsSlotProps, MessagePartsHost } from '../../../react/host';
import type { ContentRowProps } from '../ContentRow';
import { createMessagesHost } from '../../../__fixtures__/messagesHost';
import { MessagesHostProvider } from '../../../react/messages/host';
import { useAuthorContext } from '../../../react/messages/author';
import { useErrorSource } from '../../../react/messages/error';
import { MessagePartsHostProvider } from '../../../react/host';
import { initEnglish } from '../../../__fixtures__/i18n';
import { MessageContext } from '../../../react/message';
import ContentRow from '../ContentRow';

beforeAll(initEnglish);

const conversation = {
  conversationId: 'convo-1',
  endpoint: EModelEndpoint.agents,
  model: 'gpt-x',
} as TConversation;

const reply = {
  messageId: 'assistant-1',
  conversationId: 'convo-1',
  parentMessageId: 'user-1',
  isCreatedByUser: false,
  endpoint: EModelEndpoint.agents,
  model: 'gpt-x',
  depth: 1,
  text: '',
  content: [
    { type: ContentTypes.TEXT, text: 'Here is the answer' },
    { type: ContentTypes.ERROR, error: 'boom', agentId: 'agent_lane' },
  ],
} as TMessage;

/** What a part rendered inside the row reads from the row's contexts. */
function PartProbe() {
  const author = useAuthorContext();
  const source = useErrorSource();
  return (
    <span data-testid="probe">
      {author?.label}|{source?.partAgentId}
    </span>
  );
}

function renderRow(
  props: Partial<ContentRowProps> = {},
  parts: Partial<MessagePartsHost> = {},
  renderContentParts = jest.fn((_props: ContentPartsSlotProps) => (
    <MessageContext.Provider value={{ messageId: 'assistant-1', isExpanded: false, partIndex: 1 }}>
      <PartProbe />
    </MessageContext.Provider>
  )),
) {
  const partsHost = {
    useShowThinking: () => true,
    useAutoExpandTools: () => false,
    renderContentParts,
    ...parts,
  } as MessagePartsHost;
  const messagesHost = createMessagesHost({
    renderMessageIcon: ({ iconData }) => <span data-testid="icon">{iconData?.model}</span>,
  });
  render(
    <MessagesHostProvider host={messagesHost}>
      <MessagePartsHostProvider host={partsHost}>
        <ContentRow
          message={reply}
          conversation={conversation}
          index={0}
          label="Research Agent"
          iconData={{ endpoint: EModelEndpoint.agents, model: 'gpt-x' }}
          hasConfiguredSender={false}
          isLast={true}
          isLatestMessage={true}
          isSubmitting={false}
          edit={false}
          enterEdit={jest.fn()}
          hasParallelContent={false}
          fullWidth={false}
          toolbar={<button type="button">Copy to clipboard</button>}
          {...props}
        />
      </MessagePartsHostProvider>
    </MessagesHostProvider>,
  );
  return renderContentParts;
}

describe('ContentRow', () => {
  it('labels the row and draws its author icon through the messages host', () => {
    renderRow();

    const row = screen.getByRole('group', { name: 'Message 2' });
    expect(within(row).getByRole('heading', { level: 2 })).toHaveTextContent('Research Agent');
    expect(within(row).getByTestId('icon')).toHaveTextContent('gpt-x');
    expect(within(row).getByRole('button', { name: 'Copy to clipboard' })).toBeInTheDocument();
  });

  it('hands the content-parts slot the row state and the viewer preferences', () => {
    const header = <span>header</span>;
    const renderContentParts = renderRow({
      authorHeader: header,
      siblingIdx: 1,
      renderOwnerId: 'q-1',
    });

    expect(renderContentParts).toHaveBeenCalledWith(
      expect.objectContaining({
        content: reply.content,
        messageId: 'assistant-1',
        conversationId: 'convo-1',
        isCreatedByUser: false,
        isLast: true,
        isLatestMessage: true,
        isSubmitting: false,
        siblingIdx: 1,
        renderOwnerId: 'q-1',
        authorHeader: header,
        showThinking: true,
        foldLiveActivity: true,
      }),
    );
  });

  it('withholds the resume header from a user message', () => {
    const renderContentParts = renderRow({
      message: { ...reply, isCreatedByUser: true },
      authorHeader: <span>header</span>,
    });

    expect(renderContentParts).toHaveBeenCalledWith(
      expect.objectContaining({ isCreatedByUser: true, authorHeader: undefined }),
    );
  });

  it('gives the parts the row author and resolves an error part to its lane agent', () => {
    renderRow();

    expect(screen.getByTestId('probe')).toHaveTextContent('Research Agent|agent_lane');
  });

  it('draws a body the app supplies in place of the parts, and a notice after them', () => {
    const renderContentParts = renderRow({
      body: <p>Private prompt</p>,
      notice: <p role="note">Stopped at the tool call limit</p>,
    });

    expect(renderContentParts).not.toHaveBeenCalled();
    expect(screen.getByText('Private prompt')).toBeInTheDocument();
    expect(screen.getByRole('note')).toHaveTextContent('Stopped at the tool call limit');
  });

  it('expands live activity when the viewer asked for tools expanded', () => {
    const renderContentParts = renderRow({}, { useAutoExpandTools: () => true });

    expect(renderContentParts).toHaveBeenCalledWith(
      expect.objectContaining({ foldLiveActivity: false }),
    );
  });
});
