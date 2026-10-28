import { FileSources } from 'librechat-data-provider';
import { DEFAULT_FILE_LIST_LIMIT, handleFileListRequest, type FileListDependencies } from './list';

const staleFile = {
  file_id: 'f1',
  user: 'user-123',
  source: FileSources.s3,
  filepath: 'https://bucket.s3.amazonaws.com/key?X-Amz-Expires=1',
};
const freshFile = { ...staleFile, filepath: 'https://bucket.s3.amazonaws.com/key?X-Amz-Expires=2' };

function createDependencies(files = [staleFile]) {
  const cache = {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(undefined),
  };
  const dependencies: FileListDependencies = {
    getFiles: jest.fn().mockResolvedValue(files),
    batchUpdateFiles: jest.fn().mockResolvedValue(undefined),
    refreshS3FileUrls: jest.fn().mockResolvedValue(files),
    getLogStores: jest.fn().mockReturnValue(cache),
    logger: { warn: jest.fn() },
  };
  return { dependencies, cache };
}

describe('handleFileListRequest', () => {
  it('passes a positive query limit through to the owner-scoped query', async () => {
    const { dependencies } = createDependencies([]);

    await handleFileListRequest({
      userId: 'user-123',
      rawLimit: '5',
      fileStrategy: FileSources.local,
      dependencies,
    });

    expect(dependencies.getFiles).toHaveBeenCalledWith({ user: 'user-123' }, null, null, 5);
  });

  it('caps an explicit query limit at the default deployment limit', async () => {
    const { dependencies } = createDependencies([]);

    await handleFileListRequest({
      userId: 'user-123',
      rawLimit: '100000',
      fileStrategy: FileSources.local,
      dependencies,
    });

    expect(dependencies.getFiles).toHaveBeenCalledWith(
      { user: 'user-123' },
      null,
      null,
      DEFAULT_FILE_LIST_LIMIT,
    );
  });

  it('uses the configured maximum instead of the default cap', async () => {
    const { dependencies } = createDependencies([]);

    await handleFileListRequest({
      userId: 'user-123',
      rawLimit: '100000',
      maxLimit: 250,
      fileStrategy: FileSources.local,
      dependencies,
    });

    expect(dependencies.getFiles).toHaveBeenCalledWith({ user: 'user-123' }, null, null, 250);
  });

  it.each([undefined, 'abc', '0', '-1'])('leaves %p as an unlimited query', async (rawLimit) => {
    const { dependencies } = createDependencies([]);

    await handleFileListRequest({
      userId: 'user-123',
      rawLimit,
      fileStrategy: FileSources.local,
      dependencies,
    });

    expect(dependencies.getFiles).toHaveBeenCalledWith({ user: 'user-123' }, null, null, undefined);
  });

  it('returns refreshed S3 rows and avoids marking a limited request as a full-list check', async () => {
    const { dependencies, cache } = createDependencies([staleFile]);
    dependencies.refreshS3FileUrls = jest.fn().mockResolvedValue([freshFile]);

    const result = await handleFileListRequest({
      userId: 'user-123',
      rawLimit: '5',
      fileStrategy: FileSources.s3,
      dependencies,
    });

    expect(result).toEqual([freshFile]);
    expect(dependencies.refreshS3FileUrls).toHaveBeenCalledWith(
      [staleFile],
      dependencies.batchUpdateFiles,
    );
    expect(cache.set).not.toHaveBeenCalled();
  });

  it('marks the cache after refreshing an unlimited S3 request', async () => {
    const { dependencies, cache } = createDependencies([staleFile]);
    dependencies.refreshS3FileUrls = jest.fn().mockResolvedValue([freshFile]);

    const result = await handleFileListRequest({
      userId: 'user-123',
      fileStrategy: FileSources.s3,
      dependencies,
    });

    expect(result).toEqual([freshFile]);
    expect(cache.set).toHaveBeenCalledWith('user-123', true, expect.any(Number));
  });

  it('skips S3 refresh when the user interval is already marked', async () => {
    const { dependencies, cache } = createDependencies([staleFile]);
    cache.get.mockResolvedValue(true);

    const result = await handleFileListRequest({
      userId: 'user-123',
      fileStrategy: FileSources.s3,
      dependencies,
    });

    expect(dependencies.refreshS3FileUrls).not.toHaveBeenCalled();
    expect(result).toEqual([staleFile]);
  });

  it('keeps original rows when S3 refresh fails and reports the warning', async () => {
    const { dependencies } = createDependencies([staleFile]);
    dependencies.refreshS3FileUrls = jest.fn().mockRejectedValue(new Error('s3 down'));

    const result = await handleFileListRequest({
      userId: 'user-123',
      fileStrategy: FileSources.s3,
      dependencies,
    });

    expect(result).toEqual([staleFile]);
    expect(dependencies.logger.warn).toHaveBeenCalledWith(
      '[/files] Error refreshing S3 file URLs:',
      expect.any(Error),
    );
  });

  it('does not access S3 for local deployments', async () => {
    const { dependencies } = createDependencies([staleFile]);

    await handleFileListRequest({
      userId: 'user-123',
      fileStrategy: FileSources.local,
      dependencies,
    });

    expect(dependencies.refreshS3FileUrls).not.toHaveBeenCalled();
    expect(dependencies.getLogStores).not.toHaveBeenCalled();
  });
});
