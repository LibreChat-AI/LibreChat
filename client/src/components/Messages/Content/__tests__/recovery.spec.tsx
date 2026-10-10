import React from 'react';
import userEvent from '@testing-library/user-event';
import { render, screen } from '@testing-library/react';
import { Constants, ContentTypes, ForkOptions, LocalStorageKeys } from 'librechat-data-provider';
import type { TConversation, TMessage } from 'librechat-data-provider';
import type { MessagesViewContextValue } from '~/Providers/MessagesViewContext';
import type { ChatContract } from '~/hooks/Chat/contract';
import {
  MessagesViewContext,
  MessagesSubmittingContext,
  MessagesOperationsContext,
} from '~/Providers/MessagesViewContext';
import { MessageContext } from '~/Providers/MessageContext';
import AttachmentRecoveryActions from '../Error/recovery';
import translation from '~/locales/en/translation.json';
import { ChatContext } from '~/Providers/ChatContext';
import { decodeBase64 } from '~/utils/drafts';

const catalog = translation as Record<string, string>;

const mockNavigateToConvo = jest.fn();
const mockShowToast = jest.fn();
const mockForkMutate = jest.fn();
let mockForkOptions: { onSuccess?: (data: { conversation: TConversation }) => void } = {};

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) =>
    (jest.requireActual('~/locales/en/translation.json') as Record<string, string>)[key] ?? key,
  useNavigateToConvo: () => ({ navigateToConvo: mockNavigateToConvo }),
}));

jest.mock('~/hooks/Chat', () => ({
  useGetAddedConvo: () => () => null,
}));

jest.mock('~/data-provider', () => ({
  useForkConvoMutation: (options: typeof mockForkOptions) => {
    mockForkOptions = options;
    return { mutate: mockForkMutate, isLoading: false };
  },
}));

jest.mock('@librechat/client', () => ({
  ...jest.requireActual('@librechat/client'),
  useToastContext: () => ({ showToast: mockShowToast }),
}));

const screenshot = { file_id: 'screenshot', filename: 'screenshot.png', type: 'image/png' };

const user = (messageId: string, parentMessageId: string, fields: Partial<TMessage> = {}) =>
  ({
    messageId,
    parentMessageId,
    conversationId: 'convo',
    isCreatedByUser: true,
    text: `question ${messageId}`,
    ...fields,
  }) as TMessage;

const answer = (messageId: string, parentMessageId: string, fields: Partial<TMessage> = {}) =>
  ({
    messageId,
    parentMessageId,
    conversationId: 'convo',
    isCreatedByUser: false,
    text: `answer ${messageId}`,
    ...fields,
  }) as TMessage;

const uploadErrorText = 'Error uploading code environment file: 429';

function renderRecovery({
  messages,
  messageId = 'a2',
  partIndex,
  text = uploadErrorText,
  inChat = true,
  readOnly = false,
  isSubmitting = false,
  ask = jest.fn(() => true),
}: {
  messages: TMessage[];
  messageId?: string;
  partIndex?: number;
  text?: string;
  inChat?: boolean;
  readOnly?: boolean;
  isSubmitting?: boolean;
  ask?: jest.Mock;
}) {
  const conversation = { conversationId: 'convo', endpoint: 'agents' } as TConversation;
  const operations = {
    ask,
    regenerate: jest.fn(),
    handleContinue: jest.fn(),
    getMessages: () => messages,
    setMessages: jest.fn(),
  } as unknown as MessagesViewContextValue;
  const view = {
    ...operations,
    conversation,
    conversationId: 'convo',
    readOnly,
    isSubmitting,
  } as MessagesViewContextValue;
  const content = (
    <MessagesOperationsContext.Provider value={operations}>
      <MessagesSubmittingContext.Provider value={isSubmitting}>
        <MessagesViewContext.Provider value={view}>
          <MessageContext.Provider
            value={{ messageId, partIndex, isExpanded: true, conversationId: 'convo' }}
          >
            <AttachmentRecoveryActions text={text} />
          </MessageContext.Provider>
        </MessagesViewContext.Provider>
      </MessagesSubmittingContext.Provider>
    </MessagesOperationsContext.Provider>
  );
  render(
    inChat ? (
      <ChatContext.Provider value={{ conversation } as unknown as ChatContract}>
        {content}
      </ChatContext.Provider>
    ) : (
      content
    ),
  );
  return { ask };
}

const retryFixture = () => [
  user('u1', Constants.NO_PARENT),
  answer('a1', 'u1'),
  user('u2', 'a1', {
    files: [screenshot],
    manualSkills: ['charts'],
    quotes: ['quoted line'],
  }),
  answer('a2', 'u2', { error: true }),
];

const branchFixture = () => [
  user('u1', Constants.NO_PARENT, { files: [screenshot] }),
  answer('a1', 'u1'),
  user('u2', 'a1', { files: [screenshot] }),
  answer('a2', 'u2', { error: true }),
];

describe('AttachmentRecoveryActions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
  });

  it('retries the failed turn as a new version without any files', async () => {
    const messages = retryFixture();
    const { ask } = renderRecovery({ messages });

    expect(screen.getByText(catalog.com_error_attachments_cause, { exact: false })).toBeTruthy();
    expect(screen.queryByRole('button', { name: catalog.com_ui_branch_without_files })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: catalog.com_ui_retry_without_files }));

    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask).toHaveBeenCalledWith(
      { text: 'question u2', parentMessageId: 'a1', conversationId: 'convo' },
      expect.objectContaining({
        overrideFiles: [],
        overrideManualSkills: ['charts'],
        overrideQuotes: ['quoted line'],
        overrideReasoning: null,
      }),
    );
    expect(ask.mock.calls[0][1]).not.toHaveProperty('isRegenerate');
  });

  it('branches into a copy without files that ends before the failed turn', async () => {
    renderRecovery({ messages: branchFixture() });

    expect(
      screen.getByText(catalog.com_error_attachments_both_info, { exact: false }),
    ).toBeTruthy();
    await userEvent.click(
      screen.getByRole('button', { name: catalog.com_ui_branch_without_files }),
    );

    expect(mockForkMutate).toHaveBeenCalledWith({
      conversationId: 'convo',
      messageId: 'a1',
      option: ForkOptions.DIRECT_PATH,
      excludeFiles: true,
    });

    const forked = { conversationId: 'forked' } as TConversation;
    mockForkOptions.onSuccess?.({ conversation: forked });

    expect(decodeBase64(localStorage.getItem(`${LocalStorageKeys.TEXT_DRAFT}forked`) ?? '')).toBe(
      'question u2',
    );
    expect(mockNavigateToConvo).toHaveBeenCalledWith(forked);
    expect(mockShowToast).toHaveBeenCalledWith(
      expect.objectContaining({ message: catalog.com_ui_branch_without_files_draft }),
    );
  });

  it('offers the actions without blaming files for an unrelated failure', () => {
    renderRecovery({ messages: retryFixture(), text: 'Model returned 500' });

    expect(screen.queryByText(catalog.com_error_attachments_cause, { exact: false })).toBeNull();
    expect(screen.getByText(catalog.com_error_attachments_retry_info)).toBeTruthy();
  });

  it('stays out of a failure with its own remedy', () => {
    renderRecovery({ messages: retryFixture(), text: JSON.stringify({ type: 'no_user_key' }) });

    expect(screen.queryByRole('button')).toBeNull();
  });

  it('renders nothing when the branch carries no files', () => {
    const messages = [user('u1', Constants.NO_PARENT), answer('a2', 'u1', { error: true })];
    renderRecovery({ messages });

    expect(screen.queryByRole('button')).toBeNull();
  });

  it.each([
    ['outside a chat', { inChat: false }],
    ['in a read-only view', { readOnly: true }],
  ])('renders nothing %s', (_label, options) => {
    renderRecovery({ messages: retryFixture(), ...options });

    expect(screen.queryByRole('button')).toBeNull();
  });

  it('disables the actions while a response is generating', () => {
    renderRecovery({ messages: branchFixture(), isSubmitting: true });

    for (const button of screen.getAllByRole('button')) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it('shows the actions once, under the last error part of a row', () => {
    const messages = retryFixture();
    messages[3] = answer('a2', 'u2', {
      content: [
        { type: ContentTypes.ERROR, [ContentTypes.ERROR]: 'first' },
        { type: ContentTypes.TEXT, text: 'partial' },
        { type: ContentTypes.ERROR, [ContentTypes.ERROR]: uploadErrorText },
      ] as TMessage['content'],
    });

    renderRecovery({ messages, partIndex: 0 });
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('shows the actions under the last error part', () => {
    const messages = retryFixture();
    messages[3] = answer('a2', 'u2', {
      content: [
        { type: ContentTypes.ERROR, [ContentTypes.ERROR]: 'first' },
        { type: ContentTypes.ERROR, [ContentTypes.ERROR]: uploadErrorText },
      ] as TMessage['content'],
    });

    renderRecovery({ messages, partIndex: 1 });
    expect(screen.getByRole('button', { name: catalog.com_ui_retry_without_files })).toBeTruthy();
  });
});
