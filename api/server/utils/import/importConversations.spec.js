const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const { EModelEndpoint } = require('librechat-data-provider');
const { bulkIncrementTagCounts, bulkSaveConvos, bulkSaveMessages } = require('~/models');
const { getImporter } = require('./importers');
const importConversations = require('./importConversations');

jest.mock('~/models', () => ({
  initializeMessageBudget: jest.fn(),
  bulkIncrementTagCounts: jest.fn(),
  bulkSaveConvos: jest.fn(),
  bulkSaveMessages: jest.fn(),
}));

jest.mock('./importers', () => ({
  getImporter: jest.fn(),
}));

const filters = {
  messages: {
    pii: {
      fields: ['text'],
      starterPatterns: [],
      customPatterns: [
        {
          id: 'import-secret',
          label: 'restricted import value',
          regex: 'IMPORT-SECRET',
        },
      ],
    },
  },
};

describe('importConversations content filtering', () => {
  let tempDir;
  let filepath;

  beforeEach(async () => {
    jest.clearAllMocks();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'librechat-import-filter-'));
    filepath = path.join(tempDir, 'conversation.json');
    await fs.writeFile(filepath, JSON.stringify({ normalized: true }), 'utf8');
    bulkIncrementTagCounts.mockResolvedValue();
    bulkSaveConvos.mockResolvedValue();
    bulkSaveMessages.mockResolvedValue();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('threads filters into the normalized builder and removes a blocked upload', async () => {
    getImporter.mockReturnValue(async (_jsonData, requestUserId, builderFactory) => {
      const builder = builderFactory(requestUserId);
      builder.startConversation(EModelEndpoint.openAI);
      builder.addUserMessage('IMPORT-SECRET');
      builder.finishConversation('safe title');
      await builder.saveBatch();
    });

    await expect(
      importConversations({
        filepath,
        requestUserId: 'user-123',
        interfaceConfig: { retentionMode: 'all' },
        filters,
      }),
    ).rejects.toMatchObject({
      code: 'content_filter_block',
      statusCode: 400,
      body: {
        error: 'content_filter_block',
        source: 'message',
        field: 'text',
      },
    });

    await expect(fs.stat(filepath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(bulkSaveConvos).not.toHaveBeenCalled();
    expect(bulkSaveMessages).not.toHaveBeenCalled();
    expect(bulkIncrementTagCounts).not.toHaveBeenCalled();
  });

  it('threads strict attribution with a legacy-only detector into imported rows', async () => {
    getImporter.mockReturnValue(async (_jsonData, requestUserId, builderFactory) => {
      const builder = builderFactory(requestUserId);
      builder.startConversation(EModelEndpoint.openAI);
      builder.saveMessage({
        sender: 'Assistant',
        isCreatedByUser: false,
        text: 'Legacy unattributed IMPORT-SECRET',
      });
      builder.finishConversation('safe title');
      await builder.saveBatch();
    });

    await expect(
      importConversations({
        filepath,
        requestUserId: 'user-123',
        filters: { messages: { unattributedAssistantContent: 'inspect' } },
        legacyPii: {
          starterPatterns: [],
          customPatterns: [
            {
              id: 'import-secret',
              label: 'restricted import value',
              regex: 'IMPORT-SECRET',
            },
          ],
        },
      }),
    ).rejects.toMatchObject({
      code: 'content_filter_block',
      body: expect.objectContaining({ source: 'message', field: 'text' }),
    });

    await expect(fs.stat(filepath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(bulkSaveMessages).not.toHaveBeenCalled();
  });
});
