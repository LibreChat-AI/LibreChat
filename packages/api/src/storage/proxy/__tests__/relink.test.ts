import { ContentTypes, FileSources } from 'librechat-data-provider';
import type { Relinker } from '../relink';
import { relinkLink, relinkFileRef, relinkMessage } from '../relink';
import { createAzureRelinker } from '~/storage/azure/source';
import { getStoredFileURL } from '../link';

jest.mock('~/cdn/azure', () => ({ getAzureContainerClient: jest.fn() }));

const containerURL = 'https://account.blob.core.windows.net/files';
const blobPath = 'images/user-1/photo one.png';
const blobURL = `${containerURL}/images/user-1/photo%20one.png`;
const stored = getStoredFileURL(FileSources.azure_blob, blobPath);

/** Stands in for S3: `s3://<key>` is its storage link. */
const fakeS3: Relinker = {
  source: FileSources.s3,
  toStored: (link) =>
    link.startsWith('s3://') ? getStoredFileURL(FileSources.s3, link.slice(5)) : null,
  toStorage: async (link) => {
    const prefix = getStoredFileURL(FileSources.s3, '');
    return link.startsWith(prefix) ? `s3://${decodeURIComponent(link.slice(prefix.length))}` : null;
  },
};

describe('relinking stored file links', () => {
  const azure = createAzureRelinker(containerURL);
  const relinkers = [fakeS3, azure];

  it('converts Azure blob URLs to LibreChat links and back, keeping their query', async () => {
    expect(azure.toStored(blobURL)).toBe(stored);
    expect(azure.toStored(`${blobURL}?manual=true`)).toBe(`${stored}?manual=true`);
    expect(azure.toStored('https://elsewhere.example.com/files/x.png')).toBeNull();
    expect(azure.toStored(stored)).toBeNull();

    await expect(azure.toStorage(stored)).resolves.toBe(blobURL);
    await expect(azure.toStorage(`${stored}?manual=true`)).resolves.toBe(`${blobURL}?manual=true`);
    await expect(azure.toStorage(blobURL)).resolves.toBeNull();
  });

  it('uses only the relinker of a record’s source, and any for a bare link', async () => {
    await expect(relinkLink(blobURL, 'stored', relinkers, FileSources.s3)).resolves.toBeNull();
    await expect(relinkLink(blobURL, 'stored', relinkers)).resolves.toBe(stored);
    await expect(relinkLink(stored, 'stored', relinkers)).resolves.toBeNull();
  });

  it('rewrites a file record in place and reports whether it changed', async () => {
    const file = { source: FileSources.azure_blob, filepath: blobURL };
    await expect(relinkFileRef(file, 'stored', relinkers)).resolves.toBe(true);
    expect(file.filepath).toBe(stored);
    await expect(relinkFileRef(file, 'stored', relinkers)).resolves.toBe(false);
    await expect(
      relinkFileRef({ source: FileSources.local, filepath: '/images/a.png' }, 'stored', relinkers),
    ).resolves.toBe(false);
  });

  it('rewrites every file a message carries and returns only the changed fields', async () => {
    const message = {
      files: [{ source: FileSources.s3, filepath: 's3://images/u/a.png' }],
      attachments: [{ source: FileSources.local, filepath: '/images/u/b.png' }],
      content: [
        { type: ContentTypes.TEXT, text: 'hi' },
        {
          type: ContentTypes.STEER,
          files: [{ source: FileSources.azure_blob, filepath: blobURL }],
        },
        {
          type: ContentTypes.IMAGE_FILE,
          image_file: { source: FileSources.s3, filepath: 's3://images/u/c.png' },
        },
        null,
      ],
    };

    const changes = await relinkMessage(message, 'stored', relinkers);

    expect(Object.keys(changes).sort()).toEqual(['content', 'files']);
    expect(message.files[0].filepath).toBe(getStoredFileURL(FileSources.s3, 'images/u/a.png'));
    expect(message.attachments[0].filepath).toBe('/images/u/b.png');
    const [, steer, imageFile] = message.content as Array<{
      files?: Array<{ filepath: string }>;
      image_file?: { filepath: string };
    }>;
    expect(steer.files?.[0].filepath).toBe(stored);
    expect(imageFile.image_file?.filepath).toBe(getStoredFileURL(FileSources.s3, 'images/u/c.png'));

    await expect(relinkMessage(message, 'stored', relinkers)).resolves.toEqual({});
    await relinkMessage(message, 'storage', relinkers);
    expect(message.files[0].filepath).toBe('s3://images/u/a.png');
  });
});
