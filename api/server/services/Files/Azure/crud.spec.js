const mockDownload = jest.fn();
const mockUploadData = jest.fn();
const mockDelete = jest.fn();
const mockGetBlockBlobClient = jest.fn((blobPath) => ({
  url: `https://account.blob.core.windows.net/files/${blobPath}`,
  download: mockDownload,
  uploadData: mockUploadData,
  delete: mockDelete,
}));
const mockGetAzureContainerClient = jest.fn(async () => ({
  url: 'https://account.blob.core.windows.net/files',
  createIfNotExists: jest.fn(),
  getBlockBlobClient: mockGetBlockBlobClient,
}));
const mockGetSafeErrorMetadata = jest.fn(() => ({ type: 'Error', status: 403 }));

jest.mock('@librechat/data-schemas', () => ({
  logger: { error: jest.fn(), debug: jest.fn() },
}));

jest.mock('@librechat/api', () => ({
  deleteRagFile: jest.fn(),
  getAzureBlobPath: jest.requireActual('@librechat/api').getAzureBlobPath,
  getAzureFileLink: jest.requireActual('@librechat/api').getAzureFileLink,
  assertRemoteFileURL: jest.fn((url) => url),
  getSafeErrorMetadata: (...args) => mockGetSafeErrorMetadata(...args),
  getAzureContainerClient: (...args) => mockGetAzureContainerClient(...args),
  getRemoteFileFetchMaxBytes: jest.fn(() => 1024),
  getRemoteFileFetchTimeoutMs: jest.fn(() => 1000),
  assertRemoteFileContentLength: jest.fn(),
}));

const { logger } = require('@librechat/data-schemas');
const { getStoredFileURL } = jest.requireActual('@librechat/api');
const { getAzureFileStream, saveBufferToAzure, deleteFileFromAzure } = require('./crud');

describe('getAzureFileStream', () => {
  it('downloads private blobs through the authenticated Azure client', async () => {
    const stream = { pipe: jest.fn() };
    mockDownload.mockResolvedValue({ readableStreamBody: stream });

    await expect(
      getAzureFileStream(
        {},
        'https://account.blob.core.windows.net/private-files/uploads/user/report%20one.pdf',
      ),
    ).resolves.toBe(stream);

    expect(mockGetAzureContainerClient).toHaveBeenCalledWith('private-files');
    expect(mockGetBlockBlobClient).toHaveBeenCalledWith('uploads/user/report one.pdf');
  });

  it('resolves Azurite blobs relative to the configured account and container path', async () => {
    const stream = { pipe: jest.fn() };
    mockDownload.mockResolvedValue({ readableStreamBody: stream });
    mockGetAzureContainerClient.mockResolvedValueOnce({
      url: 'http://127.0.0.1:10000/devstoreaccount1/files',
      getBlockBlobClient: mockGetBlockBlobClient,
    });

    await expect(
      getAzureFileStream(
        {},
        'http://127.0.0.1:10000/devstoreaccount1/files/uploads/user/report%20one.pdf',
      ),
    ).resolves.toBe(stream);

    expect(mockGetAzureContainerClient).toHaveBeenCalledWith();
    expect(mockGetBlockBlobClient).toHaveBeenCalledWith('uploads/user/report one.pdf');
  });

  it('logs bounded metadata without the signed blob URL', async () => {
    const signedUrl =
      'https://account.blob.core.windows.net/files/uploads/user/report.pdf?sig=secret';
    const failure = Object.assign(new Error(`Request failed for ${signedUrl}`), {
      statusCode: 403,
    });
    mockDownload.mockRejectedValue(failure);

    await expect(getAzureFileStream({}, signedUrl)).rejects.toBe(failure);

    expect(mockGetSafeErrorMetadata).toHaveBeenCalledWith(failure);
    expect(logger.error).toHaveBeenCalledWith('[getAzureFileStream] Error getting blob stream:', {
      type: 'Error',
      status: 403,
    });
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(signedUrl);
  });
});

describe('stored file links', () => {
  const storedLink = getStoredFileURL('azure_blob', 'images/user-1/photo one.png');

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.STORAGE_PROXY_FILES = 'true';
  });

  afterAll(() => {
    delete process.env.STORAGE_PROXY_FILES;
  });

  it('stores LibreChat links for uploads when the proxy is on, and blob URLs when off', async () => {
    const upload = { userId: 'user-1', buffer: Buffer.from('x'), fileName: 'photo one.png' };
    await expect(saveBufferToAzure(upload)).resolves.toBe(storedLink);

    process.env.STORAGE_PROXY_FILES = 'false';
    await expect(saveBufferToAzure(upload)).resolves.toBe(
      'https://account.blob.core.windows.net/files/images/user-1/photo one.png',
    );
  });

  it('keeps blob URLs for containers other than the configured one', async () => {
    await expect(
      saveBufferToAzure({
        userId: 'user-1',
        buffer: Buffer.from('x'),
        fileName: 'photo.png',
        containerName: 'other',
      }),
    ).resolves.toMatch(/^https:/);
  });

  it('streams and deletes the blob behind a stored link from the configured container', async () => {
    const stream = { pipe: jest.fn() };
    mockDownload.mockResolvedValue({ readableStreamBody: stream });

    await expect(getAzureFileStream({}, storedLink)).resolves.toBe(stream);
    expect(mockGetAzureContainerClient).toHaveBeenCalledWith();
    expect(mockGetBlockBlobClient).toHaveBeenCalledWith('images/user-1/photo one.png');

    await deleteFileFromAzure({ user: { id: 'user-1' } }, { filepath: storedLink });
    expect(mockGetBlockBlobClient).toHaveBeenLastCalledWith('images/user-1/photo one.png');
    expect(mockDelete).toHaveBeenCalled();
  });
});
