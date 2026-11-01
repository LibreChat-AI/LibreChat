import mongoose from 'mongoose';
import { v4 as uuidv4 } from 'uuid';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { EToolResources, FileContext, FileSources } from 'librechat-data-provider';
import type { CodeEnvRef } from 'librechat-data-provider';
import type { IChatProject, IMongoFile } from '~/types';
import { _resetStrictCache } from '~/models/plugins/tenantIsolation';
import { createFileMethods, FileStorageConflictError } from './file';
import { tenantStorage, runAsSystem } from '~/config/tenantContext';
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

  describe('clearFileCodeEnvRefs', () => {
    const user = new mongoose.Types.ObjectId();
    const updatedAt = new Date('2026-10-20T00:00:00Z');
    const defaultRef: CodeEnvRef = {
      kind: 'user',
      id: user.toString(),
      storage_session_id: 'default-session',
      file_id: 'remote-default',
      executionProfile: 'default',
      executionRouteKey: 'default',
      provisionedAt: 123,
      sandboxFilename: '$notes.csv',
    };
    const statefulRef: CodeEnvRef = {
      ...defaultRef,
      storage_session_id: 'stateful-session',
      file_id: 'remote-stateful',
      executionProfile: 'stateful',
      executionRouteKey: 'stateful:a',
    };
    const snapshot = {
      file_id: 'retained-code-file',
      userId: user.toString(),
      tenantId: 'tenant-a',
      refs: [{ routeKey: 'default', ref: defaultRef }],
    };
    const metadata = {
      codeEnvRef: defaultRef,
      codeEnvRefs: { default: defaultRef, 'stateful:a': statefulRef },
      embeddedEntities: ['agent-a'],
      searchDestination: true,
      destinationChosen: true,
      routingMimeType: 'text/csv',
      sourceDispatchedAt: 42,
      toolResource: EToolResources.execute_code,
    };
    const seed = (overrides = {}) =>
      File.collection.insertOne({
        file_id: snapshot.file_id,
        user,
        tenantId: snapshot.tenantId,
        context: FileContext.message_attachment,
        conversationId: 'conversation-a',
        filename: 'notes.csv',
        filepath: '/uploads/notes.csv',
        type: 'text/csv',
        bytes: 100,
        source: 'local',
        llmDeliveryPath: 'none',
        embedded: true,
        updatedAt,
        metadata,
        ...overrides,
      });
    const read = () => File.collection.findOne({ file_id: snapshot.file_id, user });

    it('removes matching pointers without changing content, intent or bookkeeping', async () => {
      await seed({
        createdAt: updatedAt,
        expiresAt: new Date('2030-01-01'),
        expiredAt: new Date('2026-10-19'),
        deletionAttempts: 3,
        deletionRetryAt: new Date('2026-10-23'),
        text: 'canonical source',
      });
      const before = await read();
      const update = jest.spyOn(mongoose.models.File, 'updateOne');
      expect(await fileMethods.clearFileCodeEnvRefs(snapshot)).toBe(true);
      expect(update).toHaveBeenCalledTimes(2);
      const paths = ['metadata.codeEnvRefs.default', 'metadata.codeEnvRef'];
      for (const [index, path] of paths.entries()) {
        expect(update).toHaveBeenNthCalledWith(
          index + 1,
          {
            file_id: snapshot.file_id,
            user: snapshot.userId,
            $and: [{ tenantId: snapshot.tenantId }],
            $or: [expect.any(Object)],
          },
          { $unset: { [path]: '' }, $set: { 'metadata.codeDestination': true } },
          { timestamps: false },
        );
      }
      expect(JSON.stringify(update.mock.calls)).not.toMatch(/\$expr|\$\$REMOVE/);
      const after = await read();
      const { codeEnvRef: _alias, codeEnvRefs: _routes, ...intent } = metadata;
      expect(after).toEqual({
        ...before,
        metadata: {
          ...intent,
          codeDestination: true,
          codeEnvRefs: { 'stateful:a': statefulRef },
        },
      });
      expect(await fileMethods.clearFileCodeEnvRefs(snapshot)).toBe(true);
      expect(await read()).toEqual(after);
    });

    it.each([
      ['kind', 'agent'],
      ['id', 'other-owner'],
      ['storage_session_id', 'new-session'],
      ['file_id', 'new-remote-id'],
      ['executionProfile', 'stateful'],
      ['executionRouteKey', 'stateful:b'],
      ['provisionedAt', 124],
      ['sandboxFilename', 'new-name.csv'],
      ['version', 2],
    ])('preserves reprovisioned pointers when %s differs', async (field, value) => {
      const replacement = { ...defaultRef, [field]: value };
      await seed({
        metadata: {
          ...metadata,
          codeEnvRef: replacement,
          codeEnvRefs: { default: replacement, 'stateful:a': statefulRef },
        },
      });
      const before = await read();
      expect(await fileMethods.clearFileCodeEnvRefs(snapshot)).toBe(false);
      expect(await read()).toEqual(before);
    });

    it.each([
      [true, undefined],
      [true, false],
      [true, true],
      [false, undefined],
      [false, false],
      [false, true],
    ] as const)(
      'retains code intent only for a matching snapshot: %s, %s',
      async (matches, prior) => {
        const ref = matches ? defaultRef : { ...defaultRef, provisionedAt: 124 };
        await seed({
          metadata: {
            ...metadata,
            codeEnvRef: ref,
            codeEnvRefs: { default: ref },
            ...(prior === undefined ? {} : { codeDestination: prior }),
          },
        });
        expect(await fileMethods.clearFileCodeEnvRefs(snapshot)).toBe(matches);
        expect((await read())?.metadata?.codeDestination).toBe(matches ? true : prior);
      },
    );

    it('compares absent optional fields as part of the full snapshot', async () => {
      const replacement = { ...defaultRef };
      delete replacement.provisionedAt;
      await seed({
        metadata: { codeEnvRef: replacement, codeEnvRefs: { default: replacement } },
      });
      const before = await read();
      expect(await fileMethods.clearFileCodeEnvRefs(snapshot)).toBe(false);
      expect(await read()).toEqual(before);
    });

    it.each([
      'executionProfile',
      'executionRouteKey',
      'provisionedAt',
      'sandboxFilename',
      'version',
    ])('distinguishes null from absent optional snapshot fields: %s', async (field) => {
      const absent = { ...defaultRef };
      Reflect.deleteProperty(absent, field);
      const explicitNull = { ...absent, [field]: null };
      await seed({
        metadata: { codeEnvRef: explicitNull, codeEnvRefs: { default: explicitNull } },
      });
      const before = await read();
      expect(
        await fileMethods.clearFileCodeEnvRefs({
          ...snapshot,
          refs: [{ routeKey: 'default', ref: absent }],
        }),
      ).toBe(false);
      expect(await read()).toEqual(before);
      await File.collection.updateOne(
        { file_id: snapshot.file_id },
        { $set: { metadata: { codeEnvRef: absent, codeEnvRefs: { default: absent } } } },
      );
      const withoutField = await read();
      expect(
        await fileMethods.clearFileCodeEnvRefs({
          ...snapshot,
          refs: [{ routeKey: 'default', ref: explicitNull }],
        }),
      ).toBe(false);
      expect(await read()).toEqual(withoutField);
      await File.collection.updateOne(
        { file_id: snapshot.file_id },
        {
          $set: { metadata: { codeEnvRef: explicitNull, codeEnvRefs: { default: explicitNull } } },
        },
      );
      expect(
        await fileMethods.clearFileCodeEnvRefs({
          ...snapshot,
          refs: [{ routeKey: 'default', ref: explicitNull }],
        }),
      ).toBe(true);
      expect((await read())?.metadata?.codeEnvRefs?.default).toBeUndefined();
      expect((await read())?.metadata?.codeEnvRef).toBeUndefined();
    });

    it('matches every field regardless of BSON property order', async () => {
      await seed();
      const { file_id, ...rest } = defaultRef;
      expect(
        await fileMethods.clearFileCodeEnvRefs({
          ...snapshot,
          refs: [{ routeKey: 'default', ref: { file_id, ...rest } }],
        }),
      ).toBe(true);
      const stored = await read();
      expect(stored?.metadata?.codeEnvRef).toBeUndefined();
      expect(stored?.metadata?.codeEnvRefs).toEqual({ 'stateful:a': statefulRef });
    });

    it('clears matching sibling routes even when another snapshot was replaced', async () => {
      const replacement = { ...defaultRef, provisionedAt: 124 };
      await seed({
        metadata: {
          ...metadata,
          codeEnvRef: replacement,
          codeEnvRefs: { default: replacement, 'stateful:a': statefulRef },
        },
      });
      expect(
        await fileMethods.clearFileCodeEnvRefs({
          ...snapshot,
          refs: [...snapshot.refs, { routeKey: 'stateful:a', ref: statefulRef }],
        }),
      ).toBe(false);
      const stored = await read();
      expect(stored?.metadata?.codeEnvRef).toEqual(replacement);
      expect(stored?.metadata?.codeEnvRefs).toEqual({ default: replacement });
    });

    it.each([statefulRef, { ...defaultRef, provisionedAt: 124 }])(
      'preserves an unrelated or replaced legacy alias: %p',
      async (alias) => {
        await seed({ metadata: { ...metadata, codeEnvRef: alias } });
        expect(await fileMethods.clearFileCodeEnvRefs(snapshot)).toBe(alias === statefulRef);
        const stored = await read();
        expect(stored?.metadata?.codeEnvRef).toEqual(alias);
        expect(stored?.metadata?.codeEnvRefs?.default).toBeUndefined();
      },
    );

    it('preserves routes and aliases replaced between the independent conditional writes', async () => {
      await seed();
      const replacement = { ...defaultRef, provisionedAt: 124 };
      const sibling = { ...statefulRef, provisionedAt: 125 };
      const updateOne = File.collection.updateOne.bind(File.collection);
      jest.spyOn(File.collection, 'updateOne').mockImplementation(async (...args) => {
        const operation = args[1];
        if (
          operation != null &&
          !Array.isArray(operation) &&
          operation.$unset?.['metadata.codeEnvRef'] !== undefined
        ) {
          await updateOne(
            { file_id: snapshot.file_id },
            {
              $set: {
                'metadata.codeEnvRef': replacement,
                'metadata.codeEnvRefs.stateful:a': sibling,
              },
            },
          );
        }
        return updateOne(...args);
      });
      expect(await fileMethods.clearFileCodeEnvRefs(snapshot)).toBe(false);
      const stored = await read();
      expect(stored?.metadata?.codeEnvRef).toEqual(replacement);
      expect(stored?.metadata?.codeEnvRefs).toEqual({ 'stateful:a': sibling });
      expect(stored?.updatedAt).toEqual(updatedAt);
    });

    it.each(['metadata.codeEnvRefs.default', 'metadata.codeEnvRef'])(
      'confirms route absence with a narrow owned read when only %s matches',
      async (path) => {
        await seed({ metadata: {} });
        await File.collection.updateOne(
          { file_id: snapshot.file_id },
          { $set: { [path]: defaultRef } },
        );
        const find = jest.spyOn(mongoose.models.File, 'findOne');
        expect(await fileMethods.clearFileCodeEnvRefs(snapshot)).toBe(true);
        expect(find).toHaveBeenCalledTimes(1);
        expect(find).toHaveBeenCalledWith(
          {
            file_id: snapshot.file_id,
            user: snapshot.userId,
            $and: [{ tenantId: snapshot.tenantId }],
          },
          { _id: 0, 'metadata.codeEnvRef': 1, 'metadata.codeEnvRefs': 1 },
        );
        expect((await read())?.metadata?.codeDestination).toBe(true);
      },
    );

    it('confirms route absence when every conditional write misses', async () => {
      await seed({ metadata: {} });
      const find = jest.spyOn(mongoose.models.File, 'findOne');
      expect(await fileMethods.clearFileCodeEnvRefs(snapshot)).toBe(true);
      expect(find).toHaveBeenCalledTimes(1);
      expect(find).toHaveBeenCalledWith(
        {
          file_id: snapshot.file_id,
          user: snapshot.userId,
          $and: [{ tenantId: snapshot.tenantId }],
        },
        { _id: 0, 'metadata.codeEnvRef': 1, 'metadata.codeEnvRefs': 1 },
      );
      expect((await read())?.metadata).toEqual({});
    });

    it.each([false, true])(
      'keeps generated files hydratable with legacy-only refs: %s',
      async (legacyOnly) => {
        await seed({
          context: FileContext.execute_code,
          metadata: {
            codeEnvRef: defaultRef,
            ...(legacyOnly ? {} : { codeEnvRefs: { default: defaultRef } }),
          },
        });
        expect(await fileMethods.clearFileCodeEnvRefs(snapshot)).toBe(true);
        const stored = await read();
        expect(stored?.metadata?.codeEnvRef).toBeUndefined();
        expect(stored?.metadata?.codeEnvRefs).toEqual(legacyOnly ? undefined : {});
        const generated = await fileMethods.getCodeGeneratedFiles(
          'conversation-a',
          [snapshot.file_id],
          snapshot,
        );
        expect(generated.map((file) => file.file_id)).toEqual([snapshot.file_id]);
      },
    );

    it.each([FileContext.execute_code, FileContext.message_attachment])(
      'hydrates marker-only code intent without crossing owner, tenant, conversation or thread: %s',
      async (context) => {
        await runAsSystem(() =>
          File.create({
            file_id: snapshot.file_id,
            user,
            tenantId: snapshot.tenantId,
            conversationId: 'conversation-a',
            context,
            filename: 'notes.csv',
            filepath: '/uploads/notes.csv',
            type: 'text/csv',
            bytes: 100,
            llmDeliveryPath: 'none',
            metadata: { codeDestination: true, destinationChosen: true },
          }),
        );
        const hydrate = (ids: string[], scope = snapshot, conversationId = 'conversation-a') =>
          context === FileContext.execute_code
            ? fileMethods.getCodeGeneratedFiles(conversationId, ids, scope)
            : fileMethods.getUserCodeFiles(ids, scope);
        const files = await hydrate([snapshot.file_id]);
        expect(files.map((file) => file.file_id)).toEqual([snapshot.file_id]);
        expect(files[0].metadata?.codeDestination).toBe(true);
        expect(files[0].metadata?.codeEnvRef).toBeUndefined();
        expect(files[0].metadata?.codeEnvRefs).toBeUndefined();
        expect(await hydrate(['not-in-thread'])).toEqual([]);
        expect(
          await hydrate([snapshot.file_id], {
            ...snapshot,
            userId: new mongoose.Types.ObjectId().toString(),
          }),
        ).toEqual([]);
        expect(await hydrate([snapshot.file_id], { ...snapshot, tenantId: 'tenant-b' })).toEqual(
          [],
        );
        if (context === FileContext.execute_code) {
          expect(await hydrate([snapshot.file_id], snapshot, 'other-conversation')).toEqual([]);
        } else {
          const deferred = await fileMethods.getDeferredProvisionFiles(
            [snapshot.file_id],
            snapshot,
            { code: true },
          );
          expect(deferred.map((file) => file.file_id)).toEqual([snapshot.file_id]);
        }
        await File.updateOne(
          { file_id: snapshot.file_id },
          { $set: { 'metadata.codeDestination': false } },
        );
        expect(await hydrate([snapshot.file_id])).toEqual([]);
        await File.updateOne(
          { file_id: snapshot.file_id },
          { $unset: { 'metadata.codeDestination': '' } },
        );
        expect(await hydrate([snapshot.file_id])).toEqual([]);
      },
    );

    it.each([
      {},
      { executionProfile: 'default' as const },
      { executionProfile: 'stateful' as const },
    ])('clears legacy-only refs and queues the missing route: %p', async (routeFields) => {
      const ref: CodeEnvRef = {
        kind: 'user',
        id: user.toString(),
        storage_session_id: 'legacy-session',
        file_id: 'legacy-remote',
        ...routeFields,
      };
      await seed({ metadata: { ...metadata, codeEnvRef: ref, codeEnvRefs: undefined } });
      const routeKey = ref.executionProfile ?? 'default';
      expect(
        await fileMethods.getDeferredProvisionFiles([snapshot.file_id], snapshot, {
          code: true,
          codeRouteKey: routeKey,
        }),
      ).toEqual([]);
      expect(
        await fileMethods.clearFileCodeEnvRefs({ ...snapshot, refs: [{ routeKey, ref }] }),
      ).toBe(true);
      const deferred = await fileMethods.getDeferredProvisionFiles([snapshot.file_id], snapshot, {
        code: true,
        codeRouteKey: routeKey,
      });
      expect(deferred.map((file) => file.file_id)).toEqual([snapshot.file_id]);
      expect(deferred[0].llmDeliveryPath).toBe('none');
      expect(deferred[0].metadata?.destinationChosen).toBe(true);
    });

    it('persists each copy without mutating input or invalidating the embedding snapshot', async () => {
      await seed({
        embeddingOwnersComplete: true,
        embeddingOwnersTrackedAt: new Date('2026-10-20'),
      });
      const input = structuredClone(snapshot);
      expect(await fileMethods.clearFileCodeEnvRefs(snapshot)).toBe(true);
      expect(
        await fileMethods.clearFileCodeEnvRefs({
          ...snapshot,
          refs: [{ routeKey: 'stateful:a', ref: statefulRef }],
        }),
      ).toBe(true);
      expect(snapshot).toEqual(input);
      expect(
        await fileMethods.clearFileEmbeddings({
          ...snapshot,
          updatedAt,
          embeddedEntities: metadata.embeddedEntities,
          ownershipTrackingStart: '2026-10-19T00:00:00.000Z',
        }),
      ).toBe(true);
      const stored = await read();
      expect(stored?.updatedAt).toEqual(updatedAt);
      expect(stored?.embedded).toBe(false);
      expect(stored?.metadata?.codeEnvRefs).toEqual({});
    });

    it.each([
      { userId: new mongoose.Types.ObjectId().toString() },
      { tenantId: 'tenant-b' },
      { tenantId: undefined },
    ])('returns false without changing an unauthorized file: %p', async (scope) => {
      await seed({
        embeddingOwnersComplete: true,
        embeddingOwnersTrackedAt: new Date('2026-10-20'),
      });
      const before = await read();
      expect(await fileMethods.clearFileCodeEnvRefs({ ...snapshot, ...scope })).toBe(false);
      expect(await read()).toEqual(before);
    });

    it.each([false, true])('scopes legacy missing/null tenants explicitly: %s', async (missing) => {
      const foreign = await seed();
      const local = await seed({ tenantId: null });
      if (missing) {
        await File.collection.updateOne({ _id: local.insertedId }, { $unset: { tenantId: '' } });
      }
      expect(await fileMethods.clearFileCodeEnvRefs({ ...snapshot, tenantId: undefined })).toBe(
        true,
      );
      const records = await File.collection.find({ file_id: snapshot.file_id }).toArray();
      expect(records.find((record) => record._id.equals(foreign.insertedId))?.metadata).toEqual(
        metadata,
      );
      expect(
        records.find((record) => record._id.equals(local.insertedId))?.metadata?.codeEnvRefs,
      ).toEqual({ 'stateful:a': statefulRef });
    });

    it.each([{ tenantId: 'tenant-b' }, { tenantId: undefined }])(
      'does not let tenant middleware replace the caller scope: %p',
      async (scope) => {
        await seed({
          embeddingOwnersComplete: true,
          embeddingOwnersTrackedAt: new Date('2026-10-20'),
        });
        const before = await read();
        const cleared = await tenantStorage.run({ tenantId: snapshot.tenantId }, () =>
          fileMethods.clearFileCodeEnvRefs({ ...snapshot, ...scope }),
        );
        expect(cleared).toBe(false);
        expect(await read()).toEqual(before);
      },
    );

    it('confirms no code refs remain for empty or already-cleared snapshots', async () => {
      expect(await fileMethods.clearFileCodeEnvRefs(snapshot)).toBe(false);
      await seed({ metadata: {} });
      expect(await fileMethods.clearFileCodeEnvRefs({ ...snapshot, refs: [] })).toBe(true);
      expect(await fileMethods.clearFileCodeEnvRefs(snapshot)).toBe(true);
      expect(
        await fileMethods.clearFileCodeEnvRefs({ ...snapshot, file_id: 'missing', refs: [] }),
      ).toBe(false);
    });

    it.each(['metadata.codeEnvRef', 'metadata.codeEnvRefs.default'])(
      'rejects a primary-code-only replacement at %s',
      async (path) => {
        await seed({
          source: 'execute_code',
          context: FileContext.execute_code,
          embedded: false,
          metadata: {},
        });
        const replacement = { ...defaultRef, provisionedAt: 124 };
        await File.collection.updateOne(
          { file_id: snapshot.file_id },
          { $set: { [path]: replacement } },
        );
        const before = await read();
        expect(await fileMethods.clearFileCodeEnvRefs(snapshot)).toBe(false);
        expect(await read()).toEqual(before);
      },
    );

    it.each([false, true])(
      'returns false when only one route or alias snapshot matches: %s',
      async (aliasMatches) => {
        const replacement = { ...defaultRef, provisionedAt: 124 };
        await seed({
          metadata: {
            codeEnvRef: aliasMatches ? defaultRef : replacement,
            codeEnvRefs: { default: aliasMatches ? replacement : defaultRef },
          },
        });
        expect(await fileMethods.clearFileCodeEnvRefs(snapshot)).toBe(false);
        const stored = await read();
        expect(stored?.metadata?.codeEnvRef).toEqual(aliasMatches ? undefined : replacement);
        expect(stored?.metadata?.codeEnvRefs).toEqual(aliasMatches ? { default: replacement } : {});
        expect(stored?.updatedAt).toEqual(updatedAt);
      },
    );

    it.each([defaultRef, statefulRef])(
      'rejects an empty snapshot while any canonical or legacy code ref remains: %p',
      async (ref) => {
        await seed({ metadata: { codeEnvRef: ref } });
        expect(await fileMethods.clearFileCodeEnvRefs({ ...snapshot, refs: [] })).toBe(false);
        await File.collection.updateOne(
          { file_id: snapshot.file_id },
          { $set: { metadata: { codeEnvRefs: { unknown: ref } } } },
        );
        expect(await fileMethods.clearFileCodeEnvRefs({ ...snapshot, refs: [] })).toBe(false);
      },
    );

    it('propagates the final metadata read failure after writes settle', async () => {
      await seed();
      jest.spyOn(mongoose.models.File, 'findOne').mockImplementationOnce(() => {
        throw new Error('metadata read unavailable');
      });
      await expect(fileMethods.clearFileCodeEnvRefs(snapshot)).rejects.toThrow(
        'metadata read unavailable',
      );
      expect((await read())?.metadata?.codeEnvRef).toBeUndefined();
      expect((await read())?.metadata?.codeEnvRefs).toEqual({ 'stateful:a': statefulRef });
    });

    it.each(['', 'stateful.invalid', '$stateful'])(
      'rejects invalid route keys: %s',
      async (routeKey) => {
        await seed();
        const before = await read();
        await expect(
          fileMethods.clearFileCodeEnvRefs({
            ...snapshot,
            refs: [...snapshot.refs, { routeKey, ref: statefulRef }],
          }),
        ).rejects.toThrow('Invalid code environment route key');
        expect(await read()).toEqual(before);
      },
    );

    it('settles sibling writes before propagating a persistence failure', async () => {
      await seed();
      let finishWrite: () => void = () => undefined;
      const pendingWrite = new Promise<void>((resolve) => {
        finishWrite = resolve;
      });
      const failure = new Error('mongo unavailable');
      const updateOne = File.collection.updateOne.bind(File.collection);
      jest.spyOn(File.collection, 'updateOne').mockImplementation(async (...args) => {
        const operation = args[1];
        if (
          operation != null &&
          !Array.isArray(operation) &&
          operation.$unset?.['metadata.codeEnvRefs.default'] !== undefined
        ) {
          throw failure;
        }
        await pendingWrite;
        return updateOne(...args);
      });
      const find = jest.spyOn(mongoose.models.File, 'findOne');
      let returned = false;
      const clearing = fileMethods.clearFileCodeEnvRefs(snapshot).catch((error: Error) => {
        returned = true;
        return error;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      try {
        expect(returned).toBe(false);
      } finally {
        finishWrite();
      }
      expect(await clearing).toBe(failure);
      expect(find).not.toHaveBeenCalled();
      const stored = await read();
      expect(stored?.metadata?.codeEnvRef).toBeUndefined();
      expect(stored?.metadata?.codeEnvRefs?.default).toEqual(defaultRef);
      expect(stored?.metadata?.codeDestination).toBe(true);
    });

    it('propagates persistence failures', async () => {
      await seed();
      const before = await read();
      jest.spyOn(mongoose.models.File, 'updateOne').mockImplementation(() => {
        throw new Error('mongo unavailable');
      });
      await expect(fileMethods.clearFileCodeEnvRefs(snapshot)).rejects.toThrow('mongo unavailable');
      expect(await read()).toEqual(before);
    });
  });

  describe('clearFileEmbeddings', () => {
    const user = new mongoose.Types.ObjectId();
    const updatedAt = new Date('2026-10-20T00:00:00Z');
    const snapshot = {
      ownershipTrackingStart: '2026-10-19T00:00:00.000Z',
      file_id: 'retained-file',
      userId: user.toString(),
      tenantId: 'tenant-a',
      updatedAt,
      embeddedEntities: ['agent-a', 'agent-b'],
    };
    const seed = (overrides = {}) =>
      File.collection.insertOne({
        file_id: snapshot.file_id,
        user,
        tenantId: snapshot.tenantId,
        updatedAt,
        embedded: true,
        embeddingOwnersComplete: true,
        embeddingOwnersTrackedAt: new Date('2026-10-20'),
        metadata: {
          embeddedEntities: snapshot.embeddedEntities,
          codeEnvRef: { file_id: 'still-needed' },
          destinationChosen: true,
        },
        ...overrides,
      });

    it('preserves code references, TTL and retry bookkeeping', async () => {
      const expiredAt = new Date('2026-10-19');
      await seed({ expiredAt, deletionAttempts: 3 });
      expect(await fileMethods.clearFileEmbeddings(snapshot)).toBe(true);
      expect(await fileMethods.clearFileEmbeddings(snapshot)).toBe(true);
      const stored = await File.collection.findOne({ file_id: snapshot.file_id });
      expect(stored?.embedded).toBe(false);
      expect(stored?.metadata).toEqual({
        codeEnvRef: { file_id: 'still-needed' },
        destinationChosen: true,
        searchDestination: true,
      });
      expect(stored?.updatedAt).toEqual(updatedAt);
      expect(stored?.expiredAt).toEqual(expiredAt);
      expect(stored?.deletionAttempts).toBe(3);
    });

    it.each([true, false, undefined])(
      'retains search intent independently of the chooser marker %s',
      async (destinationChosen) => {
        await seed({
          metadata: {
            embeddedEntities: snapshot.embeddedEntities,
            ...(destinationChosen !== undefined ? { destinationChosen } : {}),
          },
        });
        expect(await fileMethods.clearFileEmbeddings(snapshot)).toBe(true);
        const files = await fileMethods.getFiles({ file_id: snapshot.file_id });
        expect(files?.[0]?.embedded).toBe(false);
        expect(files?.[0]?.metadata?.searchDestination).toBe(true);
        expect(files?.[0]?.metadata?.embeddedEntities).toBeUndefined();
        expect(files?.[0]?.metadata?.destinationChosen).toBe(destinationChosen);
      },
    );

    it('persists the optional intent through the file schema and ordinary reads', async () => {
      await File.create({
        file_id: snapshot.file_id,
        user,
        filename: 'notes.pdf',
        filepath: '/uploads/notes.pdf',
        type: 'application/pdf',
        bytes: 1024,
        embedded: false,
        metadata: { searchDestination: true },
      });
      const files = await fileMethods.getFiles({ file_id: snapshot.file_id });
      expect(files?.[0]?.metadata?.searchDestination).toBe(true);
      expect(files?.[0]?.metadata?.destinationChosen).toBeUndefined();
    });

    it('does not change a concurrent embedding or a reused file record', async () => {
      await seed({ updatedAt: new Date(updatedAt.getTime() + 1) });
      expect(await fileMethods.clearFileEmbeddings(snapshot)).toBe(false);
      const stored = await File.collection.findOne({ file_id: snapshot.file_id });
      expect(stored?.embedded).toBe(true);
      expect(stored?.metadata?.embeddedEntities).toEqual(snapshot.embeddedEntities);
    });

    it('does not discard a newly recorded namespace even when its timestamp matches', async () => {
      await seed({ metadata: { embeddedEntities: ['agent-a', 'agent-b', 'agent-c'] } });
      expect(await fileMethods.clearFileEmbeddings(snapshot)).toBe(false);
      const stored = await File.collection.findOne({ file_id: snapshot.file_id });
      expect(stored?.metadata?.embeddedEntities).toHaveLength(3);
    });

    it('matches the owner and tenant rather than a bare file id', async () => {
      const first = await seed();
      await seed({ user: new mongoose.Types.ObjectId() });
      await seed({ tenantId: 'tenant-b' });
      await seed({ tenantId: undefined });
      expect(await fileMethods.clearFileEmbeddings(snapshot)).toBe(true);
      const records = await File.collection.find({ file_id: snapshot.file_id }).toArray();
      const clearedIds = records
        .filter((record) => record.embedded === false)
        .map((record) => record._id);
      expect(clearedIds).toEqual([first.insertedId]);
    });

    it.each([null, undefined])(
      'clears only the untenanted row during system reconciliation: %p',
      async (tenantId) => {
        const foreign = await seed();
        const local = await seed({ tenantId });
        const before = await File.collection.findOne({ _id: foreign.insertedId });
        expect(
          await runAsSystem(() => fileMethods.clearFileEmbeddings({ ...snapshot, tenantId })),
        ).toBe(true);
        expect(await File.collection.findOne({ _id: foreign.insertedId })).toEqual(before);
        const stored = await File.collection.findOne({ _id: local.insertedId });
        expect(stored?.embedded).toBe(false);
        expect(stored?.metadata?.embeddedEntities).toBeUndefined();
        expect(stored?.metadata?.searchDestination).toBe(true);
        expect(stored?.updatedAt).toEqual(updatedAt);
      },
    );

    it.each([null, undefined, 'tenant-b'])(
      'does not clear a tenant row for a mismatched system scope: %p',
      async (tenantId) => {
        const seeded = await seed();
        const before = await File.collection.findOne({ _id: seeded.insertedId });
        expect(
          await runAsSystem(() => fileMethods.clearFileEmbeddings({ ...snapshot, tenantId })),
        ).toBe(false);
        expect(await File.collection.findOne({ _id: seeded.insertedId })).toEqual(before);
      },
    );

    it.each([null, undefined, 'tenant-b'])(
      'does not let embedding tenant middleware replace the caller scope: %p',
      async (tenantId) => {
        const seeded = await seed();
        const before = await File.collection.findOne({ _id: seeded.insertedId });
        expect(
          await tenantStorage.run({ tenantId: snapshot.tenantId }, () =>
            fileMethods.clearFileEmbeddings({ ...snapshot, tenantId }),
          ),
        ).toBe(false);
        expect(await File.collection.findOne({ _id: seeded.insertedId })).toEqual(before);
      },
    );

    it('clears fully tracked unscoped vector flags without an entity list', async () => {
      await seed({ metadata: { destinationChosen: true } });
      const legacy = { ...snapshot, embeddedEntities: undefined };
      expect(await fileMethods.clearFileEmbeddings(legacy)).toBe(true);
    });

    it('retains search intent on fully tracked records without metadata', async () => {
      await File.collection.insertOne({
        file_id: snapshot.file_id,
        user,
        tenantId: snapshot.tenantId,
        updatedAt,
        embedded: true,
        embeddingOwnersComplete: true,
        embeddingOwnersTrackedAt: new Date('2026-10-20'),
      });
      expect(
        await fileMethods.clearFileEmbeddings({ ...snapshot, embeddedEntities: undefined }),
      ).toBe(true);
      const stored = await File.collection.findOne({ file_id: snapshot.file_id });
      expect(stored?.embedded).toBe(false);
      expect(stored?.metadata).toEqual({ searchDestination: true });
    });

    it('propagates persistence failures instead of claiming reconciliation', async () => {
      await seed();
      const update = jest.spyOn(mongoose.models.File, 'updateOne').mockImplementationOnce(() => {
        throw new Error('mongo unavailable');
      });
      try {
        await expect(fileMethods.clearFileEmbeddings(snapshot)).rejects.toThrow(
          'mongo unavailable',
        );
      } finally {
        update.mockRestore();
      }
      expect((await File.collection.findOne({ file_id: snapshot.file_id }))?.embedded).toBe(true);
    });
  });

  describe('final file storage snapshot', () => {
    const user = new mongoose.Types.ObjectId();
    const updatedAt = new Date('2026-10-20');
    const snapshot = {
      file_id: 'cleanup-race',
      user,
      tenantId: 'tenant-a',
      updatedAt,
      source: 'local',
    };
    const options = { files: [snapshot], userId: user.toString() };
    const check = { ...snapshot, userId: user.toString() };
    const seed = (overrides = {}) => File.collection.insertOne({ ...snapshot, ...overrides });

    it('confirms a cleared snapshot and removes only its matching owned row', async () => {
      await seed({ embedded: false, metadata: { codeEnvRefs: {}, codeDestination: true } });
      await seed({ tenantId: 'tenant-b' });
      expect(await fileMethods.isFileStorageClean(check)).toBe(true);
      expect(await fileMethods.deleteFiles([snapshot.file_id], undefined, options)).toEqual({
        deletedCount: 1,
        deletedFileIds: [snapshot.file_id],
        failedFileIds: [],
      });
      expect(await File.collection.countDocuments({ file_id: snapshot.file_id })).toBe(1);
      expect(await fileMethods.isFileStorageClean(check)).toBe(false);
      expect(await fileMethods.deleteFiles([snapshot.file_id], undefined, options)).toEqual({
        deletedCount: 0,
        deletedFileIds: [snapshot.file_id],
        failedFileIds: [],
      });
    });

    it.each([
      { metadata: { codeEnvRefs: { default: { file_id: 'replacement' } } } },
      { metadata: { codeEnvRef: { file_id: 'replacement' } } },
      { embedded: true, metadata: { embeddedEntities: ['new-namespace'] } },
      { updatedAt: new Date(updatedAt.getTime() + 1) },
    ])(
      'retains a reprovisioned row and reports incomplete metadata deletion: %p',
      async (change) => {
        await seed();
        expect(await fileMethods.isFileStorageClean(check)).toBe(true);
        await File.collection.updateOne({ file_id: snapshot.file_id }, { $set: change });
        const before = await File.collection.findOne({ file_id: snapshot.file_id });
        expect(await fileMethods.isFileStorageClean(check)).toBe(false);
        await expect(
          fileMethods.deleteFiles([snapshot.file_id], undefined, options),
        ).resolves.toEqual({
          deletedCount: 0,
          deletedFileIds: [],
          failedFileIds: [snapshot.file_id],
        });
        expect(await File.collection.findOne({ file_id: snapshot.file_id })).toEqual(before);
      },
    );

    it('does not delete a copy attached between the metadata read and conditional delete', async () => {
      await seed();
      const deleteMany = File.collection.deleteMany.bind(File.collection);
      jest
        .spyOn(File.collection, 'deleteMany')
        .mockImplementationOnce(async (filter, deleteOptions) => {
          await File.collection.updateOne(
            { file_id: snapshot.file_id },
            { $set: { 'metadata.codeEnvRefs.default': { file_id: 'late-copy' } } },
          );
          return deleteMany(filter, deleteOptions);
        });
      await expect(
        fileMethods.deleteFiles([snapshot.file_id], undefined, options),
      ).resolves.toEqual({
        deletedCount: 0,
        deletedFileIds: [],
        failedFileIds: [snapshot.file_id],
      });
      const stored = await File.collection.findOne({ file_id: snapshot.file_id });
      expect(stored?.metadata?.codeEnvRefs?.default?.file_id).toBe('late-copy');
    });

    it('returns both receipt arrays without touching the database for an empty guarded batch', async () => {
      const find = jest.spyOn(mongoose.models.File, 'find');
      const remove = jest.spyOn(mongoose.models.File, 'deleteMany');
      expect(await fileMethods.deleteFiles([], undefined, options)).toEqual({
        deletedCount: 0,
        deletedFileIds: [],
        failedFileIds: [],
      });
      expect(find).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
    });

    it('detaches only confirmed successes after a mixed conditional delete in system scope', async () => {
      const successful = { ...snapshot, file_id: 'cleanup-success' };
      await seed();
      await seed(successful);
      const ChatProject = mongoose.models.ChatProject as mongoose.Model<IChatProject>;
      const ids = [snapshot.file_id, successful.file_id];
      const project = await ChatProject.collection.insertOne({
        user: user.toString(),
        tenantId: snapshot.tenantId,
        file_ids: ids,
        contextRevision: 4,
      });
      const otherTenant = await ChatProject.collection.insertOne({
        user: user.toString(),
        tenantId: 'tenant-b',
        file_ids: ids,
        contextRevision: 4,
      });
      const deleteMany = File.collection.deleteMany.bind(File.collection);
      jest
        .spyOn(File.collection, 'deleteMany')
        .mockImplementationOnce(async (filter, deleteOptions) => {
          await File.collection.updateOne(
            { file_id: snapshot.file_id },
            { $set: { 'metadata.codeEnvRefs.default': { file_id: 'late-copy' } } },
          );
          return deleteMany(filter, deleteOptions);
        });
      expect(
        await runAsSystem(() =>
          fileMethods.deleteFiles(ids, undefined, { ...options, files: [snapshot, successful] }),
        ),
      ).toEqual({
        deletedCount: 1,
        deletedFileIds: [successful.file_id],
        failedFileIds: [snapshot.file_id],
      });
      expect(await File.collection.findOne({ file_id: successful.file_id })).toBeNull();
      expect(
        (await File.collection.findOne({ file_id: snapshot.file_id }))?.metadata?.codeEnvRefs,
      ).toEqual({ default: { file_id: 'late-copy' } });
      expect(await ChatProject.collection.findOne({ _id: project.insertedId })).toMatchObject({
        file_ids: [snapshot.file_id],
        contextRevision: 5,
      });
      expect(await ChatProject.collection.findOne({ _id: otherTenant.insertedId })).toMatchObject({
        file_ids: ids,
        contextRevision: 4,
      });
    });

    it.each([undefined, null, 'tenant-a'])(
      'detaches already-absent input only from its snapshot owner and tenant: %s',
      async (tenantId) => {
        const ChatProject = mongoose.models.ChatProject as mongoose.Model<IChatProject>;
        const project = await ChatProject.collection.insertOne({
          user: user.toString(),
          ...(tenantId === undefined ? {} : { tenantId }),
          file_ids: [snapshot.file_id],
          contextRevision: 1,
        });
        const otherTenant = await ChatProject.collection.insertOne({
          user: user.toString(),
          tenantId: 'tenant-b',
          file_ids: [snapshot.file_id],
          contextRevision: 1,
        });
        const otherOwner = await ChatProject.collection.insertOne({
          user: new mongoose.Types.ObjectId().toString(),
          tenantId,
          file_ids: [snapshot.file_id],
          contextRevision: 1,
        });
        expect(
          await runAsSystem(() =>
            fileMethods.deleteFiles([snapshot.file_id], undefined, {
              userId: new mongoose.Types.ObjectId().toString(),
              files: [{ ...snapshot, tenantId }],
            }),
          ),
        ).toEqual({ deletedCount: 0, deletedFileIds: [snapshot.file_id], failedFileIds: [] });
        expect(await ChatProject.collection.findOne({ _id: project.insertedId })).toMatchObject({
          file_ids: [],
          contextRevision: 2,
        });
        for (const inserted of [otherTenant, otherOwner]) {
          expect(await ChatProject.collection.findOne({ _id: inserted.insertedId })).toMatchObject({
            file_ids: [snapshot.file_id],
            contextRevision: 1,
          });
        }
      },
    );

    it('does not delete a replacement row that was absent from the candidate read', async () => {
      await seed();
      const deleteMany = File.collection.deleteMany.bind(File.collection);
      jest
        .spyOn(File.collection, 'deleteMany')
        .mockImplementationOnce(async (filter, deleteOptions) => {
          await deleteMany({ file_id: snapshot.file_id });
          await seed();
          return deleteMany(filter, deleteOptions);
        });
      expect(await fileMethods.deleteFiles([snapshot.file_id], undefined, options)).toEqual({
        deletedCount: 0,
        deletedFileIds: [],
        failedFileIds: [snapshot.file_id],
      });
      expect(await File.collection.countDocuments({ file_id: snapshot.file_id })).toBe(1);
    });

    it('propagates operational database failures rather than issuing a receipt', async () => {
      jest
        .spyOn(File.collection, 'deleteMany')
        .mockRejectedValueOnce(new Error('mongo unavailable'));
      await expect(fileMethods.deleteFiles([snapshot.file_id], undefined, options)).rejects.toThrow(
        'mongo unavailable',
      );
    });

    it('returns the successful receipt when best-effort project cleanup fails', async () => {
      await seed();
      jest.spyOn(mongoose.models.ChatProject, 'updateMany').mockImplementationOnce(() => {
        throw new Error('cleanup failed');
      });
      expect(await fileMethods.deleteFiles([snapshot.file_id], undefined, options)).toEqual({
        deletedCount: 1,
        deletedFileIds: [snapshot.file_id],
        failedFileIds: [],
      });
      expect(await File.collection.findOne({ file_id: snapshot.file_id })).toBeNull();
    });

    it('rejects an unknown id before attempting deletion', async () => {
      const remove = jest.spyOn(mongoose.models.File, 'deleteMany');
      await expect(fileMethods.deleteFiles(['unknown'], undefined, options)).rejects.toThrow(
        'Missing file deletion snapshot',
      );
      expect(remove).not.toHaveBeenCalled();
    });

    it.each([FileSources.openai, FileSources.azure])(
      'permits an authorized missing %s record but never a changed local snapshot',
      async (source) => {
        const providerOnly = { ...check, source, allowMissingFileRecord: true };
        expect(await fileMethods.isFileStorageClean({ ...check, source })).toBe(false);
        expect(await fileMethods.isFileStorageClean(providerOnly)).toBe(true);
        await seed({ source, metadata: { codeEnvRefs: { default: { file_id: 'new-copy' } } } });
        expect(await fileMethods.isFileStorageClean(providerOnly)).toBe(false);
        await File.collection.updateOne(
          { file_id: snapshot.file_id },
          { $unset: { metadata: '' }, $set: { updatedAt: new Date(updatedAt.getTime() + 1) } },
        );
        expect(await fileMethods.isFileStorageClean(providerOnly)).toBe(false);
      },
    );

    it('does not allow missing local records through the provider-only exception', async () => {
      expect(await fileMethods.isFileStorageClean({ ...check, allowMissingFileRecord: true })).toBe(
        false,
      );
    });

    it('accepts primary vector cleanup only for its original namespace snapshot', async () => {
      const vector = {
        ...snapshot,
        source: 'vectordb',
        embedded: true,
        metadata: { embeddedEntities: ['original'] },
      };
      await seed(vector);
      const primary = {
        ...check,
        source: vector.source,
        embedded: true,
        embeddedEntities: ['original'],
      };
      expect(await fileMethods.isFileStorageClean(primary)).toBe(true);
      await File.collection.updateOne(
        { file_id: snapshot.file_id },
        { $set: { 'metadata.embeddedEntities': ['replacement'] } },
      );
      expect(await fileMethods.isFileStorageClean(primary)).toBe(false);
      await expect(
        fileMethods.deleteFiles([snapshot.file_id], undefined, { ...options, files: [vector] }),
      ).resolves.toEqual({
        deletedCount: 0,
        deletedFileIds: [],
        failedFileIds: [snapshot.file_id],
      });
    });
  });

  describe('adoptLegacySearchEmbeddings', () => {
    const Agent = () => mongoose.models.Agent as mongoose.Model<unknown>;
    const author = new mongoose.Types.ObjectId();

    const createAgent = (id: string, searchFileIds: string[]) =>
      Agent().create({
        id,
        name: id,
        provider: 'openai',
        model: 'gpt-4o',
        author,
        tool_resources: { [EToolResources.file_search]: { file_ids: searchFileIds } },
      });

    const createLegacyFile = (
      fileId: string,
      metadata?: Record<string, unknown>,
      owner: mongoose.Types.ObjectId = author,
    ) =>
      File.create({
        file_id: fileId,
        user: owner,
        filename: `${fileId}.pdf`,
        filepath: `/uploads/${fileId}.pdf`,
        type: 'application/pdf',
        bytes: 1024,
        embedded: true,
        context: FileContext.agents,
        ...(metadata ? { metadata } : {}),
      });

    afterEach(async () => {
      await Agent().deleteMany({});
    });

    it('records the namespace of a verified legacy file', async () => {
      const fileId = uuidv4();
      await createAgent('agent_owner', [fileId]);
      await createLegacyFile(fileId);

      const adopted = await fileMethods.adoptLegacySearchEmbeddings({
        files: [{ file_id: fileId, user: author.toString() }],
        agentId: 'agent_owner',
      });

      expect(adopted).toEqual([fileId]);
      const stored = (await File.findOne({ file_id: fileId }).lean()) as IMongoFile | null;
      expect(stored?.metadata?.embeddedEntities).toEqual(['agent_owner']);
    });

    it('does not touch a tenant record that shares an untenanted file_id', async () => {
      const fileId = uuidv4();
      await File.collection.insertOne({
        file_id: fileId,
        user: author,
        tenantId: 'tenant-b',
        filename: `${fileId}.pdf`,
        filepath: `/uploads/${fileId}.pdf`,
        type: 'application/pdf',
        bytes: 1024,
        embedded: true,
        context: FileContext.agents,
        object: 'file',
        usage: 0,
      });
      /* Inserted second, so an unscoped match would land on the tenant record first. */
      await createLegacyFile(fileId);

      const adopted = await fileMethods.adoptLegacySearchEmbeddings({
        files: [{ file_id: fileId, user: author.toString() }],
        agentId: 'agent_owner',
      });

      expect(adopted).toEqual([fileId]);
      const tenantRecord = await File.collection.findOne({ file_id: fileId, tenantId: 'tenant-b' });
      expect(tenantRecord?.metadata?.embeddedEntities).toBeUndefined();
      const untenanted = (await File.findOne({
        file_id: fileId,
        tenantId: { $exists: false },
      }).lean()) as IMongoFile | null;
      expect(untenanted?.metadata?.embeddedEntities).toEqual(['agent_owner']);
    });

    it("does not touch another owner's record that shares the file_id", async () => {
      const fileId = uuidv4();
      const otherOwner = new mongoose.Types.ObjectId();
      await createAgent('agent_owner', [fileId]);
      await createLegacyFile(fileId);
      await createLegacyFile(fileId, undefined, otherOwner);

      const adopted = await fileMethods.adoptLegacySearchEmbeddings({
        files: [{ file_id: fileId, user: author.toString() }],
        agentId: 'agent_owner',
      });

      expect(adopted).toEqual([fileId]);
      const foreign = (await File.findOne({
        file_id: fileId,
        user: otherOwner,
      }).lean()) as IMongoFile | null;
      expect(foreign?.metadata?.embeddedEntities).toBeUndefined();
    });

    it('reports a file a concurrent turn already adopted for the same agent', async () => {
      const fileId = uuidv4();
      await createAgent('agent_owner', [fileId]);
      await createLegacyFile(fileId, { embeddedEntities: ['agent_owner'] });

      const adopted = await fileMethods.adoptLegacySearchEmbeddings({
        files: [{ file_id: fileId, user: author.toString() }],
        agentId: 'agent_owner',
      });

      expect(adopted).toEqual([fileId]);
    });

    it('reports a committed adoption when a sibling write fails', async () => {
      const adoptedId = uuidv4();
      const failingId = uuidv4();
      await createAgent('agent_owner', [adoptedId, failingId]);
      await createLegacyFile(adoptedId);
      await createLegacyFile(failingId);
      const original = File.findOneAndUpdate.bind(File);
      const spy = jest
        .spyOn(File, 'findOneAndUpdate')
        .mockImplementation(((filter: { file_id?: string }, ...rest: unknown[]) =>
          filter.file_id === failingId
            ? { lean: () => Promise.reject(new Error('write failed')) }
            : (original as (...args: unknown[]) => unknown)(filter, ...rest)) as never);

      try {
        const adopted = await fileMethods.adoptLegacySearchEmbeddings({
          files: [
            { file_id: adoptedId, user: author.toString() },
            { file_id: failingId, user: author.toString() },
          ],
          agentId: 'agent_owner',
        });

        expect(adopted).toEqual([adoptedId]);
      } finally {
        spy.mockRestore();
      }
    });

    it('keeps the namespaces already recorded', async () => {
      const fileId = uuidv4();
      await createLegacyFile(fileId, { embeddedEntities: ['agent_source'] });

      const adopted = await fileMethods.adoptLegacySearchEmbeddings({
        files: [{ file_id: fileId, user: author.toString() }],
        agentId: 'agent_owner',
      });

      expect(adopted).toEqual([fileId]);
      const stored = (await File.findOne({ file_id: fileId }).lean()) as IMongoFile | null;
      expect(stored?.metadata?.embeddedEntities).toEqual(['agent_source', 'agent_owner']);
    });
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

    it('casts string owner ids in atomic pipeline upserts', async () => {
      const fileId = uuidv4();
      const userId = new mongoose.Types.ObjectId();

      const file = await fileMethods.createFile({
        file_id: fileId,
        user: userId.toString() as unknown as mongoose.Types.ObjectId,
        filename: 'owned.txt',
        filepath: '/uploads/owned.txt',
        type: 'text/plain',
        bytes: 100,
      });

      expect(file?.user).toEqual(userId);
      await expect(File.countDocuments({ file_id: fileId, user: userId })).resolves.toBe(1);
    });

    it('rejects cross-tenant mutation fields before atomic pipeline upserts', async () => {
      const userId = new mongoose.Types.ObjectId();

      await expect(
        tenantStorage.run({ tenantId: 'tenant-a' }, async () =>
          fileMethods.createFile({
            file_id: uuidv4(),
            user: userId,
            tenantId: 'tenant-b',
            filename: 'cross-tenant.txt',
            filepath: '/uploads/cross-tenant.txt',
            type: 'text/plain',
            bytes: 100,
          }),
        ),
      ).rejects.toThrow('Cross-tenant tenantId mutation is not allowed');
    });

    it('derives matching tenant ids from the tenant-scoped upsert filter', async () => {
      const fileId = uuidv4();
      const file = await tenantStorage.run({ tenantId: 'tenant-a' }, async () =>
        fileMethods.createFile({
          file_id: fileId,
          user: new mongoose.Types.ObjectId(),
          tenantId: 'tenant-a',
          filename: 'tenant-owned.txt',
          filepath: '/uploads/tenant-owned.txt',
          type: 'text/plain',
          bytes: 100,
        }),
      );

      expect(file?.tenantId).toBe('tenant-a');
      await expect(
        runAsSystem(() => File.countDocuments({ file_id: fileId, tenantId: 'tenant-a' })),
      ).resolves.toBe(1);
    });
  });

  describe('getAvailableProjectFiles', () => {
    it('retains the embedded picker index and adds a distinct search-intent partial index', () => {
      const keys = { user: 1, tenantId: 1, context: 1, _id: -1 };
      expect(File.schema.indexes()).toEqual(
        expect.arrayContaining([
          [
            keys,
            expect.objectContaining({
              name: 'project_file_picker',
              partialFilterExpression: { embedded: true },
            }),
          ],
          [
            keys,
            expect.objectContaining({
              name: 'project_file_picker_search_destination',
              partialFilterExpression: { 'metadata.searchDestination': true },
            }),
          ],
        ]),
      );
    });

    it('treats an empty tenant id as no tenant, matching project file reads', async () => {
      const userId = new mongoose.Types.ObjectId().toString();
      await File.create({
        user: userId,
        file_id: 'untenanted',
        filename: 'Untenanted.txt',
        filepath: '/uploads/untenanted',
        object: 'file',
        type: 'text/plain',
        bytes: 1,
        embedded: true,
        context: FileContext.message_attachment,
      });
      const result = await fileMethods.getAvailableProjectFiles({
        userId,
        tenantId: '',
        excludedFileIds: [],
        limit: 10,
      });
      expect(result.files.map((file) => file.file_id)).toEqual(['untenanted']);
    });

    it('paginates only eligible owner files with stable cursors and literal search', async () => {
      const userId = new mongoose.Types.ObjectId().toString();
      const now = new Date('2026-01-01T00:00:00.000Z');
      const base = {
        user: userId,
        tenantId: 'tenant-a',
        filename: 'Report excluded.txt',
        filepath: '/uploads/report',
        object: 'file',
        type: 'text/plain',
        bytes: 1,
        usage: 0,
        embedded: true,
        context: FileContext.message_attachment,
        text: 'secret',
        storageKey: 'internal-storage-key',
      };
      await File.create([
        { ...base, file_id: 'report-1', filename: 'Report [literal].txt' },
        { ...base, file_id: 'report-2', filename: 'Report two.txt' },
        {
          ...base,
          file_id: 'expired',
          expiredAt: new Date('2025-12-31T23:59:59.000Z'),
        },
        { ...base, file_id: 'foreign-tenant', tenantId: 'tenant-b' },
        { ...base, file_id: 'foreign-owner', user: new mongoose.Types.ObjectId().toString() },
        { ...base, file_id: 'agent-knowledge', context: FileContext.agents },
        { ...base, file_id: 'not-indexed', embedded: false },
        { ...base, file_id: 'attached' },
      ]);

      const first = await fileMethods.getAvailableProjectFiles({
        userId,
        tenantId: 'tenant-a',
        excludedFileIds: ['attached'],
        limit: 1,
        search: 'report',
        now,
      });
      await File.updateOne(
        { file_id: first.files[0].file_id },
        { $set: { filename: `Report ${'renamed'.repeat(100)}` } },
      );
      const second = await fileMethods.getAvailableProjectFiles({
        userId,
        tenantId: 'tenant-a',
        excludedFileIds: ['attached'],
        limit: 1,
        search: 'report',
        cursor: first.nextCursor,
        now,
      });

      expect(first.files).toHaveLength(1);
      expect(second.files).toHaveLength(1);
      expect(first.files[0].file_id).toBe('report-2');
      expect(second.files[0].file_id).toBe('report-1');
      expect(first.nextCursor).toEqual(expect.any(String));
      expect(second.nextCursor).toBeNull();
      expect(first.files[0]).not.toHaveProperty('text');
      expect(second.files[0]).not.toHaveProperty('storageKey');
      /** The picker's rows reach `@librechat/api` and the client, so the identifiers must
       *  already be plain strings rather than driver objects. */
      expect(first.files[0]).toMatchObject({ _id: expect.any(String), user: userId });
      const literalMatch = await fileMethods.getAvailableProjectFiles({
        userId,
        tenantId: 'tenant-a',
        search: '[literal]',
        now,
      });
      expect(literalMatch.files.map((file) => file.file_id)).toEqual(['report-1']);
    });

    it.each([0, 51, 1.5])('rejects an unbounded page size: %p', async (limit) => {
      await expect(
        fileMethods.getAvailableProjectFiles({
          userId: new mongoose.Types.ObjectId().toString(),
          tenantId: 'tenant-a',
          limit,
        }),
      ).rejects.toThrow('Invalid project file limit');
    });
  });

  describe('getProjectFiles', () => {
    it.each([
      { searchDestination: true, routingMimeType: 'image/heic' },
      { routingMimeType: 'image/heic' },
      { searchDestination: false },
      undefined,
    ])('preserves only routing metadata across project reads: %p', async (metadata) => {
      const userId = new mongoose.Types.ObjectId().toString();
      await File.create({
        file_id: 'converted-project-file',
        user: userId,
        tenantId: 'tenant-a',
        embedded: true,
        context: FileContext.message_attachment,
        filename: 'converted.jpeg',
        filepath: '/uploads/converted.jpeg',
        type: 'image/jpeg',
        bytes: 1,
        text: 'private extracted content',
        metadata: { ...metadata, destinationChosen: true, embeddedEntities: ['private-agent'] },
      });
      const options = { fileIds: ['converted-project-file'], userId, tenantId: 'tenant-a' };
      const [projectFile] = await fileMethods.getProjectFiles(options);
      const [withContent] = await fileMethods.getProjectFiles({ ...options, includeContent: true });
      const available = await fileMethods.getAvailableProjectFiles(options);
      for (const record of [projectFile, withContent, available.files[0]]) {
        expect(record.type).toBe('image/jpeg');
        expect(record.metadata).toEqual(metadata);
        if (metadata === undefined) {
          expect(record).not.toHaveProperty('metadata');
        }
      }
      expect(projectFile).not.toHaveProperty('text');
      expect(available.files[0]).not.toHaveProperty('text');
      expect(withContent.text).toBe('private extracted content');
    });

    it('hydrates and lists retained search intent without widening owner, tenant or context scope', async () => {
      const userId = new mongoose.Types.ObjectId().toString();
      const base = {
        user: userId,
        tenantId: 'tenant-a',
        embedded: false,
        metadata: { searchDestination: true },
        context: FileContext.message_attachment,
        filename: 'repair.txt',
        filepath: '/uploads/repair.txt',
        type: 'text/plain',
        bytes: 1,
        source: 's3',
        storageKey: 'owner/repair',
        storageRegion: 'region',
      };
      await File.create([
        { ...base, file_id: 'repair' },
        { ...base, file_id: 'foreign', user: new mongoose.Types.ObjectId().toString() },
        { ...base, file_id: 'other-tenant', tenantId: 'tenant-b' },
        { ...base, file_id: 'agent', context: FileContext.agents },
        { ...base, file_id: 'declined', metadata: { destinationChosen: true } },
      ]);
      const files = await fileMethods.getProjectFiles({
        fileIds: ['repair', 'foreign', 'other-tenant', 'agent', 'declined'],
        userId,
        tenantId: 'tenant-a',
      });
      expect(files).toEqual([
        expect.objectContaining({
          file_id: 'repair',
          embedded: false,
          metadata: { searchDestination: true },
          source: 's3',
          storageKey: 'owner/repair',
          storageRegion: 'region',
        }),
      ]);
      const available = await fileMethods.getAvailableProjectFiles({
        userId,
        tenantId: 'tenant-a',
      });
      expect(available.files.map((file) => file.file_id)).toEqual(['repair']);
    });

    it('enforces owner scope and only includes content when requested', async () => {
      const userId = new mongoose.Types.ObjectId().toString();
      await File.create([
        {
          file_id: 'project-owned',
          user: userId,
          tenantId: 'tenant-a',
          embedded: true,
          context: FileContext.message_attachment,
          filename: 'owned.txt',
          filepath: '/uploads/owned.txt',
          type: 'text/plain',
          bytes: 1,
          text: 'private project content',
        },
        {
          file_id: 'project-foreign',
          user: new mongoose.Types.ObjectId().toString(),
          tenantId: 'tenant-a',
          embedded: true,
          context: FileContext.message_attachment,
          filename: 'foreign.txt',
          filepath: '/uploads/foreign.txt',
          type: 'text/plain',
          bytes: 1,
          text: 'must not leak',
        },
      ]);

      const metadata = await fileMethods.getProjectFiles({
        fileIds: ['project-owned', 'project-foreign'],
        userId,
        tenantId: 'tenant-a',
      });
      expect(metadata.map((file) => file.file_id)).toEqual(['project-owned']);
      expect(metadata[0]).toEqual(
        expect.objectContaining({
          user: userId,
          _id: expect.any(String),
        }),
      );
      expect(metadata[0]?.updatedAt).toBeInstanceOf(Date);
      expect(metadata[0]).not.toHaveProperty('text');

      const withContent = await fileMethods.getProjectFiles({
        fileIds: ['project-owned'],
        userId,
        tenantId: 'tenant-a',
        includeContent: true,
      });
      expect(withContent[0]?.text).toBe('private project content');
    });
  });

  describe('claimCodeFile', () => {
    const fencedStates = [
      { deletionPending: true },
      { deleting: 'deletion-owner' },
      { provisioning: ['provision-owner'] },
    ];

    it.each(fencedStates)('rejects a fenced filename claim: %j', async (storageOperations) => {
      await File.init();
      const input = {
        filename: 'fenced.csv',
        conversationId: 'fenced-conversation',
        file_id: 'fenced-file',
        user: new mongoose.Types.ObjectId().toString(),
        tenantId: 'tenant-a',
        sourceDispatchedAt: 100,
      };
      await fileMethods.claimCodeFile(input);
      await File.updateOne({ file_id: input.file_id }, { $set: { storageOperations } });
      const before = await File.findOne({ file_id: input.file_id }).lean();

      await expect(
        fileMethods.claimCodeFile({
          ...input,
          file_id: 'replacement-file',
          sourceDispatchedAt: 200,
        }),
      ).rejects.toMatchObject({
        name: 'FileStorageConflictError',
        code: 'FILE_STORAGE_CONFLICT',
      });
      expect(await File.findOne({ file_id: input.file_id }).lean()).toEqual(before);
      expect(await File.countDocuments()).toBe(1);

      const independent = await fileMethods.claimCodeFile({
        ...input,
        filename: 'independent.csv',
        file_id: 'independent-file',
      });
      expect(independent.file_id).toBe('independent-file');
    });

    it.each(fencedStates)(
      'rejects commits after a storage fence is acquired: %j',
      async (storageOperations) => {
        await File.init();
        const input = {
          filename: 'late-fence.csv',
          conversationId: 'late-fence-conversation',
          file_id: 'late-fence-file',
          user: new mongoose.Types.ObjectId().toString(),
          tenantId: 'tenant-a',
          sourceDispatchedAt: 100,
        };
        await fileMethods.claimCodeFile(input);
        await File.updateOne({ file_id: input.file_id }, { $set: { storageOperations } });
        const before = await File.findOne({ file_id: input.file_id }).lean();
        const output = {
          ...input,
          context: FileContext.execute_code,
          filepath: '/uploads/new.csv',
          type: 'text/csv',
          bytes: 20,
          source: FileSources.local,
          metadata: { sourceDispatchedAt: 200 },
        };

        await expect(fileMethods.commitCodeFile(output)).rejects.toBeInstanceOf(
          FileStorageConflictError,
        );
        expect(await fileMethods.commitCodeFile(output, 200)).toBe(false);
        await expect(
          fileMethods.createFile(
            { ...output, user: new mongoose.Types.ObjectId(input.user) },
            true,
          ),
        ).rejects.toBeInstanceOf(FileStorageConflictError);
        expect(await File.findOne({ file_id: input.file_id }).lean()).toEqual(before);
        expect(await File.countDocuments()).toBe(1);
      },
    );

    it('reuses active rows with empty provisioning without changing their metadata', async () => {
      const input = {
        filename: 'active.csv',
        conversationId: 'active-conversation',
        file_id: 'active-file',
        user: new mongoose.Types.ObjectId().toString(),
        sourceDispatchedAt: 100,
      };
      await fileMethods.claimCodeFile(input);
      await File.updateOne(
        { file_id: input.file_id },
        { $set: { storageOperations: { provisioning: [], deletionPending: false } } },
      );
      const before = await File.findOne({ file_id: input.file_id }).lean();
      const claimed = await fileMethods.claimCodeFile({
        ...input,
        file_id: 'unused-file',
        sourceDispatchedAt: 200,
      });
      expect(claimed.file_id).toBe(input.file_id);
      expect(await File.findOne({ file_id: input.file_id }).lean()).toEqual(before);
    });

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

  describe('recordFileWorkspaceImport', () => {
    const makeFile = (fileId: string, ownerId: mongoose.Types.ObjectId, tenantId = 'tenant-a') =>
      runAsSystem(() =>
        fileMethods.createFile({
          file_id: fileId,
          user: ownerId,
          tenantId,
          filename: 'report.pdf',
          filepath: '/uploads/report.pdf',
          source: 'local',
          type: 'application/pdf',
          bytes: 3,
          context: FileContext.message_attachment,
          metadata: { routingMimeType: 'application/pdf' },
        }),
      );
    const keyA = 'a'.repeat(32);
    const keyB = 'b'.repeat(32);
    const copy = (path: string) => ({ sha256: 'c'.repeat(64), path });

    it('records copies and the digest without replacing sibling targets or metadata', async () => {
      const ownerId = new mongoose.Types.ObjectId();
      const fileId = uuidv4();
      await makeFile(fileId, ownerId);

      await Promise.all([
        runAsSystem(() =>
          fileMethods.recordFileWorkspaceImport({
            file_id: fileId,
            user: ownerId.toString(),
            tenantId: 'tenant-a',
            copy: { key: keyA, target: copy('.librechat/attachments/report.pdf') },
          }),
        ),
        runAsSystem(() =>
          fileMethods.recordFileWorkspaceImport({
            file_id: fileId,
            user: ownerId.toString(),
            tenantId: 'tenant-a',
            copy: { key: keyB, target: copy('.librechat/attachments/report (2).pdf') },
          }),
        ),
        runAsSystem(() =>
          fileMethods.recordFileWorkspaceImport({
            file_id: fileId,
            user: ownerId.toString(),
            tenantId: 'tenant-a',
            digest: { source: 's/o', sha256: 'c'.repeat(64), bytes: 3 },
          }),
        ),
      ]);

      const stored = await runAsSystem(() => fileMethods.findFileById(fileId));
      expect(stored?.metadata?.workspaceImports).toEqual({
        digest: { source: 's/o', sha256: 'c'.repeat(64), bytes: 3 },
        targets: {
          [keyA]: copy('.librechat/attachments/report.pdf'),
          [keyB]: copy('.librechat/attachments/report (2).pdf'),
        },
      });
      expect(stored?.metadata?.routingMimeType).toBe('application/pdf');
    });

    it("never marks another user's file", async () => {
      const ownerId = new mongoose.Types.ObjectId();
      const fileId = uuidv4();
      await makeFile(fileId, ownerId);

      const matched = await runAsSystem(() =>
        fileMethods.recordFileWorkspaceImport({
          file_id: fileId,
          user: new mongoose.Types.ObjectId().toString(),
          tenantId: 'tenant-a',
          copy: { key: keyA, target: copy('.librechat/attachments/report.pdf') },
        }),
      );

      expect(matched).toBe(false);
      const stored = await runAsSystem(() => fileMethods.findFileById(fileId));
      expect(stored?.metadata?.workspaceImports).toBeUndefined();
    });

    it("never marks the same user's record in another tenant", async () => {
      const ownerId = new mongoose.Types.ObjectId();
      const fileId = uuidv4();
      await makeFile(fileId, ownerId, 'tenant-b');

      const matched = await runAsSystem(() =>
        fileMethods.recordFileWorkspaceImport({
          file_id: fileId,
          user: ownerId.toString(),
          tenantId: 'tenant-a',
          copy: { key: keyA, target: copy('.librechat/attachments/report.pdf') },
        }),
      );

      expect(matched).toBe(false);
      const stored = await runAsSystem(() => fileMethods.findFileById(fileId));
      expect(stored?.metadata?.workspaceImports).toBeUndefined();
    });

    it('rejects a key that would address another metadata path', async () => {
      await expect(
        fileMethods.recordFileWorkspaceImport({
          file_id: uuidv4(),
          user: new mongoose.Types.ObjectId().toString(),
          copy: { key: 'targets.$where', target: copy('.librechat/attachments/report.pdf') },
        }),
      ).rejects.toThrow('hex digests');
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

    /* `prepareImageURL` clears the upload TTL with nothing but the id on every
     * reuse of an image. Project resume compatibility fingerprints canonical
     * content by `updatedAt`, so that bookkeeping must not read as a new
     * version while a real field write still must. */
    it('clears the upload TTL without posing as a content write', async () => {
      const fileId = uuidv4();
      await fileMethods.createFile({
        file_id: fileId,
        user: new mongoose.Types.ObjectId(),
        filename: 'reused.png',
        filepath: '/uploads/reused.png',
        type: 'image/png',
        bytes: 100,
      });
      const stamp = new Date('2020-01-01T00:00:00.000Z');
      await File.updateOne(
        { file_id: fileId },
        { $set: { updatedAt: stamp } },
        {
          timestamps: false,
        },
      );

      const reused = await fileMethods.updateFile({ file_id: fileId });
      expect(reused?.expiresAt).toBeUndefined();
      expect(reused?.updatedAt).toEqual(stamp);

      const rewritten = await fileMethods.updateFile({ file_id: fileId, text: 'extracted' });
      expect(rewritten?.updatedAt).not.toEqual(stamp);
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

    it('scopes usage and hold consumption without advancing the content version', async () => {
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
      const contentUpdatedAt = new Date('2020-01-01');
      await File.collection.updateOne(
        { file_id: fileId },
        { $set: { updatedAt: contentUpdatedAt } },
      );

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
      expect(allowed?.updatedAt).toEqual(contentUpdatedAt);
      const changedContent = await fileMethods.updateFile({
        file_id: fileId,
        text: 'Updated canonical file contents.',
      });
      expect(changedContent?.updatedAt?.getTime()).toBeGreaterThan(contentUpdatedAt.getTime());
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

  describe('project reference cleanup on delete', () => {
    async function seed() {
      const userId = new mongoose.Types.ObjectId();
      const ChatProject = mongoose.models.ChatProject as mongoose.Model<IChatProject>;
      const ids = [uuidv4(), uuidv4()];
      for (const fileId of ids) {
        await fileMethods.createFile({
          file_id: fileId,
          user: userId,
          filename: `${fileId}.txt`,
          filepath: `/uploads/${fileId}.txt`,
          type: 'text/plain',
          bytes: 1,
        });
      }
      const project = await ChatProject.create({
        user: userId.toString(),
        name: 'P',
        file_ids: [...ids, 'other'],
        contextRevision: 4,
      });
      const untouched = await ChatProject.create({
        user: new mongoose.Types.ObjectId().toString(),
        name: 'Q',
        file_ids: [ids[0]],
        contextRevision: 1,
      });
      return { ids, project, untouched, ChatProject };
    }

    it('pulls a deleted file from the owner projects and bumps the revision', async () => {
      const { ids, project, untouched, ChatProject } = await seed();
      await fileMethods.deleteFile(ids[0]);
      const after = await ChatProject.findById(project._id).lean();
      expect(after?.file_ids).toEqual([ids[1], 'other']);
      expect(after?.contextRevision).toBe(5);
      const other = await ChatProject.findById(untouched._id).lean();
      expect(other?.file_ids).toEqual([ids[0]]);
      expect(other?.contextRevision).toBe(1);
    });

    it('pulls every id removed by deleteFiles', async () => {
      const { ids, project, ChatProject } = await seed();
      await fileMethods.deleteFiles(ids);
      const after = await ChatProject.findById(project._id).lean();
      expect(after?.file_ids).toEqual(['other']);
      expect(after?.contextRevision).toBe(5);
    });

    it('pulls a file removed through deleteFileByFilter', async () => {
      const { ids, project, ChatProject } = await seed();
      await fileMethods.deleteFileByFilter({ file_id: ids[1] });
      const after = await ChatProject.findById(project._id).lean();
      expect(after?.file_ids).toEqual([ids[0], 'other']);
    });

    it('clears the user projects on a user-wide delete without reading the files', async () => {
      const { project, untouched, ChatProject } = await seed();
      const File = mongoose.models.File as mongoose.Model<IMongoFile>;
      const findSpy = jest.spyOn(File, 'find');
      await fileMethods.deleteFiles([], project.user);
      expect(findSpy).not.toHaveBeenCalled();
      findSpy.mockRestore();
      const after = await ChatProject.findById(project._id).lean();
      expect(after?.file_ids).toEqual([]);
      expect(after?.contextRevision).toBe(5);
      expect((await ChatProject.findById(untouched._id).lean())?.file_ids).toHaveLength(1);
    });

    it('still reports a completed delete when the project cleanup fails', async () => {
      const { ids, ChatProject } = await seed();
      const spy = jest.spyOn(ChatProject, 'updateMany').mockImplementationOnce(() => {
        throw new Error('cleanup failed');
      });
      const deleted = await fileMethods.deleteFile(ids[0]);
      spy.mockRestore();
      expect(deleted?.file_id).toBe(ids[0]);
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
