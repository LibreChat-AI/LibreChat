const mockDownload = jest.fn();
const mockDelete = jest.fn();
const mockGetBlockBlobClient = jest.fn(() => ({ download: mockDownload, delete: mockDelete }));
const mockGetAzureContainerClient = jest.fn(async () => ({
  url: 'https://account.blob.core.windows.net/files',
  getBlockBlobClient: mockGetBlockBlobClient,
}));
const mockGetSafeErrorMetadata = jest.fn(() => ({ type: 'Error', status: 403 }));

jest.mock('@librechat/data-schemas', () => ({
  logger: { error: jest.fn(), debug: jest.fn() },
}));

jest.mock('@librechat/api', () => ({
  ...jest.requireActual('../../../../../packages/api/src/storage/ownedBlobDelete'),
  dispatchFileDeletion: jest.requireActual('../../../../../packages/api/src/files/dispatch')
    .dispatchFileDeletion,
  deleteRagFile: jest.fn(),
  assertRemoteFileURL: jest.fn((url) => url),
  getSafeErrorMetadata: (...args) => mockGetSafeErrorMetadata(...args),
  getAzureContainerClient: (...args) => mockGetAzureContainerClient(...args),
  getRemoteFileFetchMaxBytes: jest.fn(() => 1024),
  getRemoteFileFetchTimeoutMs: jest.fn(() => 1000),
  assertRemoteFileContentLength: jest.fn(),
}));

const { logger } = require('@librechat/data-schemas');
const { getAzureFileStream, deleteFileFromAzure } = require('./crud');
const { deleteRagFile } = require('@librechat/api');

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

describe('deleteFileFromAzure', () => {
  const req = { user: { id: 'owner' } };
  const file = { filepath: 'https://account.blob.core.windows.net/files/uploads/owner/file.txt' };

  beforeEach(() => {
    mockDelete.mockReset().mockResolvedValue(undefined);
    deleteRagFile.mockReset().mockResolvedValue(undefined);
  });

  it('does not mark a failed client preflight', async () => {
    const onDelete = jest.fn();
    const error = Object.assign(new Error('client timed out'), { code: 'ETIMEDOUT' });
    mockGetAzureContainerClient.mockRejectedValueOnce(error);
    await expect(deleteFileFromAzure(req, file, undefined, onDelete)).rejects.toBe(error);
    expect(onDelete).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('does not mark invalid ownership before dispatch', async () => {
    const onDelete = jest.fn();
    await expect(
      deleteFileFromAzure({ user: { id: 'other' } }, file, undefined, onDelete),
    ).rejects.toThrow('Invalid file path');
    expect(onDelete).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('marks a lost delete response without confirming deletion', async () => {
    const onDelete = jest.fn();
    const error = Object.assign(new Error('response lost'), { code: 'ETIMEDOUT' });
    mockDelete.mockRejectedValueOnce(error);
    await expect(deleteFileFromAzure(req, file, undefined, onDelete)).rejects.toBe(error);
    expect(onDelete.mock.calls).toEqual([[]]);
    expect(deleteRagFile).toHaveBeenCalledWith({ userId: 'owner', file });
  });

  it('retains the blob when RAG cleanup returns false', async () => {
    const onDelete = jest.fn();
    deleteRagFile.mockResolvedValueOnce(false);
    await expect(deleteFileFromAzure(req, file, undefined, onDelete)).rejects.toThrow(
      'Vector deletion was not confirmed',
    );
    expect(onDelete).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('does not dispatch blob deletion when RAG cleanup is denied', async () => {
    const onDelete = jest.fn();
    const error = Object.assign(new Error('RAG denied'), { statusCode: 403 });
    deleteRagFile.mockImplementationOnce(async () => {
      expect(onDelete).not.toHaveBeenCalled();
      throw error;
    });
    await expect(deleteFileFromAzure(req, file, undefined, onDelete)).rejects.toBe(error);
    expect(onDelete).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
  });
});
