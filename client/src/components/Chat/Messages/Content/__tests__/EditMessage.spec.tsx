import React from 'react';
import userEvent from '@testing-library/user-event';
import { Constants } from 'librechat-data-provider';
import { render, screen, waitFor } from '@testing-library/react';
import type { TMessage } from 'librechat-data-provider';
import EditMessage from '../EditMessage';

const mockMutateAsync = jest.fn();
const mockSetMessages = jest.fn();
const mockGetMessages = jest.fn();

jest.mock('recoil', () => ({
  useRecoilValue: () => 'ltr',
}));

jest.mock('~/store', () => ({
  __esModule: true,
  default: { chatDirection: {} },
}));

jest.mock('librechat-data-provider/react-query', () => ({
  useUpdateMessageMutation: () => ({
    mutateAsync: mockMutateAsync,
    isLoading: false,
  }),
}));

jest.mock('~/Providers', () => ({
  useMessagesConversation: () => ({
    conversation: { conversationId: 'conversation-1', model: 'test-model' },
  }),
  useMessagesOperations: () => ({
    getMessages: mockGetMessages,
    setMessages: mockSetMessages,
  }),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

jest.mock('~/hooks/Chat', () => ({
  useGetAddedConvo: () => () => null,
}));

jest.mock('../Container', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const message = {
  messageId: 'user-1',
  parentMessageId: 'root',
  conversationId: 'conversation-1',
  isCreatedByUser: true,
  text: 'Original message',
} as TMessage;

const assistantMessage = {
  messageId: 'assistant-1',
  parentMessageId: 'user-1',
  conversationId: 'conversation-1',
  isCreatedByUser: false,
  text: 'Original answer',
} as TMessage;

const emptyAssistantMessage = {
  messageId: 'assistant-2',
  parentMessageId: 'user-1',
  conversationId: 'conversation-1',
  isCreatedByUser: false,
  text: '',
} as TMessage;

function renderEditor({
  enterEdit = jest.fn(),
  ask = jest.fn(),
  setSiblingIdx = jest.fn(),
  editedMessage = message,
} = {}) {
  render(
    <EditMessage
      text={editedMessage.text}
      message={editedMessage}
      isSubmitting={false}
      ask={ask}
      enterEdit={enterEdit}
      siblingIdx={0}
      setSiblingIdx={setSiblingIdx}
    />,
  );
  return { ask, enterEdit, setSiblingIdx };
}

describe('EditMessage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetMessages.mockReturnValue([message]);
    mockMutateAsync.mockResolvedValue({});
  });

  it('sizes the editor from the configured message font rather than pinning it', () => {
    renderEditor();

    const editor = screen.getByTestId('message-text-editor');
    expect(editor).toHaveClass('message-editor-text');
    expect(editor).not.toHaveClass('text-sm');
  });

  it('waits for a successful save before updating local state and closing', async () => {
    const user = userEvent.setup();
    const { enterEdit } = renderEditor();

    await user.clear(screen.getByTestId('message-text-editor'));
    await user.type(screen.getByTestId('message-text-editor'), 'Updated message');
    await user.click(screen.getByRole('button', { name: 'com_ui_save' }));

    await waitFor(() =>
      expect(mockMutateAsync).toHaveBeenCalledWith({
        conversationId: message.conversationId,
        model: 'test-model',
        text: 'Updated message',
        messageId: message.messageId,
      }),
    );
    expect(mockSetMessages).toHaveBeenCalledWith([
      expect.objectContaining({ messageId: message.messageId, text: 'Updated message' }),
    ]);
    expect(enterEdit).toHaveBeenCalledWith(true);
  });

  it('writes the save onto the thread as it stands when the request resolves', async () => {
    const user = userEvent.setup();
    const streamedAnswer = {
      messageId: 'assistant-streaming',
      parentMessageId: message.messageId,
      conversationId: 'conversation-1',
      isCreatedByUser: false,
      text: 'Half an answer',
    } as TMessage;

    /** The answer keeps streaming into the cache while the request is in flight. */
    mockMutateAsync.mockImplementation(async () => {
      mockGetMessages.mockReturnValue([message, streamedAnswer]);
      return {};
    });

    renderEditor();

    await user.clear(screen.getByTestId('message-text-editor'));
    await user.type(screen.getByTestId('message-text-editor'), 'Updated message');
    await user.click(screen.getByRole('button', { name: 'com_ui_save' }));

    await waitFor(() => expect(mockSetMessages).toHaveBeenCalled());
    expect(mockSetMessages).toHaveBeenCalledWith([
      expect.objectContaining({ messageId: message.messageId, text: 'Updated message' }),
      expect.objectContaining({ messageId: streamedAnswer.messageId, text: 'Half an answer' }),
    ]);
  });

  it('keeps the editor open with the draft when saving fails', async () => {
    const user = userEvent.setup();
    mockMutateAsync.mockRejectedValue(new Error('Save failed'));
    const { enterEdit } = renderEditor();

    await user.clear(screen.getByTestId('message-text-editor'));
    await user.type(screen.getByTestId('message-text-editor'), 'Unsaved message');
    await user.click(screen.getByRole('button', { name: 'com_ui_save' }));

    expect(await screen.findByText('com_ui_save_message_error')).toBeInTheDocument();
    expect(screen.getByTestId('message-text-editor')).toHaveValue('Unsaved message');
    expect(enterEdit).not.toHaveBeenCalled();
  });

  it('submits the edited user message with its original context', async () => {
    const user = userEvent.setup();
    const ask = jest.fn();
    const { enterEdit } = renderEditor({ ask });

    await user.clear(screen.getByTestId('message-text-editor'));
    await user.type(screen.getByTestId('message-text-editor'), 'Updated and rerun');
    await user.click(screen.getByRole('button', { name: 'com_ui_update_rerun' }));

    await waitFor(() =>
      expect(ask).toHaveBeenCalledWith(
        expect.objectContaining({
          text: 'Updated and rerun',
          parentMessageId: message.parentMessageId,
          conversationId: message.conversationId,
        }),
        expect.objectContaining({
          overrideFiles: message.files,
          overrideManualSkills: message.manualSkills,
          overrideQuotes: message.quotes,
        }),
      ),
    );
    expect(enterEdit).toHaveBeenCalledWith(true);
  });

  /** The rerun that matters most needs no edit at all: a cancelled response, or a
   *  backend restarted on different parameters, has to be reissued untouched. */
  it('reruns an unchanged request without needing a cosmetic edit first', async () => {
    const user = userEvent.setup();
    const ask = jest.fn();
    const { enterEdit, setSiblingIdx } = renderEditor({ ask });

    const rerun = screen.getByRole('button', { name: 'com_ui_rerun' });
    expect(rerun).toBeEnabled();
    /** Saving an untouched draft still has nothing to write. */
    expect(screen.getByRole('button', { name: 'com_ui_save' })).toBeDisabled();

    await user.click(rerun);

    await waitFor(() =>
      expect(ask).toHaveBeenCalledWith(
        expect.objectContaining({
          text: 'Original message',
          parentMessageId: message.parentMessageId,
          conversationId: message.conversationId,
        }),
        expect.objectContaining({ overrideFiles: message.files }),
      ),
    );
    expect(setSiblingIdx).toHaveBeenCalledWith(-1);
    expect(enterEdit).toHaveBeenCalledWith(true);
  });

  it('names the rerun after the edit only once the draft differs', async () => {
    const user = userEvent.setup();
    renderEditor();

    expect(screen.getByRole('button', { name: 'com_ui_rerun' })).toBeInTheDocument();

    await user.type(screen.getByTestId('message-text-editor'), ' again');

    expect(screen.queryByRole('button', { name: 'com_ui_rerun' })).toBeNull();
    expect(screen.getByRole('button', { name: 'com_ui_update_rerun' })).toBeEnabled();
  });

  it('keeps the editor open with the draft when a rerun is refused mid-stream', async () => {
    const user = userEvent.setup();
    const ask = jest.fn().mockReturnValue(false);
    const { enterEdit, setSiblingIdx } = renderEditor({ ask });

    await user.clear(screen.getByTestId('message-text-editor'));
    await user.type(screen.getByTestId('message-text-editor'), 'Refused rerun');
    await user.click(screen.getByRole('button', { name: 'com_ui_update_rerun' }));

    await waitFor(() => expect(ask).toHaveBeenCalled());
    expect(screen.getByTestId('message-text-editor')).toHaveValue('Refused rerun');
    expect(setSiblingIdx).not.toHaveBeenCalled();
    expect(enterEdit).not.toHaveBeenCalled();
  });

  it('keeps an assistant edit open when a refused rerun would discard it', async () => {
    const user = userEvent.setup();
    mockGetMessages.mockReturnValue([message, assistantMessage]);
    const ask = jest.fn().mockReturnValue(false);
    const { enterEdit, setSiblingIdx } = renderEditor({ ask, editedMessage: assistantMessage });

    await user.clear(screen.getByTestId('message-text-editor'));
    await user.type(screen.getByTestId('message-text-editor'), 'Refused answer edit');
    await user.click(screen.getByRole('button', { name: 'com_ui_rerun' }));

    await waitFor(() => expect(ask).toHaveBeenCalled());
    expect(screen.getByTestId('message-text-editor')).toHaveValue('Refused answer edit');
    expect(setSiblingIdx).not.toHaveBeenCalled();
    expect(enterEdit).not.toHaveBeenCalled();
  });

  /** An answer's draft never reaches the submission, so the button must not offer to
   *  update it, the status slot has to say the edit is about to be dropped, and the
   *  submission has to be the plain regeneration the hover action sends. */
  it('reruns an assistant response as a regeneration of that response', async () => {
    const user = userEvent.setup();
    mockGetMessages.mockReturnValue([message, assistantMessage]);
    const ask = jest.fn();
    const { enterEdit, setSiblingIdx } = renderEditor({ ask, editedMessage: assistantMessage });

    await user.clear(screen.getByTestId('message-text-editor'));
    await user.type(screen.getByTestId('message-text-editor'), 'An edited answer');

    expect(screen.queryByRole('button', { name: 'com_ui_update_rerun' })).toBeNull();
    expect(screen.getByText('com_ui_rerun_discards_changes')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'com_ui_rerun' }));

    await waitFor(() => expect(ask).toHaveBeenCalled());
    expect(ask).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: message.messageId }),
      expect.objectContaining({
        isRegenerate: true,
        /** Names this answer, so an older sibling's rerun cannot prune the newest
         *  answer's subtree out of the optimistic thread. */
        targetResponseMessageId: assistantMessage.messageId,
      }),
    );
    const [, options] = ask.mock.calls[0] as [unknown, Record<string, unknown>];
    /** Edit-resubmission options would replace this row in place instead. */
    expect(options).not.toHaveProperty('editedMessageId');
    expect(options).not.toHaveProperty('isEdited');
    expect(options).not.toHaveProperty('editedText');
    /** The new answer is a sibling of this one, not of the user turn. */
    expect(setSiblingIdx).not.toHaveBeenCalled();
    expect(enterEdit).toHaveBeenCalledWith(true);
  });

  /** A rerun replays the parent as the turn's user message. A model turn chained
   *  onto another model turn — an imported thread with no user message between two
   *  replies — has no such parent, and submitting one would mint a user message
   *  under an existing response's id. The editor withholds the action instead of
   *  offering one that silently refuses, and Save still applies. */
  it('offers no rerun when the parent to replay is not a user turn', async () => {
    const user = userEvent.setup();
    const chainedAnswer = {
      messageId: 'assistant-2',
      parentMessageId: assistantMessage.messageId,
      conversationId: 'conversation-1',
      isCreatedByUser: false,
      text: 'A second answer with no user turn behind it',
    } as TMessage;
    mockGetMessages.mockReturnValue([message, assistantMessage, chainedAnswer]);
    const ask = jest.fn();
    renderEditor({ ask, editedMessage: chainedAnswer });

    expect(screen.queryByRole('button', { name: 'com_ui_rerun' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'com_ui_update_rerun' })).toBeNull();
    expect(screen.getByRole('button', { name: 'com_ui_save' })).toBeInTheDocument();
    /** The footer's status slot answers why the action it usually carries is gone. */
    expect(screen.getByText('com_ui_rerun_needs_user_turn')).toBeInTheDocument();

    /** The shortcut cannot reach it either. */
    const editor = screen.getByTestId('message-text-editor');
    await user.click(editor);
    await user.keyboard('{Control>}{Enter}{/Control}');

    expect(ask).not.toHaveBeenCalled();
    expect(editor).toHaveAttribute('aria-keyshortcuts', 'Control+S Meta+S Escape');
  });

  /** The importer chains each saved message onto the previous one, so a thread whose
   *  first human message was empty leaves its reply at the root: the rerun has no
   *  parent in the thread at all, not merely a model one. Offering the action there
   *  ran a submission that resolved no parent and returned without feedback. */
  it('offers no rerun when the response has no parent turn in the thread', async () => {
    const user = userEvent.setup();
    const rootAnswer = {
      messageId: 'assistant-3',
      parentMessageId: Constants.NO_PARENT,
      conversationId: 'conversation-1',
      isCreatedByUser: false,
      text: 'An imported reply with nothing before it',
    } as TMessage;
    mockGetMessages.mockReturnValue([rootAnswer]);
    const ask = jest.fn();
    renderEditor({ ask, editedMessage: rootAnswer });

    expect(screen.queryByRole('button', { name: 'com_ui_rerun' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'com_ui_update_rerun' })).toBeNull();
    expect(screen.getByRole('button', { name: 'com_ui_save' })).toBeInTheDocument();
    expect(screen.getByText('com_ui_rerun_needs_user_turn')).toBeInTheDocument();

    const editor = screen.getByTestId('message-text-editor');
    await user.click(editor);
    await user.keyboard('{Control>}{Enter}{/Control}');

    expect(ask).not.toHaveBeenCalled();
    expect(editor).toHaveAttribute('aria-keyshortcuts', 'Control+S Meta+S Escape');
  });

  /** The rerun-discards-changes warning describes an action this editor does not
   *  offer, so a save-only editor reports unsaved changes instead. */
  it('reports unsaved changes rather than a discarded rerun when no rerun is offered', async () => {
    const user = userEvent.setup();
    const chainedAnswer = {
      messageId: 'assistant-2',
      parentMessageId: assistantMessage.messageId,
      conversationId: 'conversation-1',
      isCreatedByUser: false,
      text: 'A second answer with no user turn behind it',
    } as TMessage;
    mockGetMessages.mockReturnValue([message, assistantMessage, chainedAnswer]);
    renderEditor({ editedMessage: chainedAnswer });

    await user.type(screen.getByTestId('message-text-editor'), ' edited');

    expect(screen.getByText('com_ui_unsaved_changes')).toBeInTheDocument();
    expect(screen.queryByText('com_ui_rerun_discards_changes')).toBeNull();
  });

  /** A response cancelled before its first token is exactly what needs rerunning, and
   *  the form marks text required so Save cannot blank a message. Routing the rerun
   *  through that validation left the enabled button inert. */
  it('reruns an answer that was cancelled before any text arrived', async () => {
    const user = userEvent.setup();
    mockGetMessages.mockReturnValue([message, emptyAssistantMessage]);
    const ask = jest.fn();
    const { enterEdit } = renderEditor({ ask, editedMessage: emptyAssistantMessage });

    const rerun = screen.getByRole('button', { name: 'com_ui_rerun' });
    expect(rerun).toBeEnabled();
    await user.click(rerun);

    await waitFor(() => expect(ask).toHaveBeenCalled());
    expect(ask).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: message.messageId }),
      expect.objectContaining({ targetResponseMessageId: emptyAssistantMessage.messageId }),
    );
    expect(enterEdit).toHaveBeenCalledWith(true);
  });
});
