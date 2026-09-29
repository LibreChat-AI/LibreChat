import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { RecoilRoot, type MutableSnapshot } from 'recoil';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  Constants,
  ContentTypes,
  EModelEndpoint,
  type TConversation,
  type TMessage,
} from 'librechat-data-provider';
import {
  MessagesViewContext,
  type MessagesViewContextValue,
} from '~/Providers/MessagesViewContext';
import { hasCopyableText } from '~/hooks/Messages/useCopyToClipboard';
import HoverButtons from '~/components/Chat/Messages/HoverButtons';
import store from '~/store';

const conversation = {
  conversationId: 'convo-1',
  endpoint: EModelEndpoint.agents,
  title: 'Test',
} as TConversation;

const userMessage = {
  messageId: 'user-1',
  conversationId: 'convo-1',
  parentMessageId: null,
  isCreatedByUser: true,
  text: 'tell me a long story',
} as TMessage;

function renderHoverButtons({
  isSubmitting,
  message = userMessage,
  conversation: targetConversation = conversation,
  isLast = false,
  latestMessageId = 'assistant-1',
  getCanCopy = () => hasCopyableText({ text: message.text, content: message.content }),
  handleFeedback,
  thread,
}: {
  isSubmitting: boolean;
  message?: TMessage;
  conversation?: TConversation;
  isLast?: boolean;
  latestMessageId?: string;
  getCanCopy?: () => boolean;
  handleFeedback?: () => void;
  /** The rows the hover controls resolve the message's parent from. Omitted, the
   *  thread is unavailable, as on a search row. */
  thread?: TMessage[];
}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  const initializeState = ({ set }: MutableSnapshot) => set(store.textToSpeech, false);

  const { container } = render(
    <QueryClientProvider client={queryClient}>
      <RecoilRoot initializeState={initializeState}>
        <MessagesViewContext.Provider
          value={{ getMessages: () => thread } as unknown as MessagesViewContextValue}
        >
          <MemoryRouter>
            <HoverButtons
              index={0}
              isLast={isLast}
              isEditing={false}
              message={message}
              conversation={targetConversation}
              isSubmitting={isSubmitting}
              enterEdit={jest.fn()}
              regenerate={jest.fn()}
              handleContinue={jest.fn()}
              copyToClipboard={jest.fn()}
              getCanCopy={getCanCopy}
              latestMessageId={latestMessageId}
              handleFeedback={handleFeedback}
            />
          </MemoryRouter>
        </MessagesViewContext.Provider>
      </RecoilRoot>
    </QueryClientProvider>,
  );

  return container;
}

describe('HoverButtons edit affordance', () => {
  it('keeps edit available on an earlier message while a generation is in flight', () => {
    const container = renderHoverButtons({ isSubmitting: true });
    const editButton = container.querySelector<HTMLButtonElement>(`#edit-${userMessage.messageId}`);

    expect(editButton).not.toBeNull();
    expect(editButton).toBeEnabled();
    expect(editButton).not.toHaveClass('pointer-events-none', 'opacity-0', '!opacity-0');
  });

  it('reveals on row hover once the generation settles', () => {
    const container = renderHoverButtons({ isSubmitting: false });
    const editButton = container.querySelector<HTMLButtonElement>(`#edit-${userMessage.messageId}`);

    expect(editButton).not.toBeNull();
    expect(editButton).toBeEnabled();
    expect(editButton).toHaveClass('group-hover:opacity-100');
    expect(editButton).not.toHaveClass('pointer-events-none', 'opacity-0', '!opacity-0');
  });

  it('offers no actions at all on the actively streaming assistant message', () => {
    const assistantMessage = {
      ...userMessage,
      messageId: 'assistant-1',
      isCreatedByUser: false,
      text: 'Partial response',
    } as TMessage;

    const container = renderHoverButtons({
      isSubmitting: true,
      message: assistantMessage,
      isLast: true,
      latestMessageId: assistantMessage.messageId,
    });

    /** Copying, forking or editing half a sentence all act on text that is about
     *  to change, so the response carries nothing until it settles. */
    expect(container.querySelector(`#edit-${assistantMessage.messageId}`)).toBeNull();
    expect(screen.queryByTestId('copy-response-button')).toBeNull();
    expect(container.querySelectorAll('button')).toHaveLength(0);
  });

  it('offers copy for an error response', () => {
    const errorMessage = {
      ...userMessage,
      messageId: 'assistant-error',
      isCreatedByUser: false,
      error: true,
      text: 'Tool execution failed',
    } as TMessage;

    renderHoverButtons({
      isSubmitting: false,
      message: errorMessage,
      isLast: true,
      latestMessageId: errorMessage.messageId,
    });

    expect(screen.getByTestId('copy-response-button')).toBeEnabled();
  });

  it('disables copy when the response serializes to nothing', () => {
    const errorPartMessage = {
      ...userMessage,
      messageId: 'assistant-error-part',
      isCreatedByUser: false,
      error: true,
      text: '',
      content: [{ type: ContentTypes.ERROR, error: 'Deployment lookup failed' }],
    } as TMessage;

    renderHoverButtons({
      isSubmitting: false,
      message: errorPartMessage,
      isLast: true,
      latestMessageId: errorPartMessage.messageId,
    });

    expect(screen.getByTestId('copy-response-button')).toBeDisabled();
  });

  it('never inspects a response that is still streaming', () => {
    const streamingMessage = {
      ...userMessage,
      messageId: 'assistant-1',
      isCreatedByUser: false,
      text: 'partial resp',
    } as TMessage;
    const getCanCopy = jest.fn(() => true);

    renderHoverButtons({
      isSubmitting: true,
      message: streamingMessage,
      isLast: true,
      latestMessageId: streamingMessage.messageId,
      getCanCopy,
    });

    expect(screen.queryByTestId('copy-response-button')).toBeNull();
    expect(getCanCopy).not.toHaveBeenCalled();
  });

  it('keeps child-thread history readable without model-turn controls', () => {
    const assistantMessage = {
      ...userMessage,
      messageId: 'assistant-child',
      isCreatedByUser: false,
      text: 'Completed child result',
    } as TMessage;
    const childConversation = {
      ...conversation,
      conversationId: 'child-thread',
      subagentThread: {
        rootConversationId: 'parent-thread',
        parentConversationId: 'parent-thread',
        parentMessageId: 'parent-message',
        parentToolCallId: 'parent-tool-call',
        parentAgentId: 'parent-agent',
        subagentType: 'researcher',
        subagentKind: 'agent',
        depth: 1,
      },
    } as TConversation;

    const container = renderHoverButtons({
      isSubmitting: false,
      message: assistantMessage,
      conversation: childConversation,
      isLast: true,
      latestMessageId: assistantMessage.messageId,
    });

    expect(screen.getByTestId('copy-response-button')).toBeEnabled();
    expect(container.querySelector(`#edit-${assistantMessage.messageId}`)).toBeNull();
    expect(screen.queryByTestId('regenerate-generation-button')).toBeNull();
    expect(screen.queryByTestId('continue-generation-button')).toBeNull();
  });

  /** A compaction turn parents onto the leaf it summarized, so every rerun shape
   *  would replay a model turn in the user slot: the submission mints a user
   *  message under an existing response's id and runs on empty text. Its editor
   *  has nothing to show either — neither a summary nor the error part a skipped
   *  or failed compaction persists is an editable part type. */
  it.each([
    [
      'a finished compaction',
      [
        {
          type: ContentTypes.SUMMARY,
          content: [{ type: ContentTypes.TEXT, text: 'Earlier turns, compacted.' }],
        },
      ],
    ],
    [
      'a failed compaction',
      [
        {
          type: ContentTypes.SUMMARY,
          failed: true,
          content: [{ type: ContentTypes.TEXT, text: 'Earlier turns, compacted.' }],
        },
      ],
    ],
    ['a compaction that persisted an error part', [{ type: ContentTypes.ERROR, error: 'failed' }]],
  ])('withholds rerun controls on %s', (_label, content) => {
    const summarizedLeaf = {
      ...userMessage,
      messageId: 'assistant-1',
      parentMessageId: 'user-1',
      isCreatedByUser: false,
      text: 'The long answer',
    } as TMessage;
    const compactionMessage = {
      ...userMessage,
      messageId: 'compaction-1',
      parentMessageId: summarizedLeaf.messageId,
      isCreatedByUser: false,
      text: '',
      finish_reason: 'length',
      content,
    } as TMessage;

    const container = renderHoverButtons({
      isSubmitting: false,
      message: compactionMessage,
      isLast: true,
      latestMessageId: compactionMessage.messageId,
      thread: [userMessage, summarizedLeaf, compactionMessage],
    });

    /** The row itself is intact — only the rerun shapes are withheld. */
    expect(screen.getByTestId('copy-response-button')).not.toBeNull();
    expect(container.querySelector(`#edit-${compactionMessage.messageId}`)).toBeNull();
    expect(screen.queryByTestId('regenerate-generation-button')).toBeNull();
    expect(screen.queryByTestId('continue-generation-button')).toBeNull();
  });

  /** Compact runs on whatever leaf the branch ends with, so its summary can hang
   *  off a user message. Replaying that message would answer it again instead of
   *  redoing the compaction, so the server's marker withholds the rerun shapes
   *  there too. */
  it('withholds rerun controls on a marked compaction hanging off a user message', () => {
    const compactionMessage = {
      ...userMessage,
      messageId: 'compaction-1',
      parentMessageId: userMessage.messageId,
      isCreatedByUser: false,
      text: '',
      finish_reason: 'length',
      content: [
        {
          type: ContentTypes.SUMMARY,
          initiatedBy: 'user',
          content: [{ type: ContentTypes.TEXT, text: 'Earlier turns, compacted.' }],
        },
      ],
    } as TMessage;

    const container = renderHoverButtons({
      isSubmitting: false,
      message: compactionMessage,
      isLast: true,
      latestMessageId: compactionMessage.messageId,
      thread: [userMessage, compactionMessage],
    });

    expect(screen.getByTestId('copy-response-button')).not.toBeNull();
    expect(container.querySelector(`#edit-${compactionMessage.messageId}`)).toBeNull();
    expect(screen.queryByTestId('regenerate-generation-button')).toBeNull();
    expect(screen.queryByTestId('continue-generation-button')).toBeNull();
  });

  /** The failure branch of the same shape: a compaction that produced no summary
   *  marks its error part, which is the only thing distinguishing it from a
   *  response to the user message it hangs off. */
  it('withholds rerun controls on a marked compaction failure hanging off a user message', () => {
    const failedCompaction = {
      ...userMessage,
      messageId: 'compaction-1',
      parentMessageId: userMessage.messageId,
      isCreatedByUser: false,
      text: '',
      content: [{ type: ContentTypes.ERROR, error: 'Summarization failed', initiatedBy: 'user' }],
    } as TMessage;

    const container = renderHoverButtons({
      isSubmitting: false,
      message: failedCompaction,
      isLast: true,
      latestMessageId: failedCompaction.messageId,
      thread: [userMessage, failedCompaction],
    });

    expect(container.querySelector(`#edit-${failedCompaction.messageId}`)).toBeNull();
    expect(screen.queryByTestId('regenerate-generation-button')).toBeNull();
    expect(screen.queryByTestId('continue-generation-button')).toBeNull();
  });

  /** An ordinary turn that auto-summarized and was cancelled before its first
   *  answer token persists the same summary-only content, but it hangs off the
   *  user's message and is exactly the turn a user needs to rerun. */
  it('keeps rerun controls on a cancelled turn that only auto-summarized', () => {
    const summarizedResponse = {
      ...userMessage,
      messageId: 'assistant-1',
      parentMessageId: userMessage.messageId,
      isCreatedByUser: false,
      text: '',
      finish_reason: 'length',
      content: [
        {
          type: ContentTypes.SUMMARY,
          content: [{ type: ContentTypes.TEXT, text: 'Older turns were summarized.' }],
        },
      ],
    } as TMessage;

    const container = renderHoverButtons({
      isSubmitting: false,
      message: summarizedResponse,
      isLast: true,
      latestMessageId: summarizedResponse.messageId,
      thread: [userMessage, summarizedResponse],
    });

    expect(container.querySelector(`#edit-${summarizedResponse.messageId}`)).not.toBeNull();
    expect(screen.getByTestId('regenerate-generation-button')).toBeEnabled();
    expect(screen.getByTestId('continue-generation-button')).toBeEnabled();
  });

  /** An imported or restored conversation can chain one model turn onto another
   *  without a user message between them. That reply has no user turn to replay,
   *  so the rerun shapes go, but its stored content is saved directly by the
   *  editor and stays editable. */
  it('keeps the editor, not the rerun shapes, on a model turn chained onto another', () => {
    const firstReply = {
      ...userMessage,
      messageId: 'assistant-1',
      parentMessageId: userMessage.messageId,
      isCreatedByUser: false,
      text: 'The first half of the answer',
    } as TMessage;
    const chainedReply = {
      ...userMessage,
      messageId: 'assistant-2',
      parentMessageId: firstReply.messageId,
      isCreatedByUser: false,
      text: 'The second half of the answer',
      finish_reason: 'length',
    } as TMessage;

    const container = renderHoverButtons({
      isSubmitting: false,
      message: chainedReply,
      isLast: true,
      latestMessageId: chainedReply.messageId,
      thread: [userMessage, firstReply, chainedReply],
    });

    expect(container.querySelector(`#edit-${chainedReply.messageId}`)).not.toBeNull();
    expect(screen.queryByTestId('regenerate-generation-button')).toBeNull();
    expect(screen.queryByTestId('continue-generation-button')).toBeNull();
  });

  /** The same imported shape with the skipped human message first: the reply is
   *  chained onto nothing, so the thread holds no parent at all. `regenerate` can
   *  only log that when the button is pressed, so the row withholds it. */
  it('withholds the rerun shapes on a model turn left at the root', () => {
    const rootReply = {
      ...userMessage,
      messageId: 'assistant-1',
      parentMessageId: Constants.NO_PARENT,
      isCreatedByUser: false,
      text: 'An imported reply with nothing before it',
      finish_reason: 'length',
    } as TMessage;

    const container = renderHoverButtons({
      isSubmitting: false,
      message: rootReply,
      isLast: true,
      latestMessageId: rootReply.messageId,
      thread: [rootReply],
    });

    /** Its stored text is still saved directly, so the editor stays. */
    expect(container.querySelector(`#edit-${rootReply.messageId}`)).not.toBeNull();
    expect(screen.queryByTestId('regenerate-generation-button')).toBeNull();
    expect(screen.queryByTestId('continue-generation-button')).toBeNull();
  });

  /** An artifact keeps its own read-only renderer, so a chained reply made only of
   *  one has no field to type in and no turn to replay: its editor would be dead. */
  it('withholds the editor on a chained model turn whose only content is an artifact', () => {
    const firstReply = {
      ...userMessage,
      messageId: 'assistant-1',
      parentMessageId: userMessage.messageId,
      isCreatedByUser: false,
      text: 'Here it comes',
    } as TMessage;
    const artifactReply = {
      ...userMessage,
      messageId: 'assistant-2',
      parentMessageId: firstReply.messageId,
      isCreatedByUser: false,
      text: '',
      content: [
        {
          type: ContentTypes.TEXT,
          text: ':::artifact{identifier="demo" type="text/html" title="Demo"}\n<div />\n:::',
        },
      ],
    } as TMessage;

    const container = renderHoverButtons({
      isSubmitting: false,
      message: artifactReply,
      isLast: true,
      latestMessageId: artifactReply.messageId,
      thread: [userMessage, firstReply, artifactReply],
    });

    expect(screen.getByTestId('copy-response-button')).not.toBeNull();
    expect(container.querySelector(`#edit-${artifactReply.messageId}`)).toBeNull();
    expect(screen.queryByTestId('regenerate-generation-button')).toBeNull();
  });

  /** A response whose parts the editor cannot show a field for still opens the
   *  editor when there is a user turn behind it: its Rerun is the point. */
  it('keeps the editor on an uneditable response that still has a user turn behind it', () => {
    const toolOnlyReply = {
      ...userMessage,
      messageId: 'assistant-1',
      parentMessageId: userMessage.messageId,
      isCreatedByUser: false,
      text: '',
      content: [{ type: ContentTypes.ERROR, error: 'failed' }],
    } as TMessage;

    const container = renderHoverButtons({
      isSubmitting: false,
      message: toolOnlyReply,
      isLast: true,
      latestMessageId: toolOnlyReply.messageId,
      thread: [userMessage, toolOnlyReply],
    });

    expect(container.querySelector(`#edit-${toolOnlyReply.messageId}`)).not.toBeNull();
    expect(screen.getByTestId('regenerate-generation-button')).toBeEnabled();
  });

  /** A row rendered outside the messages view cannot resolve its parent. Withholding
   *  on an unknown parent would strip the controls from every such row, so the gate
   *  stays open and the rerun paths refuse a non-user parent on their own. */
  it('keeps rerun controls when the thread is unavailable', () => {
    const compactionMessage = {
      ...userMessage,
      messageId: 'compaction-1',
      parentMessageId: 'assistant-1',
      isCreatedByUser: false,
      text: '',
      finish_reason: 'length',
      content: [
        {
          type: ContentTypes.SUMMARY,
          content: [{ type: ContentTypes.TEXT, text: 'Earlier turns, compacted.' }],
        },
      ],
    } as TMessage;

    const container = renderHoverButtons({
      isSubmitting: false,
      message: compactionMessage,
      isLast: true,
      latestMessageId: compactionMessage.messageId,
    });

    expect(container.querySelector(`#edit-${compactionMessage.messageId}`)).not.toBeNull();
    expect(screen.getByTestId('regenerate-generation-button')).toBeEnabled();
  });
});

describe('HoverButtons feedback affordance', () => {
  const assistantMessage = {
    ...userMessage,
    messageId: 'assistant-1',
    isCreatedByUser: false,
    text: 'Here is the answer',
  } as TMessage;

  const renderSettledResponse = (handleFeedback?: () => void) =>
    renderHoverButtons({
      isSubmitting: false,
      message: assistantMessage,
      isLast: true,
      latestMessageId: 'assistant-2',
      handleFeedback,
    });

  it('offers feedback on a settled response when a handler is supplied', async () => {
    renderSettledResponse(jest.fn());

    fireEvent.click(screen.getByRole('button', { name: 'Rate response' }));

    expect(await screen.findByRole('button', { name: 'Love this' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Needs improvement' })).toBeInTheDocument();
  });

  /** `useMessageActions` withholds the handler when `interface.feedback` is false, so
   *  this is how a deployment that disabled feedback reaches the action row. */
  it('hides feedback when no handler is supplied', () => {
    renderSettledResponse();

    expect(screen.queryByRole('button', { name: 'Rate response' })).toBeNull();
    expect(screen.getByTestId('copy-response-button')).toBeInTheDocument();
  });
});
