const mockDownload = jest.fn();
const mockGetBlockBlobClient = jest.fn(() => ({ download: mockDownload }));
const mockGetAzureContainerClient = jest.fn(async () => ({
  url: 'https://account.blob.core.windows.net/files',
  getBlockBlobClient: mockGetBlockBlobClient,
}));

jest.mock('@librechat/data-schemas', () => ({
  logger: { error: jest.fn() },
}));

jest.mock('@librechat/api', () => ({
  deleteRagFile: jest.fn(),
  createAzureFileStream: jest.requireActual('../../../../../packages/api/src/storage/read.ts')
    .createAzureFileStream,
  createAzureStreamStorage: jest.fn(() => ({
    planFile: jest.fn(),
    saveStream: jest.fn(),
    streamFile: jest.fn(),
  })),
  assertRemoteFileURL: jest.fn((url) => url),
  getAzureContainerClient: (...args) => mockGetAzureContainerClient(...args),
  getRemoteFileFetchMaxBytes: jest.fn(() => 1024),
  getRemoteFileFetchTimeoutMs: jest.fn(() => 1000),
  assertRemoteFileContentLength: jest.fn(),
}));

const { logger } = require('@librechat/data-schemas');
const { getAzureFileStream } = require('./crud');

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

  it('propagates download failures without logging signed blob URLs', async () => {
    const signedUrl =
      'https://account.blob.core.windows.net/files/uploads/user/report.pdf?sig=secret';
    const failure = Object.assign(new Error(`Request failed for ${signedUrl}`), {
      statusCode: 403,
    });
    mockDownload.mockRejectedValue(failure);

    await expect(getAzureFileStream({}, signedUrl)).rejects.toBe(failure);

    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(signedUrl);
  });
});
