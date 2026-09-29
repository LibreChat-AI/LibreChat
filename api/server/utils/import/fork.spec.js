const { Constants, ForkOptions } = require('librechat-data-provider');

const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};
jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: mockLogger,
}));

jest.mock('~/models', () => ({
  getConvo: jest.fn(),
  bulkSaveConvos: jest.fn(),
  getMessages: jest.fn(),
  bulkSaveMessages: jest.fn(),
  bulkIncrementTagCounts: jest.fn(),
  getSharedMessages: jest.fn(),
}));

jest.mock('~/server/controllers/ModelController', () => ({
  getModelsConfig: jest.fn().mockResolvedValue({ openAI: ['gpt-test'] }),
}));

jest.mock('~/server/services/Config', () => ({
  getAppConfig: jest.fn().mockResolvedValue({ interfaceConfig: {} }),
}));

let mockIdCounter = 0;
jest.mock('uuid', () => {
  return {
    v4: jest.fn(() => {
      mockIdCounter++;
      return mockIdCounter.toString();
    }),
  };
});

const {
  forkConversation,
  duplicateConversation,
  forkSharedConversation,
  splitAtTargetLevel,
  getAllMessagesUpToParent,
  getMessagesUpToTargetLevel,
  cloneMessagesWithTimestamps,
} = require('./fork');
const {
  bulkIncrementTagCounts,
  getConvo,
  bulkSaveConvos,
  getMessages,
  bulkSaveMessages,
  getSharedMessages,
} = require('~/models');
const { getModelsConfig } = require('~/server/controllers/ModelController');
const { createImportBatchBuilder } = require('./importBatchBuilder');
const BaseClient = require('~/app/clients/BaseClient');

/**
 *
 * @param {TMessage[]} messages - The list of messages to visualize.
 * @param {string | null} parentId - The parent message ID.
 * @param {string} prefix - The prefix to use for each line.
 * @returns
 */
function printMessageTree(messages, parentId = Constants.NO_PARENT, prefix = '') {
  let treeVisual = '';

  const childMessages = messages.filter((msg) => msg.parentMessageId === parentId);
  for (let index = 0; index < childMessages.length; index++) {
    const msg = childMessages[index];
    const isLast = index === childMessages.length - 1;
    const connector = isLast ? '└── ' : '├── ';

    treeVisual += `${prefix}${connector}[${msg.messageId}]: ${
      msg.parentMessageId !== Constants.NO_PARENT ? `Child of ${msg.parentMessageId}` : 'Root'
    }\n`;
    treeVisual += printMessageTree(messages, msg.messageId, prefix + (isLast ? '    ' : '|   '));
  }

  return treeVisual;
}

const mockMessages = [
  {
    messageId: '0',
    parentMessageId: Constants.NO_PARENT,
    text: 'Root message 1',
    createdAt: '2021-01-01',
  },
  {
    messageId: '1',
    parentMessageId: Constants.NO_PARENT,
    text: 'Root message 2',
    createdAt: '2021-01-01',
  },
  { messageId: '2', parentMessageId: '1', text: 'Child of 1', createdAt: '2021-01-02' },
  { messageId: '3', parentMessageId: '1', text: 'Child of 1', createdAt: '2021-01-03' },
  { messageId: '4', parentMessageId: '2', text: 'Child of 2', createdAt: '2021-01-04' },
  { messageId: '5', parentMessageId: '2', text: 'Child of 2', createdAt: '2021-01-05' },
  { messageId: '6', parentMessageId: '3', text: 'Child of 3', createdAt: '2021-01-06' },
  { messageId: '7', parentMessageId: '3', text: 'Child of 3', createdAt: '2021-01-07' },
  { messageId: '8', parentMessageId: '7', text: 'Child of 7', createdAt: '2021-01-07' },
];

const mockConversation = { convoId: 'abc123', title: 'Original Title' };

describe('forkConversation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIdCounter = 0;
    getConvo.mockResolvedValue(mockConversation);
    getMessages.mockResolvedValue(mockMessages);
    bulkSaveConvos.mockResolvedValue(null);
    bulkSaveMessages.mockResolvedValue(null);
  });

  test('should fork conversation without branches', async () => {
    const result = await forkConversation({
      originalConvoId: 'abc123',
      targetMessageId: '3',
      requestUserId: 'user1',
      option: ForkOptions.DIRECT_PATH,
    });
    console.debug('forkConversation: direct path\n', printMessageTree(result.messages));

    // Reversed order due to setup in function
    const expectedMessagesTexts = ['Child of 1', 'Root message 2'];
    expect(getMessages).toHaveBeenCalled();
    expect(bulkSaveMessages).toHaveBeenCalledWith(
      expect.arrayContaining(
        expectedMessagesTexts.map((text) => expect.objectContaining({ text })),
      ),
      true,
    );
  });

  test('should fork conversation without branches (deeper)', async () => {
    const result = await forkConversation({
      originalConvoId: 'abc123',
      targetMessageId: '8',
      requestUserId: 'user1',
      option: ForkOptions.DIRECT_PATH,
    });
    console.debug('forkConversation: direct path (deeper)\n', printMessageTree(result.messages));

    const expectedMessagesTexts = ['Child of 7', 'Child of 3', 'Child of 1', 'Root message 2'];
    expect(getMessages).toHaveBeenCalled();
    expect(bulkSaveMessages).toHaveBeenCalledWith(
      expect.arrayContaining(
        expectedMessagesTexts.map((text) => expect.objectContaining({ text })),
      ),
      true,
    );
  });

  test('detaches subagent lineage when forking a child conversation', async () => {
    getConvo.mockResolvedValue({
      ...mockConversation,
      subagentThread: {
        rootConversationId: 'root-conversation',
        parentConversationId: 'parent-conversation',
        parentToolCallId: 'parent-tool-call',
        subagentType: 'researcher',
        subagentKind: 'agent',
        depth: 1,
      },
    });

    await forkConversation({
      originalConvoId: 'abc123',
      targetMessageId: '3',
      requestUserId: 'user1',
      option: ForkOptions.DIRECT_PATH,
    });

    expect(bulkSaveConvos.mock.calls[0][0][0]).not.toHaveProperty('subagentThread');
    expect(
      bulkSaveMessages.mock.calls[0][0].every(
        (message) => message.subagentTask == null && message.subagentTranscript == null,
      ),
    ).toBe(true);
  });

  test('does not carry the source messages trace sampling onto their copies', async () => {
    getMessages.mockResolvedValue([
      {
        messageId: 'user-1',
        parentMessageId: Constants.NO_PARENT,
        isCreatedByUser: true,
        text: 'Hello',
      },
      {
        messageId: 'response-1',
        parentMessageId: 'user-1',
        isCreatedByUser: false,
        text: 'Hi',
        langfuseSampled: true,
        langfuseDestinationIds: ['destination-a'],
        langfuseRunId: 'run-a',
      },
    ]);

    await forkConversation({
      originalConvoId: 'abc123',
      targetMessageId: 'response-1',
      requestUserId: 'user1',
      option: ForkOptions.DIRECT_PATH,
    });

    const savedMessages = bulkSaveMessages.mock.calls[0][0];
    expect(savedMessages.map((message) => message.text)).toEqual(['Hello', 'Hi']);
    expect(
      savedMessages.every(
        (message) =>
          message.langfuseSampled === false &&
          !('langfuseDestinationIds' in message) &&
          !('langfuseRunId' in message),
      ),
    ).toBe(true);
  });

  test('drops child execution metadata while retaining its visible transcript', async () => {
    getConvo.mockResolvedValue({
      ...mockConversation,
      agent_id: 'agent-1',
      subagentThread: {
        rootConversationId: 'root-conversation',
        parentConversationId: 'parent-conversation',
        parentToolCallId: 'parent-tool-call',
        subagentType: 'researcher',
        subagentKind: 'agent',
        depth: 1,
      },
    });
    getMessages.mockResolvedValue([
      {
        messageId: 'task-1:user',
        parentMessageId: Constants.NO_PARENT,
        isCreatedByUser: true,
        text: 'Investigate this.',
        subagentTask: { attemptKey: 'attempt-1', status: 'running' },
      },
      {
        messageId: 'task-1:assistant',
        parentMessageId: 'task-1:user',
        isCreatedByUser: false,
        text: 'The investigation is complete.',
        subagentTask: { attemptKey: 'attempt-1', status: 'completed' },
        subagentTranscript: {
          taskId: 'task-1',
          mode: 'replace',
          messagesJson: '[{"role":"assistant","content":"private"}]',
        },
      },
    ]);

    await forkConversation({
      originalConvoId: 'abc123',
      targetMessageId: 'task-1:assistant',
      requestUserId: 'user1',
      option: ForkOptions.DIRECT_PATH,
    });

    const savedConversation = bulkSaveConvos.mock.calls[0][0][0];
    const savedMessages = bulkSaveMessages.mock.calls[0][0];
    expect(savedConversation).toEqual(expect.objectContaining({ agent_id: 'agent-1' }));
    expect(savedConversation).not.toHaveProperty('subagentThread');
    expect(savedMessages.map((message) => message.text)).toEqual([
      'Investigate this.',
      'The investigation is complete.',
    ]);
    expect(
      savedMessages.every(
        (message) => message.subagentTask == null && message.subagentTranscript == null,
      ),
    ).toBe(true);
  });

  test('should fork conversation with branches', async () => {
    const result = await forkConversation({
      originalConvoId: 'abc123',
      targetMessageId: '3',
      requestUserId: 'user1',
      option: ForkOptions.INCLUDE_BRANCHES,
    });

    console.debug('forkConversation: include branches\n', printMessageTree(result.messages));

    const expectedMessagesTexts = ['Root message 2', 'Child of 1', 'Child of 1'];
    expect(getMessages).toHaveBeenCalled();
    expect(bulkSaveMessages).toHaveBeenCalledWith(
      expect.arrayContaining(
        expectedMessagesTexts.map((text) => expect.objectContaining({ text })),
      ),
      true,
    );
  });

  test('should fork conversation up to target level', async () => {
    const result = await forkConversation({
      originalConvoId: 'abc123',
      targetMessageId: '3',
      requestUserId: 'user1',
      option: ForkOptions.TARGET_LEVEL,
    });

    console.debug('forkConversation: target level\n', printMessageTree(result.messages));

    const expectedMessagesTexts = ['Root message 1', 'Root message 2', 'Child of 1', 'Child of 1'];
    expect(getMessages).toHaveBeenCalled();
    expect(bulkSaveMessages).toHaveBeenCalledWith(
      expect.arrayContaining(
        expectedMessagesTexts.map((text) => expect.objectContaining({ text })),
      ),
      true,
    );
  });

  test('should handle errors during message fetching', async () => {
    getMessages.mockRejectedValue(new Error('Failed to fetch messages'));

    await expect(
      forkConversation({
        originalConvoId: 'abc123',
        targetMessageId: '3',
        requestUserId: 'user1',
      }),
    ).rejects.toThrow('Failed to fetch messages');
  });

  test('should increment tag counts when forking conversation with tags', async () => {
    const mockConvoWithTags = {
      ...mockConversation,
      tags: ['bookmark1', 'bookmark2'],
    };
    getConvo.mockResolvedValue(mockConvoWithTags);

    await forkConversation({
      originalConvoId: 'abc123',
      targetMessageId: '3',
      requestUserId: 'user1',
      option: ForkOptions.DIRECT_PATH,
    });

    // Verify that bulkIncrementTagCounts was called with correct tags
    expect(bulkIncrementTagCounts).toHaveBeenCalledWith('user1', ['bookmark1', 'bookmark2']);
  });

  test('should handle conversation without tags when forking', async () => {
    const mockConvoWithoutTags = {
      ...mockConversation,
      // No tags field
    };
    getConvo.mockResolvedValue(mockConvoWithoutTags);

    await forkConversation({
      originalConvoId: 'abc123',
      targetMessageId: '3',
      requestUserId: 'user1',
      option: ForkOptions.DIRECT_PATH,
    });

    // bulkIncrementTagCounts will be called with array containing undefined
    expect(bulkIncrementTagCounts).toHaveBeenCalled();
  });

  test('should handle empty tags array when forking', async () => {
    const mockConvoWithEmptyTags = {
      ...mockConversation,
      tags: [],
    };
    getConvo.mockResolvedValue(mockConvoWithEmptyTags);

    await forkConversation({
      originalConvoId: 'abc123',
      targetMessageId: '3',
      requestUserId: 'user1',
      option: ForkOptions.DIRECT_PATH,
    });

    // bulkIncrementTagCounts will be called with empty array
    expect(bulkIncrementTagCounts).toHaveBeenCalledWith('user1', []);
  });

  test('blocks filtered cloned content before writing any fork records', async () => {
    getMessages.mockResolvedValue([
      {
        messageId: 'private-message',
        parentMessageId: Constants.NO_PARENT,
        isCreatedByUser: true,
        text: 'PRIVATE-SENTINEL',
        createdAt: '2021-01-01',
      },
    ]);

    await expect(
      forkConversation({
        originalConvoId: 'abc123',
        targetMessageId: 'private-message',
        requestUserId: 'user1',
        option: ForkOptions.DIRECT_PATH,
        filters: {
          messages: {
            pii: {
              starterPatterns: [],
              customPatterns: [{ id: 'private', label: 'private value', regex: 'PRIVATE-[A-Z]+' }],
            },
          },
        },
      }),
    ).rejects.toMatchObject({
      code: 'content_filter_block',
      body: expect.objectContaining({ source: 'message', field: 'text' }),
    });

    expect(bulkSaveConvos).not.toHaveBeenCalled();
    expect(bulkSaveMessages).not.toHaveBeenCalled();
    expect(bulkIncrementTagCounts).not.toHaveBeenCalled();
  });

  test('blocks unattributed assistant prose with strict legacy-only policy before forking', async () => {
    getMessages.mockResolvedValue([
      {
        messageId: 'private-assistant-message',
        parentMessageId: Constants.NO_PARENT,
        isCreatedByUser: false,
        text: 'Legacy unattributed PRIVATE-SENTINEL',
        createdAt: '2021-01-01',
      },
    ]);

    await expect(
      forkConversation({
        originalConvoId: 'abc123',
        targetMessageId: 'private-assistant-message',
        requestUserId: 'user1',
        option: ForkOptions.DIRECT_PATH,
        filters: { messages: { unattributedAssistantContent: 'inspect' } },
        legacyPii: {
          starterPatterns: [],
          customPatterns: [{ id: 'private', label: 'private value', regex: 'PRIVATE-[A-Z]+' }],
        },
      }),
    ).rejects.toMatchObject({
      code: 'content_filter_block',
      body: expect.objectContaining({ source: 'message', field: 'text' }),
    });

    expect(bulkSaveConvos).not.toHaveBeenCalled();
    expect(bulkSaveMessages).not.toHaveBeenCalled();
  });
});

describe('duplicateConversation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIdCounter = 0;
    getConvo.mockResolvedValue(mockConversation);
    getMessages.mockResolvedValue(mockMessages);
    bulkSaveConvos.mockResolvedValue(null);
    bulkSaveMessages.mockResolvedValue(null);
    bulkIncrementTagCounts.mockResolvedValue(null);
  });

  test('should duplicate conversation and increment tag counts', async () => {
    const mockConvoWithTags = {
      ...mockConversation,
      tags: ['important', 'work', 'project'],
    };
    getConvo.mockResolvedValue(mockConvoWithTags);

    await duplicateConversation({
      userId: 'user1',
      conversationId: 'abc123',
    });

    // Verify that bulkIncrementTagCounts was called with correct tags
    expect(bulkIncrementTagCounts).toHaveBeenCalledWith('user1', ['important', 'work', 'project']);
  });

  test('should duplicate conversation without tags', async () => {
    const mockConvoWithoutTags = {
      ...mockConversation,
      // No tags field
    };
    getConvo.mockResolvedValue(mockConvoWithoutTags);

    await duplicateConversation({
      userId: 'user1',
      conversationId: 'abc123',
    });

    // bulkIncrementTagCounts will be called with array containing undefined
    expect(bulkIncrementTagCounts).toHaveBeenCalled();
  });

  test('should handle empty tags array when duplicating', async () => {
    const mockConvoWithEmptyTags = {
      ...mockConversation,
      tags: [],
    };
    getConvo.mockResolvedValue(mockConvoWithEmptyTags);

    await duplicateConversation({
      userId: 'user1',
      conversationId: 'abc123',
    });

    // bulkIncrementTagCounts will be called with empty array
    expect(bulkIncrementTagCounts).toHaveBeenCalledWith('user1', []);
  });

  test('detaches subagent lineage when duplicating a child conversation', async () => {
    getConvo.mockResolvedValue({
      ...mockConversation,
      subagentThread: {
        rootConversationId: 'root-conversation',
        parentConversationId: 'parent-conversation',
        parentToolCallId: 'parent-tool-call',
        subagentType: 'researcher',
        subagentKind: 'agent',
        depth: 1,
      },
    });

    await duplicateConversation({
      userId: 'user1',
      conversationId: 'abc123',
    });

    expect(bulkSaveConvos.mock.calls[0][0][0]).not.toHaveProperty('subagentThread');
  });

  test('does not log a submitted duplicate title', async () => {
    await duplicateConversation({
      userId: 'user1',
      conversationId: 'abc123',
      title: 'PRIVATE-SENTINEL',
    });

    expect(JSON.stringify(mockLogger.debug.mock.calls)).not.toContain('PRIVATE-SENTINEL');
  });

  test('blocks filtered cloned content before writing any duplicate records', async () => {
    getMessages.mockResolvedValue([
      {
        messageId: 'private-message',
        parentMessageId: Constants.NO_PARENT,
        isCreatedByUser: true,
        text: 'PRIVATE-SENTINEL',
        createdAt: '2021-01-01',
      },
    ]);

    await expect(
      duplicateConversation({
        userId: 'user1',
        conversationId: 'abc123',
        filters: {
          messages: {
            pii: {
              starterPatterns: [],
              customPatterns: [{ id: 'private', label: 'private value', regex: 'PRIVATE-[A-Z]+' }],
            },
          },
        },
      }),
    ).rejects.toMatchObject({
      code: 'content_filter_block',
      body: expect.objectContaining({ source: 'message', field: 'text' }),
    });

    expect(bulkSaveConvos).not.toHaveBeenCalled();
    expect(bulkSaveMessages).not.toHaveBeenCalled();
    expect(bulkIncrementTagCounts).not.toHaveBeenCalled();
  });
});

describe('forkSharedConversation', () => {
  const mockSharedMessages = [
    {
      messageId: 'msg_a',
      parentMessageId: Constants.NO_PARENT,
      text: 'Shared root',
      isCreatedByUser: true,
      createdAt: '2021-01-01',
    },
    {
      messageId: 'msg_b',
      parentMessageId: 'msg_a',
      text: 'Shared reply',
      isCreatedByUser: false,
      createdAt: '2021-01-02',
    },
  ];

  const SHARE_REVISION = '2026-01-01T00:00:00.000Z';

  const mockShare = {
    shareId: 'share123',
    conversationId: 'convo_anon',
    title: 'Shared Title',
    updatedAt: new Date(SHARE_REVISION),
    messages: mockSharedMessages,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockIdCounter = 0;
    getSharedMessages.mockResolvedValue(mockShare);
    getConvo.mockResolvedValue(mockConversation);
    getMessages.mockResolvedValue(mockSharedMessages);
    bulkSaveConvos.mockResolvedValue(null);
    bulkSaveMessages.mockResolvedValue(null);
    bulkIncrementTagCounts.mockResolvedValue(null);
  });

  test('should reject a fork aimed at a payload the owner has since republished', async () => {
    getSharedMessages.mockResolvedValue({
      ...mockShare,
      updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    });

    await expect(
      forkSharedConversation({
        shareId: 'share123',
        shareResourceId: 'resource123',
        requestUserId: 'user1',
        targetMessageIndex: 1,
        shareRevision: '2026-01-01T00:00:00.000Z',
      }),
    ).rejects.toMatchObject({ code: 'SHARE_REVISION_MISMATCH' });

    expect(bulkSaveMessages).not.toHaveBeenCalled();
  });

  test('should fork when the held revision still matches the published one', async () => {
    getSharedMessages.mockResolvedValue({
      ...mockShare,
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    const result = await forkSharedConversation({
      shareId: 'share123',
      shareResourceId: 'resource123',
      requestUserId: 'user1',
      shareRevision: SHARE_REVISION,
    });

    expect(result).toBeTruthy();
    expect(bulkSaveMessages).toHaveBeenCalled();
  });

  test('should clone shared messages into a conversation owned by the requesting user', async () => {
    const result = await forkSharedConversation({
      shareId: 'share123',
      shareResourceId: 'resource123',
      requestUserId: 'user1',
    });

    expect(getSharedMessages).toHaveBeenCalledWith('share123', 'resource123', {
      snapshotFiles: undefined,
      preflight: undefined,
    });

    const savedMessages = bulkSaveMessages.mock.calls[0][0];
    expect(savedMessages).toHaveLength(2);
    const [root, reply] = savedMessages;
    expect(root).toMatchObject({
      text: 'Shared root',
      user: 'user1',
      endpoint: 'openAI',
      parentMessageId: Constants.NO_PARENT,
    });
    expect(reply).toMatchObject({
      text: 'Shared reply',
      user: 'user1',
      parentMessageId: root.messageId,
    });
    expect(root.messageId).not.toBe('msg_a');
    expect(reply.messageId).not.toBe('msg_b');

    const savedConvos = bulkSaveConvos.mock.calls[0][0];
    expect(savedConvos[0]).toMatchObject({
      user: 'user1',
      title: 'Shared Title',
      endpoint: 'openAI',
      model: 'gpt-test',
    });

    expect(getConvo).toHaveBeenCalledWith('user1', savedConvos[0].conversationId);
    expect(result).toMatchObject({ conversation: mockConversation, messages: mockSharedMessages });
  });

  test('applies the requesting tenant content filters before saving a shared fork', async () => {
    const { getAppConfig } = require('~/server/services/Config');
    getAppConfig.mockResolvedValueOnce({
      interfaceConfig: {},
      filters: {
        messages: {
          pii: {
            starterPatterns: [],
            customPatterns: [{ id: 'private', label: 'private value', regex: 'PRIVATE-[A-Z]+' }],
          },
        },
      },
    });
    getSharedMessages.mockResolvedValueOnce({
      ...mockShare,
      messages: [{ ...mockSharedMessages[0], text: 'PRIVATE-SENTINEL' }],
    });

    await expect(
      forkSharedConversation({
        shareId: 'share123',
        shareResourceId: 'resource123',
        requestUserId: 'user1',
      }),
    ).rejects.toMatchObject({
      code: 'content_filter_block',
      body: expect.objectContaining({ source: 'message', field: 'text' }),
    });
    expect(bulkSaveConvos).not.toHaveBeenCalled();
    expect(bulkSaveMessages).not.toHaveBeenCalled();
  });

  test('should use an available endpoint when the deployment does not expose OpenAI', async () => {
    getModelsConfig.mockResolvedValueOnce({ anthropic: ['claude-test'] });

    await forkSharedConversation({
      shareId: 'share123',
      shareResourceId: 'resource123',
      requestUserId: 'user1',
    });

    const savedConvos = bulkSaveConvos.mock.calls[0][0];
    expect(savedConvos[0]).toMatchObject({ endpoint: 'anthropic', model: 'claude-test' });

    const savedMessages = bulkSaveMessages.mock.calls[0][0];
    expect(savedMessages.every((message) => message.endpoint === 'anthropic')).toBe(true);
  });

  test('should return null when the share is not found', async () => {
    getSharedMessages.mockResolvedValue(null);

    const result = await forkSharedConversation({
      shareId: 'missing',
      requestUserId: 'user1',
    });

    expect(result).toBeNull();
    expect(bulkSaveMessages).not.toHaveBeenCalled();
  });

  test('should return null when the share has no messages', async () => {
    getSharedMessages.mockResolvedValue({ ...mockShare, messages: [] });

    const result = await forkSharedConversation({
      shareId: 'share123',
      requestUserId: 'user1',
    });

    expect(result).toBeNull();
    expect(bulkSaveMessages).not.toHaveBeenCalled();
  });

  test('should normalize orphaned parentMessageId references to NO_PARENT', async () => {
    getSharedMessages.mockResolvedValue({
      ...mockShare,
      messages: [
        {
          messageId: 'msg_orphan',
          parentMessageId: 'msg_deleted',
          text: 'Orphaned message',
          createdAt: '2021-01-01',
        },
      ],
    });

    await forkSharedConversation({
      shareId: 'share123',
      requestUserId: 'user1',
    });

    const savedMessages = bulkSaveMessages.mock.calls[0][0];
    expect(savedMessages[0].parentMessageId).toBe(Constants.NO_PARENT);
  });

  test('should forward snapshotFiles to getSharedMessages so the kill switch is honored', async () => {
    await forkSharedConversation({
      shareId: 'share123',
      shareResourceId: 'resource123',
      requestUserId: 'user1',
      snapshotFiles: false,
    });

    expect(getSharedMessages).toHaveBeenCalledWith('share123', 'resource123', {
      snapshotFiles: false,
      preflight: undefined,
    });
  });

  test('forwards shared-content preflight before a legacy snapshot can be persisted', async () => {
    const sharedContentPreflight = jest.fn();

    await forkSharedConversation({
      shareId: 'share123',
      shareResourceId: 'resource123',
      requestUserId: 'user1',
      sharedContentPreflight,
    });

    expect(getSharedMessages).toHaveBeenCalledWith('share123', 'resource123', {
      snapshotFiles: undefined,
      preflight: sharedContentPreflight,
    });
  });

  test('should strip anonymized model identifiers from cloned messages', async () => {
    getSharedMessages.mockResolvedValue({
      ...mockShare,
      messages: [
        {
          messageId: 'msg_a',
          parentMessageId: Constants.NO_PARENT,
          text: 'Assistant message',
          model: 'a_anon123',
          createdAt: '2021-01-01',
        },
      ],
    });

    await forkSharedConversation({
      shareId: 'share123',
      requestUserId: 'user1',
    });

    const savedMessages = bulkSaveMessages.mock.calls[0][0];
    expect(savedMessages[0].model).not.toBe('a_anon123');
  });

  test('should strip file_id from cloned files and attachments', async () => {
    getSharedMessages.mockResolvedValue({
      ...mockShare,
      messages: [
        {
          messageId: 'msg_a',
          parentMessageId: Constants.NO_PARENT,
          text: 'Message with files',
          isCreatedByUser: true,
          createdAt: '2021-01-01',
          files: [{ file_id: 'owner-file-1', filepath: '/images/owner/a.png' }],
          attachments: [
            { file_id: 'owner-file-2', toolCallId: 'tool_1', filepath: '/images/owner/b.png' },
          ],
        },
      ],
    });

    await forkSharedConversation({
      shareId: 'share123',
      requestUserId: 'user1',
    });

    const savedMessages = bulkSaveMessages.mock.calls[0][0];
    const [message] = savedMessages;
    expect(message.files[0]).not.toHaveProperty('file_id');
    expect(message.attachments[0]).not.toHaveProperty('file_id');
    // Render-only metadata is preserved
    expect(message.files[0].filepath).toBe('/images/owner/a.png');
    expect(message.attachments[0].toolCallId).toBe('tool_1');
  });

  test('should resolve interfaceConfig from the app config and pass it to the builder', async () => {
    const interfaceConfig = { retentionMode: 'all', retention: { days: 30 } };
    const loadAppConfig = jest.fn().mockResolvedValue({ interfaceConfig });
    const builderFactory = jest.fn((userId, config) => createImportBatchBuilder(userId, config));

    await forkSharedConversation({
      shareId: 'share123',
      requestUserId: 'user1',
      userRole: 'USER',
      userTenantId: 'tenant-viewer',
      loadAppConfig,
      builderFactory,
    });

    expect(loadAppConfig).toHaveBeenCalledWith({
      role: 'USER',
      userId: 'user1',
      tenantId: 'tenant-viewer',
    });
    expect(builderFactory).toHaveBeenCalledWith('user1', interfaceConfig, undefined);
  });

  test('passes strict attribution and legacy message policy to the shared-fork builder', async () => {
    const filters = { messages: { unattributedAssistantContent: 'inspect' } };
    const legacyPii = { starterPatterns: [] };
    const loadAppConfig = jest.fn().mockResolvedValue({
      filters,
      messageFilter: { pii: legacyPii },
    });
    const builderFactory = jest.fn((...args) => createImportBatchBuilder(...args));

    await forkSharedConversation({
      shareId: 'share123',
      requestUserId: 'user1',
      loadAppConfig,
      builderFactory,
    });

    expect(builderFactory).toHaveBeenCalledWith('user1', undefined, filters, legacyPii);
  });

  test('should resolve the app config under the requesting user tenant', async () => {
    const { tenantStorage, getTenantId } = require('@librechat/data-schemas');
    let tenantDuringConfigLoad;
    const loadAppConfig = jest.fn(async () => {
      tenantDuringConfigLoad = getTenantId();
      return { interfaceConfig: {} };
    });

    await tenantStorage.run({ tenantId: 'tenant-share-owner' }, () =>
      forkSharedConversation({
        shareId: 'share123',
        requestUserId: 'user1',
        userTenantId: 'tenant-viewer',
        loadAppConfig,
      }),
    );

    expect(tenantDuringConfigLoad).toBe('tenant-viewer');
  });

  test('should clone only the active branch path when targetMessageIndex is provided', async () => {
    getSharedMessages.mockResolvedValue({
      ...mockShare,
      messages: [
        {
          messageId: 'msg_root',
          parentMessageId: Constants.NO_PARENT,
          text: 'Root',
          createdAt: '2021-01-01T00:00:00.000Z',
        },
        {
          messageId: 'msg_branch_a',
          parentMessageId: 'msg_root',
          text: 'Branch A (shared)',
          createdAt: '2021-01-02T00:00:00.000Z',
        },
        {
          messageId: 'msg_branch_b',
          parentMessageId: 'msg_root',
          text: 'Branch B (newer sibling)',
          createdAt: '2021-01-03T00:00:00.000Z',
        },
      ],
    });

    // Index 1 = the "Branch A" tip the viewer had active.
    await forkSharedConversation({
      shareId: 'share123',
      requestUserId: 'user1',
      targetMessageIndex: 1,
      shareRevision: SHARE_REVISION,
    });

    const savedTexts = bulkSaveMessages.mock.calls[0][0].map((message) => message.text);
    expect(savedTexts).toEqual(['Root', 'Branch A (shared)']);
    expect(savedTexts).not.toContain('Branch B (newer sibling)');
  });

  test('should select the correct branch even when siblings share a createdAt', async () => {
    getSharedMessages.mockResolvedValue({
      ...mockShare,
      messages: [
        {
          messageId: 'msg_root',
          parentMessageId: Constants.NO_PARENT,
          text: 'Root',
          createdAt: '2021-01-01T00:00:00.000Z',
        },
        {
          messageId: 'msg_sib_a',
          parentMessageId: 'msg_root',
          text: 'Sibling A',
          createdAt: '2021-01-02T00:00:00.000Z',
        },
        {
          messageId: 'msg_sib_b',
          parentMessageId: 'msg_root',
          text: 'Sibling B (same timestamp)',
          createdAt: '2021-01-02T00:00:00.000Z',
        },
      ],
    });

    // Index 2 unambiguously targets Sibling B despite the shared createdAt.
    await forkSharedConversation({
      shareId: 'share123',
      requestUserId: 'user1',
      targetMessageIndex: 2,
      shareRevision: SHARE_REVISION,
    });

    const savedTexts = bulkSaveMessages.mock.calls[0][0].map((message) => message.text);
    expect(savedTexts).toEqual(['Root', 'Sibling B (same timestamp)']);
    expect(savedTexts).not.toContain('Sibling A');
  });

  test('should fall back to the full set when targetMessageIndex is out of range', async () => {
    await forkSharedConversation({
      shareId: 'share123',
      requestUserId: 'user1',
      targetMessageIndex: 999,
      shareRevision: SHARE_REVISION,
    });

    expect(bulkSaveMessages.mock.calls[0][0]).toHaveLength(mockSharedMessages.length);
  });

  test('should ignore a positional target that comes without a revision', async () => {
    await forkSharedConversation({
      shareId: 'share123',
      requestUserId: 'user1',
      targetMessageIndex: 1,
    });

    // Nothing proves which payload the index was read against, so the whole share
    // is cloned instead of a branch the caller may never have seen.
    expect(bulkSaveMessages.mock.calls[0][0]).toHaveLength(mockSharedMessages.length);
  });

  test('should persist under the requesting user tenant, not the share tenant', async () => {
    const { tenantStorage, getTenantId } = require('@librechat/data-schemas');
    let tenantDuringSave;
    bulkSaveConvos.mockImplementation(async () => {
      tenantDuringSave = getTenantId();
    });

    // Simulate the handler running inside the share owner's tenant context
    // (as `canAccessSharedLink` does) and ensure the write switches to the viewer's.
    await tenantStorage.run({ tenantId: 'tenant-share-owner' }, () =>
      forkSharedConversation({
        shareId: 'share123',
        requestUserId: 'user1',
        userTenantId: 'tenant-viewer',
      }),
    );

    expect(tenantDuringSave).toBe('tenant-viewer');
  });
});

const mockMessagesComplex = [
  { messageId: '7', parentMessageId: Constants.NO_PARENT, text: 'Message 7' },
  { messageId: '8', parentMessageId: Constants.NO_PARENT, text: 'Message 8' },
  { messageId: '5', parentMessageId: '7', text: 'Message 5' },
  { messageId: '6', parentMessageId: '7', text: 'Message 6' },
  { messageId: '9', parentMessageId: '8', text: 'Message 9' },
  { messageId: '2', parentMessageId: '5', text: 'Message 2' },
  { messageId: '3', parentMessageId: '5', text: 'Message 3' },
  { messageId: '1', parentMessageId: '6', text: 'Message 1' },
  { messageId: '4', parentMessageId: '6', text: 'Message 4' },
  { messageId: '10', parentMessageId: '3', text: 'Message 10' },
];

describe('getMessagesUpToTargetLevel', () => {
  test('should get all messages up to target level', async () => {
    const result = getMessagesUpToTargetLevel(mockMessagesComplex, '5');
    const mappedResult = result.map((msg) => msg.messageId);
    console.debug(
      '[getMessagesUpToTargetLevel] should get all messages up to target level\n',
      mappedResult,
    );
    console.debug('mockMessages\n', printMessageTree(mockMessagesComplex));
    console.debug('result\n', printMessageTree(result));
    expect(mappedResult).toEqual(['7', '8', '5', '6', '9']);
  });

  test('should get all messages if target is deepest level', async () => {
    const result = getMessagesUpToTargetLevel(mockMessagesComplex, '10');
    expect(result.length).toEqual(mockMessagesComplex.length);
  });

  test('should return target if only message', async () => {
    const result = getMessagesUpToTargetLevel(
      [mockMessagesComplex[mockMessagesComplex.length - 1]],
      '10',
    );
    const mappedResult = result.map((msg) => msg.messageId);
    console.debug(
      '[getMessagesUpToTargetLevel] should return target if only message\n',
      mappedResult,
    );
    console.debug('mockMessages\n', printMessageTree(mockMessages));
    console.debug('result\n', printMessageTree(result));
    expect(mappedResult).toEqual(['10']);
  });

  test('should return empty array if target message ID does not exist', async () => {
    const result = getMessagesUpToTargetLevel(mockMessagesComplex, '123');
    expect(result).toEqual([]);
  });

  test('should return correct messages when target is a root message', async () => {
    const result = getMessagesUpToTargetLevel(mockMessagesComplex, '7');
    const mappedResult = result.map((msg) => msg.messageId);
    expect(mappedResult).toEqual(['7', '8']);
  });

  test('should correctly handle single message with non-matching ID', async () => {
    const singleMessage = [
      { messageId: '30', parentMessageId: Constants.NO_PARENT, text: 'Message 30' },
    ];
    const result = getMessagesUpToTargetLevel(singleMessage, '31');
    expect(result).toEqual([]);
  });

  test('should correctly handle case with circular dependencies', async () => {
    const circularMessages = [
      { messageId: '40', parentMessageId: '42', text: 'Message 40' },
      { messageId: '41', parentMessageId: '40', text: 'Message 41' },
      { messageId: '42', parentMessageId: '41', text: 'Message 42' },
    ];
    const result = getMessagesUpToTargetLevel(circularMessages, '40');
    const mappedResult = result.map((msg) => msg.messageId);
    expect(new Set(mappedResult)).toEqual(new Set(['40', '41', '42']));
  });

  test('should return all messages when all are interconnected and target is deep in hierarchy', async () => {
    const interconnectedMessages = [
      { messageId: '50', parentMessageId: Constants.NO_PARENT, text: 'Root Message' },
      { messageId: '51', parentMessageId: '50', text: 'Child Level 1' },
      { messageId: '52', parentMessageId: '51', text: 'Child Level 2' },
      { messageId: '53', parentMessageId: '52', text: 'Child Level 3' },
    ];
    const result = getMessagesUpToTargetLevel(interconnectedMessages, '53');
    const mappedResult = result.map((msg) => msg.messageId);
    expect(mappedResult).toEqual(['50', '51', '52', '53']);
  });
});

describe('getAllMessagesUpToParent', () => {
  const mockMessages = [
    { messageId: '11', parentMessageId: Constants.NO_PARENT, text: 'Message 11' },
    { messageId: '12', parentMessageId: Constants.NO_PARENT, text: 'Message 12' },
    { messageId: '13', parentMessageId: '11', text: 'Message 13' },
    { messageId: '14', parentMessageId: '12', text: 'Message 14' },
    { messageId: '15', parentMessageId: '13', text: 'Message 15' },
    { messageId: '16', parentMessageId: '13', text: 'Message 16' },
    { messageId: '21', parentMessageId: '13', text: 'Message 21' },
    { messageId: '17', parentMessageId: '14', text: 'Message 17' },
    { messageId: '18', parentMessageId: '16', text: 'Message 18' },
    { messageId: '19', parentMessageId: '18', text: 'Message 19' },
    { messageId: '20', parentMessageId: '19', text: 'Message 20' },
  ];

  test('should handle empty message list', async () => {
    const result = getAllMessagesUpToParent([], '10');
    expect(result).toEqual([]);
  });

  test('should handle target message not found', async () => {
    const result = getAllMessagesUpToParent(mockMessages, 'invalid-id');
    expect(result).toEqual([]);
  });

  test('should handle single level tree (no parents)', async () => {
    const result = getAllMessagesUpToParent(
      [
        { messageId: '11', parentMessageId: Constants.NO_PARENT, text: 'Message 11' },
        { messageId: '12', parentMessageId: Constants.NO_PARENT, text: 'Message 12' },
      ],
      '11',
    );
    const mappedResult = result.map((msg) => msg.messageId);
    expect(mappedResult).toEqual(['11']);
  });

  test('should correctly retrieve messages in a deeply nested structure', async () => {
    const result = getAllMessagesUpToParent(mockMessages, '20');
    const mappedResult = result.map((msg) => msg.messageId);
    expect(mappedResult).toContain('11');
    expect(mappedResult).toContain('13');
    expect(mappedResult).toContain('16');
    expect(mappedResult).toContain('18');
    expect(mappedResult).toContain('19');
    expect(mappedResult).toContain('20');
  });

  test('should return only the target message if it has no parent', async () => {
    const result = getAllMessagesUpToParent(mockMessages, '11');
    const mappedResult = result.map((msg) => msg.messageId);
    expect(mappedResult).toEqual(['11']);
  });

  test('should handle messages without a parent ID defined', async () => {
    const additionalMessages = [
      ...mockMessages,
      { messageId: '22', text: 'Message 22' }, // No parentMessageId field
    ];
    const result = getAllMessagesUpToParent(additionalMessages, '22');
    const mappedResult = result.map((msg) => msg.messageId);
    expect(mappedResult).toEqual(['22']);
  });

  test('should retrieve all messages from the target to the root (including indirect ancestors)', async () => {
    const result = getAllMessagesUpToParent(mockMessages, '18');
    const mappedResult = result.map((msg) => msg.messageId);
    console.debug(
      '[getAllMessagesUpToParent] should retrieve all messages from the target to the root\n',
      mappedResult,
    );
    console.debug('mockMessages\n', printMessageTree(mockMessages));
    console.debug('result\n', printMessageTree(result));
    expect(mappedResult).toEqual(['11', '13', '15', '16', '21', '18']);
  });

  test('should handle circular dependencies gracefully', () => {
    const mockMessages = [
      { messageId: '1', parentMessageId: '2' },
      { messageId: '2', parentMessageId: '3' },
      { messageId: '3', parentMessageId: '1' },
    ];

    const targetMessageId = '1';
    const result = getAllMessagesUpToParent(mockMessages, targetMessageId);

    const uniqueIds = new Set(result.map((msg) => msg.messageId));
    expect(uniqueIds.size).toBe(result.length);
    expect(result.map((msg) => msg.messageId).sort()).toEqual(['1', '2', '3'].sort());
  });

  test('should return target if only message', async () => {
    const result = getAllMessagesUpToParent([mockMessages[mockMessages.length - 1]], '20');
    const mappedResult = result.map((msg) => msg.messageId);
    console.debug(
      '[getAllMessagesUpToParent] should return target if only message\n',
      mappedResult,
    );
    console.debug('mockMessages\n', printMessageTree(mockMessages));
    console.debug('result\n', printMessageTree(result));
    expect(mappedResult).toEqual(['20']);
  });
});

describe('getMessagesForConversation', () => {
  const mockMessages = [
    { messageId: '11', parentMessageId: Constants.NO_PARENT, text: 'Message 11' },
    { messageId: '12', parentMessageId: Constants.NO_PARENT, text: 'Message 12' },
    { messageId: '13', parentMessageId: '11', text: 'Message 13' },
    { messageId: '14', parentMessageId: '12', text: 'Message 14' },
    { messageId: '15', parentMessageId: '13', text: 'Message 15' },
    { messageId: '16', parentMessageId: '13', text: 'Message 16' },
    { messageId: '21', parentMessageId: '13', text: 'Message 21' },
    { messageId: '17', parentMessageId: '14', text: 'Message 17' },
    { messageId: '18', parentMessageId: '16', text: 'Message 18' },
    { messageId: '19', parentMessageId: '18', text: 'Message 19' },
    { messageId: '20', parentMessageId: '19', text: 'Message 20' },
  ];

  test('should provide the direct path to the target without branches', async () => {
    const result = BaseClient.getMessagesForConversation({
      messages: mockMessages,
      parentMessageId: '18',
    });
    const mappedResult = result.map((msg) => msg.messageId);
    console.debug(
      '[getMessagesForConversation] should provide the direct path to the target without branches\n',
      mappedResult,
    );
    console.debug('mockMessages\n', printMessageTree(mockMessages));
    console.debug('result\n', printMessageTree(result));
    expect(new Set(mappedResult)).toEqual(new Set(['11', '13', '16', '18']));
  });

  test('should return target if only message', async () => {
    const result = BaseClient.getMessagesForConversation({
      messages: [mockMessages[mockMessages.length - 1]],
      parentMessageId: '20',
    });
    const mappedResult = result.map((msg) => msg.messageId);
    console.debug(
      '[getMessagesForConversation] should return target if only message\n',
      mappedResult,
    );
    console.debug('mockMessages\n', printMessageTree(mockMessages));
    console.debug('result\n', printMessageTree(result));
    expect(new Set(mappedResult)).toEqual(new Set(['20']));
  });

  test('should break on detecting a circular dependency', async () => {
    const mockMessagesWithCycle = [
      ...mockMessagesComplex,
      { messageId: '100', parentMessageId: '101', text: 'Message 100' },
      { messageId: '101', parentMessageId: '100', text: 'Message 101' }, // introduces circular dependency
    ];

    const result = BaseClient.getMessagesForConversation({
      messages: mockMessagesWithCycle,
      parentMessageId: '100',
    });
    const mappedResult = result.map((msg) => msg.messageId);
    console.debug(
      '[getMessagesForConversation] should break on detecting a circular dependency\n',
      mappedResult,
    );
    expect(mappedResult).toEqual(['101', '100']);
  });

  // Testing with mockMessagesComplex
  test('should correctly find the conversation path including root messages', async () => {
    const result = BaseClient.getMessagesForConversation({
      messages: mockMessagesComplex,
      parentMessageId: '2',
    });
    const mappedResult = result.map((msg) => msg.messageId);
    console.debug(
      '[getMessagesForConversation] should correctly find the conversation path including root messages\n',
      mappedResult,
    );
    expect(new Set(mappedResult)).toEqual(new Set(['7', '5', '2']));
  });

  // Testing summary feature
  test('should stop at summary if option is enabled', async () => {
    const messagesWithSummary = [
      ...mockMessagesComplex,
      { messageId: '11', parentMessageId: '7', text: 'Message 11', summary: 'Summary for 11' },
    ];

    const result = BaseClient.getMessagesForConversation({
      messages: messagesWithSummary,
      parentMessageId: '11',
      summary: true,
    });
    const mappedResult = result.map((msg) => msg.messageId);
    console.debug(
      '[getMessagesForConversation] should stop at summary if option is enabled\n',
      mappedResult,
    );
    expect(mappedResult).toEqual(['11']); // Should include only the summarizing message
  });

  // Testing no parent condition
  test('should return only the root message if no parent exists', async () => {
    const result = BaseClient.getMessagesForConversation({
      messages: mockMessagesComplex,
      parentMessageId: '8',
    });
    const mappedResult = result.map((msg) => msg.messageId);
    console.debug(
      '[getMessagesForConversation] should return only the root message if no parent exists\n',
      mappedResult,
    );
    expect(mappedResult).toEqual(['8']); // The message with no parent in the thread
  });
});

describe('splitAtTargetLevel', () => {
  /* const mockMessagesComplex = [
    { messageId: '7', parentMessageId: Constants.NO_PARENT, text: 'Message 7' },
    { messageId: '8', parentMessageId: Constants.NO_PARENT, text: 'Message 8' },
    { messageId: '5', parentMessageId: '7', text: 'Message 5' },
    { messageId: '6', parentMessageId: '7', text: 'Message 6' },
    { messageId: '9', parentMessageId: '8', text: 'Message 9' },
    { messageId: '2', parentMessageId: '5', text: 'Message 2' },
    { messageId: '3', parentMessageId: '5', text: 'Message 3' },
    { messageId: '1', parentMessageId: '6', text: 'Message 1' },
    { messageId: '4', parentMessageId: '6', text: 'Message 4' },
    { messageId: '10', parentMessageId: '3', text: 'Message 10' },
  ];

     mockMessages
    ├── [7]: Root
    |   ├── [5]: Child of 7
    |   |   ├── [2]: Child of 5
    |   |   └── [3]: Child of 5
    |   |       └── [10]: Child of 3
    |   └── [6]: Child of 7
    |       ├── [1]: Child of 6
    |       └── [4]: Child of 6
    └── [8]: Root
        └── [9]: Child of 8
  */
  test('should include target message level and all descendants (1/2)', () => {
    console.debug('splitAtTargetLevel: mockMessages\n', printMessageTree(mockMessagesComplex));
    const result = splitAtTargetLevel(mockMessagesComplex, '2');
    const mappedResult = result.map((msg) => msg.messageId);
    console.debug(
      'splitAtTargetLevel: include target message level and all descendants (1/2)\n',
      printMessageTree(result),
    );
    expect(mappedResult).toEqual(['2', '3', '1', '4', '10']);
  });

  test('should include target message level and all descendants (2/2)', () => {
    console.debug('splitAtTargetLevel: mockMessages\n', printMessageTree(mockMessagesComplex));
    const result = splitAtTargetLevel(mockMessagesComplex, '5');
    const mappedResult = result.map((msg) => msg.messageId);
    console.debug(
      'splitAtTargetLevel: include target message level and all descendants (2/2)\n',
      printMessageTree(result),
    );
    expect(mappedResult).toEqual(['5', '6', '9', '2', '3', '1', '4', '10']);
  });

  test('should handle when target message is root', () => {
    const result = splitAtTargetLevel(mockMessagesComplex, '7');
    console.debug('splitAtTargetLevel: target level is root message\n', printMessageTree(result));
    expect(result.length).toBe(mockMessagesComplex.length);
  });

  test('should handle when target message is deepest, lonely child', () => {
    const result = splitAtTargetLevel(mockMessagesComplex, '10');
    const mappedResult = result.map((msg) => msg.messageId);
    console.debug(
      'splitAtTargetLevel: target message is deepest, lonely child\n',
      printMessageTree(result),
    );
    expect(mappedResult).toEqual(['10']);
  });

  test('should handle when target level is last with many neighbors', () => {
    const mockMessages = [
      ...mockMessagesComplex,
      { messageId: '11', parentMessageId: '10', text: 'Message 11' },
      { messageId: '12', parentMessageId: '10', text: 'Message 12' },
      { messageId: '13', parentMessageId: '10', text: 'Message 13' },
      { messageId: '14', parentMessageId: '10', text: 'Message 14' },
      { messageId: '15', parentMessageId: '4', text: 'Message 15' },
      { messageId: '16', parentMessageId: '15', text: 'Message 15' },
    ];
    const result = splitAtTargetLevel(mockMessages, '11');
    const mappedResult = result.map((msg) => msg.messageId);
    console.debug(
      'splitAtTargetLevel: should handle when target level is last with many neighbors\n',
      printMessageTree(result),
    );
    expect(mappedResult).toEqual(['11', '12', '13', '14', '16']);
  });

  test('should handle non-existent target message', () => {
    // Non-existent message ID
    const result = splitAtTargetLevel(mockMessagesComplex, '99');
    expect(result.length).toBe(0);
  });
});

describe('cloneMessagesWithTimestamps', () => {
  test('should preserve user-submitted provenance without marking untouched model output', () => {
    const messagesToClone = [
      {
        messageId: 'submitted-assistant',
        parentMessageId: Constants.NO_PARENT,
        text: 'Imported assistant prose',
        isCreatedByUser: false,
        isUserSubmitted: true,
      },
      {
        messageId: 'model-assistant',
        parentMessageId: Constants.NO_PARENT,
        text: 'Untouched model prose',
        isCreatedByUser: false,
      },
      {
        messageId: 'mixed-assistant',
        parentMessageId: Constants.NO_PARENT,
        text: 'Mixed assistant prose',
        isCreatedByUser: false,
        userSubmittedPaths: ['/content/1/steer'],
        userSubmittedMessageFieldPaths: [{ path: '/content/0/tool_call/output', field: 'answer' }],
      },
    ];
    const importBatchBuilder = createImportBatchBuilder('testUser');
    importBatchBuilder.startConversation();

    cloneMessagesWithTimestamps(messagesToClone, importBatchBuilder);

    expect(
      importBatchBuilder.messages.find((message) => message.text === 'Imported assistant prose'),
    ).toMatchObject({ isCreatedByUser: false, isUserSubmitted: true });
    expect(
      importBatchBuilder.messages.find((message) => message.text === 'Untouched model prose'),
    ).not.toHaveProperty('isUserSubmitted');
    expect(
      importBatchBuilder.messages.find((message) => message.text === 'Mixed assistant prose'),
    ).toMatchObject({
      userSubmittedPaths: ['/content/1/steer'],
      userSubmittedMessageFieldPaths: [{ path: '/content/0/tool_call/output', field: 'answer' }],
    });
  });

  test('should maintain proper timestamp order between parent and child messages', () => {
    // Create messages with out-of-order timestamps
    const messagesToClone = [
      {
        messageId: 'parent',
        parentMessageId: Constants.NO_PARENT,
        text: 'Parent Message',
        createdAt: '2023-01-01T00:02:00Z', // Later timestamp
      },
      {
        messageId: 'child1',
        parentMessageId: 'parent',
        text: 'Child Message 1',
        createdAt: '2023-01-01T00:01:00Z', // Earlier timestamp
      },
      {
        messageId: 'child2',
        parentMessageId: 'parent',
        text: 'Child Message 2',
        createdAt: '2023-01-01T00:03:00Z',
      },
    ];

    const importBatchBuilder = createImportBatchBuilder('testUser');
    importBatchBuilder.startConversation();

    cloneMessagesWithTimestamps(messagesToClone, importBatchBuilder);

    // Verify timestamps are properly ordered
    const clonedMessages = importBatchBuilder.messages;
    expect(clonedMessages.length).toBe(3);

    // Find cloned messages (they'll have new IDs)
    const parent = clonedMessages.find((msg) => msg.parentMessageId === Constants.NO_PARENT);
    const children = clonedMessages.filter((msg) => msg.parentMessageId === parent.messageId);

    // Verify parent timestamp is earlier than all children
    children.forEach((child) => {
      expect(new Date(child.createdAt).getTime()).toBeGreaterThan(
        new Date(parent.createdAt).getTime(),
      );
    });
  });

  test('should handle multi-level message chains', () => {
    const messagesToClone = [
      {
        messageId: 'root',
        parentMessageId: Constants.NO_PARENT,
        text: 'Root',
        createdAt: '2023-01-01T00:03:00Z', // Latest
      },
      {
        messageId: 'parent',
        parentMessageId: 'root',
        text: 'Parent',
        createdAt: '2023-01-01T00:01:00Z', // Earliest
      },
      {
        messageId: 'child',
        parentMessageId: 'parent',
        text: 'Child',
        createdAt: '2023-01-01T00:02:00Z', // Middle
      },
    ];

    const importBatchBuilder = createImportBatchBuilder('testUser');
    importBatchBuilder.startConversation();

    cloneMessagesWithTimestamps(messagesToClone, importBatchBuilder);

    const clonedMessages = importBatchBuilder.messages;
    expect(clonedMessages.length).toBe(3);

    // Verify the chain of timestamps
    const root = clonedMessages.find((msg) => msg.parentMessageId === Constants.NO_PARENT);
    const parent = clonedMessages.find((msg) => msg.parentMessageId === root.messageId);
    const child = clonedMessages.find((msg) => msg.parentMessageId === parent.messageId);

    expect(new Date(parent.createdAt).getTime()).toBeGreaterThan(
      new Date(root.createdAt).getTime(),
    );
    expect(new Date(child.createdAt).getTime()).toBeGreaterThan(
      new Date(parent.createdAt).getTime(),
    );
  });

  test('should handle messages with identical timestamps', () => {
    const sameTimestamp = '2023-01-01T00:00:00Z';
    const messagesToClone = [
      {
        messageId: 'parent',
        parentMessageId: Constants.NO_PARENT,
        text: 'Parent',
        createdAt: sameTimestamp,
      },
      {
        messageId: 'child',
        parentMessageId: 'parent',
        text: 'Child',
        createdAt: sameTimestamp,
      },
    ];

    const importBatchBuilder = createImportBatchBuilder('testUser');
    importBatchBuilder.startConversation();

    cloneMessagesWithTimestamps(messagesToClone, importBatchBuilder);

    const clonedMessages = importBatchBuilder.messages;
    const parent = clonedMessages.find((msg) => msg.parentMessageId === Constants.NO_PARENT);
    const child = clonedMessages.find((msg) => msg.parentMessageId === parent.messageId);

    expect(new Date(child.createdAt).getTime()).toBeGreaterThan(
      new Date(parent.createdAt).getTime(),
    );
  });

  test('should preserve original timestamps when already properly ordered', () => {
    const messagesToClone = [
      {
        messageId: 'parent',
        parentMessageId: Constants.NO_PARENT,
        text: 'Parent',
        createdAt: '2023-01-01T00:00:00Z',
      },
      {
        messageId: 'child',
        parentMessageId: 'parent',
        text: 'Child',
        createdAt: '2023-01-01T00:01:00Z',
      },
    ];

    const importBatchBuilder = createImportBatchBuilder('testUser');
    importBatchBuilder.startConversation();

    cloneMessagesWithTimestamps(messagesToClone, importBatchBuilder);

    const clonedMessages = importBatchBuilder.messages;
    const parent = clonedMessages.find((msg) => msg.parentMessageId === Constants.NO_PARENT);
    const child = clonedMessages.find((msg) => msg.parentMessageId === parent.messageId);

    expect(parent.createdAt).toEqual(new Date(messagesToClone[0].createdAt));
    expect(child.createdAt).toEqual(new Date(messagesToClone[1].createdAt));
  });

  test('should handle complex multi-branch scenario with out-of-order timestamps', () => {
    const complexMessages = [
      // Branch 1: Root -> A -> (B, C) -> D
      {
        messageId: 'root1',
        parentMessageId: Constants.NO_PARENT,
        text: 'Root 1',
        createdAt: '2023-01-01T00:05:00Z', // Root is later than children
      },
      {
        messageId: 'A1',
        parentMessageId: 'root1',
        text: 'A1',
        createdAt: '2023-01-01T00:02:00Z',
      },
      {
        messageId: 'B1',
        parentMessageId: 'A1',
        text: 'B1',
        createdAt: '2023-01-01T00:01:00Z', // Earlier than parent
      },
      {
        messageId: 'C1',
        parentMessageId: 'A1',
        text: 'C1',
        createdAt: '2023-01-01T00:03:00Z',
      },
      {
        messageId: 'D1',
        parentMessageId: 'B1',
        text: 'D1',
        createdAt: '2023-01-01T00:04:00Z',
      },

      // Branch 2: Root -> (X, Y, Z) where Z has children but X is latest
      {
        messageId: 'root2',
        parentMessageId: Constants.NO_PARENT,
        text: 'Root 2',
        createdAt: '2023-01-01T00:06:00Z',
      },
      {
        messageId: 'X2',
        parentMessageId: 'root2',
        text: 'X2',
        createdAt: '2023-01-01T00:09:00Z', // Latest of siblings
      },
      {
        messageId: 'Y2',
        parentMessageId: 'root2',
        text: 'Y2',
        createdAt: '2023-01-01T00:07:00Z',
      },
      {
        messageId: 'Z2',
        parentMessageId: 'root2',
        text: 'Z2',
        createdAt: '2023-01-01T00:08:00Z',
      },
      {
        messageId: 'Z2Child',
        parentMessageId: 'Z2',
        text: 'Z2 Child',
        createdAt: '2023-01-01T00:04:00Z', // Earlier than all parents
      },

      // Branch 3: Root with alternating early/late timestamps
      {
        messageId: 'root3',
        parentMessageId: Constants.NO_PARENT,
        text: 'Root 3',
        createdAt: '2023-01-01T00:15:00Z', // Latest of all
      },
      {
        messageId: 'E3',
        parentMessageId: 'root3',
        text: 'E3',
        createdAt: '2023-01-01T00:10:00Z',
      },
      {
        messageId: 'F3',
        parentMessageId: 'E3',
        text: 'F3',
        createdAt: '2023-01-01T00:14:00Z', // Later than parent
      },
      {
        messageId: 'G3',
        parentMessageId: 'F3',
        text: 'G3',
        createdAt: '2023-01-01T00:11:00Z', // Earlier than parent
      },
      {
        messageId: 'H3',
        parentMessageId: 'G3',
        text: 'H3',
        createdAt: '2023-01-01T00:13:00Z',
      },
    ];

    const importBatchBuilder = createImportBatchBuilder('testUser');
    importBatchBuilder.startConversation();

    cloneMessagesWithTimestamps(complexMessages, importBatchBuilder);

    const clonedMessages = importBatchBuilder.messages;
    console.debug(
      'Complex multi-branch scenario\nOriginal messages:\n',
      printMessageTree(complexMessages),
    );
    console.debug('Cloned messages:\n', printMessageTree(clonedMessages));

    // Helper function to verify timestamp order
    const verifyTimestampOrder = (parentId, messages) => {
      const parent = messages.find((msg) => msg.messageId === parentId);
      const children = messages.filter((msg) => msg.parentMessageId === parentId);

      children.forEach((child) => {
        const parentTime = new Date(parent.createdAt).getTime();
        const childTime = new Date(child.createdAt).getTime();
        expect(childTime).toBeGreaterThan(parentTime);
        // Recursively verify child's children
        verifyTimestampOrder(child.messageId, messages);
      });
    };

    // Verify each branch
    const roots = clonedMessages.filter((msg) => msg.parentMessageId === Constants.NO_PARENT);
    roots.forEach((root) => verifyTimestampOrder(root.messageId, clonedMessages));

    // Additional specific checks
    const getMessageByText = (text) => clonedMessages.find((msg) => msg.text === text);

    // Branch 1 checks
    const root1 = getMessageByText('Root 1');
    const b1 = getMessageByText('B1');
    const d1 = getMessageByText('D1');
    expect(new Date(b1.createdAt).getTime()).toBeGreaterThan(new Date(root1.createdAt).getTime());
    expect(new Date(d1.createdAt).getTime()).toBeGreaterThan(new Date(b1.createdAt).getTime());

    // Branch 2 checks
    const root2 = getMessageByText('Root 2');
    const x2 = getMessageByText('X2');
    const z2Child = getMessageByText('Z2 Child');
    const z2 = getMessageByText('Z2');
    expect(new Date(x2.createdAt).getTime()).toBeGreaterThan(new Date(root2.createdAt).getTime());
    expect(new Date(z2Child.createdAt).getTime()).toBeGreaterThan(new Date(z2.createdAt).getTime());

    // Branch 3 checks
    const f3 = getMessageByText('F3');
    const g3 = getMessageByText('G3');
    expect(new Date(g3.createdAt).getTime()).toBeGreaterThan(new Date(f3.createdAt).getTime());

    // Verify all messages are present
    expect(clonedMessages.length).toBe(complexMessages.length);
  });
});
