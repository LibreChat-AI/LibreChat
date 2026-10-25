import type { StoredUploadRef } from './orphan';
import {
  resolveStoredUploadTarget,
  withStoredUploadCleanup,
  createStoredUploadDelete,
} from './orphan';

const stored: StoredUploadRef = {
  file_id: 'file-1',
  filepath: 'https://bucket.example/images/user/file-1.png',
  source: 's3',
  storageKey: 'images/user/file-1.png',
};

describe('withStoredUploadCleanup', () => {
  const logger = { error: jest.fn() };
  const recordExists = jest.fn().mockResolvedValue(false);
  const req = { user: { id: 'u1', tenantId: 't1' } };
  beforeEach(() => {
    logger.error.mockClear();
    recordExists.mockReset().mockResolvedValue(false);
  });

  it('returns the result without resolving or calling delete when the next step succeeds', async () => {
    const deleteFile = jest.fn();
    const resolveDeleteFile = jest.fn(() => deleteFile);
    await expect(
      withStoredUploadCleanup(
        { stored, resolveDeleteFile, recordExists, req, logger },
        async () => 'ok',
      ),
    ).resolves.toBe('ok');
    expect(resolveDeleteFile).not.toHaveBeenCalled();
    expect(deleteFile).not.toHaveBeenCalled();
  });

  it('deletes the stored object and rethrows the original error when the next step fails', async () => {
    const deleteFile = jest.fn().mockResolvedValue(undefined);
    const failure = new Error('createFile failed');
    await expect(
      withStoredUploadCleanup(
        { stored, resolveDeleteFile: () => deleteFile, recordExists, req, logger },
        async () => {
          throw failure;
        },
      ),
    ).rejects.toBe(failure);
    expect(deleteFile).toHaveBeenCalledWith(req, { ...stored, user: 'u1', tenantId: 't1' });
  });

  it('deletes without a record lookup when the failure precedes the record write', async () => {
    const deleteFile = jest.fn().mockResolvedValue(undefined);
    recordExists.mockRejectedValue(new Error('database unavailable'));
    const failure = new Error('addAgentResourceFile failed');
    await expect(
      withStoredUploadCleanup(
        {
          stored,
          resolveDeleteFile: () => deleteFile,
          recordExists,
          req,
          logger,
          trackWrite: true,
        },
        async () => {
          throw failure;
        },
      ),
    ).rejects.toBe(failure);
    expect(recordExists).not.toHaveBeenCalled();
    expect(deleteFile).toHaveBeenCalledTimes(1);
  });

  it('still consults the record once the write has begun', async () => {
    const deleteFile = jest.fn();
    recordExists.mockResolvedValue(true);
    const failure = new Error('lost acknowledgement');
    await expect(
      withStoredUploadCleanup(
        {
          stored,
          resolveDeleteFile: () => deleteFile,
          recordExists,
          req,
          logger,
          trackWrite: true,
        },
        async (beginWrite) => {
          beginWrite();
          throw failure;
        },
      ),
    ).rejects.toBe(failure);
    expect(recordExists).toHaveBeenCalledTimes(1);
    expect(deleteFile).not.toHaveBeenCalled();
  });

  it('keeps the stored object when the rejected write actually committed a record', async () => {
    const deleteFile = jest.fn();
    recordExists.mockResolvedValue(true);
    const failure = new Error('lost acknowledgement');
    await expect(
      withStoredUploadCleanup(
        { stored, resolveDeleteFile: () => deleteFile, recordExists, req, logger },
        async () => {
          throw failure;
        },
      ),
    ).rejects.toBe(failure);
    expect(deleteFile).not.toHaveBeenCalled();
  });

  it('keeps the stored object and logs when the record lookup itself fails', async () => {
    const deleteFile = jest.fn();
    recordExists.mockRejectedValue(new Error('db down'));
    const failure = new Error('createFile failed');
    await expect(
      withStoredUploadCleanup(
        { stored, resolveDeleteFile: () => deleteFile, recordExists, req, logger },
        async () => {
          throw failure;
        },
      ),
    ).rejects.toBe(failure);
    expect(deleteFile).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it('logs a failed cleanup without replacing the original error', async () => {
    const deleteFile = jest.fn().mockRejectedValue(new Error('storage down'));
    const failure = new Error('createFile failed');
    await expect(
      withStoredUploadCleanup(
        { stored, resolveDeleteFile: () => deleteFile, recordExists, req, logger },
        async () => {
          throw failure;
        },
      ),
    ).rejects.toBe(failure);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it('logs a failing resolver without replacing the original error', async () => {
    const failure = new Error('createFile failed');
    await expect(
      withStoredUploadCleanup(
        {
          stored,
          resolveDeleteFile: () => {
            throw new Error('no strategy');
          },
          recordExists,
          req,
          logger,
        },
        async () => {
          throw failure;
        },
      ),
    ).rejects.toBe(failure);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it('rethrows when the strategy has no delete function', async () => {
    const failure = new Error('createFile failed');
    await expect(
      withStoredUploadCleanup(
        { stored, resolveDeleteFile: () => undefined, recordExists, req, logger },
        async () => {
          throw failure;
        },
      ),
    ).rejects.toBe(failure);
    expect(logger.error).not.toHaveBeenCalled();
  });
});

describe('resolveStoredUploadTarget', () => {
  const base = { file_id: 'f', filepath: '/images/f.png', source: 'local' };
  const converted = { file_id: 'c', filepath: '/images/c.png', source: 's3' };

  it('targets the stored object for a non-Assistants upload, with storage metadata', () => {
    expect(
      resolveStoredUploadTarget({
        isAssistantUpload: false,
        stored: base,
        storageMetadata: { storageKey: 'k' },
      }),
    ).toEqual({ source: 'local', stored: { ...base, storageKey: 'k' } });
  });

  it('targets only the converted image for an Assistants upload', () => {
    expect(
      resolveStoredUploadTarget({
        isAssistantUpload: true,
        stored: base,
        convertedImage: converted,
        storageMetadata: { storageKey: 'k' },
      }),
    ).toEqual({ source: 's3', stored: { ...converted, storageKey: 'k', recordId: 'f' } });
  });

  it('targets nothing for an Assistants upload without a converted image', () => {
    expect(resolveStoredUploadTarget({ isAssistantUpload: true, stored: base })).toBeUndefined();
  });
});

describe('createStoredUploadDelete', () => {
  const req = { user: { id: 'u1' } } as never;
  const strategies = (map: Record<string, jest.Mock | undefined>) => (source: string) =>
    map[source];

  it('removes the vector and code environment copies named by the reference', async () => {
    const primary = jest.fn().mockResolvedValue(undefined);
    const vector = jest.fn().mockResolvedValue(undefined);
    const code = jest.fn().mockResolvedValue(undefined);
    const file = { ...stored, embedded: true, metadata: { codeEnvRef: { file_id: 'c1' } } };
    await createStoredUploadDelete({
      source: 's3',
      getDeleteFile: strategies({ s3: primary, vectordb: vector, execute_code: code }),
    })(req, file);
    expect(primary).toHaveBeenCalledWith(req, file);
    expect(vector).toHaveBeenCalledWith(req, file);
    expect(code).toHaveBeenCalledWith(req, file);
  });

  it('skips secondary copies the reference does not name', async () => {
    const primary = jest.fn().mockResolvedValue(undefined);
    const vector = jest.fn();
    await createStoredUploadDelete({
      source: 's3',
      getDeleteFile: strategies({ s3: primary, vectordb: vector }),
    })(req, stored);
    expect(primary).toHaveBeenCalledTimes(1);
    expect(vector).not.toHaveBeenCalled();
  });

  it('still deletes the secondary copies when the primary delete fails, then rethrows', async () => {
    const failure = new Error('storage down');
    const primary = jest.fn().mockRejectedValue(failure);
    const vector = jest.fn().mockResolvedValue(undefined);
    await expect(
      createStoredUploadDelete({
        source: 's3',
        getDeleteFile: strategies({ s3: primary, vectordb: vector }),
      })(req, { ...stored, embedded: true }),
    ).rejects.toBe(failure);
    expect(vector).toHaveBeenCalledTimes(1);
  });
});
