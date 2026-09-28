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
} = require('~/models');
const { ImportBatchBuilder } = require('./importBatchBuilder');

jest.mock('~/models', () => ({
  bulkIncrementTagCounts: jest.fn(),
  bulkSaveConvos: jest.fn(),
  bulkSaveMessages: jest.fn(),
  deleteImportedConversations: jest.fn(),
  deleteImportedMessages: jest.fn(),
  getFiles: jest.fn(),
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
    const writeError = new Error('message write failed');
    bulkSaveMessages.mockRejectedValueOnce(writeError);

    await expect(builder.saveBatch()).rejects.toBe(writeError);

    const scope = {
      user: 'user-123',
      conversationIds: [builder.conversations[0].conversationId],
    };
    expect(deleteImportedMessages).toHaveBeenCalledWith(scope);
    expect(deleteImportedConversations).toHaveBeenCalledWith(scope);
    expect(bulkSaveConvos.mock.invocationCallOrder[0]).toBeLessThan(
      bulkSaveMessages.mock.invocationCallOrder[0],
    );
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
