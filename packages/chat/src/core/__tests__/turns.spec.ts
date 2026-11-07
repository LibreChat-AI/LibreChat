import { Constants, ContentTypes, EModelEndpoint } from 'librechat-data-provider';
import type { TMessage, TConversation } from 'librechat-data-provider';
import type { BuildTurnInput } from '../turns';
import type { ExtendedFile } from '../files';
import { buildTurn, createRegenerate } from '../turns';

const conversationId = 'conversation-1';

const user: TMessage = {
  messageId: 'user-1',
  parentMessageId: Constants.NO_PARENT as string,
  conversationId,
  text: 'Hello',
  sender: 'User',
  isCreatedByUser: true,
  manualSkills: ['skill-a'],
  quotes: ['quote-a'],
  files: [{ file_id: 'file-1', filepath: '/f', filename: 'f.txt', type: 'text/plain' }],
};

const response: TMessage = {
  messageId: 'response-1',
  parentMessageId: 'user-1',
  conversationId,
  text: 'Hi',
  sender: 'Assistant',
  isCreatedByUser: false,
  content: [
    { type: ContentTypes.THINK, [ContentTypes.THINK]: 'thinking', streamedIndex: 0 },
    { type: ContentTypes.TEXT, [ContentTypes.TEXT]: 'answer' },
  ],
};

const conversation = (overrides: Partial<TConversation> = {}): TConversation => ({
  conversationId,
  endpoint: EModelEndpoint.agents,
  agent_id: 'agent-1',
  title: null,
  createdAt: '2026-10-28T00:00:00.000Z',
  updatedAt: '2026-10-28T00:00:00.000Z',
  ...overrides,
});

const input = (overrides: Partial<BuildTurnInput> = {}): BuildTurnInput => ({
  text: 'Next question',
  params: { text: 'Next question' },
  options: {},
  conversationId,
  conversation: conversation(),
  latestMessage: response,
  cachedMessages: [user, response],
  canClearFiles: true,
  routeProjectId: null,
  isTemporary: false,
  ephemeralAgent: null,
  getSender: () => 'Assistant',
  userKey: undefined,
  manualSkills: [],
  quotes: [],
  reasoningOverride: undefined,
  code: {
    approvalMode: undefined,
    environmentMode: undefined,
    workspaces: undefined,
  },
  ...overrides,
});

describe('buildTurn', () => {
  it('appends a user message and a response placeholder to the branch tail', () => {
    const turn = buildTurn(input());

    expect(turn.currentMsg).toMatchObject({
      text: 'Next question',
      isCreatedByUser: true,
      parentMessageId: 'response-1',
      conversationId,
    });
    expect(turn.initialResponse).toMatchObject({
      parentMessageId: turn.currentMsg.messageId,
      model: 'agent-1',
      content: [],
      isCreatedByUser: false,
    });
    expect(turn.submissionMessages).toEqual([user, response]);
    expect(turn.submission.userMessage.messageId).toBe(turn.currentMsg.messageId);
    expect(turn.submission.endpointOption.overrideUserMessageId).toBe(
      `${turn.currentMsg.messageId}${Constants.COMMON_DIVIDER}0`,
    );
    expect(turn.startsSubmitting).toBe(true);
    expect(turn.newChatPath).toBeUndefined();
  });

  it('starts a new chat at the route the project id scopes it to', () => {
    const turn = buildTurn(
      input({
        conversationId: Constants.NEW_CONVO as string,
        conversation: conversation({ conversationId: Constants.NEW_CONVO as string }),
        routeProjectId: 'a'.repeat(24),
      }),
    );

    expect(turn.conversationId).toBeNull();
    expect(turn.currentMsg.parentMessageId).toBe(Constants.NO_PARENT);
    expect(turn.submissionMessages).toEqual([]);
    expect(turn.newChatPath).toBe(`/c/new?projectId=${'a'.repeat(24)}`);
    expect(turn.submission.conversation.chatProjectId).toBe('a'.repeat(24));
  });

  it('ignores the route project id for an existing chat', () => {
    const turn = buildTurn(input({ routeProjectId: 'b'.repeat(24) }));

    expect(turn.submission.conversation.chatProjectId).toBeUndefined();
    expect(turn.newChatPath).toBeUndefined();
  });

  it('consumes the composer files of a fresh send', () => {
    const files = new Map<string, ExtendedFile>([
      [
        'temp-1',
        {
          file_id: 'file-2',
          temp_file_id: 'temp-1',
          filename: 'a.png',
          type: 'image/png',
          progress: 1,
          size: 1,
        },
      ],
    ]);
    const turn = buildTurn(input({ files }));

    expect(turn.currentMsg.files).toEqual([
      expect.objectContaining({ file_id: 'file-2', filename: 'a.png', type: 'image/png' }),
    ]);
    expect(turn.fileEffects).toEqual({
      submittedFileIds: ['temp-1', 'file-2', 'temp-1'],
      clearComposer: true,
    });
  });

  it('leaves composer files alone when the caller supplies the attachments', () => {
    const files = new Map<string, ExtendedFile>([
      ['temp-1', { file_id: 'file-2', temp_file_id: 'temp-1', progress: 1, size: 1 }],
    ]);
    const turn = buildTurn(input({ files, options: { overrideFiles: [] } }));

    expect(turn.currentMsg.files).toBeUndefined();
    expect(turn.fileEffects).toBeUndefined();
  });

  it('regenerates under the user message and replays its files', () => {
    const turn = buildTurn(
      input({
        text: user.text,
        params: {
          text: user.text,
          messageId: user.messageId,
          parentMessageId: Constants.NO_PARENT as string,
        },
        options: { isRegenerate: true, targetResponseMessageId: response.messageId },
      }),
    );

    expect(turn.regenerateShaped).toBe(true);
    expect(turn.initialResponse.parentMessageId).toBe('user-1');
    expect(turn.initialResponse.messageId).toBe('response-1_');
    expect(turn.submission.userMessage.overrideParentMessageId).toBe('user-1');
    expect(turn.submissionMessages.map((message) => message.messageId)).toEqual(['user-1']);
    expect(turn.currentMsg.files).toEqual(user.files);
    expect(turn.fileEffects?.clearComposer).toBe(true);
  });

  it('edits a content part on a copy, leaving the cached response untouched', () => {
    const turn = buildTurn(
      input({
        text: user.text,
        params: { text: user.text, messageId: user.messageId, parentMessageId: user.messageId },
        options: {
          isEdited: true,
          editedMessageId: response.messageId,
          editedContent: { index: 1, type: ContentTypes.TEXT, [ContentTypes.TEXT]: 'edited' },
        },
      }),
    );

    expect(turn.initialResponse.content).toEqual([
      { type: ContentTypes.THINK, [ContentTypes.THINK]: 'thinking' },
      { type: ContentTypes.TEXT, [ContentTypes.TEXT]: 'edited' },
    ]);
    expect(turn.submission.editPrefixLength).toBe(2);
    expect(response.content?.[1]).toEqual({
      type: ContentTypes.TEXT,
      [ContentTypes.TEXT]: 'answer',
    });
    expect(response.content?.[0]).toHaveProperty('streamedIndex', 0);
  });

  it('seeds an Assistants response with a text part and leaves submitting to the stream', () => {
    const turn = buildTurn(
      input({
        conversation: conversation({
          endpoint: EModelEndpoint.assistants,
          assistant_id: 'asst-1',
          agent_id: undefined,
        }),
        userKey: 'never',
      }),
    );

    expect(turn.initialResponse.model).toBe('asst-1');
    expect(turn.initialResponse.content).toEqual([
      { type: ContentTypes.TEXT, [ContentTypes.TEXT]: { value: '' } },
    ]);
    expect(turn.submission.endpointOption.key).toBe('never');
    expect(turn.startsSubmitting).toBe(false);
  });
});

describe('createRegenerate', () => {
  const messages = [user, response];

  it('replays the user message a response answers, with its skills, quotes and reasoning', () => {
    const ask = jest.fn();
    createRegenerate(ask, () => messages)(response);

    expect(ask).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'user-1', text: 'Hello' }),
      expect.objectContaining({
        isRegenerate: true,
        targetResponseMessageId: 'response-1',
        overrideManualSkills: ['skill-a'],
        overrideQuotes: ['quote-a'],
        overrideReasoning: null,
      }),
    );
  });

  it('targets no response when regenerating from the user message itself', () => {
    const ask = jest.fn();
    createRegenerate(ask, () => messages)(user);

    expect(ask.mock.calls[0][1]).toMatchObject({ targetResponseMessageId: undefined });
  });

  it('asks nothing when the parent is not a user message', () => {
    const ask = jest.fn();
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    createRegenerate(ask, () => [response])(response);

    expect(ask).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalled();
  });
});
