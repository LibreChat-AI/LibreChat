import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { FileContext, FileSources } from 'librechat-data-provider';
import { createMethods, createModels } from '@librechat/data-schemas';
import type { CodeFileCommitData, FileProvisionCommit, IMongoFile } from '@librechat/data-schemas';
import { createFileProvisionRecovery, withFileProvisioning, withFileDeletion } from './operations';

let mongo: MongoMemoryServer;
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
  mongo = await MongoMemoryServer.create();
  createModels(mongoose);
  await mongoose.connect(mongo.getUri());
  File = mongoose.models.File as mongoose.Model<IMongoFile>;
  methods = createMethods(mongoose);
}, 30_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
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
