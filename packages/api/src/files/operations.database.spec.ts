import os from 'node:os';
import path from 'node:path';
import mongoose from 'mongoose';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { FileContext, FileSources } from 'librechat-data-provider';
import { createMethods, createModels } from '@librechat/data-schemas';
import type { CodeFileCommitData, FileProvisionCommit, IMongoFile } from '@librechat/data-schemas';
import type { AxiosInstance } from 'axios';
import { createFileProvisionRecovery, withFileProvisioning, withFileDeletion } from './operations';
import { createVectorFileUploader } from './rag/upload';

let mongo: MongoMemoryServer;
let directory: string;
let uploadPath: string;
let File: mongoose.Model<IMongoFile>;
let methods: ReturnType<typeof createMethods>;
const owner = new mongoose.Types.ObjectId();
const scope = { file_id: 'recovery-file', userId: owner.toString(), tenantId: 'tenant' };
const file = { file_id: scope.file_id, user: owner, tenantId: scope.tenantId };
const ref = {
  kind: 'user' as const,
  id: scope.userId,
  storage_session_id: 'session',
  file_id: 'remote',
};

beforeAll(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'rag-lifecycle-'));
  uploadPath = path.join(directory, 'notes.txt');
  await writeFile(uploadPath, 'notes');
  mongo = await MongoMemoryServer.create({ instance: { args: ['--nounixsocket'] } });
  createModels(mongoose);
  await mongoose.connect(mongo.getUri());
  File = mongoose.models.File as mongoose.Model<IMongoFile>;
  methods = createMethods(mongoose);
}, 30_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
  await rm(directory, { recursive: true, force: true });
});

beforeEach(async () => {
  await File.deleteMany({});
  await File.create({
    ...file,
    filename: 'notes.txt',
    filepath: '/uploads/notes.txt',
    type: 'text/plain',
    bytes: 1,
    source: 'local',
  });
});

it('recovers the original remote result and claim after the database becomes available', async () => {
  const storage = { ...methods, recovery: createFileProvisionRecovery() };
  const commit = jest
    .spyOn(storage, 'commitFileProvision')
    .mockRejectedValueOnce(new Error('database unavailable'))
    .mockRejectedValueOnce(new Error('database unavailable'));
  const upload = jest.fn(async () => ({
    value: ref,
    commit: { code: { routeKey: 'default', ref } },
  }));
  const options = {
    file,
    userId: scope.userId,
    storage,
    destination: 'code:default:notes.txt',
    operation: upload,
  };
  await expect(withFileProvisioning(options)).rejects.toThrow('persistence was not confirmed');
  const pending = await File.findOne({ file_id: file.file_id }).lean();
  const token = pending?.storageOperations?.provisioning?.[0];
  expect(token).toEqual(expect.any(String));

  expect(await withFileProvisioning({ ...options, storage: { ...storage } })).toBe(ref);
  expect(upload).toHaveBeenCalledTimes(1);
  expect(commit).toHaveBeenCalledTimes(3);
  expect(commit).toHaveBeenLastCalledWith(
    expect.objectContaining({ claim: expect.objectContaining({ token }) }),
  );
  const stored = await File.findOne({ file_id: file.file_id }).lean();
  expect(stored?.metadata?.codeEnvRefs?.default).toEqual(ref);
  expect(stored?.storageOperations?.provisioning).toEqual([]);
  expect(
    await methods.acquireFileDeletion({
      ...scope,
      updatedAt: stored?.updatedAt,
      token: 'deletion',
    }),
  ).toEqual({ resumed: false });
});

it('reconciles a lost acquisition acknowledgment without abandoning its applied token', async () => {
  const storage = { ...methods, recovery: createFileProvisionRecovery() };
  const acquire = jest
    .spyOn(storage, 'acquireFileProvision')
    .mockImplementationOnce(async (claim) => {
      await methods.acquireFileProvision(claim);
      throw new Error('acquisition acknowledgment lost');
    });
  const release = jest.spyOn(storage, 'releaseFileProvision');
  const operation = jest.fn(async () => ({
    value: ref,
    commit: { code: { routeKey: 'default', ref } },
  }));
  const options = { file, userId: scope.userId, storage, destination: 'code', operation };
  await expect(withFileProvisioning(options)).rejects.toThrow();
  expect(operation).not.toHaveBeenCalled();
  const original = acquire.mock.calls[0][0];
  expect(
    (await File.findOne({ file_id: file.file_id }).lean())?.storageOperations?.provisioning,
  ).toEqual([original.token]);
  await expect(withFileProvisioning(options)).resolves.toBe(ref);
  expect(operation).toHaveBeenCalledTimes(1);
  expect(release).toHaveBeenCalledWith(original);
  const stored = await File.findOne({ file_id: file.file_id }).lean();
  expect(stored?.storageOperations?.provisioning).toEqual([]);
  expect(
    await methods.acquireFileDeletion({ ...scope, updatedAt: stored?.updatedAt, token: 'delete' }),
  ).toEqual({ resumed: false });
});

it('retries release only after a lost acknowledgment without overwriting a later pointer', async () => {
  const storage = { ...methods, recovery: createFileProvisionRecovery() };
  const release = jest
    .spyOn(storage, 'releaseFileProvision')
    .mockImplementationOnce(async (claim) => {
      await methods.releaseFileProvision(claim);
      throw new Error('release acknowledgment lost');
    });
  const commit = jest.spyOn(storage, 'commitFileProvision');
  const operation = jest.fn(async () => ({
    value: ref,
    commit: { code: { routeKey: 'default', ref } },
  }));
  const options = {
    file,
    userId: scope.userId,
    storage,
    destination: 'code:default:notes.txt',
    operation,
  };
  await expect(withFileProvisioning(options)).rejects.toThrow('persistence was not confirmed');

  const peer = { ...scope, token: 'peer' };
  const replacement: FileProvisionCommit = {
    claim: peer,
    code: { routeKey: 'default', ref: { ...ref, file_id: 'replacement' } },
  };
  expect(await methods.acquireFileProvision(peer)).toBe(true);
  expect(await methods.commitFileProvision(replacement)).toBe(true);
  expect(await methods.releaseFileProvision(peer)).toBe(true);
  expect(await withFileProvisioning(options)).toBe(ref);
  expect(operation).toHaveBeenCalledTimes(1);
  expect(commit).toHaveBeenCalledTimes(1);
  expect(release).toHaveBeenCalledTimes(2);
  const stored = await File.findOne({ file_id: file.file_id }).lean();
  expect(stored?.metadata?.codeEnvRefs?.default?.file_id).toBe('replacement');
  expect(stored?.storageOperations?.provisioning).toEqual([]);
});

it.each([true, false])(
  'recovers a deletion acquisition with lost acknowledgement, applied=%s',
  async (applied) => {
    const storage = { ...methods, recovery: createFileProvisionRecovery() };
    const stored = await File.findOne({ file_id: file.file_id }).lean();
    const snapshot = { ...file, updatedAt: stored?.updatedAt };
    const acquire = jest
      .spyOn(storage, 'acquireFileDeletion')
      .mockImplementationOnce(async (claim) => {
        if (applied) expect(await methods.acquireFileDeletion(claim)).not.toBeNull();
        throw new Error('deletion acquisition acknowledgement lost');
      });
    const release = jest.spyOn(storage, 'releaseFileDeletion');
    const stale = jest.fn();
    const options = { file: snapshot, userId: scope.userId, storage };
    await expect(withFileDeletion({ ...options, operation: stale })).rejects.toThrow(
      'acknowledgement lost',
    );
    const original = acquire.mock.calls[0][0];
    const operation = jest.fn(async (removed: () => void) => {
      removed();
      return ref;
    });
    await expect(withFileDeletion({ ...options, operation })).resolves.toBe(ref);
    expect(stale).not.toHaveBeenCalled();
    expect(operation).toHaveBeenCalledTimes(1);
    expect(release.mock.calls[0][0]).toEqual({ ...original, retainDeletion: true });
    const after = await File.findOne({ file_id: file.file_id }).lean();
    expect(after?.storageOperations?.deleting).toBeUndefined();
    expect(after?.storageOperations?.deletionPending).toBe(true);
    expect(await methods.acquireFileProvision({ ...scope, token: 'upload' })).toBe(false);
  },
);

it('retries only deletion release after its applied acknowledgement is lost', async () => {
  const storage = { ...methods, recovery: createFileProvisionRecovery() };
  const stored = await File.findOne({ file_id: file.file_id }).lean();
  const release = jest
    .spyOn(storage, 'releaseFileDeletion')
    .mockImplementationOnce(async (claim) => {
      expect(await methods.releaseFileDeletion(claim)).toBe(true);
      throw new Error('deletion release acknowledgement lost');
    });
  const operation = jest.fn(async (removed: () => void) => {
    removed();
    return ref;
  });
  const options = {
    file: { ...file, updatedAt: stored?.updatedAt },
    userId: scope.userId,
    storage,
    operation,
  };
  await expect(withFileDeletion(options)).rejects.toThrow('acknowledgement lost');
  const replacement = jest.fn();
  await expect(withFileDeletion({ ...options, operation: replacement })).resolves.toBe(ref);
  expect(operation).toHaveBeenCalledTimes(1);
  expect(replacement).not.toHaveBeenCalled();
  expect(release).toHaveBeenCalledTimes(2);
  expect(release.mock.calls[0][0]).toEqual(release.mock.calls[1][0]);
  const after = await File.findOne({ file_id: file.file_id }).lean();
  expect(after?.storageOperations?.deleting).toBeUndefined();
  expect(after?.storageOperations?.deletionPending).toBe(true);
  expect(await methods.acquireFileProvision({ ...scope, token: 'upload' })).toBe(false);
});

it('never clears a newer deletion token or its pending intent when retrying release', async () => {
  const storage = { ...methods, recovery: createFileProvisionRecovery() };
  const stored = await File.findOne({ file_id: file.file_id }).lean();
  jest.spyOn(storage, 'releaseFileDeletion').mockImplementationOnce(async (claim) => {
    expect(await methods.releaseFileDeletion(claim)).toBe(true);
    throw new Error('acknowledgement lost');
  });
  const options = {
    file: { ...file, updatedAt: stored?.updatedAt },
    userId: scope.userId,
    storage,
  };
  await expect(withFileDeletion({ ...options, operation: async () => ref })).rejects.toThrow();
  const peer = { ...scope, updatedAt: stored?.updatedAt, token: 'foreign' };
  expect(await methods.acquireFileDeletion(peer)).toEqual({ resumed: false });
  const replacement = jest.fn();
  await expect(withFileDeletion({ ...options, operation: replacement })).rejects.toThrow(
    'could not be released',
  );
  expect(replacement).not.toHaveBeenCalled();
  const after = await File.findOne({ file_id: file.file_id }).lean();
  expect(after?.storageOperations?.deleting).toBe('foreign');
  expect(after?.storageOperations?.deletionPending).toBe(true);
});

it('keeps regenerated output writes fenced until their complete record is committed', async () => {
  const storage = { ...methods, recovery: createFileProvisionRecovery() };
  const output: CodeFileCommitData = {
    file_id: file.file_id,
    user: scope.userId,
    tenantId: scope.tenantId,
    filename: 'notes.txt',
    filepath: '/uploads/notes.txt',
    type: 'text/plain',
    bytes: 8,
    object: 'file',
    usage: 2,
    source: FileSources.local,
    context: FileContext.execute_code,
    conversationId: 'conversation',
    metadata: { codeEnvRefs: { default: ref } },
  };
  const saved = await withFileProvisioning({
    file,
    userId: scope.userId,
    storage,
    destination: 'generated-output',
    operation: async () => {
      const before = await File.findOne({ file_id: file.file_id }).lean();
      expect(
        await methods.acquireFileDeletion({
          ...scope,
          updatedAt: before?.updatedAt,
          token: 'blocked',
        }),
      ).toBeNull();
      return { value: output, commit: { output: { file: output } } };
    },
  });
  expect(saved).toBe(output);
  const row = await File.findOne({ file_id: file.file_id }).lean();
  expect(row?.usage).toBe(2);
  expect(row?.metadata?.codeEnvRefs?.default).toEqual(ref);
  expect(row?.storageOperations?.provisioning).toEqual([]);
  expect(
    await methods.acquireFileDeletion({ ...scope, updatedAt: row?.updatedAt, token: 'next' }),
  ).toEqual({ resumed: false });
});

it('does not overwrite fresh output bytes while deletion intent remains after primary removal', async () => {
  const storage = { ...methods, recovery: createFileProvisionRecovery() };
  const row = await File.findOne({ file_id: file.file_id }).lean();
  expect(
    await methods.acquireFileDeletion({ ...scope, updatedAt: row?.updatedAt, token: 'delete' }),
  ).toEqual({ resumed: false });
  expect(
    await methods.releaseFileDeletion({ ...scope, token: 'delete', retainDeletion: true }),
  ).toBe(true);
  const writePrimary = jest.fn();
  await expect(
    withFileProvisioning({
      file,
      userId: scope.userId,
      storage,
      destination: 'generated-output',
      operation: writePrimary,
    }),
  ).rejects.toThrow('conflicts');
  expect(writePrimary).not.toHaveBeenCalled();
  expect(
    (await File.findOne({ file_id: file.file_id }).lean())?.storageOperations?.deletionPending,
  ).toBe(true);
});

const refusalReceipt = {
  status: false,
  file_id: file.file_id,
  known_type: true,
  error: { code: 'RAG_EMBEDDING_REFUSED', side_effects: 'none' },
};

function ragProvision(data: unknown) {
  const storage = { ...methods, recovery: createFileProvisionRecovery() };
  const post = jest.fn().mockResolvedValue({ status: 200, data });
  const upload = createVectorFileUploader({
    baseUrl: 'http://rag.test',
    httpClient: { post } as Pick<AxiosInstance, 'post'>,
    generateToken: () => 'test-token',
  });
  const options = {
    file,
    userId: scope.userId,
    storage,
    destination: 'search:user',
    operation: async (_claim: FileProvisionCommit['claim'], onUploadStart: () => void) => ({
      value: await upload({
        req: { user: { id: scope.userId } },
        file: { path: uploadPath, originalname: 'notes.txt', size: 5 },
        file_id: file.file_id,
        onUploadStart,
      }),
      commit: { embedded: true, entityId: scope.userId },
    }),
  };
  return { options, storage, post };
}

it('releases a confirmed RAG refusal and allows a fresh successful retry', async () => {
  const { options, post } = ragProvision(refusalReceipt);
  await expect(withFileProvisioning(options)).rejects.toMatchObject({
    code: 'RAG_EMBEDDING_REFUSED',
  });
  const refused = await File.findOne({ file_id: file.file_id }).lean();
  expect(refused?.storageOperations?.provisioning).toEqual([]);
  expect(refused?.embedded).not.toBe(true);
  expect(refused?.metadata?.embeddedEntities).toBeUndefined();

  post.mockResolvedValueOnce({
    status: 200,
    data: { status: true, known_type: true, file_id: file.file_id },
  });
  await expect(withFileProvisioning(options)).resolves.toMatchObject({ embedded: true });
  expect(post).toHaveBeenCalledTimes(2);
  const stored = await File.findOne({ file_id: file.file_id }).lean();
  expect(stored?.storageOperations?.provisioning).toEqual([]);
  expect(stored?.embedded).toBe(true);
  expect(stored?.metadata?.embeddedEntities).toContain(scope.userId);
});

it('allows owner-scoped deletion after refusal without publishing remote pointers', async () => {
  const { options, storage } = ragProvision(refusalReceipt);
  await expect(withFileProvisioning(options)).rejects.toMatchObject({
    code: 'RAG_EMBEDDING_REFUSED',
  });
  const stored = await File.findOne({ file_id: file.file_id }).lean();
  expect(
    await methods.acquireFileDeletion({
      ...scope,
      userId: new mongoose.Types.ObjectId().toString(),
      token: 'foreign',
      updatedAt: stored?.updatedAt,
    }),
  ).toBeNull();
  expect(
    await methods.acquireFileDeletion({
      ...scope,
      tenantId: 'other',
      token: 'foreign',
      updatedAt: stored?.updatedAt,
    }),
  ).toBeNull();
  const remove = jest.fn(async () => 'deleted');
  await expect(
    withFileDeletion({
      file: { ...file, updatedAt: stored?.updatedAt },
      userId: scope.userId,
      storage,
      operation: remove,
    }),
  ).resolves.toBe('deleted');
  expect(remove).toHaveBeenCalledTimes(1);
});

it.each([{ status: false, known_type: true }, { status: true, known_type: false }, {}, null])(
  'retains the RAG claim and blocks retry and deletion for uncertain response %j',
  async (data) => {
    const { options, storage, post } = ragProvision(data);
    await expect(withFileProvisioning(options)).rejects.toThrow('outcome is unknown');
    const pending = await File.findOne({ file_id: file.file_id }).lean();
    expect(pending?.storageOperations?.provisioning).toHaveLength(1);
    await expect(withFileProvisioning(options)).rejects.toThrow('outcome is unknown');
    const remove = jest.fn();
    await expect(
      withFileDeletion({ file, userId: scope.userId, storage, operation: remove }),
    ).rejects.toThrow('outcome is unknown');
    // A restarted process cannot take over the durable claim either.
    expect(
      await methods.acquireFileDeletion({
        ...scope,
        token: 'restart',
        updatedAt: pending?.updatedAt,
      }),
    ).toBeNull();
    expect(remove).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledTimes(1);
    expect(
      (await File.findOne({ file_id: file.file_id }).lean())?.storageOperations?.provisioning,
    ).toEqual(pending?.storageOperations?.provisioning);
  },
);

it('never clears another provisioning request or its committed namespace on refusal', async () => {
  const { options } = ragProvision(refusalReceipt);
  const peer = { ...scope, token: 'other-request' };
  expect(await methods.acquireFileProvision(peer)).toBe(true);
  expect(
    await methods.commitFileProvision({ claim: peer, embedded: true, entityId: 'agent-peer' }),
  ).toBe(true);
  await expect(withFileProvisioning(options)).rejects.toMatchObject({
    code: 'RAG_EMBEDDING_REFUSED',
  });
  const stored = await File.findOne({ file_id: file.file_id }).lean();
  expect(stored?.storageOperations?.provisioning).toEqual([peer.token]);
  expect(stored?.metadata?.embeddedEntities).toEqual(['agent-peer']);
  expect(stored?.embedded).toBe(true);
  expect(
    await methods.acquireFileDeletion({ ...scope, token: 'blocked', updatedAt: stored?.updatedAt }),
  ).toBeNull();
  expect(await methods.releaseFileProvision(peer)).toBe(true);
  expect(
    await methods.acquireFileDeletion({ ...scope, token: 'delete', updatedAt: stored?.updatedAt }),
  ).toEqual({ resumed: false });
});

it('blocks deletion while refusal is in flight and releases only after its receipt', async () => {
  const { options, post } = ragProvision(refusalReceipt);
  let respond!: (value: { status: number; data: unknown }) => void;
  let dispatched!: () => void;
  const started = new Promise<void>((resolve) => {
    dispatched = resolve;
  });
  post.mockImplementationOnce(() => {
    dispatched();
    return new Promise((resolve) => {
      respond = resolve;
    });
  });
  const attempt = withFileProvisioning(options);
  const rejected = attempt.catch((error: unknown) => error);
  await started;
  const pending = await File.findOne({ file_id: file.file_id }).lean();
  expect(
    await methods.acquireFileDeletion({
      ...scope,
      token: 'blocked',
      updatedAt: pending?.updatedAt,
    }),
  ).toBeNull();
  respond({ status: 200, data: refusalReceipt });
  await expect(rejected).resolves.toMatchObject({ code: 'RAG_EMBEDDING_REFUSED' });
  const stored = await File.findOne({ file_id: file.file_id }).lean();
  expect(
    await methods.acquireFileDeletion({ ...scope, token: 'delete', updatedAt: stored?.updatedAt }),
  ).toEqual({ resumed: false });
});

it('recovers only its refused claim when release acknowledgement is lost', async () => {
  const { options, storage } = ragProvision(refusalReceipt);
  const release = jest
    .spyOn(storage, 'releaseFileProvision')
    .mockRejectedValueOnce(new Error('database unavailable'));
  await expect(withFileProvisioning(options)).rejects.toMatchObject({
    code: 'RAG_EMBEDDING_REFUSED',
  });
  const pending = await File.findOne({ file_id: file.file_id }).lean();
  expect(pending?.storageOperations?.provisioning).toHaveLength(1);
  await storage.recovery.recover(scope, storage);
  expect(release).toHaveBeenCalledTimes(2);
  expect(release.mock.calls[0][0]).toEqual(release.mock.calls[1][0]);
  expect(
    (await File.findOne({ file_id: file.file_id }).lean())?.storageOperations?.provisioning,
  ).toEqual([]);
});

it.each(['ETIMEDOUT', 'ECONNRESET', 'ERR_CANCELED'])(
  'keeps the durable claim on RAG transport uncertainty: %s',
  async (code) => {
    const { options, storage, post } = ragProvision(refusalReceipt);
    post.mockRejectedValueOnce(Object.assign(new Error('private upstream payload'), { code }));
    await expect(withFileProvisioning(options)).rejects.toThrow('outcome is unknown');
    const stored = await File.findOne({ file_id: file.file_id }).lean();
    expect(stored?.storageOperations?.provisioning).toHaveLength(1);
    await expect(storage.recovery.recover(scope, storage)).rejects.toThrow('outcome is unknown');
    expect(
      await methods.acquireFileDeletion({
        ...scope,
        token: 'delete',
        updatedAt: stored?.updatedAt,
      }),
    ).toBeNull();
    expect(post).toHaveBeenCalledTimes(1);
  },
);
