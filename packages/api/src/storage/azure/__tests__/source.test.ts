import { FileSources } from 'librechat-data-provider';
import { azureFileSource, getAzureBlobPath, getAzureFileLink } from '../source';
import { getStoredFileURL } from '~/storage/proxy/link';

const mockDownload = jest.fn();
const mockGetProperties = jest.fn();
const mockGetBlockBlobClient = jest.fn((_blobPath: string) => ({
  download: mockDownload,
  getProperties: mockGetProperties,
}));

jest.mock('~/cdn/azure', () => ({
  getAzureContainerClient: jest.fn(async () => ({ getBlockBlobClient: mockGetBlockBlobClient })),
}));

const blobPath = 'images/user-1/photo one.png';
const blobURL = `https://account.blob.core.windows.net/files/${blobPath}`;

describe('Azure stored file links', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.STORAGE_PROXY_FILES = 'true';
    delete process.env.AZURE_CONTAINER_NAME;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('links blobs of the configured container to LibreChat when the proxy is on', () => {
    const link = getAzureFileLink(blobURL, blobPath);
    expect(link).toBe(getStoredFileURL(FileSources.azure_blob, blobPath));
    expect(getAzureBlobPath(link)).toBe(blobPath);
    expect(getAzureBlobPath(blobURL)).toBeNull();
  });

  it('keeps blob URLs when the proxy is off or the container is not the configured one', () => {
    expect(getAzureFileLink(blobURL, blobPath, 'other')).toBe(blobURL);
    expect(getAzureFileLink(blobURL, blobPath, 'files')).not.toBe(blobURL);
    process.env.STORAGE_PROXY_FILES = 'false';
    expect(getAzureFileLink(blobURL, blobPath)).toBe(blobURL);
  });

  it('reads owners from blob paths and recognises Azure avatar names', () => {
    expect(azureFileSource.parseKey(blobPath)).toEqual({
      userId: 'user-1',
      fileName: 'photo one.png',
      avatar: false,
    });
    expect(azureFileSource.parseKey('images/user-1/avatar-1700000000000.png')?.avatar).toBe(true);
    expect(
      azureFileSource.parseKey('images/user-1/agent-agent_abc-avatar-1700000000000.png')?.avatar,
    ).toBe(true);
    expect(azureFileSource.parseKey('images/user-1')).toBeNull();
  });

  it('downloads blobs and answers HEAD from blob properties', async () => {
    const signal = new AbortController().signal;
    const body = { pipe: jest.fn() };
    mockDownload.mockResolvedValue({ readableStreamBody: body, contentLength: 5 });
    mockGetProperties.mockResolvedValue({ contentLength: 5 });

    await expect(azureFileSource.read(blobPath, { head: false, signal })).resolves.toEqual({
      body,
      contentLength: 5,
    });
    expect(mockGetBlockBlobClient).toHaveBeenCalledWith(blobPath);
    expect(mockDownload).toHaveBeenCalledWith(0, undefined, { abortSignal: signal });

    await expect(azureFileSource.read(blobPath, { head: true, signal })).resolves.toEqual({
      contentLength: 5,
    });
  });

  it('recognises missing blobs', () => {
    expect(azureFileSource.isNotFound({ statusCode: 404 })).toBe(true);
    expect(azureFileSource.isNotFound({ code: 'BlobNotFound' })).toBe(true);
    expect(azureFileSource.isNotFound({ statusCode: 403 })).toBe(false);
  });
});
