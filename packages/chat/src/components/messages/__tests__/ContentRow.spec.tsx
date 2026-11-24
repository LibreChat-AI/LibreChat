/**
 * @jest-environment jsdom
 */
import { render, screen, within } from '@testing-library/react';
import { ContentTypes, EModelEndpoint } from 'librechat-data-provider';
import type { Agent, TConversation, TMessage } from 'librechat-data-provider';
import type { ContentPartsSlotProps, MessagePartsHost } from '../../../react/host';
import type { ContentRowProps } from '../ContentRow';
import { createMessagesHost } from '../../../__fixtures__/messagesHost';
import { MessagesHostProvider } from '../../../react/messages/host';
import { useAuthorContext } from '../../../react/messages/author';
import { useErrorSource } from '../../../react/messages/error';
import { MessagePartsHostProvider } from '../../../react/host';
import { renderContentParts } from '../../contentRenderer';
import { initEnglish } from '../../../__fixtures__/i18n';
import { MessageContext } from '../../../react/message';
import ContentRow from '../ContentRow';

jest.mock('../../contentRenderer', () => ({
  renderContentParts: jest.fn(() => <span data-testid="package-content" />),
}));

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
  it('draws its parts with the package renderer when the host names none', () => {
    const hostRenderer = renderRow({}, { renderContentParts: undefined });

    expect(hostRenderer).not.toHaveBeenCalled();
    expect(screen.getByTestId('package-content')).toBeInTheDocument();
    expect(jest.mocked(renderContentParts)).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'assistant-1', content: reply.content }),
    );
  });

  it('leaves the package renderer alone when the host names its own', () => {
    jest.mocked(renderContentParts).mockClear();
    const hostRenderer = renderRow();

    expect(hostRenderer).toHaveBeenCalled();
    expect(jest.mocked(renderContentParts)).not.toHaveBeenCalled();
    expect(screen.queryByTestId('package-content')).not.toBeInTheDocument();
  });

  describe('the author the model selector already shows', () => {
    const agent = { id: 'agent_1', name: 'Research Agent' } as Agent;
    const convo = { ...conversation, agent_id: 'agent_1' } as TConversation;
    const nameIsHidden = () => screen.getByText('Research Agent').closest('.sr-only') != null;

    it('keeps only the assistive technology text when the deployment opts in', () => {
      const parts = renderRow({
        agent,
        conversation: convo,
        hideSelectedAuthor: true,
        authorHeader: <span>Resume header</span>,
      });
      expect(screen.getByRole('heading', { name: /Research Agent/ })).toHaveClass('sr-only');
      expect(nameIsHidden()).toBe(true);
      expect(screen.queryByTestId('icon')).not.toBeInTheDocument();
      expect(parts.mock.calls[0][0].authorHeader).toBeUndefined();
    });

    it.each([
      ['the deployment has not opted in', { agent, conversation: convo }],
      [
        'another agent wrote the turn',
        {
          agent,
          conversation: { ...convo, agent_id: 'agent_2' } as TConversation,
          hideSelectedAuthor: true,
        },
      ],
      [
        'the thread is a read-only subagent thread',
        {
          agent,
          conversation: {
            ...convo,
            subagentThread: { parentConversationId: 'parent' },
          } as TConversation,
          hideSelectedAuthor: true,
        },
      ],
      ['the turn has no agent', { conversation: convo, hideSelectedAuthor: true }],
    ])('shows the author when %s', (_case, props) => {
      renderRow(props);
      expect(nameIsHidden()).toBe(false);
      expect(screen.getByTestId('icon')).toBeInTheDocument();
    });
  });

  describe('a model spec or plain endpoint conversation with no saved agent', () => {
    const spec = {
      conversationId: 'convo-1',
      endpoint: 'Claude' as EModelEndpoint,
      model: 'claude-sonnet-5',
      spec: 'ClickHouse Agent Claude',
    } as TConversation;
    const specReply = {
      ...reply,
      endpoint: 'Claude',
      model: 'claude-sonnet-5',
      sender: 'ClickHouse Agent',
    } as TMessage;
    /** The selection as the host resolves it: the sender a turn sent now would be written with. */
    const selection = {
      message: specReply,
      conversation: spec,
      hideSelectedAuthor: true,
      selectedSender: 'ClickHouse Agent',
    };
    const nameIsHidden = () => screen.getByText('Research Agent').closest('.sr-only') != null;

    it('keeps only the assistive technology text for its own response', () => {
      const parts = renderRow({ ...selection, authorHeader: <span>Resume header</span> });
      expect(screen.getByRole('heading', { name: /Research Agent/ })).toHaveClass('sr-only');
      expect(nameIsHidden()).toBe(true);
      expect(screen.queryByTestId('icon')).not.toBeInTheDocument();
      expect(parts.mock.calls[0][0].authorHeader).toBeUndefined();
    });

    it('keeps only the assistive technology text when the server saved the ephemeral agent id', () => {
      renderRow({
        ...selection,
        conversation: {
          ...spec,
          agent_id: 'Claude__claude-sonnet-5___Research_Agent',
        } as TConversation,
      });
      expect(nameIsHidden()).toBe(true);
    });

    it('hides the author while the response has no model or sender yet', () => {
      renderRow({
        ...selection,
        message: {
          ...specReply,
          endpoint: undefined,
          model: undefined,
          sender: undefined,
        } as TMessage,
      });
      expect(nameIsHidden()).toBe(true);
    });

    it('hides the author when the host cannot name the selected sender', () => {
      renderRow({ ...selection, selectedSender: undefined });
      expect(nameIsHidden()).toBe(true);
    });

    it.each([
      ['the deployment has not opted in', { ...selection, hideSelectedAuthor: false }],
      [
        'a different model wrote the turn',
        { ...selection, message: { ...specReply, model: 'other-model' } as TMessage },
      ],
      [
        'another spec on the same model wrote the turn',
        { ...selection, message: { ...specReply, sender: 'Other Spec' } as TMessage },
      ],
      [
        'the selection moved to the plain model since the turn was written',
        { ...selection, selectedSender: 'Claude' },
      ],
      ['the response is in an added conversation pane', { ...selection, index: 1 }],
      [
        'the thread is a read-only subagent thread',
        {
          ...selection,
          conversation: { ...spec, subagentThread: { parentConversationId: 'p' } } as TConversation,
        },
      ],
    ])('shows the author when %s', (_case, props) => {
      renderRow(props);
      expect(nameIsHidden()).toBe(false);
      expect(screen.getByTestId('icon')).toBeInTheDocument();
    });
  });

  it('keeps the part headers for parallel agent content in a spec conversation', () => {
    const header = <span>Resume header</span>;
    const parts = renderRow({
      message: {
        ...reply,
        endpoint: 'Claude',
        model: 'claude-sonnet-5',
        sender: 'ClickHouse Agent',
      } as TMessage,
      conversation: {
        ...conversation,
        endpoint: 'Claude' as EModelEndpoint,
        model: 'claude-sonnet-5',
      } as TConversation,
      hasParallelContent: true,
      hideSelectedAuthor: true,
      selectedSender: 'ClickHouse Agent',
      authorHeader: header,
    });
    expect(parts.mock.calls[0][0].authorHeader).toBe(header);
  });

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
