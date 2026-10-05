const { ContentTypes } = require('librechat-data-provider');
const { ImportBatchBuilder } = require('./importBatchBuilder');
const db = require('~/models');

jest.mock('~/models', () => ({
  getAvailableMediaFileIds: jest.fn().mockResolvedValue([]),
  getFiles: jest.fn().mockResolvedValue([]),
  bulkSaveConvos: jest.fn().mockResolvedValue(undefined),
  bulkSaveMessages: jest.fn().mockResolvedValue(undefined),
  bulkIncrementTagCounts: jest.fn().mockResolvedValue(undefined),
  deleteImportedConversations: jest.fn().mockResolvedValue(undefined),
  deleteImportedMessages: jest.fn().mockResolvedValue(undefined),
  initializeMessageBudget: jest.fn(),
}));
jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  getTenantId: () => 'tenant-a',
}));

const filters = {
  files: { pii: { fields: ['content', 'extracted_text'], uninspectable: 'block' } },
};

describe('conversation import media policy ordering', () => {
  it('clears an unavailable generated original before inspection and the first database write', async () => {
    const builder = new ImportBatchBuilder('owner', undefined, filters);
    const file = {
      file_id: 'f17ecafe-0000-4000-8000-000000000001',
      filepath: '/api/media/assets/missing/content',
    };
    builder.startConversation();
    builder.saveMessage({
      text: 'Keep this text',
      sender: 'assistant',
      isCreatedByUser: false,
      isUserSubmitted: true,
      files: [file],
      content: [{ type: ContentTypes.IMAGE_FILE, image_file: file }],
    });
    builder.finishConversation('Imported');

    await builder.saveBatch();

    expect(db.getAvailableMediaFileIds).toHaveBeenCalledWith({
      scope: { ownerId: 'owner', tenantId: 'tenant-a' },
      fileIds: [file.file_id],
    });
    expect(db.bulkSaveMessages).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          text: 'Keep this text',
          files: [],
          content: [
            {
              type: ContentTypes.IMAGE_FILE,
              image_file: { file_id: '', filepath: '', unavailable: 'not_transferred' },
            },
          ],
        }),
      ],
      true,
      { unavailableMedia: 'placeholder' },
    );
    expect(db.getAvailableMediaFileIds.mock.invocationCallOrder[0]).toBeLessThan(
      db.bulkSaveConvos.mock.invocationCallOrder[0],
    );
  });

  it('still blocks unresolved ordinary files before writing any conversation', async () => {
    const builder = new ImportBatchBuilder('owner', undefined, filters);
    builder.startConversation();
    builder.saveMessage({
      text: 'Ordinary attachment',
      sender: 'user',
      isCreatedByUser: true,
      files: [{ file_id: 'ordinary-file' }],
    });
    builder.finishConversation('Imported');

    await expect(builder.saveBatch()).rejects.toMatchObject({
      code: 'content_filter_uninspectable',
    });
    expect(db.getAvailableMediaFileIds).not.toHaveBeenCalled();
    expect(db.bulkSaveConvos).not.toHaveBeenCalled();
    expect(db.bulkSaveMessages).not.toHaveBeenCalled();
  });
});
