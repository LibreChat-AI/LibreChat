import path from 'node:path';
import { tmpdir } from 'node:os';
import { FileSources } from 'librechat-data-provider';
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import type { FileStorageDeletionObserver } from './dispatch';
import { createDeleteFileWithSecondaryStorage, isMissingStorageError } from './storage';
import { createFileProvisionRecovery } from './operations';
import { dispatchFileDeletion } from './dispatch';
import { createVectorFileDeleter } from './rag';

const req: {
  user: { id: string; tenantId: string };
  config: { fileConfig: { retainedFileCleanup?: boolean; vectorOwnershipTrackingStart?: string } };
} = {
  user: { id: 'owner', tenantId: 'tenant-a' },
  config: {
    fileConfig: {
      retainedFileCleanup: true,
      vectorOwnershipTrackingStart: '2026-10-19T00:00:00.000Z',
    },
  },
};
const client = { provider: 'openai' };
const file = {
  file_id: 'attachment',
  user: 'owner',
  tenantId: 'tenant-a',
  embedded: true,
  embeddingOwnersComplete: true,
  embeddingOwnersTrackedAt: '2026-10-20T00:00:00.000Z',
  metadata: { codeEnvRef: { file_id: 'code-copy' } },
};

function setup(source: string = FileSources.local) {
  const primary = jest
    .fn()
    .mockImplementation(
      async (
        _req: typeof req,
        _file: typeof file,
        _client?: typeof client,
        onDelete?: FileStorageDeletionObserver,
      ) => dispatchFileDeletion(onDelete, async () => ({ deleted: true })),
    );
  const vectors = jest.fn().mockResolvedValue({ deleted: true });
  const code = jest.fn().mockResolvedValue({ deleted: true });
  const getDeleteFile = jest.fn((secondary: string) =>
    secondary === FileSources.vectordb ? vectors : code,
  );
  const logger = { warn: jest.fn() };
  const clearFileEmbeddings = jest.fn().mockResolvedValue(true);
  const isFileStorageClean = jest.fn().mockResolvedValue(true);
  const fileStorage = {
    recovery: createFileProvisionRecovery(),
    acquireFileProvision: jest.fn().mockResolvedValue(true),
    releaseFileProvision: jest.fn().mockResolvedValue(true),
    commitFileProvision: jest.fn().mockResolvedValue(true),
    acquireFileDeletion: jest.fn().mockResolvedValue({ resumed: false }),
    releaseFileDeletion: jest.fn().mockResolvedValue(true),
  };
  const remove = createDeleteFileWithSecondaryStorage<typeof req, typeof file, typeof client>({
    source,
    deleteFile: primary,
    getDeleteFile,
    clearFileEmbeddings,
    isFileStorageClean,
    fileStorage,
    logger,
  });
  return {
    primary,
    vectors,
    code,
    getDeleteFile,
    clearFileEmbeddings,
    isFileStorageClean,
    fileStorage,
    logger,
    remove,
  };
}

describe('createDeleteFileWithSecondaryStorage', () => {
  beforeEach(() => {
    file.embedded = true;
    file.metadata = { codeEnvRef: { file_id: 'code-copy' } };
  });
  it.each([FileSources.local, FileSources.vectordb])(
    'retains the embedding snapshot and primary on unverified vector 404 (%s)',
    async (source) => {
      const { primary, vectors, remove, clearFileEmbeddings } = setup(source);
      const httpClient = {
        delete: jest.fn().mockRejectedValue({ response: { status: 404 } }),
        get: jest.fn().mockRejectedValue({ response: { status: 404 } }),
      };
      const deleteVectors = createVectorFileDeleter({
        baseUrl: 'https://rag.example',
        ownershipTrackingStart: req.config.fileConfig.vectorOwnershipTrackingStart,
        httpClient,
        generateToken: () => 'token',
      });
      (source === FileSources.vectordb ? primary : vectors).mockImplementation(deleteVectors);
      const retained = { ...file, metadata: { ...file.metadata, embeddedEntities: ['agent-a'] } };
      await expect(remove(req, retained)).rejects.toThrow('Vector deletion was not confirmed');
      expect(clearFileEmbeddings).not.toHaveBeenCalled();
      expect(retained.embedded).toBe(true);
      expect(retained.metadata.embeddedEntities).toEqual(['agent-a']);
      if (source === FileSources.local) expect(primary).not.toHaveBeenCalled();
    },
  );

  it.each([FileSources.local, FileSources.vectordb])(
    'retains a partially adopted legacy file and its unknown agent-b vectors (%s)',
    async (source) => {
      const { primary, vectors, remove, clearFileEmbeddings, isFileStorageClean } = setup(source);
      const copies = new Set(['agent-a', 'agent-b']);
      const httpClient = {
        delete: jest.fn().mockImplementation(async () => {
          copies.delete('agent-a');
          return { status: 200 };
        }),
        get: jest.fn().mockResolvedValue({ data: [] }),
      };
      const deleteVectors = createVectorFileDeleter({
        baseUrl: 'https://rag.example',
        ownershipTrackingStart: req.config.fileConfig.vectorOwnershipTrackingStart,
        httpClient,
        generateToken: () => 'token',
      });
      (source === FileSources.vectordb ? primary : vectors).mockImplementation(deleteVectors);
      const legacy = {
        ...file,
        embeddingOwnersComplete: false,
        metadata: { ...file.metadata, embeddedEntities: ['agent-a'] },
      };
      await expect(remove(req, legacy)).rejects.toThrow('Complete vector ownership');
      expect([...copies]).toEqual(['agent-a', 'agent-b']);
      expect(httpClient.delete).not.toHaveBeenCalled();
      expect(clearFileEmbeddings).not.toHaveBeenCalled();
      if (source === FileSources.local) {
        expect(isFileStorageClean).not.toHaveBeenCalled();
        expect(primary).not.toHaveBeenCalled();
      }
      expect(legacy.metadata.embeddedEntities).toEqual(['agent-a']);
      expect(legacy.embedded).toBe(true);
    },
  );

  it.each([FileSources.local, FileSources.vectordb])(
    'keeps the primary and metadata when an old writer damages overlap-era ownership (%s)',
    async (source) => {
      const { primary, vectors, remove, clearFileEmbeddings } = setup(source);
      const httpClient = { delete: jest.fn(), get: jest.fn() };
      const erase = createVectorFileDeleter({
        baseUrl: 'https://rag.example',
        httpClient,
        generateToken: () => 'token',
        ownershipTrackingStart: req.config.fileConfig.vectorOwnershipTrackingStart,
      });
      (source === FileSources.vectordb ? primary : vectors).mockImplementation(erase);
      const damaged = {
        ...file,
        embeddingOwnersTrackedAt: '2026-10-18T00:00:00.000Z',
        metadata: { ...file.metadata, embeddedEntities: ['agent-a'] },
      };
      await expect(remove(req, damaged)).rejects.toThrow('safe writer rollout');
      expect(httpClient.delete).not.toHaveBeenCalled();
      expect(clearFileEmbeddings).not.toHaveBeenCalled();
      if (source === FileSources.local) expect(primary).not.toHaveBeenCalled();
      expect(damaged.embedded).toBe(true);
      expect(damaged.metadata.embeddedEntities).toEqual(['agent-a']);
    },
  );

  it('waits for both secondaries before deleting the primary with its provider client', async () => {
    const { primary, vectors, code, remove } = setup(FileSources.openai);
    let finishCode: () => void = () => {};
    const pendingCode = new Promise<{ deleted: true }>((resolve) => {
      finishCode = () => resolve({ deleted: true });
    });
    code.mockReturnValue(pendingCode);

    const deletion = remove(req, file, client);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(vectors).toHaveBeenCalledWith(req, file);
    expect(code).toHaveBeenCalledWith(req, file);
    expect(primary).not.toHaveBeenCalled();
    finishCode();
    await deletion;

    expect(primary).toHaveBeenCalledTimes(1);
    expect(primary).toHaveBeenCalledWith(req, file, client);
    expect(file.user).toBe('owner');
    expect(file.tenantId).toBe('tenant-a');
  });

  it.each([FileSources.openai, FileSources.azure])(
    'deletes an authorized provider-only assistant file from %s without a local row',
    async (source) => {
      const { primary, isFileStorageClean, getDeleteFile, clearFileEmbeddings, logger } =
        setup(source);
      const remove = createDeleteFileWithSecondaryStorage({
        source,
        deleteFile: primary,
        getDeleteFile,
        clearFileEmbeddings,
        isFileStorageClean,
        fileStorage: {
          recovery: createFileProvisionRecovery(),
          acquireFileProvision: jest.fn().mockResolvedValue(true),
          releaseFileProvision: jest.fn().mockResolvedValue(true),
          commitFileProvision: jest.fn().mockResolvedValue(true),
          acquireFileDeletion: jest.fn().mockResolvedValue({ resumed: false }),
          releaseFileDeletion: jest.fn().mockResolvedValue(true),
        },
        logger,
      });
      isFileStorageClean.mockImplementation(
        async (snapshot) => snapshot.allowMissingFileRecord === true,
      );
      const providerFile = { file_id: 'provider-only', embedded: false };
      await remove({ ...req, body: { assistant_id: 'assistant' } }, providerFile, client);
      expect(isFileStorageClean).toHaveBeenCalledWith(
        expect.objectContaining({
          file_id: providerFile.file_id,
          userId: req.user.id,
          tenantId: req.user.tenantId,
          allowMissingFileRecord: true,
        }),
      );
      expect(primary).toHaveBeenCalledWith(expect.anything(), providerFile, client);
    },
  );

  it.each([FileSources.local, FileSources.openai, FileSources.azure])(
    'does not treat a persisted %s file as provider-only',
    async (source) => {
      const { primary, isFileStorageClean, remove } = setup(source);
      isFileStorageClean.mockResolvedValue(false);
      const assistantRequest = { ...req, body: { assistant_id: 'assistant' } };
      await expect(remove(assistantRequest, file, client)).rejects.toThrow(
        'File storage cleanup was not confirmed',
      );
      expect(isFileStorageClean).toHaveBeenCalledWith(
        expect.not.objectContaining({ allowMissingFileRecord: true }),
      );
      expect(primary).not.toHaveBeenCalled();
    },
  );

  it.each(['replacement', 'failure'])(
    'retains primary bytes when final code-only cleanup has a %s',
    async (mode) => {
      const { primary, code, isFileStorageClean, remove } = setup();
      file.embedded = false;
      if (mode === 'replacement') isFileStorageClean.mockResolvedValue(false);
      else isFileStorageClean.mockRejectedValue(new Error('resource not found'));
      await expect(remove(req, file)).rejects.toThrow('File storage cleanup was not confirmed');
      expect(code).toHaveBeenCalledTimes(1);
      expect(primary).not.toHaveBeenCalled();
    },
  );

  it.each([401, 403, 500])('keeps primary bytes on HTTP %s', async (status) => {
    const { primary, code, remove } = setup();
    const dir = await mkdtemp(path.join(tmpdir(), 'file-delete-'));
    const primaryPath = path.join(dir, 'attachment.png');
    try {
      await writeFile(primaryPath, 'readable attachment');
      primary.mockImplementation(() => unlink(primaryPath));
      const error = Object.assign(new Error('secondary unavailable'), { response: { status } });
      code.mockRejectedValue(error);

      await expect(remove(req, file)).rejects.toBe(error);
      expect(primary).not.toHaveBeenCalled();
      expect(await readFile(primaryPath, 'utf8')).toBe('readable attachment');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('retries partial secondary cleanup without skipping the primary', async () => {
    const { primary, vectors, code, remove } = setup();
    const failure = new Error('code unavailable');
    const absent = Object.assign(new Error('already removed'), {
      code: 'ERR_BAD_REQUEST',
      response: { status: 404 },
    });
    vectors.mockResolvedValueOnce({ deleted: true }).mockRejectedValueOnce(absent);
    code.mockRejectedValueOnce(failure).mockResolvedValueOnce({ deleted: true });

    await expect(remove(req, file)).rejects.toBe(failure);
    expect(primary).not.toHaveBeenCalled();
    await expect(remove(req, file)).resolves.toBeUndefined();
    expect(vectors).toHaveBeenCalledTimes(1);
    expect(code).toHaveBeenCalledTimes(2);
    expect(primary).toHaveBeenCalledTimes(1);
  });

  it('does not let a missing secondary hide a failure in another secondary', async () => {
    const { primary, vectors, code, remove } = setup();
    vectors.mockRejectedValue(Object.assign(new Error('missing'), { status: 404 }));
    const failure = new Error('permission denied');
    code.mockRejectedValue(failure);

    await expect(remove(req, file)).rejects.toBe(failure);
    expect(primary).not.toHaveBeenCalled();
  });

  it('settles every secondary before returning a failure', async () => {
    const { primary, vectors, code, remove } = setup();
    const failure = new Error('vector unavailable');
    vectors.mockRejectedValue(failure);
    let finishCode: () => void = () => {};
    const pendingCode = new Promise<{ deleted: true }>((resolve) => {
      finishCode = () => resolve({ deleted: true });
    });
    code.mockReturnValue(pendingCode);
    let settled = false;
    const deletion = remove(req, file).catch((error) => {
      settled = true;
      return error;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(primary).not.toHaveBeenCalled();
    finishCode();
    expect(await deletion).toBe(failure);
  });

  it('retries after primary failure even when both secondaries have already gone', async () => {
    const { primary, vectors, code, remove } = setup();
    const failure = new Error('primary permission denied');
    primary.mockRejectedValueOnce(failure).mockResolvedValueOnce(undefined);
    const absent = Object.assign(new Error('absent'), { code: 'NotFound' });
    vectors.mockResolvedValueOnce({ deleted: true }).mockRejectedValueOnce(absent);
    code.mockResolvedValueOnce({ deleted: true }).mockRejectedValueOnce(absent);

    await expect(remove(req, file)).rejects.toBe(failure);
    await expect(remove(req, file)).resolves.toBeUndefined();
    expect(primary).toHaveBeenCalledTimes(2);
  });

  describe.each([FileSources.s3, FileSources.cloudfront, FileSources.azure_blob])(
    '%s mutation boundary',
    (source) => {
      it('releases deletion intent after preflight fails following secondary cleanup', async () => {
        const { primary, vectors, code, fileStorage, remove } = setup(source);
        const failure = Object.assign(new Error('preflight timed out'), { code: 'ETIMEDOUT' });
        primary.mockRejectedValue(failure);
        await expect(remove(req, file, client)).rejects.toBe(failure);
        expect(vectors).toHaveBeenCalledTimes(1);
        expect(code).toHaveBeenCalledTimes(1);
        expect(file.embedded).toBe(false);
        expect(primary).toHaveBeenCalledWith(req, file, client, expect.any(Function));
        expect(fileStorage.releaseFileDeletion).toHaveBeenCalledWith(
          expect.objectContaining({ retainDeletion: false }),
        );
      });

      it('does not clear deletion intent inherited from an earlier attempt on preflight failure', async () => {
        const { primary, fileStorage, remove } = setup(source);
        fileStorage.acquireFileDeletion.mockResolvedValue({ resumed: true });
        primary.mockRejectedValue(new Error('preflight timed out'));
        await expect(remove(req, file)).rejects.toThrow('preflight timed out');
        expect(fileStorage.releaseFileDeletion).toHaveBeenCalledWith(
          expect.objectContaining({ retainDeletion: true }),
        );
      });

      it('retains deletion intent when the dispatched delete loses its response', async () => {
        const { primary, fileStorage, remove } = setup(source);
        primary.mockImplementation((_req, _file, _client, onDelete) =>
          dispatchFileDeletion(onDelete, async () => {
            throw Object.assign(new Error('delete response lost'), { code: 'ETIMEDOUT' });
          }),
        );
        await expect(remove(req, file)).rejects.toThrow('delete response lost');
        expect(fileStorage.releaseFileDeletion).toHaveBeenCalledWith(
          expect.objectContaining({ retainDeletion: true }),
        );
      });

      it('reopens repair after the actual delete is definitively rejected', async () => {
        const { primary, fileStorage, remove } = setup(source);
        primary.mockImplementation((_req, _file, _client, onDelete) =>
          dispatchFileDeletion(onDelete, async () => {
            throw Object.assign(new Error('delete denied'), { statusCode: 403 });
          }),
        );
        await expect(remove(req, file)).rejects.toThrow('delete denied');
        expect(fileStorage.releaseFileDeletion).toHaveBeenCalledWith(
          expect.objectContaining({ retainDeletion: false }),
        );
      });

      it('retains deletion intent after a confirmed delete followed by RAG rejection', async () => {
        const { primary, fileStorage, remove } = setup(source);
        primary.mockImplementation(async (_req, _file, _client, onDelete) => {
          await dispatchFileDeletion(onDelete, async () => undefined);
          throw Object.assign(new Error('RAG denied'), { statusCode: 403 });
        });
        await expect(remove(req, file)).rejects.toThrow('RAG denied');
        expect(fileStorage.releaseFileDeletion).toHaveBeenCalledWith(
          expect.objectContaining({ retainDeletion: true }),
        );
      });
    },
  );

  it('retains deletion intent when primary dispatch loses its response', async () => {
    const { primary, fileStorage, remove } = setup();
    primary.mockRejectedValue(Object.assign(new Error('response lost'), { code: 'ETIMEDOUT' }));
    await expect(remove(req, file)).rejects.toThrow('response lost');
    expect(fileStorage.releaseFileDeletion).toHaveBeenCalledWith(
      expect.objectContaining({ retainDeletion: true }),
    );
  });

  it.each([
    { response: { status: 403 } },
    { $metadata: { httpStatusCode: 403 } },
    { statusCode: 403 },
    { status: 403 },
  ])('reopens repair after a definitive primary access rejection: %j', async (denial) => {
    const { primary, fileStorage, remove } = setup();
    primary.mockRejectedValue(Object.assign(new Error('access denied'), denial));
    await expect(remove(req, file)).rejects.toThrow('access denied');
    expect(fileStorage.releaseFileDeletion).toHaveBeenCalledWith(
      expect.objectContaining({ retainDeletion: false }),
    );
  });

  it('retains uncertainty from a second secondary instead of forgiving it as the first denial', async () => {
    const { vectors, code, primary, fileStorage, remove } = setup();
    vectors.mockRejectedValue(
      Object.assign(new Error('vector denied'), { response: { status: 403 } }),
    );
    code.mockRejectedValue(Object.assign(new Error('code response lost'), { code: 'ETIMEDOUT' }));
    await expect(remove(req, file)).rejects.toThrow('vector denied');
    expect(primary).not.toHaveBeenCalled();
    expect(fileStorage.releaseFileDeletion).toHaveBeenCalledWith(
      expect.objectContaining({ retainDeletion: true }),
    );
  });

  it('logs only safe metadata for an already-removed secondary', async () => {
    const { vectors, logger, remove } = setup();
    vectors.mockRejectedValue(
      Object.assign(new Error('private provider message'), {
        response: { status: 404, data: 'private provider payload' },
      }),
    );
    await remove(req, file);
    expect(logger.warn).toHaveBeenCalledWith('File storage was already missing during delete', {
      type: 'Error',
      status: 404,
    });
  });

  it('accepts an absent primary only after the secondaries are cleaned up', async () => {
    const { primary, vectors, code, remove } = setup();
    primary.mockRejectedValue(Object.assign(new Error('absent'), { code: 'ENOENT' }));

    await expect(remove(req, file)).resolves.toBeUndefined();
    expect(vectors).toHaveBeenCalledTimes(1);
    expect(code).toHaveBeenCalledTimes(1);
  });

  it.each([FileSources.vectordb, FileSources.execute_code])(
    'does not delete the primary %s source twice',
    async (source) => {
      const { primary, getDeleteFile, remove } = setup(source);
      await remove(req, file, client);
      expect(getDeleteFile).not.toHaveBeenCalledWith(source);
      expect(getDeleteFile).toHaveBeenCalledTimes(1);
      expect(primary).toHaveBeenCalledTimes(1);
    },
  );

  it.each([false, true])(
    'reconciles confirmed primary-vector cleanup before returning (already absent: %s)',
    async (absent) => {
      const { primary, clearFileEmbeddings, remove } = setup(FileSources.vectordb);
      const retained = { ...file, metadata: { ...file.metadata, embeddedEntities: ['namespace'] } };
      if (absent)
        primary.mockRejectedValue(Object.assign(new Error('already gone'), { status: 404 }));
      await remove(req, retained, client);
      expect(primary).toHaveBeenCalledTimes(1);
      expect(clearFileEmbeddings).toHaveBeenCalledTimes(1);
      expect(clearFileEmbeddings).toHaveBeenCalledWith({
        file_id: retained.file_id,
        userId: retained.user,
        tenantId: retained.tenantId,
        updatedAt: undefined,
        embeddedEntities: ['namespace'],
        ownershipTrackingStart: req.config.fileConfig.vectorOwnershipTrackingStart,
      });
      expect(primary.mock.invocationCallOrder[0]).toBeLessThan(
        clearFileEmbeddings.mock.invocationCallOrder[0],
      );
      expect(retained.embedded).toBe(false);
      expect(retained.metadata).toEqual(expect.objectContaining({ searchDestination: true }));
      expect(retained.metadata.embeddedEntities).toBeUndefined();
    },
  );

  it.each(['conflict', 'failure'])(
    'reports incomplete primary-vector cleanup after reconciliation %s',
    async (mode) => {
      const { primary, clearFileEmbeddings, remove } = setup(FileSources.vectordb);
      if (mode === 'conflict') clearFileEmbeddings.mockResolvedValue(false);
      else clearFileEmbeddings.mockRejectedValue(new Error('resource not found'));
      await expect(remove(req, file, client)).rejects.toThrow(
        'File embedding reconciliation failed',
      );
      expect(primary).toHaveBeenCalledTimes(1);
      expect(file.embedded).toBe(true);
    },
  );

  it('uses the codeEnvRefs map without changing the owner or provider references', async () => {
    const { primary, code } = setup();
    const mapped = {
      ...file,
      embedded: false,
      metadata: { codeEnvRefs: { stateful: { file_id: 'stateful-copy' } } },
    };
    const deleteMapped = createDeleteFileWithSecondaryStorage({
      source: FileSources.local,
      deleteFile: primary,
      getDeleteFile: () => code,
      clearFileEmbeddings: jest.fn().mockResolvedValue(true),
      isFileStorageClean: jest.fn().mockResolvedValue(true),
      fileStorage: {
        recovery: createFileProvisionRecovery(),
        acquireFileProvision: jest.fn().mockResolvedValue(true),
        releaseFileProvision: jest.fn().mockResolvedValue(true),
        commitFileProvision: jest.fn().mockResolvedValue(true),
        acquireFileDeletion: jest.fn().mockResolvedValue({ resumed: false }),
        releaseFileDeletion: jest.fn().mockResolvedValue(true),
      },
      logger: { warn: jest.fn() },
    });
    await deleteMapped(req, mapped);
    expect(code).toHaveBeenCalledWith(req, mapped);
    expect(mapped.metadata.codeEnvRefs.stateful.file_id).toBe('stateful-copy');
    expect(mapped.user).toBe('owner');
    expect(mapped.tenantId).toBe('tenant-a');
  });

  it.each(['primary', 'code'])('clears vectors on %s failure', async (failing) => {
    const { primary, vectors, code, clearFileEmbeddings, remove } = setup();
    const retained = {
      ...file,
      metadata: { ...file.metadata, embeddedEntities: ['agent-a', 'agent-b'], keep: true },
    };
    vectors.mockResolvedValue({ deleted: true });
    const failure = new Error('provider down');
    (failing === 'primary' ? primary : code).mockRejectedValue(failure);

    await expect(remove(req, retained)).rejects.toBe(failure);
    expect(clearFileEmbeddings).toHaveBeenCalledWith({
      file_id: 'attachment',
      userId: 'owner',
      tenantId: 'tenant-a',
      updatedAt: undefined,
      embeddedEntities: ['agent-a', 'agent-b'],
      ownershipTrackingStart: req.config.fileConfig.vectorOwnershipTrackingStart,
    });
    expect(retained.embedded).toBe(false);
    expect(retained.metadata).toEqual({
      codeEnvRef: file.metadata.codeEnvRef,
      keep: true,
      searchDestination: true,
    });
    if (failing === 'code') expect(primary).not.toHaveBeenCalled();
  });

  it('fails closed on skipped vector requests before primary deletion', async () => {
    const { primary, vectors, clearFileEmbeddings, remove } = setup();
    vectors.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('rag down'));
    await expect(remove(req, file)).rejects.toThrow('Vector deletion was not confirmed');
    await expect(remove(req, file)).rejects.toThrow('rag down');
    expect(primary).not.toHaveBeenCalled();
    expect(clearFileEmbeddings).not.toHaveBeenCalled();
    expect(file.embedded).toBe(true);
  });

  it.each([undefined, false])(
    'stages embedded cleanup before reader rollout (%s)',
    async (enabled) => {
      const { primary, vectors, code, remove } = setup();
      const staged = { ...req, config: { fileConfig: { retainedFileCleanup: enabled } } };
      await expect(remove(staged, file)).rejects.toThrow('requires upgraded readers');
      expect(primary).not.toHaveBeenCalled();
      expect(vectors).not.toHaveBeenCalled();
      expect(code).not.toHaveBeenCalled();
      expect(file.embedded).toBe(true);
    },
  );

  it('stages code-reference invalidation before marker-aware readers are deployed', async () => {
    const { primary, code, vectors, remove } = setup();
    const codeOnly = { ...file, embedded: false };
    await expect(remove({ ...req, config: { fileConfig: {} } }, codeOnly)).rejects.toThrow(
      'requires upgraded readers',
    );
    expect(primary).not.toHaveBeenCalled();
    expect(code).not.toHaveBeenCalled();
    expect(vectors).not.toHaveBeenCalled();
  });

  it('retains primary when code cleanup was skipped', async () => {
    const { primary, code, remove } = setup();
    code.mockResolvedValue(undefined);
    await expect(remove(req, file)).rejects.toThrow('Code storage deletion was not confirmed');
    expect(primary).not.toHaveBeenCalled();
  });

  it('keeps every retry reference when both secondaries fail', async () => {
    const { primary, vectors, code, clearFileEmbeddings, remove } = setup();
    vectors.mockRejectedValue(new Error('rag down'));
    code.mockRejectedValue(new Error('code down'));
    await expect(remove(req, file)).rejects.toThrow('rag down');
    expect(clearFileEmbeddings).not.toHaveBeenCalled();
    expect(primary).not.toHaveBeenCalled();
    expect(file.metadata.codeEnvRef.file_id).toBe('code-copy');
  });

  it.each(['outage', 'conflict'])('retains primary on reconciliation %s', async (failure) => {
    const { primary, vectors, clearFileEmbeddings, remove } = setup();
    vectors.mockResolvedValue({ deleted: true });
    if (failure === 'outage') {
      clearFileEmbeddings.mockRejectedValue(new Error('resource not found'));
    } else {
      clearFileEmbeddings.mockResolvedValue(false);
    }
    await expect(remove(req, file)).rejects.toThrow('File embedding reconciliation failed');
    expect(primary).not.toHaveBeenCalled();
    expect(file.embedded).toBe(true);
    expect(file.metadata.codeEnvRef.file_id).toBe('code-copy');
  });

  it('retries primary deletion without probing an empty reconciled code map', async () => {
    const { primary, getDeleteFile } = setup();
    const remove = createDeleteFileWithSecondaryStorage({
      source: FileSources.local,
      deleteFile: primary,
      getDeleteFile,
      clearFileEmbeddings: jest.fn().mockResolvedValue(true),
      isFileStorageClean: jest.fn().mockResolvedValue(true),
      fileStorage: {
        recovery: createFileProvisionRecovery(),
        acquireFileProvision: jest.fn().mockResolvedValue(true),
        releaseFileProvision: jest.fn().mockResolvedValue(true),
        commitFileProvision: jest.fn().mockResolvedValue(true),
        acquireFileDeletion: jest.fn().mockResolvedValue({ resumed: false }),
        releaseFileDeletion: jest.fn().mockResolvedValue(true),
      },
      logger: { warn: jest.fn() },
    });
    await remove(req, {
      ...file,
      embedded: false,
      metadata: { codeEnvRefs: {}, codeDestination: true },
    });
    expect(primary).toHaveBeenCalledTimes(1);
    expect(getDeleteFile).not.toHaveBeenCalled();
  });

  it('only deletes primary storage for a file without secondary references', async () => {
    const { primary, getDeleteFile } = setup();
    const remove = createDeleteFileWithSecondaryStorage({
      source: FileSources.local,
      deleteFile: primary,
      getDeleteFile,
      clearFileEmbeddings: jest.fn().mockResolvedValue(true),
      isFileStorageClean: jest.fn().mockResolvedValue(true),
      fileStorage: {
        recovery: createFileProvisionRecovery(),
        acquireFileProvision: jest.fn().mockResolvedValue(true),
        releaseFileProvision: jest.fn().mockResolvedValue(true),
        commitFileProvision: jest.fn().mockResolvedValue(true),
        acquireFileDeletion: jest.fn().mockResolvedValue({ resumed: false }),
        releaseFileDeletion: jest.fn().mockResolvedValue(true),
      },
      logger: { warn: jest.fn() },
    });
    await remove(req, {});
    expect(getDeleteFile).not.toHaveBeenCalled();
    expect(primary).toHaveBeenCalledWith(req, {}, undefined);
  });
});

describe('isMissingStorageError', () => {
  it.each([
    { code: 'ENOENT' },
    { code: 'NoSuchKey' },
    { code: 'NotFound' },
    { code: 'ResourceNotFound' },
    { status: 404 },
    { statusCode: '404' },
    { code: 'ERR_BAD_REQUEST', response: { status: 404 } },
    new Error('blob does not exist'),
  ])('recognizes an absent object: %j', (error) => {
    expect(isMissingStorageError(error)).toBe(true);
  });

  it.each([
    null,
    undefined,
    { response: { status: 401 } },
    { response: { status: 403 } },
    { response: { status: 500 } },
    { code: 'ETIMEDOUT' },
    { code: 'EACCES' },
    new Error('Configuration not found'),
  ])('does not forgive operational failures: %j', (error) => {
    expect(isMissingStorageError(error)).toBe(false);
  });
});
