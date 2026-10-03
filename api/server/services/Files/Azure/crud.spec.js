const mockDownload = jest.fn();
const mockGetBlockBlobClient = jest.fn(() => ({ download: mockDownload }));
const mockGetUserDelegationKey = jest.fn();
const mockInitializeAzureBlobService = jest.fn(async () => ({
  getUserDelegationKey: mockGetUserDelegationKey,
}));
const mockGetAzureContainerClient = jest.fn(async () => ({
  url: 'https://account.blob.core.windows.net/files',
  getBlockBlobClient: mockGetBlockBlobClient,
}));
const mockGetSafeErrorMetadata = jest.fn(() => ({ type: 'Error', status: 403 }));

jest.mock('@librechat/data-schemas', () => ({
  logger: { debug: jest.fn(), error: jest.fn() },
}));

jest.mock('@librechat/api', () => ({
  deleteRagFile: jest.fn(),
  assertRemoteFileURL: jest.fn((url) => url),
  getSafeErrorMetadata: (...args) => mockGetSafeErrorMetadata(...args),
  getAzureContainerClient: (...args) => mockGetAzureContainerClient(...args),
  initializeAzureBlobService: (...args) => mockInitializeAzureBlobService(...args),
  getRemoteFileFetchMaxBytes: jest.fn(() => 1024),
  getRemoteFileFetchTimeoutMs: jest.fn(() => 1000),
  assertRemoteFileContentLength: jest.fn(),
  sanitizeContentDispositionFilename: jest.fn((name) => name),
}));

const { logger } = require('@librechat/data-schemas');
const { getAzureFileStream, getAzureDownloadURL } = require('./crud');

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

describe('getAzureDownloadURL', () => {
  const BLOB_URL =
    'https://acct.blob.core.windows.net/files/images/507f1f77bcf86cd799439011/a%20file.png';

  /** @returns {{ containerClient: object, blobClient: object }} */
  function mockContainer(blobClient) {
    const containerClient = {
      containerName: 'files',
      accountName: 'acct',
      getBlobClient: jest.fn(() => blobClient),
    };
    mockGetAzureContainerClient.mockResolvedValueOnce(containerClient);
    return containerClient;
  }

  beforeEach(() => jest.clearAllMocks());

  it('signs a read-only, HTTPS-only URL with the account key', async () => {
    const blobClient = {
      url: 'https://acct.blob.core.windows.net/files/images/u/f.png',
      generateSasUrl: jest.fn().mockResolvedValue('https://signed.example/f.png?sig=abc'),
    };
    const containerClient = mockContainer(blobClient);

    const url = await getAzureDownloadURL({
      file: { filepath: BLOB_URL },
      customFilename: 'report.png',
      contentType: 'image/png',
    });

    expect(url).toBe('https://signed.example/f.png?sig=abc');
    /** container prefix stripped, path decoded */
    expect(containerClient.getBlobClient).toHaveBeenCalledWith(
      'images/507f1f77bcf86cd799439011/a file.png',
    );
    const options = blobClient.generateSasUrl.mock.calls[0][0];
    expect(options.permissions.read).toBe(true);
    expect(options.permissions.write).toBeFalsy();
    expect(options.protocol).toBe('https');
    expect(options.contentDisposition).toBe('attachment; filename="report.png"');
    expect(options.contentType).toBe('image/png');
    /** starts in the past, so host clock drift cannot invalidate the signature */
    expect(options.startsOn.getTime()).toBeLessThan(Date.now());
    expect(options.expiresOn.getTime()).toBeGreaterThan(Date.now());
  });

  it('accepts a container-relative filepath', async () => {
    const blobClient = {
      url: 'https://acct.blob.core.windows.net/files/images/u/f.png',
      generateSasUrl: jest.fn().mockResolvedValue('https://signed.example/f.png?sig=abc'),
    };
    const containerClient = mockContainer(blobClient);

    await getAzureDownloadURL({ file: { filepath: '/images/u/f.png' } });

    expect(containerClient.getBlobClient).toHaveBeenCalledWith('images/u/f.png');
  });

  it('falls back to a user delegation key when no account key is configured', async () => {
    const blobClient = {
      url: 'https://acct.blob.core.windows.net/files/images/u/f.png',
      generateSasUrl: jest.fn().mockRejectedValue(new Error('Cannot generate SAS')),
    };
    mockContainer(blobClient);
    mockGetUserDelegationKey.mockResolvedValue({ value: 'delegation-key' });

    const url = await getAzureDownloadURL({ file: { filepath: BLOB_URL } });

    expect(mockGetUserDelegationKey).toHaveBeenCalled();
    expect(url.startsWith(`${blobClient.url}?`)).toBe(true);
  });

  it('throws when the service is not initialized', async () => {
    mockGetAzureContainerClient.mockResolvedValueOnce(null);
    await expect(getAzureDownloadURL({ file: { filepath: BLOB_URL } })).rejects.toThrow(
      'Azure Blob Service not initialized',
    );
  });
});
