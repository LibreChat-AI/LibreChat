import { toPublicFiles, toPublicMessageFiles, toPublicMessagePage } from './public';

const media = {
  file_id: 'f17ecafe-1234-4123-8123-123456789012',
  filename: 'original.png',
  type: 'image/png',
  bytes: 4096,
  filepath: 'https://private.example/original.png?signature=private-secret',
  source: FileSources.s3,
  object: 'file' as const,
  user: 'owner',
  embedded: false,
  width: 512,
  height: 512,
  usage: 2,
  metadata: { destinationChosen: true },
  storageKey: 'private-original-key',
  storageRegion: 'private-region',
  mediaOutputKey: 'private-job',
  mediaContentDigest: 'private-digest',
  mediaRetainers: ['private-thread'],
  mediaRenditionLocations: [{ filepath: 'private-plan' }],
  mediaRenditions: { thumbnail: { filepath: 'private-thumbnail', type: 'image/png', bytes: 32 } },
};
const contentPath = `/api/media/assets/${media.file_id}/content`;

describe('public media files at existing response boundaries', () => {
  it('keeps ordinary files unchanged and exposes media originals without private storage metadata', () => {
    const ordinary = { ...media, file_id: 'ordinary-file', filepath: '/uploads/ordinary.png' };
    const [unchanged, projected] = toPublicFiles([ordinary, media]);
    expect(unchanged).toBe(ordinary);
    expect(projected).toEqual({
      file_id: media.file_id,
      filename: media.filename,
      type: media.type,
      bytes: media.bytes,
      filepath: contentPath,
      source: media.source,
      object: media.object,
      user: media.user,
      embedded: media.embedded,
      width: media.width,
      height: media.height,
      usage: media.usage,
      metadata: media.metadata,
      deletionRestriction: 'retained_media',
    });
    expect(JSON.stringify(projected)).not.toContain('private-');
    expect(projected.filepath).not.toContain('rendition');
    expect(media.filepath).toContain('private-secret');
    expect(media.storageKey).toBe('private-original-key');
  });

  it('repairs saved image and attachment snapshots without altering the stored message', () => {
    const attachment = { ...media, type: undefined, messageId: 'saved', toolCallId: 'saved-call' };
    const ordinary = { ...attachment, file_id: 'ordinary-file' };
    const message = {
      messageId: 'saved',
      files: [{ ...media, source: undefined }],
      attachments: [attachment, ordinary],
      content: [
        { type: ContentTypes.TEXT as const, text: 'Keep this text' },
        {
          type: ContentTypes.IMAGE_FILE as const,
          image_file: media,
          native_media: { continuationRef: 'saved-ref' },
        },
        // Legacy provider snapshots and older native media rows can carry partial image metadata.
        {
          type: ContentTypes.IMAGE_FILE,
          image_file: { file_id: 'provider-image' },
        } as TMessageContentParts,
        {
          type: ContentTypes.IMAGE_FILE,
          image_file: { file_id: media.file_id, filepath: media.filepath },
        } as TMessageContentParts,
        { type: ContentTypes.STEER as const, steer: 'Use this original', files: [media] },
      ],
    };
    const projected = toPublicMessageFiles(message);
    expect(projected.files[0].filepath).toBe(contentPath);
    expect(projected.attachments[0].filepath).toBe(contentPath);
    expect(projected.attachments[1]).toBe(ordinary);
    expect(projected.content[0]).toBe(message.content[0]);
    expect(projected.content[1]).toMatchObject({
      image_file: { filepath: contentPath, bytes: media.bytes },
      native_media: { continuationRef: 'saved-ref' },
    });
    expect(projected.content[2]).toBe(message.content[2]);
    expect(projected.content[3]).toEqual({
      type: ContentTypes.IMAGE_FILE,
      image_file: { file_id: media.file_id, filepath: contentPath },
    });
    expect(projected.content[4]).toMatchObject({ files: [{ filepath: contentPath }] });
    expect(message.files[0].filepath).toBe(media.filepath);
    expect(message.content[1]).toMatchObject({ image_file: media });
    expect(toPublicMessagePage({ messages: [message], nextCursor: 'next' })).toMatchObject({
      messages: [{ files: [{ filepath: contentPath }] }],
      nextCursor: 'next',
    });
  });
});
import { ContentTypes, FileSources } from 'librechat-data-provider';
import type { TMessageContentParts } from 'librechat-data-provider';
