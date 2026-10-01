import {
  MAX_CONVERSATION_IMPORT_BSON_BYTES,
  MAX_CONVERSATION_IMPORT_DOCUMENT_BYTES,
  ConversationImportError,
  assertConversationImportWriteSize,
  executeConversationImportWrites,
  isConversationImportError,
} from './import';

describe('conversation import writes', () => {
  it('rejects a document too close to the MongoDB BSON limit before writes begin', () => {
    let thrown: Error | undefined;
    try {
      assertConversationImportWriteSize({
        conversations: [
          {
            user: 'authenticated-user',
            conversationId: 'generated-conversation',
            title: 'x'.repeat(MAX_CONVERSATION_IMPORT_BSON_BYTES),
          },
        ],
        messages: [],
        tenantId: 'tenant-a',
      });
    } catch (error) {
      if (error instanceof Error) {
        thrown = error;
      }
    }
    expect(thrown).toBeInstanceOf(ConversationImportError);
    expect(thrown).toMatchObject({
      code: 'invalid_request',
      statusCode: 413,
      message: `Each imported conversation or message must be at most ${MAX_CONVERSATION_IMPORT_DOCUMENT_BYTES} bytes`,
      body: {
        error: 'invalid_request',
        message: `Each imported conversation or message must be at most ${MAX_CONVERSATION_IMPORT_DOCUMENT_BYTES} bytes`,
      },
    });
    expect(isConversationImportError(thrown)).toBe(true);

    expect(() =>
      assertConversationImportWriteSize({
        conversations: [{ conversationId: 'generated-conversation', title: 'Imported' }],
        messages: [{ conversationId: 'generated-conversation', text: 'Hello' }],
      }),
    ).not.toThrow();
  });

  it('compensates a partial conversation write before rethrowing its error', async () => {
    const order: string[] = [];
    const writeError = new Error('conversation write failed');

    await expect(
      executeConversationImportWrites({
        saveConversations: jest.fn(async () => {
          order.push('save conversations');
          throw writeError;
        }),
        saveMessages: jest.fn(async () => {
          order.push('save messages');
        }),
        updateTagCounts: jest.fn(async () => {
          order.push('update tags');
        }),
        deleteMessages: jest.fn(async () => {
          order.push('delete messages');
        }),
        deleteConversations: jest.fn(async () => {
          order.push('delete conversations');
        }),
      }),
    ).rejects.toBe(writeError);

    expect(order).toEqual(['save conversations', 'delete messages', 'delete conversations']);
  });

  it('compensates partial messages before removing their conversation', async () => {
    const order: string[] = [];
    const writeError = new Error('message write failed');

    await expect(
      executeConversationImportWrites({
        saveConversations: jest.fn(async () => {
          order.push('save conversations');
        }),
        saveMessages: jest.fn(async () => {
          order.push('save messages');
          throw writeError;
        }),
        updateTagCounts: jest.fn(async () => {
          order.push('update tags');
        }),
        deleteMessages: jest.fn(async () => {
          order.push('delete messages');
        }),
        deleteConversations: jest.fn(async () => {
          order.push('delete conversations');
        }),
      }),
    ).rejects.toBe(writeError);

    expect(order).toEqual([
      'save conversations',
      'save messages',
      'delete messages',
      'delete conversations',
    ]);
  });

  it('keeps the conversation discoverable when message cleanup fails', async () => {
    const writeError = new Error('message write failed');
    const cleanupError = new Error('message cleanup failed');
    const deleteConversations = jest.fn().mockResolvedValue(undefined);
    const onCleanupError = jest.fn();

    await expect(
      executeConversationImportWrites({
        saveConversations: jest.fn().mockResolvedValue(undefined),
        saveMessages: jest.fn().mockRejectedValue(writeError),
        updateTagCounts: jest.fn().mockResolvedValue(undefined),
        deleteMessages: jest.fn().mockRejectedValue(cleanupError),
        deleteConversations,
        onCleanupError,
      }),
    ).rejects.toBe(writeError);

    expect(deleteConversations).not.toHaveBeenCalled();
    expect(onCleanupError).toHaveBeenCalledWith(cleanupError, 'messages');
  });

  it('reports failed conversation cleanup without replacing the write error', async () => {
    const writeError = new Error('message write failed');
    const cleanupError = new Error('conversation cleanup failed');
    const onCleanupError = jest.fn();

    await expect(
      executeConversationImportWrites({
        saveConversations: jest.fn().mockResolvedValue(undefined),
        saveMessages: jest.fn().mockRejectedValue(writeError),
        updateTagCounts: jest.fn().mockResolvedValue(undefined),
        deleteMessages: jest.fn().mockResolvedValue(undefined),
        deleteConversations: jest.fn().mockRejectedValue(cleanupError),
        onCleanupError,
      }),
    ).rejects.toBe(writeError);

    expect(onCleanupError).toHaveBeenCalledWith(cleanupError, 'conversations');
  });

  it('keeps the completed import when derived tag count refresh fails', async () => {
    const tagError = new Error('tag count failed');
    const onTagCountError = jest.fn();
    const deleteMessages = jest.fn().mockResolvedValue(undefined);
    const deleteConversations = jest.fn().mockResolvedValue(undefined);

    await expect(
      executeConversationImportWrites({
        saveConversations: jest.fn().mockResolvedValue(undefined),
        saveMessages: jest.fn().mockResolvedValue(undefined),
        updateTagCounts: jest.fn().mockRejectedValue(tagError),
        deleteMessages,
        deleteConversations,
        onTagCountError,
      }),
    ).resolves.toBeUndefined();

    expect(deleteMessages).not.toHaveBeenCalled();
    expect(deleteConversations).not.toHaveBeenCalled();
    expect(onTagCountError).toHaveBeenCalledWith(tagError);
  });
});
