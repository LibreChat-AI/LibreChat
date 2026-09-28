import mongoose from 'mongoose';
import { v4 as uuidv4 } from 'uuid';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { EToolResources, FileContext } from 'librechat-data-provider';
import { _resetStrictCache } from '~/models/plugins/tenantIsolation';
import { runAsSystem } from '~/config/tenantContext';
import { createFileMethods } from './file';
import { createModels } from '~/models';

let File: mongoose.Model<unknown>;
let fileMethods: ReturnType<typeof createFileMethods>;
let mongoServer: MongoMemoryServer;
let modelsToCleanup: string[] = [];

describe('File Methods', () => {
  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    const mongoUri = mongoServer.getUri();
    await mongoose.connect(mongoUri);

    const models = createModels(mongoose);
    modelsToCleanup = Object.keys(models);
    Object.assign(mongoose.models, models);

    File = mongoose.models.File as mongoose.Model<unknown>;
    fileMethods = createFileMethods(mongoose);
  });

  afterAll(async () => {
    const collections = mongoose.connection.collections;
    for (const key in collections) {
      await collections[key].deleteMany({});
    }

    for (const modelName of modelsToCleanup) {
      if (mongoose.models[modelName]) {
        delete mongoose.models[modelName];
      }
    }

    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    await File.deleteMany({});
  });

  describe('createFile', () => {
    it('should create a new file with TTL', async () => {
      const fileId = uuidv4();
      const userId = new mongoose.Types.ObjectId();

      const file = await fileMethods.createFile({
        file_id: fileId,
        user: userId,
        filename: 'test.txt',
        filepath: '/uploads/test.txt',
        type: 'text/plain',
        bytes: 100,
      });

      expect(file).not.toBeNull();
      expect(file?.file_id).toBe(fileId);
      expect(file?.filename).toBe('test.txt');
      expect(file?.expiresAt).toBeDefined();
    });

    it('should create a file without TTL when disableTTL is true', async () => {
      const fileId = uuidv4();
      const userId = new mongoose.Types.ObjectId();

      const file = await fileMethods.createFile(
        {
          file_id: fileId,
          user: userId,
          filename: 'permanent.txt',
          filepath: '/uploads/permanent.txt',
          type: 'text/plain',
          bytes: 200,
        },
        true,
      );

      expect(file).not.toBeNull();
      expect(file?.file_id).toBe(fileId);
      expect(file?.expiresAt).toBeUndefined();
    });

    it('persists independent Code API pointers for both execution profiles', async () => {
      const defaultRef = {
        kind: 'user' as const,
        id: 'user-1',
        storage_session_id: 'default-session',
        file_id: 'default-file',
        executionProfile: 'default' as const,
      };
      const statefulRef = {
        ...defaultRef,
        storage_session_id: 'stateful-session',
        file_id: 'stateful-file',
        executionProfile: 'stateful' as const,
      };

      const file = await fileMethods.createFile({
        file_id: uuidv4(),
        user: new mongoose.Types.ObjectId(),
        filename: 'dual-profile.txt',
        filepath: '/uploads/dual-profile.txt',
        type: 'text/plain',
        bytes: 10,
        metadata: {
          codeEnvRef: defaultRef,
          codeEnvRefs: { default: defaultRef, stateful: statefulRef },
        },
      });

      expect(file?.metadata?.codeEnvRefs?.default?.file_id).toBe('default-file');
      expect(file?.metadata?.codeEnvRefs?.stateful?.file_id).toBe('stateful-file');
    });
  });

  describe('claimCodeFile', () => {
    it('claims code output files independently per tenant', async () => {
      const userId = new mongoose.Types.ObjectId().toString();

      const tenantA = await fileMethods.claimCodeFile({
        filename: 'report.csv',
        conversationId: 'conversation-1',
        file_id: 'file-tenant-a',
        user: userId,
        tenantId: 'tenant-a',
      });
      const tenantB = await fileMethods.claimCodeFile({
        filename: 'report.csv',
        conversationId: 'conversation-1',
        file_id: 'file-tenant-b',
        user: userId,
        tenantId: 'tenant-b',
      });
      const tenantAAgain = await fileMethods.claimCodeFile({
        filename: 'report.csv',
        conversationId: 'conversation-1',
        file_id: 'file-tenant-a-new',
        user: userId,
        tenantId: 'tenant-a',
      });

      expect(tenantA.file_id).toBe('file-tenant-a');
      expect(tenantA.tenantId).toBe('tenant-a');
      expect(tenantB.file_id).toBe('file-tenant-b');
      expect(tenantB.tenantId).toBe('tenant-b');
      expect(tenantAAgain.file_id).toBe('file-tenant-a');
    });

    it('does not bump updatedAt on re-claim (id reservation, not a content write)', async () => {
      const userId = new mongoose.Types.ObjectId().toString();
      const File = mongoose.models.File;

      await fileMethods.claimCodeFile({
        filename: 'stable.csv',
        conversationId: 'conversation-ts',
        file_id: 'stable-file',
        user: userId,
      });
      const written = new Date('2024-01-01T00:00:00.000Z');
      await File.updateOne(
        { file_id: 'stable-file' },
        { $set: { updatedAt: written } },
        { timestamps: false },
      );

      /** The background harvest's out-of-order guard compares `updatedAt`
       *  against the harvest start; a claim bumping it would make every
       *  existing filename look freshly written and misfire the guard. */
      const reclaimed = await fileMethods.claimCodeFile({
        filename: 'stable.csv',
        conversationId: 'conversation-ts',
        file_id: 'stable-file-second',
        user: userId,
      });
      expect(reclaimed.file_id).toBe('stable-file');
      expect(new Date(reclaimed.updatedAt as unknown as string).getTime()).toBe(written.getTime());
    });

    it('stamps sourceDispatchedAt on claim INSERT only (existing claims untouched)', async () => {
      const userId = new mongoose.Types.ObjectId().toString();

      const inserted = await fileMethods.claimCodeFile({
        filename: 'stamped.csv',
        conversationId: 'conversation-stamp',
        file_id: 'stamped-file',
        user: userId,
        sourceDispatchedAt: 111,
      });
      expect(
        (inserted.metadata as { sourceDispatchedAt?: number } | undefined)?.sourceDispatchedAt,
      ).toBe(111);

      /** A later claimant's stamp must not overwrite the owner's. */
      const reclaimed = await fileMethods.claimCodeFile({
        filename: 'stamped.csv',
        conversationId: 'conversation-stamp',
        file_id: 'stamped-file-second',
        user: userId,
        sourceDispatchedAt: 222,
      });
      expect(reclaimed.file_id).toBe('stamped-file');
      expect(
        (reclaimed.metadata as { sourceDispatchedAt?: number } | undefined)?.sourceDispatchedAt,
      ).toBe(111);
    });

    it('keeps non-tenant code output claims in the legacy namespace', async () => {
      const userId = new mongoose.Types.ObjectId().toString();

      const legacy = await fileMethods.claimCodeFile({
        filename: 'legacy.csv',
        conversationId: 'conversation-1',
        file_id: 'legacy-file',
        user: userId,
      });
      const tenant = await fileMethods.claimCodeFile({
        filename: 'legacy.csv',
        conversationId: 'conversation-1',
        file_id: 'tenant-file',
        user: userId,
        tenantId: 'tenant-a',
      });

      expect(legacy.file_id).toBe('legacy-file');
      expect(legacy.tenantId).toBeNull();
      expect(tenant.file_id).toBe('tenant-file');
      expect(tenant.tenantId).toBe('tenant-a');
    });

    it('treats null tenantId as the legacy code output namespace', async () => {
      const userId = new mongoose.Types.ObjectId().toString();

      const legacy = await fileMethods.claimCodeFile({
        filename: 'nullable-legacy.csv',
        conversationId: 'conversation-1',
        file_id: 'legacy-null-file',
        user: userId,
        tenantId: null,
      });
      const legacyAgain = await fileMethods.claimCodeFile({
        filename: 'nullable-legacy.csv',
        conversationId: 'conversation-1',
        file_id: 'legacy-null-file-new',
        user: userId,
      });

      expect(legacy.file_id).toBe('legacy-null-file');
      expect(legacyAgain.file_id).toBe('legacy-null-file');
    });
  });

  describe('findFileById', () => {
    it('should find a file by file_id', async () => {
      const fileId = uuidv4();
      const userId = new mongoose.Types.ObjectId();

      await fileMethods.createFile({
        file_id: fileId,
        user: userId,
        filename: 'find-me.txt',
        filepath: '/uploads/find-me.txt',
        type: 'text/plain',
        bytes: 150,
      });

      const found = await fileMethods.findFileById(fileId);
      expect(found).not.toBeNull();
      expect(found?.file_id).toBe(fileId);
      expect(found?.filename).toBe('find-me.txt');
    });

    it('should return null for non-existent file', async () => {
      const found = await fileMethods.findFileById('non-existent');
      expect(found).toBeNull();
    });
  });

  describe('getFiles', () => {
    it('should retrieve multiple files matching filter', async () => {
      const userId = new mongoose.Types.ObjectId();
      const fileIds = [uuidv4(), uuidv4(), uuidv4()];

      for (const fileId of fileIds) {
        await fileMethods.createFile({
          file_id: fileId,
          user: userId,
          filename: `file-${fileId}.txt`,
          filepath: `/uploads/${fileId}.txt`,
          type: 'text/plain',
          bytes: 100,
        });
      }

      const files = await fileMethods.getFiles({ user: userId });
      expect(files).toHaveLength(3);
      expect(files!.map((f) => f.file_id)).toEqual(expect.arrayContaining(fileIds));
    });

    it('should exclude text field by default', async () => {
      const fileId = uuidv4();
      const userId = new mongoose.Types.ObjectId();

      await fileMethods.createFile({
        file_id: fileId,
        user: userId,
        filename: 'with-text.txt',
        filepath: '/uploads/with-text.txt',
        type: 'text/plain',
        bytes: 100,
        text: 'Some content here',
      });

      const files = await fileMethods.getFiles({ file_id: fileId });
      expect(files).toHaveLength(1);
      expect(files![0].text).toBeUndefined();
    });
  });

  describe('getExpiredFiles', () => {
    it('returns only files whose expiredAt date has passed', async () => {
      const userId = new mongoose.Types.ObjectId();
      const now = new Date('2030-01-01T00:00:00.000Z');
      const expiredFileId = uuidv4();
      const futureFileId = uuidv4();
      const permanentFileId = uuidv4();
      const missingExpiryFileId = uuidv4();

      await fileMethods.createFile(
        {
          file_id: expiredFileId,
          user: userId,
          filename: 'expired.txt',
          filepath: '/uploads/expired.txt',
          type: 'text/plain',
          bytes: 100,
          expiredAt: new Date('2029-12-31T23:59:59.000Z'),
        },
        true,
      );
      await fileMethods.createFile(
        {
          file_id: futureFileId,
          user: userId,
          filename: 'future.txt',
          filepath: '/uploads/future.txt',
          type: 'text/plain',
          bytes: 100,
          expiredAt: new Date('2030-01-01T00:00:01.000Z'),
        },
        true,
      );
      await fileMethods.createFile(
        {
          file_id: permanentFileId,
          user: userId,
          filename: 'permanent.txt',
          filepath: '/uploads/permanent.txt',
          type: 'text/plain',
          bytes: 100,
          expiredAt: null,
        },
        true,
      );
      await fileMethods.createFile(
        {
          file_id: missingExpiryFileId,
          user: userId,
          filename: 'missing-expiry.txt',
          filepath: '/uploads/missing-expiry.txt',
          type: 'text/plain',
          bytes: 100,
        },
        true,
      );

      const files = await fileMethods.getExpiredFiles(100, { now });

      expect(files.map((file) => file.file_id)).toEqual([expiredFileId]);
    });

    /** Seeds a sweep-eligible file, then drives its retry state through the
     *  same methods the sweep itself uses. */
    const seedExpiredFile = async ({
      file_id,
      expiredAt,
      attempts = 0,
      retryAt,
    }: {
      file_id: string;
      expiredAt: Date;
      attempts?: number;
      retryAt?: Date;
    }) => {
      await fileMethods.createFile(
        {
          file_id,
          user: new mongoose.Types.ObjectId(),
          filename: `${file_id}.txt`,
          filepath: `/uploads/${file_id}.txt`,
          type: 'text/plain',
          bytes: 100,
          expiredAt,
        },
        true,
      );
      for (let i = 0; i < attempts; i++) {
        await fileMethods.incrementFileDeletionAttempts(file_id);
      }
      if (retryAt) {
        await fileMethods.deferExpiredFile(file_id, retryAt);
      }
    };

    it('holds back files whose deletion backoff has not elapsed', async () => {
      const now = new Date('2030-01-01T00:00:00.000Z');
      const readyFileId = uuidv4();
      const backedOffFileId = uuidv4();

      await seedExpiredFile({
        file_id: backedOffFileId,
        expiredAt: new Date('2029-12-01T00:00:00.000Z'),
        attempts: 2,
        retryAt: new Date('2030-01-01T00:00:01.000Z'),
      });
      await seedExpiredFile({
        file_id: readyFileId,
        expiredAt: new Date('2029-12-31T00:00:00.000Z'),
        attempts: 2,
        retryAt: new Date('2029-12-31T23:00:00.000Z'),
      });

      const files = await fileMethods.getExpiredFiles(100, { now });

      expect(files.map((file) => file.file_id)).toEqual([readyFileId]);
    });

    it('holds a parked file back without excluding it for good', async () => {
      const parkedFileId = uuidv4();
      const retriableFileId = uuidv4();

      /* The parked file expired first, so with nothing holding it back it
       * sorts to the front of every batch and a limit-sized run of them
       * starves everything that expired afterwards. */
      await seedExpiredFile({
        file_id: parkedFileId,
        expiredAt: new Date('2029-01-01T00:00:00.000Z'),
        attempts: 10,
        retryAt: new Date('2030-02-01T00:00:00.000Z'),
      });
      await seedExpiredFile({
        file_id: retriableFileId,
        expiredAt: new Date('2029-12-31T00:00:00.000Z'),
        attempts: 9,
      });

      const parked = await fileMethods.getExpiredFiles(100, {
        now: new Date('2030-01-01T00:00:00.000Z'),
      });
      expect(parked.map((file) => file.file_id)).toEqual([retriableFileId]);

      /* Nothing is excluded permanently — a record reused for different
       * content in the meantime gets its object swept rather than stranded. */
      const afterPark = await fileMethods.getExpiredFiles(100, {
        now: new Date('2030-02-01T00:00:01.000Z'),
      });
      expect(afterPark.map((file) => file.file_id)).toEqual([parkedFileId, retriableFileId]);
    });

    it('leaves retry state alone on writes that touch the record', async () => {
      const fileId = uuidv4();
      await seedExpiredFile({
        file_id: fileId,
        expiredAt: new Date('2029-01-01T00:00:00.000Z'),
        attempts: 4,
        retryAt: new Date('2030-02-01T00:00:00.000Z'),
      });

      /* `prepareImagesLocal` clears the upload TTL with nothing but the id
       * on every reuse of an image, the deferred preview only transitions
       * `status`, and `processCodeOutput` repurposes a row for new content.
       * None of them need to reason about sweep bookkeeping: the deferral
       * is a deadline, so the worst a survivor can do is delay. */
      await fileMethods.updateFile({ file_id: fileId });
      await fileMethods.updateFile({ file_id: fileId, status: 'ready' });

      const [file] = (await fileMethods.getFiles({ file_id: fileId }))!;
      expect(file.deletionAttempts).toBe(4);
      expect(file.deletionRetryAt).toEqual(new Date('2030-02-01T00:00:00.000Z'));
    });

    it('records retry bookkeeping without posing as a content write', async () => {
      const fileId = uuidv4();
      await seedExpiredFile({ file_id: fileId, expiredAt: new Date('2029-01-01T00:00:00.000Z') });
      const [before] = (await fileMethods.getFiles({ file_id: fileId }))!;

      /* `processCodeOutput` falls back to `updatedAt` as the writer-order
       * stamp for records predating `metadata.sourceDispatchedAt`. A sweep
       * that bumped it would look like a newer content writer and a
       * background harvest would drop its attachment. */
      await fileMethods.incrementFileDeletionAttempts(fileId);
      await fileMethods.deferExpiredFile(fileId, new Date('2030-06-01T00:00:00.000Z'));

      const [after] = (await fileMethods.getFiles({ file_id: fileId }))!;
      expect(after.deletionAttempts).toBe(1);
      expect(after.updatedAt).toEqual(before.updatedAt);
    });
  });

  describe('deferExpiredFile', () => {
    const createDeferrableFile = async (file_id: string) => {
      await fileMethods.createFile(
        {
          file_id,
          user: new mongoose.Types.ObjectId(),
          filename: 'deferred.txt',
          filepath: '/uploads/deferred.txt',
          type: 'text/plain',
          bytes: 100,
          expiredAt: new Date('2029-12-31T00:00:00.000Z'),
        },
        true,
      );
    };

    it('stamps the next retry and counts the attempt', async () => {
      const fileId = uuidv4();
      const retryAt = new Date('2030-02-01T00:00:00.000Z');
      await createDeferrableFile(fileId);

      expect(await fileMethods.incrementFileDeletionAttempts(fileId)).toBe(1);
      await fileMethods.deferExpiredFile(fileId, retryAt);

      const [file] = (await fileMethods.getFiles({ file_id: fileId }))!;
      expect(file.deletionAttempts).toBe(1);
      expect(file.deletionRetryAt).toEqual(retryAt);
    });

    it('hands concurrent sweeps distinct attempt numbers', async () => {
      const fileId = uuidv4();
      await createDeferrableFile(fileId);

      /* Two nodes recording a failure for the same file in the same pass.
       * Deriving the attempt from the queried snapshot would give both the
       * same number and neither would see the cap being reached. */
      const attempts = await Promise.all([
        fileMethods.incrementFileDeletionAttempts(fileId),
        fileMethods.incrementFileDeletionAttempts(fileId),
        fileMethods.incrementFileDeletionAttempts(fileId),
      ]);

      expect([...attempts].sort()).toEqual([1, 2, 3]);
    });

    it('never pulls a deferral earlier than one already committed', async () => {
      const fileId = uuidv4();
      const later = new Date('2030-02-01T00:00:00.000Z');
      const earlier = new Date('2030-01-01T00:00:00.000Z');
      await createDeferrableFile(fileId);

      await fileMethods.deferExpiredFile(fileId, later);
      await fileMethods.deferExpiredFile(fileId, earlier);

      const [file] = (await fileMethods.getFiles({ file_id: fileId }))!;
      expect(file.deletionRetryAt).toEqual(later);
    });
  });

  describe('getToolFilesByIds', () => {
    it('should retrieve files for file_search tool (embedded files)', async () => {
      const userId = new mongoose.Types.ObjectId();
      const embeddedFileId = uuidv4();
      const regularFileId = uuidv4();

      await fileMethods.createFile({
        file_id: embeddedFileId,
        user: userId,
        filename: 'embedded.txt',
        filepath: '/uploads/embedded.txt',
        type: 'text/plain',
        bytes: 100,
        embedded: true,
      });

      await fileMethods.createFile({
        file_id: regularFileId,
        user: userId,
        filename: 'regular.txt',
        filepath: '/uploads/regular.txt',
        type: 'text/plain',
        bytes: 100,
      });

      const toolSet = new Set([EToolResources.file_search]);
      const files = await fileMethods.getToolFilesByIds([embeddedFileId, regularFileId], toolSet);

      expect(files).toHaveLength(1);
      expect(files[0].file_id).toBe(embeddedFileId);
    });

    it('should retrieve files for context tool', async () => {
      const userId = new mongoose.Types.ObjectId();
      const contextFileId = uuidv4();

      await fileMethods.createFile({
        file_id: contextFileId,
        user: userId,
        filename: 'context.txt',
        filepath: '/uploads/context.txt',
        type: 'text/plain',
        bytes: 100,
        text: 'Context content',
        context: FileContext.agents,
      });

      const toolSet = new Set([EToolResources.context]);
      const files = await fileMethods.getToolFilesByIds([contextFileId], toolSet);

      expect(files).toHaveLength(1);
      expect(files[0].file_id).toBe(contextFileId);
    });

    it('should not retrieve execute_code files (handled by getCodeGeneratedFiles)', async () => {
      const userId = new mongoose.Types.ObjectId();
      const codeFileId = uuidv4();

      await fileMethods.createFile({
        file_id: codeFileId,
        user: userId,
        filename: 'code.py',
        filepath: '/uploads/code.py',
        type: 'text/x-python',
        bytes: 100,
        context: FileContext.execute_code,
        metadata: {
          codeEnvRef: {
            kind: 'user',
            id: userId.toString(),
            storage_session_id: 'session-x',
            file_id: codeFileId,
          },
        },
      });

      // execute_code files are explicitly excluded from getToolFilesByIds
      // They are retrieved via getCodeGeneratedFiles and getUserCodeFiles instead
      const toolSet = new Set([EToolResources.execute_code]);
      const files = await fileMethods.getToolFilesByIds([codeFileId], toolSet);

      expect(files).toHaveLength(0);
    });

    it('owner-scopes historical tool file lookups', async () => {
      const ownerId = new mongoose.Types.ObjectId();
      const victimId = new mongoose.Types.ObjectId();
      const ownerFileId = uuidv4();
      const victimFileId = uuidv4();

      await runAsSystem(() =>
        fileMethods.createFile({
          file_id: ownerFileId,
          user: ownerId,
          tenantId: 'tenant-a',
          filename: 'owner-embedded.txt',
          filepath: '/uploads/owner-embedded.txt',
          type: 'text/plain',
          bytes: 100,
          embedded: true,
        }),
      );
      await runAsSystem(() =>
        fileMethods.createFile({
          file_id: victimFileId,
          user: victimId,
          tenantId: 'tenant-a',
          filename: 'victim-embedded.txt',
          filepath: '/uploads/victim-embedded.txt',
          type: 'text/plain',
          bytes: 100,
          embedded: true,
        }),
      );

      const toolSet = new Set([EToolResources.file_search]);
      const files = await fileMethods.getToolFilesByIds([ownerFileId, victimFileId], toolSet, {
        userId: ownerId.toString(),
        tenantId: 'tenant-a',
      });

      expect(files).toHaveLength(1);
      expect(files[0].file_id).toBe(ownerFileId);
    });
  });

  describe('getCodeGeneratedFiles', () => {
    /* The function filters by `file_id IN threadFileIds` — the file_ids
     * referenced by messages in the current conversation thread —
     * rather than by `messageId IN threadMessageIds`. The change
     * matters when a code-output file is shared across sibling branches
     * (regenerations); the File record's own `messageId` points at
     * whichever sibling FIRST created it (preserved deliberately by
     * processCodeOutput for provenance), but `threadFileIds` reaches
     * any sibling that references the file via `messages.files[]`. */

    it('finds a code-output file referenced by the current thread', async () => {
      const userId = new mongoose.Types.ObjectId();
      const conversationId = uuidv4();
      const fileId = uuidv4();

      await fileMethods.createFile({
        file_id: fileId,
        user: userId,
        conversationId,
        messageId: 'msg-original-creator',
        filename: 'output.csv',
        filepath: '/uploads/output.csv',
        type: 'text/csv',
        bytes: 100,
        context: FileContext.execute_code,
        metadata: {
          codeEnvRef: {
            kind: 'user',
            id: userId.toString(),
            storage_session_id: 'sess',
            file_id: fileId,
          },
        },
      });

      const files = await fileMethods.getCodeGeneratedFiles(conversationId, [fileId]);
      expect(files).toHaveLength(1);
      expect(files[0].file_id).toBe(fileId);
    });

    it('reaches a file whose creator messageId is on a sibling branch (regression)', async () => {
      /* Branched-conversation case: sibling A creates the file (its
       * messageId is preserved on the File record), sibling N
       * recreates the same filename — claimCodeFile finds the existing
       * record and the messageId stays at A. The current thread (parent
       * = N) doesn't include A. Filtering by threadFileIds (which
       * includes the file_id N's message references) reaches it. */
      const userId = new mongoose.Types.ObjectId();
      const conversationId = uuidv4();
      const fileId = uuidv4();

      await fileMethods.createFile({
        file_id: fileId,
        user: userId,
        conversationId,
        /* The file's messageId points at sibling A — NOT in the
         * current thread [siblingN, root]. The old `messageId IN`
         * filter would have excluded the file here. */
        messageId: 'siblingA',
        filename: 'output.csv',
        filepath: '/uploads/output.csv',
        type: 'text/csv',
        bytes: 100,
        context: FileContext.execute_code,
        metadata: {
          codeEnvRef: {
            kind: 'user',
            id: userId.toString(),
            storage_session_id: 'sess',
            file_id: fileId,
          },
        },
      });

      const files = await fileMethods.getCodeGeneratedFiles(conversationId, [fileId]);
      expect(files).toHaveLength(1);
      expect(files[0].file_id).toBe(fileId);
    });

    it('returns empty when threadFileIds is missing or empty', async () => {
      const conversationId = uuidv4();
      expect(await fileMethods.getCodeGeneratedFiles(conversationId)).toEqual([]);
      expect(await fileMethods.getCodeGeneratedFiles(conversationId, [])).toEqual([]);
    });

    it('does not cross conversation boundaries even with matching file_id', async () => {
      const userId = new mongoose.Types.ObjectId();
      const fileId = uuidv4();

      await fileMethods.createFile({
        file_id: fileId,
        user: userId,
        conversationId: 'other-conv',
        messageId: 'msg-creator',
        filename: 'output.csv',
        filepath: '/uploads/output.csv',
        type: 'text/csv',
        bytes: 100,
        context: FileContext.execute_code,
        metadata: {
          codeEnvRef: {
            kind: 'user',
            id: userId.toString(),
            storage_session_id: 'sess',
            file_id: fileId,
          },
        },
      });

      const files = await fileMethods.getCodeGeneratedFiles('this-conv', [fileId]);
      expect(files).toEqual([]);
    });

    it('excludes non-execute_code files even when file_id matches', async () => {
      /* `tool_resources.execute_code.file_ids` is the source of
       * threadFileIds, but `messages.files[]` includes files of
       * every context. The `context: execute_code` filter prevents
       * a user-uploaded chat file from being mistakenly fetched via
       * this function (it'd go through getUserCodeFiles instead). */
      const userId = new mongoose.Types.ObjectId();
      const conversationId = uuidv4();
      const fileId = uuidv4();

      await fileMethods.createFile({
        file_id: fileId,
        user: userId,
        conversationId,
        messageId: 'msg-1',
        filename: 'note.txt',
        filepath: '/uploads/note.txt',
        type: 'text/plain',
        bytes: 100,
        context: FileContext.message_attachment,
        metadata: {
          codeEnvRef: {
            kind: 'user',
            id: userId.toString(),
            storage_session_id: 'sess',
            file_id: fileId,
          },
        },
      });

      const files = await fileMethods.getCodeGeneratedFiles(conversationId, [fileId]);
      expect(files).toEqual([]);
    });

    it('owner-scopes code-generated file lookups', async () => {
      const ownerId = new mongoose.Types.ObjectId();
      const victimId = new mongoose.Types.ObjectId();
      const conversationId = uuidv4();
      const ownerFileId = uuidv4();
      const victimFileId = uuidv4();

      for (const [fileId, userId, filename] of [
        [ownerFileId, ownerId, 'owner-output.csv'],
        [victimFileId, victimId, 'victim-output.csv'],
      ] as const) {
        await runAsSystem(() =>
          fileMethods.createFile({
            file_id: fileId,
            user: userId,
            tenantId: 'tenant-a',
            conversationId,
            messageId: `msg-${fileId}`,
            filename,
            filepath: `/uploads/${filename}`,
            type: 'text/csv',
            bytes: 100,
            context: FileContext.execute_code,
            metadata: {
              codeEnvRef: {
                kind: 'user',
                id: userId.toString(),
                storage_session_id: `sess-${fileId}`,
                file_id: fileId,
              },
            },
          }),
        );
      }

      const files = await fileMethods.getCodeGeneratedFiles(
        conversationId,
        [ownerFileId, victimFileId],
        { userId: ownerId.toString(), tenantId: 'tenant-a' },
      );

      expect(files).toHaveLength(1);
      expect(files[0].file_id).toBe(ownerFileId);
    });
  });

  describe('getDeferredProvisionFiles', () => {
    it('rejects route keys that cannot be used as MongoDB field segments', async () => {
      const ownerScope = { userId: new mongoose.Types.ObjectId().toString() };

      await expect(
        fileMethods.getDeferredProvisionFiles([uuidv4()], ownerScope, {
          code: true,
          codeRouteKey: 'stateful.invalid',
        }),
      ).rejects.toThrow('Invalid code environment route key');
    });

    const makeFile = (
      fileId: string,
      ownerId: mongoose.Types.ObjectId,
      overrides: Record<string, unknown> = {},
    ) =>
      runAsSystem(() =>
        fileMethods.createFile({
          file_id: fileId,
          user: ownerId,
          tenantId: 'tenant-a',
          conversationId: 'conversation-a',
          filename: `${fileId}.csv`,
          filepath: `/uploads/${fileId}.csv`,
          source: 'local',
          type: 'text/csv',
          bytes: 100,
          context: FileContext.message_attachment,
          ...overrides,
        }),
      );

    it('returns attachments that carry neither an embedding nor a code reference', async () => {
      const ownerId = new mongoose.Types.ObjectId();
      const deferredId = uuidv4();
      await makeFile(deferredId, ownerId);

      const results = await fileMethods.getDeferredProvisionFiles([deferredId], {
        userId: ownerId.toString(),
        tenantId: 'tenant-a',
      });

      expect(results.map((file) => file.file_id)).toEqual([deferredId]);
    });

    it('returns an agent file embedded only in another agent namespace', async () => {
      /* Its vectors are under the other agent's entity, so the namespace this turn
       * searches has none of them. The record-wide flag cannot say that, and skipping
       * hydration here means nothing downstream ever notices. */
      const ownerId = new mongoose.Types.ObjectId();
      const foreignId = uuidv4();
      await makeFile(foreignId, ownerId, {
        context: FileContext.agents,
        embedded: true,
        metadata: { embeddedEntities: ['other-agent'] },
      });

      const results = await fileMethods.getDeferredProvisionFiles(
        [foreignId],
        { userId: ownerId.toString(), tenantId: 'tenant-a' },
        {
          search: true,
          searchNamespaces: ['this-agent', ownerId.toString()],
        },
      );

      expect(results.map((file) => file.file_id)).toEqual([foreignId]);
    });

    it('leaves an agent file embedded in every candidate namespace alone', async () => {
      const ownerId = new mongoose.Types.ObjectId();
      const settledId = uuidv4();
      await makeFile(settledId, ownerId, {
        context: FileContext.agents,
        embedded: true,
        metadata: { embeddedEntities: ['this-agent', ownerId.toString()] },
      });

      const results = await fileMethods.getDeferredProvisionFiles(
        [settledId],
        { userId: ownerId.toString(), tenantId: 'tenant-a' },
        {
          search: true,
          searchNamespaces: ['this-agent', ownerId.toString()],
        },
      );

      expect(results).toEqual([]);
    });

    it('returns a default-route reference so liveness can screen it', async () => {
      /* A usable reference is not a live one. With resendFiles off this is the only query
       * that runs, so excluding it leaves an expired session unnoticed and the code tool
       * running without the file. */
      const ownerId = new mongoose.Types.ObjectId();
      const refId = uuidv4();
      await makeFile(refId, ownerId, {
        metadata: {
          codeEnvRef: { kind: 'user', id: 'u1', storage_session_id: 's1', file_id: 'r1' },
          codeEnvRefs: {
            default: { kind: 'user', id: 'u1', storage_session_id: 's1', file_id: 'r1' },
          },
        },
      });

      const results = await fileMethods.getDeferredProvisionFiles(
        [refId],
        { userId: ownerId.toString(), tenantId: 'tenant-a' },
        { code: true, codeRouteKey: 'default', hydrateProvisioned: true },
      );

      expect(results.map((file) => file.file_id)).toEqual([refId]);
    });

    it('leaves a default reference alone when another query already hydrates it', async () => {
      /* With resendFiles on, getToolFilesByIds loads provisioned files and the probe sees
       * them there, so widening this query would only duplicate the read. */
      const ownerId = new mongoose.Types.ObjectId();
      const refId = uuidv4();
      await makeFile(refId, ownerId, {
        metadata: {
          codeEnvRef: { kind: 'user', id: 'u1', storage_session_id: 's1', file_id: 'r1' },
          codeEnvRefs: {
            default: { kind: 'user', id: 'u1', storage_session_id: 's1', file_id: 'r1' },
          },
        },
      });

      const results = await fileMethods.getDeferredProvisionFiles(
        [refId],
        { userId: ownerId.toString(), tenantId: 'tenant-a' },
        { code: true, codeRouteKey: 'default', hydrateProvisioned: false },
      );

      expect(results).toEqual([]);
    });

    it('returns a usable stateful reference so priming can add it to the tool resources', async () => {
      /* Being provisioned already is not a reason to skip it: with no other query running,
       * this is what puts the record into tool_resources. Omitting it drops the file the
       * previous turn provisioned successfully while retrying the one that failed. */
      const ownerId = new mongoose.Types.ObjectId();
      const refId = uuidv4();
      const statefulRef = {
        kind: 'user',
        id: 'u1',
        storage_session_id: 's2',
        file_id: 'r2',
        executionRouteKey: 'stateful:a',
      };
      await makeFile(refId, ownerId, {
        metadata: {
          codeEnvRef: { kind: 'user', id: 'u1', storage_session_id: 's1', file_id: 'r1' },
          codeEnvRefs: { 'stateful:a': statefulRef },
        },
      });

      const results = await fileMethods.getDeferredProvisionFiles(
        [refId],
        { userId: ownerId.toString(), tenantId: 'tenant-a' },
        { code: true, codeRouteKey: 'stateful:a', hydrateProvisioned: true },
      );

      expect(results.map((file) => file.file_id)).toEqual([refId]);
    });

    it('returns an embedded attachment to a search-only agent when nothing else hydrates', async () => {
      /* With resendFiles off, getToolFilesByIds does not run, so this is the only query
       * that can put an already-embedded attachment into tool_resources.file_search.
       * Excluding it on the embedded flag leaves the next search with no reference to a
       * file the previous turn embedded successfully. */
      const ownerId = new mongoose.Types.ObjectId();
      const fileId = uuidv4();
      await makeFile(fileId, ownerId, { embedded: true });

      const results = await fileMethods.getDeferredProvisionFiles(
        [fileId],
        { userId: ownerId.toString(), tenantId: 'tenant-a' },
        { search: true, searchNamespaces: [ownerId.toString()], hydrateProvisioned: true },
      );

      expect(results.map((file) => file.file_id)).toEqual([fileId]);
    });

    it('leaves an embedded attachment alone when another query already hydrates it', async () => {
      const ownerId = new mongoose.Types.ObjectId();
      const fileId = uuidv4();
      await makeFile(fileId, ownerId, { embedded: true });

      const results = await fileMethods.getDeferredProvisionFiles(
        [fileId],
        { userId: ownerId.toString(), tenantId: 'tenant-a' },
        { search: true, searchNamespaces: [ownerId.toString()], hydrateProvisioned: false },
      );

      expect(results).toEqual([]);
    });

    it('surfaces a read failure rather than reporting nothing to provision', async () => {
      /* An empty list is indistinguishable from nothing needing provisioning, so a
       * swallowed error would let the tool run without the attachment. */
      const ownerId = new mongoose.Types.ObjectId();
      const failing = createFileMethods({
        ...mongoose,
        models: {
          ...mongoose.models,
          File: {
            find: () => {
              throw new Error('mongo unavailable');
            },
          },
        },
      } as unknown as typeof mongoose);

      await expect(
        failing.getDeferredProvisionFiles([uuidv4()], { userId: ownerId.toString() }),
      ).rejects.toThrow(/mongo unavailable/);
    });

    it('still queues a file whose only code reference is for another route', async () => {
      const ownerId = new mongoose.Types.ObjectId();
      const otherRouteId = uuidv4();
      await makeFile(otherRouteId, ownerId, {
        embedded: true,
        metadata: {
          codeEnvRefs: {
            'stateful:a': {
              kind: 'user',
              id: ownerId.toString(),
              storage_session_id: 'session-a',
              file_id: otherRouteId,
              executionRouteKey: 'stateful:a',
            },
          },
        },
      });

      const results = await fileMethods.getDeferredProvisionFiles(
        [otherRouteId],
        { userId: ownerId.toString(), tenantId: 'tenant-a' },
        { code: true, codeRouteKey: 'stateful:b' },
      );

      expect(results.map((file) => file.file_id)).toEqual([otherRouteId]);
    });

    it('omits a file already provisioned for the active route', async () => {
      const ownerId = new mongoose.Types.ObjectId();
      const sameRouteId = uuidv4();
      await makeFile(sameRouteId, ownerId, {
        embedded: true,
        metadata: {
          codeEnvRefs: {
            'stateful:b': {
              kind: 'user',
              id: ownerId.toString(),
              storage_session_id: 'session-b',
              file_id: sameRouteId,
              executionRouteKey: 'stateful:b',
            },
          },
        },
      });

      const results = await fileMethods.getDeferredProvisionFiles(
        [sameRouteId],
        { userId: ownerId.toString(), tenantId: 'tenant-a' },
        { code: true, codeRouteKey: 'stateful:b' },
      );

      expect(results).toEqual([]);
    });

    it('treats a legacy pointer without a route key as the default deployment', async () => {
      const ownerId = new mongoose.Types.ObjectId();
      const legacyId = uuidv4();
      await makeFile(legacyId, ownerId, {
        embedded: true,
        metadata: {
          codeEnvRef: {
            kind: 'user',
            id: ownerId.toString(),
            storage_session_id: 'session',
            file_id: legacyId,
          },
        },
      });
      const ownerScope = { userId: ownerId.toString(), tenantId: 'tenant-a' };

      const onDefault = await fileMethods.getDeferredProvisionFiles([legacyId], ownerScope, {
        code: true,
        codeRouteKey: 'default',
      });
      const onStateful = await fileMethods.getDeferredProvisionFiles([legacyId], ownerScope, {
        code: true,
        codeRouteKey: 'stateful:b',
      });

      expect(onDefault).toEqual([]);
      expect(onStateful.map((file) => file.file_id)).toEqual([legacyId]);
    });

    it('omits a file that already carries every requested result', async () => {
      const ownerId = new mongoose.Types.ObjectId();
      const embeddedId = uuidv4();
      const provisionedId = uuidv4();
      const generatedId = uuidv4();
      await makeFile(embeddedId, ownerId, {
        embedded: true,
        metadata: {
          codeEnvRef: {
            kind: 'user',
            id: ownerId.toString(),
            storage_session_id: 'session',
            file_id: embeddedId,
          },
        },
      });
      await makeFile(provisionedId, ownerId, {
        embedded: true,
        metadata: {
          codeEnvRef: {
            kind: 'user',
            id: ownerId.toString(),
            storage_session_id: 'session',
            file_id: provisionedId,
          },
        },
      });
      await makeFile(generatedId, ownerId, { context: FileContext.execute_code });

      const results = await fileMethods.getDeferredProvisionFiles(
        [embeddedId, provisionedId, generatedId],
        { userId: ownerId.toString(), tenantId: 'tenant-a' },
      );

      expect(results).toEqual([]);
    });

    it('returns a search-embedded file when the agent needs code provisioning', async () => {
      const ownerId = new mongoose.Types.ObjectId();
      const embeddedOnlyId = uuidv4();
      await makeFile(embeddedOnlyId, ownerId, { embedded: true });

      const forCode = await fileMethods.getDeferredProvisionFiles(
        [embeddedOnlyId],
        { userId: ownerId.toString(), tenantId: 'tenant-a' },
        { code: true },
      );
      const forSearch = await fileMethods.getDeferredProvisionFiles(
        [embeddedOnlyId],
        { userId: ownerId.toString(), tenantId: 'tenant-a' },
        { search: true },
      );

      expect(forCode.map((file) => file.file_id)).toEqual([embeddedOnlyId]);
      expect(forSearch).toEqual([]);
    });

    it('returns a code-provisioned file when the agent needs search provisioning', async () => {
      const ownerId = new mongoose.Types.ObjectId();
      const codeOnlyId = uuidv4();
      await makeFile(codeOnlyId, ownerId, {
        metadata: {
          codeEnvRef: {
            kind: 'user',
            id: ownerId.toString(),
            storage_session_id: 'session',
            file_id: codeOnlyId,
          },
        },
      });

      const forSearch = await fileMethods.getDeferredProvisionFiles(
        [codeOnlyId],
        { userId: ownerId.toString(), tenantId: 'tenant-a' },
        { search: true },
      );
      const forCode = await fileMethods.getDeferredProvisionFiles(
        [codeOnlyId],
        { userId: ownerId.toString(), tenantId: 'tenant-a' },
        { code: true },
      );

      expect(forSearch.map((file) => file.file_id)).toEqual([codeOnlyId]);
      expect(forCode).toEqual([]);
    });

    it('does not cross the authenticated owner scope', async () => {
      const ownerId = new mongoose.Types.ObjectId();
      const victimId = new mongoose.Types.ObjectId();
      const victimFileId = uuidv4();
      await makeFile(victimFileId, victimId);

      const results = await fileMethods.getDeferredProvisionFiles([victimFileId], {
        userId: ownerId.toString(),
        tenantId: 'tenant-a',
      });

      expect(results).toEqual([]);
    });
  });

  describe('updateFileCodeEnvRef', () => {
    const makeRefFile = (fileId: string, ownerId: mongoose.Types.ObjectId) =>
      runAsSystem(() =>
        fileMethods.createFile({
          file_id: fileId,
          user: ownerId,
          tenantId: 'tenant-a',
          conversationId: 'conversation-a',
          filename: `${fileId}.csv`,
          filepath: `/uploads/${fileId}.csv`,
          source: 'local',
          type: 'text/csv',
          bytes: 100,
          context: FileContext.message_attachment,
          metadata: { sourceDispatchedAt: 42 },
        }),
      );

    const ref = (routeKey: string, remoteId: string) => ({
      kind: 'user' as const,
      id: 'u1',
      storage_session_id: `session-${routeKey}`,
      file_id: remoteId,
      executionRouteKey: routeKey,
    });

    it('keeps concurrently written sibling routes', async () => {
      const ownerId = new mongoose.Types.ObjectId();
      const fileId = uuidv4();
      await makeRefFile(fileId, ownerId);

      await Promise.all([
        runAsSystem(() =>
          fileMethods.updateFileCodeEnvRef({
            file_id: fileId,
            routeKey: 'default',
            ref: ref('default', 'remote-default'),
          }),
        ),
        runAsSystem(() =>
          fileMethods.updateFileCodeEnvRef({
            file_id: fileId,
            routeKey: 'stateful:a',
            ref: ref('stateful:a', 'remote-stateful'),
          }),
        ),
      ]);

      const stored = await runAsSystem(() => fileMethods.findFileById(fileId));
      const refs = stored?.metadata?.codeEnvRefs as Record<string, { file_id: string }> | undefined;
      expect(refs?.default?.file_id).toBe('remote-default');
      expect(refs?.['stateful:a']?.file_id).toBe('remote-stateful');
    });

    it('leaves sibling metadata fields in place', async () => {
      const ownerId = new mongoose.Types.ObjectId();
      const fileId = uuidv4();
      await makeRefFile(fileId, ownerId);

      await runAsSystem(() =>
        fileMethods.updateFileCodeEnvRef({
          file_id: fileId,
          routeKey: 'default',
          ref: ref('default', 'remote-default'),
          legacyRef: ref('default', 'remote-default'),
        }),
      );

      const stored = await runAsSystem(() => fileMethods.findFileById(fileId));
      expect(stored?.metadata?.sourceDispatchedAt).toBe(42);
      expect((stored?.metadata?.codeEnvRef as { file_id: string } | undefined)?.file_id).toBe(
        'remote-default',
      );
    });

    it('rejects a route key that would write outside its entry', async () => {
      const ownerId = new mongoose.Types.ObjectId();
      const fileId = uuidv4();
      await makeRefFile(fileId, ownerId);

      await expect(
        runAsSystem(() =>
          fileMethods.updateFileCodeEnvRef({
            file_id: fileId,
            routeKey: 'a.b',
            ref: ref('a.b', 'remote'),
          }),
        ),
      ).rejects.toThrow(/Invalid code environment route key/);
    });
  });

  describe('getUserCodeFiles', () => {
    it('returns only authenticated owner code-env uploads', async () => {
      const ownerId = new mongoose.Types.ObjectId();
      const victimId = new mongoose.Types.ObjectId();
      const ownerFileId = uuidv4();
      const victimFileId = uuidv4();

      await runAsSystem(() =>
        fileMethods.createFile({
          file_id: ownerFileId,
          user: ownerId,
          tenantId: 'tenant-a',
          conversationId: 'conversation-owner',
          filename: 'owner.csv',
          filepath: '/uploads/owner.csv',
          source: 'local',
          type: 'text/csv',
          bytes: 100,
          context: FileContext.message_attachment,
          metadata: {
            codeEnvRef: {
              kind: 'user',
              id: ownerId.toString(),
              storage_session_id: 'owner-session',
              file_id: ownerFileId,
            },
          },
        }),
      );
      await runAsSystem(() =>
        fileMethods.createFile({
          file_id: victimFileId,
          user: victimId,
          tenantId: 'tenant-a',
          conversationId: 'conversation-victim',
          filename: 'victim.csv',
          filepath: '/uploads/victim.csv',
          source: 'local',
          type: 'text/csv',
          bytes: 100,
          context: FileContext.message_attachment,
          metadata: {
            codeEnvRef: {
              kind: 'user',
              id: victimId.toString(),
              storage_session_id: 'victim-session',
              file_id: victimFileId,
            },
          },
        }),
      );

      const files = await fileMethods.getUserCodeFiles([ownerFileId, victimFileId], {
        userId: ownerId.toString(),
        tenantId: 'tenant-a',
      });

      expect(files).toHaveLength(1);
      expect(files[0]).toMatchObject({
        file_id: ownerFileId,
        filename: 'owner.csv',
        filepath: '/uploads/owner.csv',
        source: 'local',
        metadata: {
          codeEnvRef: {
            kind: 'user',
            id: ownerId.toString(),
            storage_session_id: 'owner-session',
            file_id: ownerFileId,
          },
        },
      });
    });

    it('excludes files outside the authenticated tenant scope', async () => {
      const ownerId = new mongoose.Types.ObjectId();
      const fileId = uuidv4();

      await runAsSystem(() =>
        fileMethods.createFile({
          file_id: fileId,
          user: ownerId,
          tenantId: 'tenant-b',
          filename: 'tenant-b.csv',
          filepath: '/uploads/tenant-b.csv',
          source: 'local',
          type: 'text/csv',
          bytes: 100,
          context: FileContext.message_attachment,
          metadata: {
            codeEnvRef: {
              kind: 'user',
              id: ownerId.toString(),
              storage_session_id: 'tenant-b-session',
              file_id: fileId,
            },
          },
        }),
      );

      const files = await fileMethods.getUserCodeFiles([fileId], {
        userId: ownerId.toString(),
        tenantId: 'tenant-a',
      });

      expect(files).toEqual([]);
    });
  });

  describe('updateFile', () => {
    it('should update file data and remove TTL', async () => {
      const fileId = uuidv4();
      const userId = new mongoose.Types.ObjectId();

      await fileMethods.createFile({
        file_id: fileId,
        user: userId,
        filename: 'original.txt',
        filepath: '/uploads/original.txt',
        type: 'text/plain',
        bytes: 100,
      });

      const updated = await fileMethods.updateFile({
        file_id: fileId,
        filename: 'updated.txt',
        bytes: 200,
      });

      expect(updated).not.toBeNull();
      expect(updated?.filename).toBe('updated.txt');
      expect(updated?.bytes).toBe(200);
      expect(updated?.expiresAt).toBeUndefined();
    });

    /* The optional `extraFilter` enables conditional updates — used by
     * the deferred-preview render's `finalizePreview` to guard against
     * an older render of the same `file_id` overwriting a newer turn's
     * record on cross-turn filename reuse. (Codex P1 review on PR
     * #12957.) */
    describe('extraFilter (conditional update)', () => {
      it('commits when the extra filter matches the current document', async () => {
        const fileId = uuidv4();
        const userId = new mongoose.Types.ObjectId();
        await fileMethods.createFile({
          file_id: fileId,
          user: userId,
          filename: 'data.xlsx',
          filepath: '/uploads/data.xlsx',
          type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          bytes: 100,
          status: 'pending',
          previewRevision: 'rev-A',
        });

        const updated = await fileMethods.updateFile(
          { file_id: fileId, status: 'ready', text: '<table></table>' },
          { previewRevision: 'rev-A' },
        );

        expect(updated).not.toBeNull();
        expect(updated?.status).toBe('ready');
        expect(updated?.text).toBe('<table></table>');
      });

      it('returns null and skips the write when the extra filter does NOT match', async () => {
        const fileId = uuidv4();
        const userId = new mongoose.Types.ObjectId();
        await fileMethods.createFile({
          file_id: fileId,
          user: userId,
          filename: 'data.xlsx',
          filepath: '/uploads/data.xlsx',
          type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          bytes: 100,
          status: 'pending',
          previewRevision: 'rev-B', // newer turn has rotated the revision
        });

        /* An older render that started while revision was 'rev-A' tries
         * to commit. The newer turn has since rotated to 'rev-B'. The
         * conditional update silently no-ops. */
        const updated = await fileMethods.updateFile(
          { file_id: fileId, status: 'ready', text: '<stale/>' },
          { previewRevision: 'rev-A' },
        );

        expect(updated).toBeNull();

        /* Critical: the newer record's text MUST be untouched. */
        const fresh = await fileMethods.findFileById(fileId);
        expect(fresh?.previewRevision).toBe('rev-B');
        expect(fresh?.status).toBe('pending');
        expect(fresh?.text).toBeUndefined();
      });

      it('falls back to single-key update when extraFilter is omitted (back-compat)', async () => {
        const fileId = uuidv4();
        const userId = new mongoose.Types.ObjectId();
        await fileMethods.createFile({
          file_id: fileId,
          user: userId,
          filename: 'plain.txt',
          filepath: '/uploads/plain.txt',
          type: 'text/plain',
          bytes: 50,
        });

        const updated = await fileMethods.updateFile({
          file_id: fileId,
          bytes: 99,
        });

        expect(updated).not.toBeNull();
        expect(updated?.bytes).toBe(99);
      });
    });
  });

  describe('updateFileUsage', () => {
    it('should increment usage count', async () => {
      const fileId = uuidv4();
      const userId = new mongoose.Types.ObjectId();

      await fileMethods.createFile({
        file_id: fileId,
        user: userId,
        filename: 'usage-test.txt',
        filepath: '/uploads/usage-test.txt',
        type: 'text/plain',
        bytes: 100,
        usage: 0,
      });

      const updated = await fileMethods.updateFileUsage({ file_id: fileId });
      expect(updated?.usage).toBe(1);

      const updated2 = await fileMethods.updateFileUsage({ file_id: fileId, inc: 5 });
      expect(updated2?.usage).toBe(6);
    });

    it('should skip usage and TTL mutation when the owner filter does not match', async () => {
      const fileId = uuidv4();
      const ownerId = new mongoose.Types.ObjectId();
      const otherUserId = new mongoose.Types.ObjectId();

      await fileMethods.createFile({
        file_id: fileId,
        temp_file_id: 'tmp-file',
        user: ownerId,
        filename: 'owned.txt',
        filepath: '/uploads/owned.txt',
        type: 'text/plain',
        bytes: 100,
        usage: 0,
      });

      const denied = await fileMethods.updateFileUsage({
        file_id: fileId,
        user: otherUserId.toString(),
      });
      const unchanged = await fileMethods.findFileById(fileId);

      expect(denied).toBeNull();
      expect(unchanged?.usage).toBe(0);
      expect(unchanged?.temp_file_id).toBe('tmp-file');
      expect(unchanged?.expiresAt).toBeDefined();

      const allowed = await fileMethods.updateFileUsage({
        file_id: fileId,
        user: ownerId.toString(),
      });

      expect(allowed?.usage).toBe(1);
      expect(allowed?.temp_file_id).toBeUndefined();
      expect(allowed?.expiresAt).toBeUndefined();
    });
  });

  describe('updateFilesUsage', () => {
    it('should update usage for multiple files', async () => {
      const userId = new mongoose.Types.ObjectId();
      const fileIds = [uuidv4(), uuidv4()];

      for (const fileId of fileIds) {
        await fileMethods.createFile({
          file_id: fileId,
          user: userId,
          filename: `file-${fileId}.txt`,
          filepath: `/uploads/${fileId}.txt`,
          type: 'text/plain',
          bytes: 100,
          usage: 0,
        });
      }

      const files = fileIds.map((file_id) => ({ file_id }));
      const updated = await fileMethods.updateFilesUsage(files);

      expect(updated).toHaveLength(2);
      for (const file of updated) {
        expect((file as { usage: number }).usage).toBe(1);
      }
    });

    it('should deduplicate files', async () => {
      const userId = new mongoose.Types.ObjectId();
      const fileId = uuidv4();

      await fileMethods.createFile({
        file_id: fileId,
        user: userId,
        filename: 'duplicate-test.txt',
        filepath: '/uploads/duplicate-test.txt',
        type: 'text/plain',
        bytes: 100,
        usage: 0,
      });

      const files = [{ file_id: fileId }, { file_id: fileId }, { file_id: fileId }];
      const updated = await fileMethods.updateFilesUsage(files);

      expect(updated).toHaveLength(1);
      expect((updated[0] as { usage: number }).usage).toBe(1);
    });

    it('should filter out null results when files do not exist', async () => {
      const userId = new mongoose.Types.ObjectId();
      const existingFileId = uuidv4();

      await fileMethods.createFile({
        file_id: existingFileId,
        user: userId,
        filename: 'existing.txt',
        filepath: '/uploads/existing.txt',
        type: 'text/plain',
        bytes: 100,
        usage: 0,
      });

      const files = [{ file_id: existingFileId }, { file_id: 'non-existent-file' }];
      const updated = await fileMethods.updateFilesUsage(files);

      expect(updated.length).toBeGreaterThan(0);
      expect(updated).not.toContain(null);
      expect(updated).not.toContain(undefined);
      const existingFile = updated.find(
        (f) => (f as { file_id: string }).file_id === existingFileId,
      );
      expect(existingFile).toBeDefined();
      expect((existingFile as { usage: number }).usage).toBe(1);
    });

    it('should handle empty files array', async () => {
      const result = await fileMethods.updateFilesUsage([]);
      expect(result).toEqual([]);
    });

    it('should handle fileIds parameter', async () => {
      const userId = new mongoose.Types.ObjectId();
      const fileIds = [uuidv4(), uuidv4()];

      for (const fileId of fileIds) {
        await fileMethods.createFile({
          file_id: fileId,
          user: userId,
          filename: `file-${fileId}.txt`,
          filepath: `/uploads/${fileId}.txt`,
          type: 'text/plain',
          bytes: 100,
          usage: 0,
        });
      }

      const files = [{ file_id: fileIds[0] }];
      const updated = await fileMethods.updateFilesUsage(files, [fileIds[1]]);

      expect(updated).toHaveLength(2);
      const file1 = updated.find((f) => (f as { file_id: string }).file_id === fileIds[0]);
      const file2 = updated.find((f) => (f as { file_id: string }).file_id === fileIds[1]);
      expect(file1).toBeDefined();
      expect(file2).toBeDefined();
      expect((file1 as { usage: number }).usage).toBe(1);
      expect((file2 as { usage: number }).usage).toBe(1);
    });

    it('should deduplicate between files and fileIds parameters', async () => {
      const userId = new mongoose.Types.ObjectId();
      const fileId = uuidv4();

      await fileMethods.createFile({
        file_id: fileId,
        user: userId,
        filename: 'test.txt',
        filepath: '/uploads/test.txt',
        type: 'text/plain',
        bytes: 100,
        usage: 0,
      });

      const files = [{ file_id: fileId }];
      const updated = await fileMethods.updateFilesUsage(files, [fileId]);

      expect(updated).toHaveLength(1);
      expect((updated[0] as { usage: number }).usage).toBe(1);
    });

    it('should only return and mutate files owned by the scoped user', async () => {
      const ownerId = new mongoose.Types.ObjectId();
      const otherUserId = new mongoose.Types.ObjectId();
      const ownerFileId = uuidv4();
      const otherFileId = uuidv4();

      await fileMethods.createFile({
        file_id: ownerFileId,
        user: ownerId,
        filename: 'owner.txt',
        filepath: '/uploads/owner.txt',
        type: 'text/plain',
        bytes: 100,
        usage: 0,
      });
      await fileMethods.createFile({
        file_id: otherFileId,
        temp_file_id: 'tmp-other',
        user: otherUserId,
        filename: 'other.txt',
        filepath: '/uploads/other.txt',
        type: 'text/plain',
        bytes: 100,
        usage: 0,
        text: 'private extracted text',
      });

      const updated = await fileMethods.updateFilesUsage(
        [{ file_id: ownerFileId }, { file_id: otherFileId }],
        undefined,
        { user: ownerId.toString() },
      );
      const otherFile = await fileMethods.findFileById(otherFileId);

      expect(updated).toHaveLength(1);
      expect(updated[0].file_id).toBe(ownerFileId);
      expect(updated[0].usage).toBe(1);
      expect(otherFile?.usage).toBe(0);
      expect(otherFile?.temp_file_id).toBe('tmp-other');
      expect(otherFile?.expiresAt).toBeDefined();
    });
  });

  describe('extendFilesTTL', () => {
    const HOUR = 3_600_000;
    const HOLD = { renewMs: 24 * HOUR, maxLifetimeMs: 48 * HOUR };

    const seedTempFile = async (
      userId: mongoose.Types.ObjectId,
      expiresAt: Date,
      createdAt?: Date,
    ) => {
      const fileId = uuidv4();
      await fileMethods.createFile({
        file_id: fileId,
        user: userId,
        filename: `${fileId}.txt`,
        filepath: `/uploads/${fileId}.txt`,
        type: 'text/plain',
        bytes: 100,
      });
      await mongoose.models.File.updateOne(
        { file_id: fileId },
        { $set: { expiresAt } },
        { timestamps: false },
      );
      /** Mongoose strips the immutable `createdAt` from updates, so backdating
       *  must go through the raw driver to actually land. */
      if (createdAt) {
        await mongoose.models.File.collection.updateOne(
          { file_id: fileId },
          { $set: { createdAt } },
        );
      }
      return fileId;
    };

    const readFile = async (fileId: string) =>
      (await mongoose.models.File.findOne({ file_id: fileId })
        .lean<{ createdAt: Date; expiresAt?: Date }>()
        .exec())!;

    it('widens the TTL toward the renewal window without unsetting it', async () => {
      const userId = new mongoose.Types.ObjectId();
      const fileId = await seedTempFile(userId, new Date(Date.now() + 60_000));

      const count = await fileMethods.extendFilesTTL([fileId], HOLD, { user: String(userId) });

      expect(count).toBe(1);
      const file = await readFile(fileId);
      expect(file.expiresAt).toBeDefined();
      expect(file.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 23 * HOUR);
      expect(file.expiresAt!.getTime()).toBeLessThanOrEqual(
        file.createdAt.getTime() + HOLD.maxLifetimeMs,
      );
    });

    /** The bound that makes the endpoint safe to expose: every renewal is
     *  clamped to createdAt + maxLifetimeMs, so replaying the call converges
     *  on a ceiling instead of advancing a window at a time. */
    it('clamps every renewal to the ceiling, however often it is replayed', async () => {
      const userId = new mongoose.Types.ObjectId();
      const fileId = await seedTempFile(userId, new Date(Date.now() + 60_000));
      const ceilingHold = { renewMs: 24 * HOUR, maxLifetimeMs: 10 * 60_000 };
      const { createdAt } = await readFile(fileId);

      const first = await fileMethods.extendFilesTTL([fileId], ceilingHold, {
        user: String(userId),
      });
      expect(first).toBe(1);

      for (let i = 0; i < 5; i++) {
        expect(
          await fileMethods.extendFilesTTL([fileId], ceilingHold, { user: String(userId) }),
        ).toBe(0);
      }

      const file = await readFile(fileId);
      expect(file.expiresAt!.getTime()).toBe(createdAt.getTime() + ceilingHold.maxLifetimeMs);
      /* The renewal window alone would have granted a full day. */
      expect(file.expiresAt!.getTime()).toBeLessThan(Date.now() + HOUR);
    });

    /** Renewal is measured from now, so a queue still draining across
     *  successive runs keeps its attachments past the first hold. */
    it('renews from now while the ceiling still allows it', async () => {
      const userId = new mongoose.Types.ObjectId();
      const twoHoursAgo = new Date(Date.now() - 2 * HOUR);
      const fileId = await seedTempFile(userId, new Date(Date.now() + 60_000), twoHoursAgo);

      const count = await fileMethods.extendFilesTTL(
        [fileId],
        { renewMs: HOUR, maxLifetimeMs: 24 * HOUR },
        { user: String(userId) },
      );

      expect(count).toBe(1);
      const file = await readFile(fileId);
      /* Anchoring to createdAt alone would have expired this an hour ago. */
      expect(file.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 50 * 60_000);
    });

    it("applies each file's own ceiling within a single batch", async () => {
      const userId = new mongoose.Types.ObjectId();
      const soon = new Date(Date.now() + 60_000);
      const freshId = await seedTempFile(userId, soon);
      const agedId = await seedTempFile(userId, soon, new Date(Date.now() - 47 * HOUR));
      const releasedId = await seedTempFile(userId, soon);
      await fileMethods.updateFileUsage({ file_id: releasedId, user: String(userId) });

      const count = await fileMethods.extendFilesTTL([freshId, agedId, releasedId], HOLD, {
        user: String(userId),
      });

      expect(count).toBe(2);
      const fresh = await readFile(freshId);
      expect(fresh.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 23 * HOUR);
      const aged = await readFile(agedId);
      expect(aged.expiresAt!.getTime()).toBe(aged.createdAt.getTime() + HOLD.maxLifetimeMs);
      expect(aged.expiresAt!.getTime()).toBeLessThan(Date.now() + 2 * HOUR);
      const released = await readFile(releasedId);
      expect(released.expiresAt).toBeUndefined();
    });

    it('does not resurrect a TTL on an already-released file', async () => {
      const userId = new mongoose.Types.ObjectId();
      const fileId = await seedTempFile(userId, new Date(Date.now() + 60_000));
      await fileMethods.updateFileUsage({ file_id: fileId, user: String(userId) });

      const count = await fileMethods.extendFilesTTL([fileId], HOLD, { user: String(userId) });

      expect(count).toBe(0);
      const file = await readFile(fileId);
      expect(file.expiresAt).toBeUndefined();
    });

    it('never moves an expiry earlier', async () => {
      const userId = new mongoose.Types.ObjectId();
      const farOut = new Date(Date.now() + 7 * 24 * HOUR);
      const fileId = await seedTempFile(userId, farOut);

      const count = await fileMethods.extendFilesTTL([fileId], HOLD, { user: String(userId) });

      expect(count).toBe(0);
      const file = await readFile(fileId);
      expect(file.expiresAt!.getTime()).toBe(farOut.getTime());
    });

    it("leaves another user's file untouched", async () => {
      const ownerId = new mongoose.Types.ObjectId();
      const attackerId = new mongoose.Types.ObjectId();
      const soon = new Date(Date.now() + 60_000);
      const fileId = await seedTempFile(ownerId, soon);

      const count = await fileMethods.extendFilesTTL([fileId], HOLD, {
        user: String(attackerId),
      });

      expect(count).toBe(0);
      const file = await readFile(fileId);
      expect(file.expiresAt!.getTime()).toBe(soon.getTime());
    });

    it('is a no-op without an owner scope rather than a cross-user update', async () => {
      const userId = new mongoose.Types.ObjectId();
      const soon = new Date(Date.now() + 60_000);
      const fileId = await seedTempFile(userId, soon);

      const count = await fileMethods.extendFilesTTL([fileId], HOLD, { user: '' } as {
        user: string;
      });

      expect(count).toBe(0);
      const file = await readFile(fileId);
      expect(file.expiresAt!.getTime()).toBe(soon.getTime());
    });

    it('is a no-op for a non-positive hold', async () => {
      const userId = new mongoose.Types.ObjectId();
      const soon = new Date(Date.now() + 60_000);
      const fileId = await seedTempFile(userId, soon);
      const owner = { user: String(userId) };

      expect(
        await fileMethods.extendFilesTTL([fileId], { renewMs: 0, maxLifetimeMs: 0 }, owner),
      ).toBe(0);
      expect(
        await fileMethods.extendFilesTTL([fileId], { renewMs: -1, maxLifetimeMs: -1 }, owner),
      ).toBe(0);
      const file = await readFile(fileId);
      expect(file.expiresAt!.getTime()).toBe(soon.getTime());
    });
  });

  describe('deleteFile', () => {
    it('should delete a file by file_id', async () => {
      const fileId = uuidv4();
      const userId = new mongoose.Types.ObjectId();

      await fileMethods.createFile({
        file_id: fileId,
        user: userId,
        filename: 'delete-me.txt',
        filepath: '/uploads/delete-me.txt',
        type: 'text/plain',
        bytes: 100,
      });

      const deleted = await fileMethods.deleteFile(fileId);
      expect(deleted).not.toBeNull();
      expect(deleted?.file_id).toBe(fileId);

      const found = await fileMethods.findFileById(fileId);
      expect(found).toBeNull();
    });
  });

  describe('deleteFiles', () => {
    it('should delete multiple files by file_ids', async () => {
      const userId = new mongoose.Types.ObjectId();
      const fileIds = [uuidv4(), uuidv4(), uuidv4()];

      for (const fileId of fileIds) {
        await fileMethods.createFile({
          file_id: fileId,
          user: userId,
          filename: `file-${fileId}.txt`,
          filepath: `/uploads/${fileId}.txt`,
          type: 'text/plain',
          bytes: 100,
        });
      }

      const result = await fileMethods.deleteFiles(fileIds);
      expect(result.deletedCount).toBe(3);

      const remaining = await fileMethods.getFiles({ file_id: { $in: fileIds } });
      expect(remaining).toHaveLength(0);
    });

    it('should delete all files for a user', async () => {
      const userId = new mongoose.Types.ObjectId();
      const otherUserId = new mongoose.Types.ObjectId();

      await fileMethods.createFile({
        file_id: uuidv4(),
        user: userId,
        filename: 'user-file-1.txt',
        filepath: '/uploads/user-file-1.txt',
        type: 'text/plain',
        bytes: 100,
      });

      await fileMethods.createFile({
        file_id: uuidv4(),
        user: userId,
        filename: 'user-file-2.txt',
        filepath: '/uploads/user-file-2.txt',
        type: 'text/plain',
        bytes: 100,
      });

      await fileMethods.createFile({
        file_id: uuidv4(),
        user: otherUserId,
        filename: 'other-user-file.txt',
        filepath: '/uploads/other-user-file.txt',
        type: 'text/plain',
        bytes: 100,
      });

      const result = await fileMethods.deleteFiles([], userId.toString());
      expect(result.deletedCount).toBe(2);

      const remaining = await fileMethods.getFiles({});
      expect(remaining).toHaveLength(1);
      expect(remaining![0].user?.toString()).toBe(otherUserId.toString());
    });
  });

  describe('batchUpdateFiles', () => {
    it('should update multiple file paths', async () => {
      const userId = new mongoose.Types.ObjectId();
      const fileIds = [uuidv4(), uuidv4()];

      for (const fileId of fileIds) {
        await fileMethods.createFile({
          file_id: fileId,
          user: userId,
          filename: `file-${fileId}.txt`,
          filepath: `/old-path/${fileId}.txt`,
          type: 'text/plain',
          bytes: 100,
        });
      }

      const updates = fileIds.map((file_id) => ({
        file_id,
        filepath: `/new-path/${file_id}.txt`,
      }));

      await fileMethods.batchUpdateFiles(updates);

      for (const fileId of fileIds) {
        const file = await fileMethods.findFileById(fileId);
        expect(file?.filepath).toBe(`/new-path/${fileId}.txt`);
      }
    });

    it('should persist storage metadata when provided', async () => {
      const userId = new mongoose.Types.ObjectId();
      const fileId = uuidv4();

      await fileMethods.createFile({
        file_id: fileId,
        user: userId,
        filename: 'region-file.txt',
        filepath: '/old-path/file.txt',
        type: 'text/plain',
        bytes: 100,
      });

      await fileMethods.batchUpdateFiles([
        {
          file_id: fileId,
          filepath: '/new-path/file.txt',
          storageKey: 'i/r/us-east-2/images/user123/file.txt',
          storageRegion: 'us-east-2',
        },
      ]);

      const file = await fileMethods.findFileById(fileId);
      expect(file?.filepath).toBe('/new-path/file.txt');
      expect(file?.storageKey).toBe('i/r/us-east-2/images/user123/file.txt');
      expect(file?.storageRegion).toBe('us-east-2');
    });

    it('should not overwrite existing storage metadata when omitted', async () => {
      const userId = new mongoose.Types.ObjectId();
      const fileId = uuidv4();

      await fileMethods.createFile({
        file_id: fileId,
        user: userId,
        filename: 'existing-metadata.txt',
        filepath: '/old-path/file.txt',
        storageKey: 'r/eu-central-1/uploads/user123/file.txt',
        storageRegion: 'eu-central-1',
        type: 'text/plain',
        bytes: 100,
      });

      await fileMethods.batchUpdateFiles([
        {
          file_id: fileId,
          filepath: '/new-path/file.txt',
        },
      ]);

      const file = await fileMethods.findFileById(fileId);
      expect(file?.filepath).toBe('/new-path/file.txt');
      expect(file?.storageKey).toBe('r/eu-central-1/uploads/user123/file.txt');
      expect(file?.storageRegion).toBe('eu-central-1');
    });

    it('should handle empty updates array gracefully', async () => {
      await expect(fileMethods.batchUpdateFiles([])).resolves.toBeUndefined();
    });
  });

  describe('sweepOrphanedPreviews', () => {
    /* The deferred-preview flow runs the deferred render in-process. If the
     * backend restarts mid-extraction, records stay at `status: 'pending'`
     * forever. The boot-time sweep transitions stale ones to 'failed'
     * with `previewError: 'orphaned'` so the frontend stops polling. */
    const userId = new mongoose.Types.ObjectId();

    /**
     * Stamp a precise `updatedAt` on a file record. Mongoose timestamps
     * insist on the current time during create, so we backdate via a
     * direct collection write afterwards.
     */
    async function makeFile(opts: {
      ageMs: number;
      status?: 'pending' | 'ready' | 'failed';
    }): Promise<string> {
      const fileId = uuidv4();
      await fileMethods.createFile({
        file_id: fileId,
        user: userId,
        filename: `${fileId}.xlsx`,
        filepath: `/uploads/${fileId}.xlsx`,
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        bytes: 1024,
        ...(opts.status ? { status: opts.status } : {}),
      });
      const backdated = new Date(Date.now() - opts.ageMs);
      await File.collection.updateOne({ file_id: fileId }, { $set: { updatedAt: backdated } });
      return fileId;
    }

    it('marks stale pending records as failed with previewError:orphaned', async () => {
      const stale = await makeFile({ ageMs: 10 * 60 * 1000, status: 'pending' });
      const fresh = await makeFile({ ageMs: 30 * 1000, status: 'pending' });

      const count = await fileMethods.sweepOrphanedPreviews();
      expect(count).toBe(1);

      const staleAfter = (await fileMethods.findFileById(stale)) as {
        status?: string;
        previewError?: string;
      } | null;
      expect(staleAfter?.status).toBe('failed');
      expect(staleAfter?.previewError).toBe('orphaned');

      const freshAfter = (await fileMethods.findFileById(fresh)) as {
        status?: string;
      } | null;
      expect(freshAfter?.status).toBe('pending');
    });

    it('does not touch records that are already ready or failed (idempotent)', async () => {
      const ready = await makeFile({ ageMs: 60 * 60 * 1000, status: 'ready' });
      const failed = await makeFile({ ageMs: 60 * 60 * 1000, status: 'failed' });

      const count = await fileMethods.sweepOrphanedPreviews();
      expect(count).toBe(0);

      const readyAfter = (await fileMethods.findFileById(ready)) as { status?: string } | null;
      const failedAfter = (await fileMethods.findFileById(failed)) as { status?: string } | null;
      expect(readyAfter?.status).toBe('ready');
      expect(failedAfter?.status).toBe('failed');
    });

    it('does not touch legacy records with no status field (back-compat)', async () => {
      const legacy = await makeFile({ ageMs: 60 * 60 * 1000 }); // no status set
      const count = await fileMethods.sweepOrphanedPreviews();
      expect(count).toBe(0);
      const after = (await fileMethods.findFileById(legacy)) as { status?: string } | null;
      expect(after?.status).toBeUndefined();
    });

    it('respects a custom maxAgeMs cutoff', async () => {
      const old10s = await makeFile({ ageMs: 10 * 1000, status: 'pending' });
      const old1m = await makeFile({ ageMs: 60 * 1000, status: 'pending' });

      // Cutoff = 30s — only the 60s-old record should be swept.
      const count = await fileMethods.sweepOrphanedPreviews(30 * 1000);
      expect(count).toBe(1);

      const tenSecAfter = (await fileMethods.findFileById(old10s)) as { status?: string } | null;
      const oneMinAfter = (await fileMethods.findFileById(old1m)) as {
        status?: string;
        previewError?: string;
      } | null;
      expect(tenSecAfter?.status).toBe('pending');
      expect(oneMinAfter?.status).toBe('failed');
      expect(oneMinAfter?.previewError).toBe('orphaned');
    });

    it('returns 0 when there are no stale pending records', async () => {
      await makeFile({ ageMs: 30 * 1000, status: 'pending' });
      const count = await fileMethods.sweepOrphanedPreviews();
      expect(count).toBe(0);
    });

    describe('strict tenant isolation (boot-time recovery)', () => {
      afterEach(() => {
        delete process.env.TENANT_ISOLATION_STRICT;
        _resetStrictCache();
      });

      it('throws under strict mode without runAsSystem', async () => {
        await runAsSystem(() => makeFile({ ageMs: 10 * 60 * 1000, status: 'pending' }));
        process.env.TENANT_ISOLATION_STRICT = 'true';
        _resetStrictCache();
        await expect(fileMethods.sweepOrphanedPreviews()).rejects.toThrow(
          /Query attempted without tenant context in strict mode/,
        );
      });

      it('succeeds under strict mode when wrapped in runAsSystem', async () => {
        const stale = await runAsSystem(() =>
          makeFile({ ageMs: 10 * 60 * 1000, status: 'pending' }),
        );
        process.env.TENANT_ISOLATION_STRICT = 'true';
        _resetStrictCache();
        const count = await runAsSystem(() => fileMethods.sweepOrphanedPreviews());
        expect(count).toBe(1);
        const after = (await runAsSystem(() => fileMethods.findFileById(stale))) as {
          status?: string;
          previewError?: string;
        } | null;
        expect(after?.status).toBe('failed');
        expect(after?.previewError).toBe('orphaned');
      });
    });
  });
});
