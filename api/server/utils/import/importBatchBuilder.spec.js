const actualApi = jest.requireActual('@librechat/api');
const mockAssertModelBoundContent = jest.fn((...args) =>
  actualApi.assertModelBoundContent(...args),
);

jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  assertModelBoundContent: (...args) => mockAssertModelBoundContent(...args),
}));

const {
  ContentFilterError,
  MAX_CONVERSATION_IMPORT_DOCUMENT_BYTES,
  contentFilterBlockResponse,
  extractConversationImportContent,
  inspectContent,
} = require('@librechat/api');
const { EModelEndpoint } = require('librechat-data-provider');
const {
  bulkIncrementTagCounts,
  bulkSaveConvos,
  bulkSaveMessages,
  deleteImportedConversations,
  deleteImportedMessages,
  getFiles,
  getConvosQueried,
} = require('~/models');
const { ImportBatchBuilder } = require('./importBatchBuilder');

jest.mock('~/models', () => ({
  initializeMessageBudget: jest.fn(),
  bulkIncrementTagCounts: jest.fn(),
  bulkSaveConvos: jest.fn(),
  bulkSaveMessages: jest.fn(),
  deleteImportedConversations: jest.fn(),
  deleteImportedMessages: jest.fn(),
  getFiles: jest.fn(),
  getConvosQueried: jest.fn(),
}));

const pattern = {
  id: 'import-secret',
  label: 'restricted import value',
  regex: 'IMPORT-SECRET',
};

function filtersFor(source, fields) {
  return {
    [source]: {
      pii: {
        fields,
        starterPatterns: [],
        customPatterns: [pattern],
      },
    },
  };
}

function deepValue(depth = 30) {
  let value = 'safe';
  for (let index = 0; index < depth; index++) {
    value = { nested: value };
  }
  return value;
}

function createBuilder(filters, { conversation = {}, message = {} } = {}) {
  const builder = new ImportBatchBuilder('user-123', undefined, filters);
  builder.startConversation(EModelEndpoint.openAI);
  builder.saveMessage({
    sender: 'user',
    isCreatedByUser: true,
    text: 'safe message',
    ...message,
  });
  builder.finishConversation('safe title', new Date('2026-01-01T00:00:00.000Z'), conversation);
  return builder;
}

describe('ImportBatchBuilder content filtering', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    bulkIncrementTagCounts.mockResolvedValue();
    bulkSaveConvos.mockResolvedValue();
    bulkSaveMessages.mockResolvedValue();
    deleteImportedConversations.mockResolvedValue();
    deleteImportedMessages.mockResolvedValue();
    getFiles.mockResolvedValue([]);
  });

  it('marks imported user and assistant prose as user-submitted', () => {
    const builder = new ImportBatchBuilder('user-123');
    builder.startConversation(EModelEndpoint.openAI);

    const userMessage = builder.addUserMessage('Imported user text');
    const assistantMessage = builder.addGptMessage('Imported assistant text', 'gpt-test');

    expect(userMessage).toMatchObject({ isCreatedByUser: true, isUserSubmitted: true });
    expect(assistantMessage).toMatchObject({ isCreatedByUser: false, isUserSubmitted: true });
  });

  it('does not reclassify copied model assistant prose as user-submitted', async () => {
    const builder = new ImportBatchBuilder('user-123', undefined, filtersFor('messages', ['text']));
    builder.startConversation(EModelEndpoint.openAI);
    builder.saveMessage({
      sender: 'Assistant',
      isCreatedByUser: false,
      text: 'Model output contains IMPORT-SECRET',
    });
    builder.finishConversation('safe title', new Date('2026-01-01T00:00:00.000Z'));

    await expect(builder.saveBatch()).resolves.toBeUndefined();
    expect(bulkSaveMessages).toHaveBeenCalledTimes(1);
  });

  it('applies strict legacy attribution with a legacy-only message detector', async () => {
    const builder = new ImportBatchBuilder(
      'user-123',
      undefined,
      { messages: { unattributedAssistantContent: 'inspect' } },
      {
        starterPatterns: [],
        customPatterns: [pattern],
      },
    );
    builder.startConversation(EModelEndpoint.openAI);
    builder.saveMessage({
      sender: 'Assistant',
      isCreatedByUser: false,
      text: 'Legacy unattributed IMPORT-SECRET',
    });
    builder.finishConversation('safe title', new Date('2026-01-01T00:00:00.000Z'));

    await expect(builder.saveBatch()).rejects.toMatchObject({
      body: {
        error: 'content_filter_block',
        source: 'message',
        field: 'text',
      },
    });
    expect(bulkSaveMessages).not.toHaveBeenCalled();
  });

  it('keeps strict attribution in the traversal fallback for ineffective provenance paths', async () => {
    const builder = new ImportBatchBuilder('user-123', undefined, {
      ...filtersFor('messages', ['text']),
      messages: {
        ...filtersFor('messages', ['text']).messages,
        unattributedAssistantContent: 'inspect',
      },
    });
    builder.startConversation(EModelEndpoint.openAI);
    builder.saveMessage({
      sender: 'Assistant',
      role: 'assistant',
      isCreatedByUser: false,
      text: 'Legacy unattributed IMPORT-SECRET',
      userSubmittedPaths: ['/messageId'],
    });
    builder.finishConversation('safe title', new Date('2026-01-01T00:00:00.000Z'));
    mockAssertModelBoundContent.mockImplementationOnce(() => {
      throw new actualApi.ContentTraversalLimitError([
        {
          id: 'stored-message.text',
          path: '/text',
          text: 'Legacy unattributed IMPORT-SECRET',
          source: 'message',
          field: 'text',
          format: 'plain',
          treatment: 'inspect_only',
          provenance: 'user',
        },
      ]);
    });

    await expect(builder.saveBatch()).rejects.toMatchObject({
      body: {
        error: 'content_filter_block',
        source: 'message',
        field: 'text',
      },
    });
    expect(bulkSaveMessages).not.toHaveBeenCalled();
  });

  it('does not swallow exact HITL traversal failures in the import fallback', async () => {
    const builder = createBuilder(filtersFor('messages', ['answer']), {
      message: {
        isCreatedByUser: false,
        role: 'assistant',
        content: [{ type: 'tool_call', tool_call: { output: 'safe answer' } }],
        userSubmittedMessageFieldPaths: [{ path: '/content/0/tool_call/output', field: 'answer' }],
      },
    });
    mockAssertModelBoundContent.mockImplementationOnce(() => {
      throw new actualApi.ContentTraversalLimitError(
        [],
        [{ source: 'message', fields: ['answer'] }],
      );
    });

    await expect(builder.saveBatch()).rejects.toMatchObject({
      body: {
        error: 'content_filter_uninspectable',
        source: 'message',
        field: 'answer',
      },
    });
    expect(bulkSaveMessages).not.toHaveBeenCalled();
  });

  it('keeps legacy-only filtering active for explicitly submitted imported rows', async () => {
    const builder = new ImportBatchBuilder('user-123', undefined, undefined, {
      starterPatterns: [],
      customPatterns: [pattern],
    });
    builder.startConversation(EModelEndpoint.openAI);
    builder.addUserMessage('Imported IMPORT-SECRET');
    builder.finishConversation('safe title', new Date('2026-01-01T00:00:00.000Z'));

    await expect(builder.saveBatch()).rejects.toMatchObject({
      body: expect.objectContaining({ source: 'message', field: 'text' }),
    });
    expect(bulkSaveMessages).not.toHaveBeenCalled();
  });

  it('blocks provenance-marked assistant content while ignoring adjacent model prose', async () => {
    const builder = new ImportBatchBuilder(
      'user-123',
      undefined,
      filtersFor('messages', ['content_part']),
    );
    builder.startConversation(EModelEndpoint.openAI);
    builder.saveMessage({
      sender: 'Assistant',
      isCreatedByUser: false,
      content: [
        { type: 'text', text: 'Adjacent model output contains IMPORT-SECRET' },
        { type: 'text', text: 'Human-authored IMPORT-SECRET' },
      ],
      userSubmittedPaths: ['/content/1/text'],
    });
    builder.finishConversation('safe title', new Date('2026-01-01T00:00:00.000Z'));

    await expect(builder.saveBatch()).rejects.toMatchObject({
      body: {
        error: 'content_filter_block',
        source: 'message',
        field: 'content_part',
      },
    });
    expect(bulkSaveMessages).not.toHaveBeenCalled();
  });

  it('preserves default-off imports without inspecting normalized content', async () => {
    const builder = createBuilder(undefined, {
      conversation: {
        promptPrefix: 'IMPORT-SECRET',
        instructions: 'IMPORT-SECRET',
      },
      message: {
        sender: 'IMPORT-SECRET',
        text: 'IMPORT-SECRET',
        content: [{ text: 'IMPORT-SECRET' }],
      },
    });

    await expect(builder.saveBatch()).resolves.toBeUndefined();

    expect(bulkSaveConvos).toHaveBeenCalledTimes(1);
    expect(bulkSaveMessages).toHaveBeenCalledTimes(1);
    expect(bulkIncrementTagCounts).toHaveBeenCalledTimes(1);
  });

  it('rejects an oversized conversation before starting any bulk write', async () => {
    const builder = createBuilder(undefined);
    builder.conversations[0].title = 'x'.repeat(16 * 1024 * 1024);

    await expect(builder.saveBatch()).rejects.toThrow(
      `at most ${MAX_CONVERSATION_IMPORT_DOCUMENT_BYTES} bytes`,
    );

    expect(bulkSaveConvos).not.toHaveBeenCalled();
    expect(bulkSaveMessages).not.toHaveBeenCalled();
    expect(bulkIncrementTagCounts).not.toHaveBeenCalled();
  });

  it('cleans only the generated owner scope when a message write fails', async () => {
    const builder = createBuilder(undefined);
    const conversationId = builder.conversations[0].conversationId;
    const writeError = new Error('message write failed');
    bulkSaveMessages.mockRejectedValueOnce(writeError);

    await expect(builder.saveBatch()).rejects.toBe(writeError);

    expect(deleteImportedMessages).toHaveBeenCalledWith({
      user: 'user-123',
      conversationIds: [conversationId],
    });
    expect(bulkSaveConvos).not.toHaveBeenCalled();
    expect(deleteImportedConversations).not.toHaveBeenCalled();
    expect(bulkIncrementTagCounts).not.toHaveBeenCalled();
  });

  it('blocks opaque imported content before starting any bulk write', async () => {
    const opaqueValue = 'data:image/png;base64,IMPORT-OPAQUE-DO-NOT-ECHO';
    const builder = createBuilder(
      {
        files: {
          pii: {
            fields: ['content'],
            uninspectable: 'block',
          },
        },
      },
      {
        message: {
          content: [{ type: 'image_url', image_url: { url: opaqueValue } }],
        },
      },
    );

    let thrown;
    try {
      await builder.saveBatch();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      code: 'content_filter_uninspectable',
      statusCode: 400,
      body: {
        error: 'content_filter_uninspectable',
        source: 'file',
        field: 'content',
      },
    });

    expect(bulkSaveConvos).not.toHaveBeenCalled();
    expect(bulkSaveMessages).not.toHaveBeenCalled();
    expect(bulkIncrementTagCounts).not.toHaveBeenCalled();
    expect(JSON.stringify(thrown.body)).not.toContain(opaqueValue);
  });

  it('resolves and inspects a canonical owner file reference before bulk writes', async () => {
    const builder = createBuilder(
      {
        files: {
          pii: {
            fields: ['extracted_text'],
            uninspectable: 'block',
          },
        },
      },
      {
        message: {
          files: [{ file_id: 'owner-file-1' }],
        },
      },
    );
    getFiles.mockResolvedValue([
      {
        file_id: 'owner-file-1',
        user: 'user-123',
        text: 'safe extracted text',
      },
    ]);

    await expect(builder.saveBatch()).resolves.toBeUndefined();

    expect(getFiles).toHaveBeenCalledWith(
      {
        file_id: { $in: ['owner-file-1'] },
        user: 'user-123',
      },
      {},
      {},
    );
    expect(bulkSaveConvos).toHaveBeenCalledTimes(1);
    expect(bulkSaveMessages).toHaveBeenCalledTimes(1);
    expect(bulkIncrementTagCounts).toHaveBeenCalledTimes(1);
  });

  it('inspects resolved canonical owner file text before bulk writes', async () => {
    const filters = filtersFor('files', ['extracted_text']);
    filters.files.pii.uninspectable = 'block';
    const builder = createBuilder(filters, {
      message: {
        files: [{ file_id: 'owner-file-1' }],
      },
    });
    getFiles.mockResolvedValue([
      {
        file_id: 'owner-file-1',
        user: 'user-123',
        text: 'resolved IMPORT-SECRET',
      },
    ]);

    await expect(builder.saveBatch()).rejects.toMatchObject({
      code: 'content_filter_block',
      body: {
        source: 'file',
        field: 'extracted_text',
      },
    });
    expect(bulkSaveConvos).not.toHaveBeenCalled();
    expect(bulkSaveMessages).not.toHaveBeenCalled();
    expect(bulkIncrementTagCounts).not.toHaveBeenCalled();
  });

  it('inspects hydrated files once instead of replaying them for every message', async () => {
    const filters = filtersFor('files', ['extracted_text']);
    filters.files.pii.uninspectable = 'block';
    const canonicalFile = {
      file_id: 'owner-file-1',
      user: 'user-123',
      text: 'safe extracted text',
    };
    const builder = createBuilder(filters, {
      message: {
        files: [{ file_id: canonicalFile.file_id }],
      },
    });
    builder.saveMessage({
      sender: 'user',
      isCreatedByUser: true,
      text: 'another safe message',
      files: [{ file_id: canonicalFile.file_id }],
    });
    getFiles.mockResolvedValue([canonicalFile]);

    await expect(builder.saveBatch()).resolves.toBeUndefined();

    const fileCalls = mockAssertModelBoundContent.mock.calls.filter(
      ([input]) => input.resolvedFiles != null,
    );
    const messageCalls = mockAssertModelBoundContent.mock.calls.filter(
      ([input]) => input.storedMessages != null,
    );
    expect(fileCalls).toEqual([
      [
        {
          filters,
          resolvedFiles: [canonicalFile],
          onTraversalFailure: actualApi.reportLocatorTraversalFailure,
        },
      ],
    ]);
    expect(messageCalls).toHaveLength(2);
    expect(
      messageCalls.every(
        ([input]) => input.onTraversalFailure === actualApi.reportLocatorTraversalFailure,
      ),
    ).toBe(true);
    expect(messageCalls.every(([input]) => input.storedMessages.length === 1)).toBe(true);
    expect(messageCalls.every(([input]) => input.resolvedFiles == null)).toBe(true);
  });

  it('fails closed for a missing canonical file reference before bulk writes', async () => {
    const builder = createBuilder(
      {
        files: {
          pii: {
            fields: ['extracted_text'],
            uninspectable: 'block',
          },
        },
      },
      {
        message: {
          files: [{ file_id: 'missing-file' }],
        },
      },
    );

    await expect(builder.saveBatch()).rejects.toMatchObject({
      code: 'content_filter_uninspectable',
      body: {
        source: 'file',
        field: 'extracted_text',
      },
    });
    expect(bulkSaveConvos).not.toHaveBeenCalled();
    expect(bulkSaveMessages).not.toHaveBeenCalled();
    expect(bulkIncrementTagCounts).not.toHaveBeenCalled();
  });

  it('fails closed for a foreign canonical file reference before bulk writes', async () => {
    const storedFiles = [
      {
        file_id: 'foreign-file',
        user: 'another-user',
        text: 'safe extracted text',
      },
    ];
    getFiles.mockImplementation(async (filter) =>
      storedFiles.filter(
        (file) =>
          filter.file_id.$in.includes(file.file_id) &&
          file.user === filter.user &&
          (filter.tenantId == null || file.tenantId === filter.tenantId),
      ),
    );
    const builder = createBuilder(
      {
        files: {
          pii: {
            fields: ['extracted_text'],
            uninspectable: 'block',
          },
        },
      },
      {
        message: {
          files: [{ file_id: 'foreign-file' }],
        },
      },
    );

    await expect(builder.saveBatch()).rejects.toMatchObject({
      code: 'content_filter_uninspectable',
      body: {
        source: 'file',
        field: 'extracted_text',
      },
    });
    expect(getFiles).toHaveBeenCalledWith(
      {
        file_id: { $in: ['foreign-file'] },
        user: 'user-123',
      },
      {},
      {},
    );
    expect(bulkSaveConvos).not.toHaveBeenCalled();
    expect(bulkSaveMessages).not.toHaveBeenCalled();
    expect(bulkIncrementTagCounts).not.toHaveBeenCalled();
  });

  it('honors opaque import allow/default behavior and file-field granularity', async () => {
    const builder = createBuilder(
      {
        files: {
          pii: {
            fields: ['extracted_text'],
            uninspectable: 'block',
          },
        },
      },
      {
        message: {
          content: [
            {
              type: 'image_url',
              image_url: { url: 'https://example.test/imported-image.png' },
            },
          ],
        },
      },
    );

    await expect(builder.saveBatch()).resolves.toBeUndefined();
    expect(bulkSaveMessages).toHaveBeenCalledTimes(1);
  });

  it('blocks imported file data for the selected derived-text field', async () => {
    const builder = createBuilder(
      {
        files: {
          pii: {
            fields: ['extracted_text'],
            uninspectable: 'block',
          },
        },
      },
      {
        message: {
          content: [{ type: 'input_file', file_data: 'opaque-imported-file' }],
        },
      },
    );

    await expect(builder.saveBatch()).rejects.toMatchObject({
      body: {
        error: 'content_filter_uninspectable',
        source: 'file',
        field: 'extracted_text',
      },
    });
    expect(bulkSaveMessages).not.toHaveBeenCalled();
  });

  it('fails closed before bulk writes when nested import inspection exhausts its budget', async () => {
    const builder = createBuilder(filtersFor('messages', ['content_part']), {
      message: {
        content: [
          {
            type: 'vendor_content',
            payload: Array.from({ length: 5000 }, (_, index) => `submitted-${index}`),
          },
        ],
      },
    });

    await expect(builder.saveBatch()).rejects.toMatchObject({
      code: 'content_filter_uninspectable',
      statusCode: 400,
      body: {
        error: 'content_filter_uninspectable',
        source: 'message',
        field: 'content_part',
      },
    });
    expect(bulkSaveConvos).not.toHaveBeenCalled();
    expect(bulkSaveMessages).not.toHaveBeenCalled();
    expect(bulkIncrementTagCounts).not.toHaveBeenCalled();
  });

  it('allows exhausted nested import content when only message text is selected', async () => {
    const builder = createBuilder(filtersFor('messages', ['text']), {
      message: {
        text: 'safe message',
        content: [
          {
            type: 'vendor_content',
            payload: Array.from({ length: 5000 }, (_, index) => `submitted-${index}`),
          },
        ],
      },
    });

    await expect(builder.saveBatch()).resolves.toBeUndefined();
    expect(bulkSaveMessages).toHaveBeenCalledTimes(1);
  });

  it('continues inspecting later imported messages after unselected traversal exhaustion', async () => {
    const builder = createBuilder(filtersFor('messages', ['text']), {
      message: {
        text: 'safe message',
        content: [
          {
            type: 'vendor_content',
            payload: Array.from({ length: 5000 }, (_, index) => `submitted-${index}`),
          },
        ],
      },
    });
    builder.saveMessage({
      sender: 'user',
      isCreatedByUser: true,
      text: 'IMPORT-SECRET',
    });

    await expect(builder.saveBatch()).rejects.toMatchObject({
      body: {
        error: 'content_filter_block',
        source: 'message',
        field: 'text',
      },
    });
    expect(bulkSaveMessages).not.toHaveBeenCalled();
  });

  it('fails closed when selected imported model request fields exhaust traversal', async () => {
    const builder = createBuilder(filtersFor('modelParameters', ['request_fields']), {
      conversation: {
        options: { provider_option: deepValue() },
      },
    });

    await expect(builder.saveBatch()).rejects.toMatchObject({
      code: 'content_filter_uninspectable',
      statusCode: 400,
    });
    expect(bulkSaveConvos).not.toHaveBeenCalled();
    expect(bulkSaveMessages).not.toHaveBeenCalled();
  });

  it('allows exhausted imported request fields when only model stop is selected', async () => {
    const builder = createBuilder(filtersFor('modelParameters', ['stop']), {
      conversation: {
        options: { provider_option: deepValue() },
      },
    });

    await expect(builder.saveBatch()).resolves.toBeUndefined();
    expect(bulkSaveConvos).toHaveBeenCalledTimes(1);
    expect(bulkSaveMessages).toHaveBeenCalledTimes(1);
  });

  it('still blocks later imported prompts after unrelated model traversal exhaustion', async () => {
    const builder = createBuilder(filtersFor('prompts', ['instructions']), {
      conversation: {
        options: { provider_option: deepValue() },
        presetOverride: { instructions: 'later IMPORT-SECRET prompt' },
      },
    });

    await expect(builder.saveBatch()).rejects.toMatchObject({
      body: {
        error: 'content_filter_block',
        source: 'prompt',
        field: 'instructions',
      },
    });
    expect(bulkSaveConvos).not.toHaveBeenCalled();
    expect(bulkSaveMessages).not.toHaveBeenCalled();
  });

  it('keeps traversal isolation after the one-time hydrated file inspection', async () => {
    const filters = {
      ...filtersFor('messages', ['text']),
      files: {
        pii: {
          fields: ['extracted_text'],
          uninspectable: 'block',
        },
      },
    };
    const canonicalFile = {
      file_id: 'owner-file-1',
      user: 'user-123',
      text: 'safe extracted text',
    };
    const builder = createBuilder(filters, {
      message: {
        text: 'safe message',
        files: [{ file_id: canonicalFile.file_id }],
      },
    });
    builder.saveMessage({
      sender: 'user',
      isCreatedByUser: true,
      text: 'IMPORT-SECRET',
      files: [{ file_id: canonicalFile.file_id }],
    });
    getFiles.mockResolvedValue([canonicalFile]);
    mockAssertModelBoundContent
      .mockImplementationOnce((...args) => actualApi.assertModelBoundContent(...args))
      .mockImplementationOnce(() => {
        throw new actualApi.ContentTraversalLimitError();
      });

    await expect(builder.saveBatch()).rejects.toMatchObject({
      body: {
        error: 'content_filter_block',
        source: 'message',
        field: 'text',
      },
    });

    const fileCalls = mockAssertModelBoundContent.mock.calls.filter(
      ([input]) => input.resolvedFiles != null,
    );
    const messageCalls = mockAssertModelBoundContent.mock.calls.filter(
      ([input]) => input.storedMessages != null,
    );
    expect(fileCalls).toEqual([
      [
        {
          filters,
          resolvedFiles: [canonicalFile],
          onTraversalFailure: actualApi.reportLocatorTraversalFailure,
        },
      ],
    ]);
    expect(messageCalls).toHaveLength(2);
    expect(
      messageCalls.every(
        ([input]) => input.onTraversalFailure === actualApi.reportLocatorTraversalFailure,
      ),
    ).toBe(true);
    expect(messageCalls.every(([input]) => input.storedMessages.length === 1)).toBe(true);
    expect(messageCalls.every(([input]) => input.resolvedFiles == null)).toBe(true);
    expect(bulkSaveMessages).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'message text',
      filters: filtersFor('messages', ['text']),
      input: { message: { text: 'IMPORT-SECRET' } },
      source: 'message',
      field: 'text',
    },
    {
      name: 'message sender',
      filters: filtersFor('messages', ['name']),
      input: { message: { sender: 'IMPORT-SECRET' } },
      source: 'message',
      field: 'name',
    },
    {
      name: 'structured message content',
      filters: filtersFor('messages', ['content_part']),
      input: { message: { content: [{ text: 'IMPORT-SECRET' }] } },
      source: 'message',
      field: 'content_part',
    },
    {
      name: 'message summary',
      filters: filtersFor('messages', ['summary']),
      input: { message: { summary: 'IMPORT-SECRET' } },
      source: 'message',
      field: 'summary',
    },
    {
      name: 'structured message summary',
      filters: filtersFor('messages', ['summary']),
      input: {
        message: { content: [{ type: 'summary', text: 'IMPORT-SECRET' }] },
      },
      source: 'message',
      field: 'summary',
    },
    {
      name: 'nested message feedback',
      filters: filtersFor('feedback', ['text']),
      input: { message: { feedback: { text: 'IMPORT-SECRET' } } },
      source: 'feedback',
      field: 'text',
    },
    {
      name: 'message attachment',
      filters: filtersFor('messages', ['attachment_reference']),
      input: { message: { attachments: [{ filename: 'IMPORT-SECRET.txt' }] } },
      source: 'message',
      field: 'attachment_reference',
    },
    {
      name: 'tool arguments',
      filters: filtersFor('toolArguments', ['arguments']),
      input: {
        message: {
          content: [{ tool_call: { arguments: { token: 'IMPORT-SECRET' } } }],
        },
      },
      source: 'tool_argument',
      field: 'arguments',
    },
    {
      name: 'conversation title',
      filters: filtersFor('conversationTitles', ['title']),
      title: 'IMPORT-SECRET',
      source: 'conversation_title',
      field: 'title',
    },
    {
      name: 'prompt metadata',
      filters: filtersFor('prompts', ['preset_text']),
      input: { conversation: { promptPrefix: 'IMPORT-SECRET' } },
      source: 'prompt',
      field: 'preset_text',
    },
    {
      name: 'agent instruction metadata',
      filters: filtersFor('agentInstructions', ['instructions']),
      input: { conversation: { instructions: 'IMPORT-SECRET' } },
      source: 'agent_instruction',
      field: 'instructions',
    },
    {
      name: 'model stop sequence',
      filters: filtersFor('modelParameters', ['stop']),
      input: { conversation: { stop: ['IMPORT-SECRET'] } },
      source: 'model_parameter',
      field: 'stop',
    },
    {
      name: 'nested provider request field',
      filters: filtersFor('modelParameters', ['request_fields']),
      input: {
        conversation: {
          additionalModelRequestFields: { thinking: { mode: 'IMPORT-SECRET' } },
        },
      },
      source: 'model_parameter',
      field: 'request_fields',
    },
    {
      name: 'arbitrary persisted provider option',
      filters: filtersFor('modelParameters', ['request_fields']),
      input: {
        conversation: {
          model_parameters: { vendorOption: 'IMPORT-SECRET' },
        },
      },
      source: 'model_parameter',
      field: 'request_fields',
    },
    {
      name: 'nested imported response format',
      filters: filtersFor('modelParameters', ['response_format']),
      input: {
        conversation: {
          options: {
            response_format: { json_schema: { description: 'IMPORT-SECRET' } },
          },
        },
      },
      source: 'model_parameter',
      field: 'response_format',
    },
  ])('blocks normalized $name before starting any bulk write', async (testCase) => {
    const builder = createBuilder(testCase.filters, testCase.input);
    if (testCase.title != null) {
      builder.conversations[0].title = testCase.title;
    }

    await expect(builder.saveBatch()).rejects.toMatchObject({
      code: 'content_filter_block',
      statusCode: 400,
      body: {
        error: 'content_filter_block',
        source: testCase.source,
        field: testCase.field,
      },
    });

    expect(bulkSaveConvos).not.toHaveBeenCalled();
    expect(bulkSaveMessages).not.toHaveBeenCalled();
    expect(bulkIncrementTagCounts).not.toHaveBeenCalled();
  });

  it('does not classify unregistered raw export metadata heuristically', async () => {
    const builder = createBuilder(filtersFor('prompts', ['text']), {
      conversation: { arbitraryRawExportField: 'IMPORT-SECRET' },
    });

    await expect(builder.saveBatch()).resolves.toBeUndefined();
    expect(bulkSaveConvos).toHaveBeenCalledTimes(1);
  });

  it('honors configured field granularity for normalized imported messages', async () => {
    const builder = createBuilder(filtersFor('messages', ['text']), {
      message: {
        sender: 'IMPORT-SECRET',
        text: 'safe message',
        content: [{ text: 'IMPORT-SECRET' }],
      },
    });

    await expect(builder.saveBatch()).resolves.toBeUndefined();
    expect(bulkSaveMessages).toHaveBeenCalledTimes(1);
  });

  it('throws the shared metadata-safe content filter error', () => {
    const finding = inspectContent(
      extractConversationImportContent({
        conversations: [{ title: 'IMPORT-SECRET' }],
        messages: [],
      }),
      { filters: filtersFor('conversationTitles', ['title']) },
    );

    expect(finding).not.toBeNull();
    const error = new ContentFilterError(finding);
    expect(error.body).toEqual(contentFilterBlockResponse(finding));
    expect(error.body).not.toHaveProperty('detectorId');
    expect(error.body).not.toHaveProperty('ruleId');
    expect(error.body).not.toHaveProperty('fragmentPath');
  });
});

describe('ImportBatchBuilder flushing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    bulkSaveMessages.mockResolvedValue(undefined);
    bulkSaveConvos.mockResolvedValue(undefined);
    bulkIncrementTagCounts.mockResolvedValue(undefined);
    getConvosQueried.mockResolvedValue({ conversations: [], nextCursor: null, convoMap: {} });
    deleteImportedConversations.mockResolvedValue(undefined);
    deleteImportedMessages.mockResolvedValue(undefined);
  });

  it('flushes once the threshold is reached and clears the buffer', async () => {
    const builder = new ImportBatchBuilder('u1', undefined, undefined, undefined, {
      flushThreshold: 2,
    });

    for (let i = 0; i < 2; i++) {
      builder.startConversation();
      builder.addUserMessage(`hello ${i}`);
      builder.finishConversation(`Chat ${i}`, new Date());
      await builder.maybeFlush();
    }

    expect(bulkSaveConvos).toHaveBeenCalledTimes(1);
    expect(bulkSaveConvos.mock.calls[0][0]).toHaveLength(2);
    expect(builder.conversations).toHaveLength(0);
    expect(builder.messages).toHaveLength(0);
  });

  it('does not flush before the threshold', async () => {
    const builder = new ImportBatchBuilder('u1', undefined, undefined, undefined, {
      flushThreshold: 5,
    });

    builder.startConversation();
    builder.addUserMessage('hello');
    builder.finishConversation('Chat', new Date());
    await builder.maybeFlush();

    expect(bulkSaveConvos).not.toHaveBeenCalled();
    expect(builder.conversations).toHaveLength(1);
  });

  it('saveBatch writes the remainder', async () => {
    const builder = new ImportBatchBuilder('u1', undefined, undefined, undefined, {
      flushThreshold: 5,
    });

    builder.startConversation();
    builder.addUserMessage('hello');
    builder.finishConversation('Chat', new Date());
    await builder.saveBatch();

    expect(bulkSaveConvos).toHaveBeenCalledTimes(1);
    expect(bulkSaveMessages).toHaveBeenCalledTimes(1);
    expect(builder.conversations).toHaveLength(0);
  });

  it('saveBatch is a no-op when nothing is buffered', async () => {
    const builder = new ImportBatchBuilder('u1', undefined, undefined, undefined, {
      flushThreshold: 5,
    });
    await builder.saveBatch();
    expect(bulkSaveConvos).not.toHaveBeenCalled();
  });

  it('writes messages before conversations, so the conversation acts as a commit marker', async () => {
    const order = [];
    bulkSaveMessages.mockImplementation(async () => {
      order.push('messages');
    });
    bulkSaveConvos.mockImplementation(async () => {
      order.push('conversations');
    });

    const builder = new ImportBatchBuilder('u1', undefined, undefined, undefined, {
      flushThreshold: 5,
    });
    builder.startConversation();
    builder.addUserMessage('hello');
    builder.finishConversation('Chat', new Date());
    await builder.saveBatch();

    expect(order).toEqual(['messages', 'conversations']);
  });

  it('never writes conversations when the message write fails', async () => {
    bulkSaveMessages.mockRejectedValueOnce(new Error('message write failed'));

    const builder = new ImportBatchBuilder('u1', undefined, undefined, undefined, {
      flushThreshold: 5,
    });
    builder.startConversation();
    builder.addUserMessage('hello');
    builder.finishConversation('Chat', new Date());

    await expect(builder.saveBatch()).rejects.toThrow('message write failed');

    expect(bulkSaveConvos).not.toHaveBeenCalled();
  });

  /** Messages go in first, so a message write that fails before any
   * conversation write leaves rows nothing points at. A retry mints fresh
   * message ids, so they are never reused and would otherwise pile up on every
   * re-import. No conversation write was issued, so only messages are removed. */
  it('removes the messages it wrote when the message write fails', async () => {
    const error = new Error('message write failed');
    bulkSaveMessages.mockRejectedValueOnce(error);

    const builder = new ImportBatchBuilder('u1', undefined, undefined, undefined, {
      flushThreshold: 5,
    });
    builder.startConversation();
    builder.addUserMessage('hello');
    const { conversation } = builder.finishConversation('Chat', new Date());

    await expect(builder.saveBatch()).rejects.toBe(error);

    expect(builder.getLastFlushOutcome()).toBe('not_committed');
    expect(bulkSaveConvos).not.toHaveBeenCalled();
    expect(deleteImportedConversations).not.toHaveBeenCalled();
    expect(deleteImportedMessages).toHaveBeenCalledWith({
      user: 'u1',
      conversationIds: [conversation.conversationId],
    });
  });

  /** A bulk write can commit and still reject: a write concern timeout, a
   * dropped response, a partially applied batch. Removing the conversations
   * first means no outcome of the cleanup leaves a committed conversation
   * whose messages are gone. */
  it('removes the conversations, then their messages, when the conversation write rejects', async () => {
    const error = new Error('conversation write outcome unknown');
    bulkSaveConvos.mockRejectedValueOnce(error);

    const builder = new ImportBatchBuilder('u1', undefined, undefined, undefined, {
      flushThreshold: 5,
    });
    builder.startConversation();
    builder.addUserMessage('first');
    const first = builder.finishConversation('First', new Date()).conversation;
    builder.startConversation();
    builder.addUserMessage('second');
    const second = builder.finishConversation('Second', new Date()).conversation;

    await expect(builder.saveBatch()).rejects.toBe(error);

    const scope = { user: 'u1', conversationIds: [first.conversationId, second.conversationId] };
    expect(builder.getLastFlushOutcome()).toBe('not_committed');
    expect(deleteImportedConversations).toHaveBeenCalledWith(scope);
    expect(deleteImportedMessages).toHaveBeenCalledWith(scope);
    expect(deleteImportedConversations.mock.invocationCallOrder[0]).toBeLessThan(
      deleteImportedMessages.mock.invocationCallOrder[0],
    );
  });

  it('keeps every message and reports ambiguity when conversation cleanup fails', async () => {
    const error = new Error('conversation write outcome unknown');
    bulkSaveConvos.mockRejectedValueOnce(error);
    deleteImportedConversations.mockRejectedValueOnce(new Error('cleanup failed'));

    const builder = new ImportBatchBuilder('u1', undefined, undefined, undefined, {
      flushThreshold: 5,
    });
    builder.startConversation();
    builder.addUserMessage('hello');
    builder.finishConversation('Chat', new Date());

    await expect(builder.saveBatch()).rejects.toBe(error);

    expect(builder.getLastFlushOutcome()).toBe('ambiguous');
    expect(deleteImportedMessages).not.toHaveBeenCalled();
  });

  /** Retention-aware readers apply `getVisibleConversationRetentionFilter`,
   * which hides the temporary and expired conversations an import creates, so
   * a committed conversation reads back as absent. No existence probe may gate
   * the cleanup. */
  it('never probes for the conversations it wrote', async () => {
    bulkSaveConvos.mockRejectedValueOnce(new Error('conversation write outcome unknown'));

    const builder = new ImportBatchBuilder('u1', undefined, undefined, undefined, {
      flushThreshold: 5,
    });
    builder.startConversation();
    builder.addUserMessage('hello');
    builder.finishConversation('Temporary', new Date());

    await expect(builder.saveBatch()).rejects.toThrow('conversation write outcome unknown');

    expect(getConvosQueried).not.toHaveBeenCalled();
  });

  /** Tag maintenance only runs once the commit markers exist, so its failure
   * is logged rather than thrown: the conversations it counts are committed. */
  it('keeps the committed batch when tag maintenance fails', async () => {
    bulkIncrementTagCounts.mockRejectedValueOnce(new Error('tag write failed'));

    const builder = new ImportBatchBuilder('u1', undefined, undefined, undefined, {
      flushThreshold: 5,
    });
    builder.startConversation();
    builder.addUserMessage('hello');
    builder.finishConversation('Chat', new Date());

    await expect(builder.saveBatch()).resolves.toBeUndefined();

    expect(builder.getLastFlushOutcome()).toBe('committed');
    expect(bulkSaveConvos).toHaveBeenCalledTimes(1);
    expect(deleteImportedConversations).not.toHaveBeenCalled();
    expect(deleteImportedMessages).not.toHaveBeenCalled();
  });
});

describe('ImportBatchBuilder importedFrom marker', () => {
  const finish = (externalId) => {
    const builder = new ImportBatchBuilder('u1');
    builder.startConversation();
    builder.addUserMessage('hello');
    const { conversation } = builder.finishConversation('Chat', new Date(), {
      importedFrom: { source: 'chatgpt', externalId },
    });
    return conversation;
  };

  it('keeps the marker when the export carries a usable id', () => {
    expect(finish('abc-123').importedFrom).toEqual({ source: 'chatgpt', externalId: 'abc-123' });
  });

  /** `convoSchema` declares `importedFrom.externalId` required, and every
   * import write goes through `bulkSaveConvos`, whose `updateOne` upserts run
   * no validators. A marker built from an id-less export therefore reached the
   * database as an invalid subdocument instead of being rejected. */
  it.each([
    ['missing', undefined],
    ['null', null],
    ['empty', ''],
    ['not a string', 42],
  ])('drops the marker when the id is %s', (_label, externalId) => {
    const conversation = finish(externalId);

    expect(conversation.importedFrom).toBeUndefined();
    expect('importedFrom' in conversation).toBe(false);
  });

  it('leaves a conversation with no marker alone', () => {
    const builder = new ImportBatchBuilder('u1');
    builder.startConversation();
    builder.addUserMessage('hello');
    const { conversation } = builder.finishConversation('Chat', new Date());

    expect('importedFrom' in conversation).toBe(false);
  });
});
