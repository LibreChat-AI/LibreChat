import { ContentTypes } from 'librechat-data-provider';
import type { FiltersConfig } from 'librechat-data-provider';
import type { MediaMethods } from '@librechat/data-schemas';
import { assertConversationImportContentAllowed } from '~/imports';
import { prepareMediaConversationImport } from './media';

const availableId = 'f17ecafe-0000-4000-8000-000000000001';
const unavailableId = 'f17ecafe-0000-4000-8000-000000000002';
const scope = { ownerId: 'owner', tenantId: 'tenant-a' };
const filters: FiltersConfig = {
  files: { pii: { fields: ['content', 'extracted_text'], uninspectable: 'block' } },
};

const lookup = () =>
  jest.fn<
    ReturnType<MediaMethods['getAvailableMediaFileIds']>,
    Parameters<MediaMethods['getAvailableMediaFileIds']>
  >();

describe('media conversation import preflight', () => {
  it('preserves live and ordinary files while batching all media reference locations', async () => {
    const available = { file_id: availableId, filepath: '/api/media/assets/live/content' };
    const missing = { file_id: unavailableId, filepath: '/api/media/assets/missing/content' };
    const ordinary = { file_id: 'ordinary', filepath: '/files/document.txt' };
    const messages = [
      {
        text: 'keep conversation text',
        files: [available, missing, ordinary],
        attachments: [missing],
        content: [
          { type: ContentTypes.IMAGE_FILE, image_file: missing },
          { type: ContentTypes.IMAGE_FILE, image_file: available },
          { type: ContentTypes.STEER, text: 'keep steering', files: [missing, ordinary] },
        ],
      },
      { files: [available, missing] },
    ];
    const getAvailableMediaFileIds = lookup().mockResolvedValue([availableId]);

    await prepareMediaConversationImport({ scope, messages, getAvailableMediaFileIds });

    expect(getAvailableMediaFileIds).toHaveBeenCalledTimes(1);
    expect(getAvailableMediaFileIds).toHaveBeenCalledWith({
      scope,
      fileIds: [availableId, unavailableId],
    });
    expect(messages[0]).toMatchObject({
      text: 'keep conversation text',
      files: [available, ordinary],
      attachments: [],
      content: [
        {
          type: ContentTypes.IMAGE_FILE,
          image_file: { file_id: '', filepath: '', unavailable: 'not_transferred' },
        },
        { type: ContentTypes.IMAGE_FILE, image_file: available },
        { type: ContentTypes.STEER, text: 'keep steering', files: [ordinary] },
      ],
    });
    expect(messages[1].files).toEqual([available]);
  });

  it('allows unavailable media placeholders through active file policy', async () => {
    const snapshot = {
      conversations: [],
      messages: [
        {
          isCreatedByUser: true,
          text: 'preserved',
          files: [{ file_id: unavailableId }],
          content: [
            {
              type: ContentTypes.IMAGE_FILE,
              image_file: { file_id: unavailableId, filepath: '/api/media/assets/missing/content' },
            },
          ],
        },
      ],
    };
    await expect(
      assertConversationImportContentAllowed(filters, snapshot, {
        user: { id: scope.ownerId, tenantId: scope.tenantId },
        getFiles: async () => [],
      }),
    ).rejects.toMatchObject({ code: 'content_filter_uninspectable' });

    await prepareMediaConversationImport({
      scope,
      messages: snapshot.messages,
      getAvailableMediaFileIds: lookup().mockResolvedValue([]),
    });

    await expect(
      assertConversationImportContentAllowed(filters, snapshot),
    ).resolves.toBeUndefined();
  });

  it('does not query or remove ordinary files, whose existing content policy still applies', async () => {
    const messages = [{ isCreatedByUser: true, files: [{ file_id: 'ordinary' }] }];
    const getAvailableMediaFileIds = lookup();
    await prepareMediaConversationImport({ scope, messages, getAvailableMediaFileIds });
    expect(getAvailableMediaFileIds).not.toHaveBeenCalled();
    await expect(
      assertConversationImportContentAllowed(filters, {
        conversations: [],
        messages,
      }),
    ).rejects.toMatchObject({ code: 'content_filter_uninspectable' });
  });

  it('fails before mutating the import if availability lookup fails', async () => {
    const messages = [{ files: [{ file_id: availableId }] }];
    const original = structuredClone(messages);
    const failure = new Error('database unavailable');
    await expect(
      prepareMediaConversationImport({
        scope,
        messages,
        getAvailableMediaFileIds: lookup().mockRejectedValue(failure),
      }),
    ).rejects.toBe(failure);
    expect(messages).toEqual(original);
  });
});
