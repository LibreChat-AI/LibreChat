import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { FileSources } from 'librechat-data-provider';
import type { StoredUploadRef } from './orphan';
import {
  createOwnedBlobFileDeleter,
  extractAzureBlobPath,
  extractFirebaseBlobPath,
} from '../storage/ownedBlobDelete';
import {
  resolveStoredUploadTarget,
  withStoredUploadCleanup,
  createStoredUploadDelete,
} from './orphan';
import { createLocalFileDeleter } from '../storage/local';
import { createVectorFileDeleter } from './rag';

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
    expect(deleteFile).toHaveBeenCalledWith(req, {
      ...stored,
      user: 'u1',
      tenantId: 't1',
      embeddingOwnersComplete: true,
      unrecordedUpload: true,
    });
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
    const vector = jest.fn().mockResolvedValue({ deleted: true });
    const code = jest.fn().mockResolvedValue(undefined);
    const file = { ...stored, embedded: true, metadata: { codeEnvRef: { file_id: 'c1' } } };
    await createStoredUploadDelete({
      source: 's3',
      getDeleteFile: strategies({ s3: primary, vectordb: vector, execute_code: code }),
    })(req, file);
    expect(primary).toHaveBeenCalledWith(req, { ...file, embedded: false });
    expect(file.embedded).toBe(true);
    expect(vector).toHaveBeenCalledWith(req, file);
    expect(code).toHaveBeenCalledWith(req, file);
  });

  it.each([undefined, false, { deleted: false }])(
    'rejects unconfirmed orphan vector cleanup: %j',
    async (receipt) => {
      const primary = jest.fn().mockResolvedValue(undefined);
      const vector = jest.fn().mockResolvedValue(receipt);
      const file = { ...stored, embedded: true };
      await expect(
        createStoredUploadDelete({
          source: 's3',
          getDeleteFile: strategies({ s3: primary, vectordb: vector }),
        })(req, file),
      ).rejects.toThrow('Vector deletion was not confirmed');
      expect(primary).toHaveBeenCalledWith(req, { ...file, embedded: false });
    },
  );

  it('keeps a vector-primary rollback embedded and requires its receipt', async () => {
    const vector = jest.fn().mockResolvedValue(undefined);
    const file = { ...stored, source: FileSources.vectordb, embedded: true };
    await expect(
      createStoredUploadDelete({
        source: FileSources.vectordb,
        getDeleteFile: strategies({ vectordb: vector }),
      })(req, file),
    ).rejects.toThrow('Vector deletion was not confirmed');
    expect(vector).toHaveBeenCalledTimes(1);
    expect(vector).toHaveBeenCalledWith(req, file);
  });

  it('does not let a synchronous provider failure prevent vector cleanup', async () => {
    const vector = jest.fn().mockResolvedValue({ deleted: true });
    await expect(
      createStoredUploadDelete({
        source: 's3',
        getDeleteFile: (source) => {
          if (source === 's3') throw new Error('missing primary');
          return vector;
        },
      })(req, { ...stored, embedded: true }),
    ).rejects.toThrow('missing primary');
    expect(vector).toHaveBeenCalledTimes(1);
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
    const vector = jest.fn().mockResolvedValue({ deleted: true });
    await expect(
      createStoredUploadDelete({
        source: 's3',
        getDeleteFile: strategies({ s3: primary, vectordb: vector }),
      })(req, { ...stored, embedded: true }),
    ).rejects.toBe(failure);
    expect(vector).toHaveBeenCalledTimes(1);
  });
});

describe('failed embedded upload rollback', () => {
  const cases = [
    {
      source: FileSources.azure_blob,
      filepath: 'https://account.blob.core.windows.net/files/uploads/u1/file.txt',
      extractPath: (url: string) => extractAzureBlobPath(url, 'files'),
    },
    {
      source: FileSources.firebase,
      filepath: 'https://firebasestorage.googleapis.com/v0/b/bucket/o/uploads%2Fu1%2Ffile.txt',
      extractPath: extractFirebaseBlobPath,
    },
    {
      source: FileSources.local,
      filepath: '/uploads/u1/file.txt',
      extractPath: (url: string) => url,
    },
  ];

  it.each(cases)(
    'removes the $source orphan even when embedding and vector rollback fail',
    async ({ source, filepath, extractPath }) => {
      const root = fs.mkdtempSync(path.join(tmpdir(), 'orphan-vector-'));
      const uploads = path.join(root, 'uploads');
      const bytes = path.join(uploads, 'u1', 'file.txt');
      fs.mkdirSync(path.dirname(bytes), { recursive: true });
      fs.writeFileSync(bytes, 'private contents');
      const req = {
        user: { id: 'u1', tenantId: 'tenant-1' },
        config: { paths: { publicPath: root, uploads } },
      };
      const logger = { error: jest.fn(), warn: jest.fn() };
      const httpClient = {
        delete: jest.fn().mockRejectedValue({ response: { status: 503 } }),
        get: jest.fn(),
      };
      const vectors = createVectorFileDeleter({
        baseUrl: 'https://rag.example',
        httpClient,
        generateToken: () => 'token',
      });
      const deleteRagFile = jest.fn(
        async ({ file }: { file: { filepath: string; embedded?: boolean } }) =>
          file.embedded !== true,
      );
      let blobPresent = true;
      const blob = createOwnedBlobFileDeleter({
        extractPath,
        isMissing: () => false,
        deleteRagFile,
        deleteBlob: async () => {
          blobPresent = false;
        },
      });
      const local = createLocalFileDeleter({ deleteRagFile, logger });
      const remove = createStoredUploadDelete({
        source,
        getDeleteFile: (destination) => {
          if (destination === FileSources.vectordb) return vectors;
          return source === FileSources.local ? local : blob;
        },
      });
      const recordExists = jest.fn().mockResolvedValue(false);
      const failure = new Error('embedding unavailable');
      const file = {
        file_id: 'f1',
        filepath,
        source,
        embedded: true,
        metadata: { embeddedEntities: ['agent-a'] },
      };
      try {
        await expect(
          withStoredUploadCleanup(
            {
              stored: file,
              resolveDeleteFile: () => remove,
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
        if (source === FileSources.local) expect(fs.existsSync(bytes)).toBe(false);
        else expect(blobPresent).toBe(false);
        expect(recordExists).not.toHaveBeenCalled();
        expect(logger.error).toHaveBeenCalledWith(
          '[withStoredUploadCleanup] Failed to delete stored upload',
          { type: 'Error' },
        );
        expect(httpClient.delete).toHaveBeenCalledWith(
          'https://rag.example/documents',
          expect.objectContaining({ params: { entity_id: 'agent-a' }, data: ['f1'] }),
        );
        expect(httpClient.delete).toHaveBeenCalledTimes(2);
        expect(file.embedded).toBe(true);
        expect(file.metadata.embeddedEntities).toEqual(['agent-a']);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
