import mongoose from 'mongoose';
import { createHash, randomUUID } from 'node:crypto';
import { MongoMemoryServer, MongoMemoryReplSet } from 'mongodb-memory-server';
import { RetentionMode, Tools, MCP_APP_MIME_TYPE, EModelEndpoint } from 'librechat-data-provider';
import type { ManagedTarget } from '~/types/managed';
import {
  allocateManagedTarget,
  discardManagedAllocation,
  managedTargetFilter,
  pinManagedTarget,
  ManagedAllocationUnavailableError,
  beginManagedTargetRegistration,
  markManagedTargetRegistered,
  sweepManagedAllocations,
} from './managed';
import {
  publishResponseRoot,
  responseReference,
  responseRootFilter,
  prepareResponseRootStorage,
} from './responseRoot';
import {
  responseScopeKeys,
  closeResponseScopes,
  createResponseRetention,
  eraseResponseRecords,
} from './responseScope';
import {
  registerResponseTarget,
  settleResponseTarget,
  reconcileResponseTargets,
} from './registration';
import { createManagedConversationId, createManagedMessageId } from '~/utils/managed';
import { createResponseCheckpointStorage } from './responseCheckpoint';
import { checkpointOwnerNamespacePrefix } from '~/utils/checkpoint';
import { tenantStorage, runAsSystem } from '~/config/tenantContext';
import { createResponseScopeModel } from '~/models/responseScope';
import { applyManagedStorage } from '~/models/plugins/managed';
import { createChatProjectModel } from '~/models/chatProject';
import { createStoredResponseModel } from '~/models/response';
import { includeManagedAllocations } from '~/utils/managed';
import { createConversationMethods } from './conversation';
import { createConversationModel } from '~/models/convo';
import { createMessageModel } from '~/models/message';
import { createResponseStorage } from './response';
import { createMessageMethods } from './message';

describe('managed target allocation on real storage', () => {
  const standalone = new mongoose.Mongoose();
  const replica = new mongoose.Mongoose();
  const ferret = process.env.FERRETDB_URI ? new mongoose.Mongoose() : undefined;
  const engines: Array<readonly [string, typeof standalone]> = [
    ['standalone', standalone],
    ['replica', replica],
    ...(ferret ? [['FerretDB', ferret] as const] : []),
  ];
  let mongo: MongoMemoryServer;
  let repl: MongoMemoryReplSet;

  beforeAll(async () => {
    [mongo, repl] = await Promise.all([
      MongoMemoryServer.create({ instance: { args: ['--setParameter', 'enableTestCommands=1'] } }),
      MongoMemoryReplSet.create({
        replSet: { count: 1 },
        instanceOpts: [{ args: ['--setParameter', 'enableTestCommands=1'] }],
      }),
    ]);
    await Promise.all([
      standalone.connect(mongo.getUri(), { monitorCommands: true, retryWrites: true }),
      replica.connect(repl.getUri(), {
        monitorCommands: true,
        retryWrites: true,
        readPreference: 'secondaryPreferred',
      }),
    ]);
    if (ferret)
      await ferret.connect(process.env.FERRETDB_URI!, {
        dbName: `managed_${randomUUID().replace(/-/g, '')}`,
        retryWrites: true,
      });
    for (const [, db] of engines) {
      const Message = createMessageModel(db);
      const Conversation = createConversationModel(db);
      const Response = createStoredResponseModel(db);
      await createChatProjectModel(db).init();
      await Promise.all([Message.init(), Conversation.init(), Response.init()]);
      await Promise.all([
        Message.createIndexes(),
        Conversation.createIndexes(),
        Response.createIndexes(),
      ]);
    }
  }, 60000);

  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    await Promise.all(engines.map(([, db]) => db.disconnect()));
    await Promise.all([mongo?.stop(), repl?.stop()]);
  });

  describe.each(engines)('%s', (_name, db) => {
    const mongoOnly = db === ferret ? describe.skip : describe;
    it('removes the obsolete root TTL index and preserves expiry as a recovery index', async () => {
      const model = createStoredResponseModel(db);
      await model.collection.createIndex({ expiredAt: 1 }, { expireAfterSeconds: 0 });
      await Promise.all([prepareResponseRootStorage(db), prepareResponseRootStorage(db)]);
      const indexes = await model.listIndexes();
      expect(indexes.some((index) => index.expireAfterSeconds != null)).toBe(false);
      expect(indexes).toEqual(
        expect.arrayContaining([expect.objectContaining({ key: { expiredAt: 1, _id: 1 } })]),
      );
    });
    it('refuses activation with an unexpected autonomous root TTL without dropping it', async () => {
      const model = createStoredResponseModel(db);
      const name = await model.collection.createIndex(
        { createdAt: 1 },
        { expireAfterSeconds: 86400, name: 'unexpected_root_ttl' },
      );
      try {
        await expect(prepareResponseRootStorage(db)).rejects.toThrow('TTL index exists');
        expect((await model.listIndexes()).some((index) => index.name === name)).toBe(true);
      } finally {
        await model.collection.dropIndex(name);
      }
    });
    function rootInput() {
      return {
        userId: randomUUID(),
        responseId: createManagedMessageId(),
        requestKey: randomUUID(),
        fingerprint: createHash('sha256').update(randomUUID()).digest('hex'),
        agentId: 'agent',
        requestJSON: '{"input":"private"}',
        conversationId: createManagedConversationId(),
        parentMessageId: '00000000-0000-0000-0000-000000000000',
        dispatch: true,
      };
    }
    it('reserves one canonical response across concurrent retries without sessions or transactions', async () => {
      const storage = createResponseStorage(db);
      const input = rootInput();
      const session = jest.spyOn(db, 'startSession');
      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          storage.reserve({
            ...input,
            responseId: createManagedMessageId(),
            conversationId: createManagedConversationId(),
          }),
        ),
      );
      expect(results.every((result) => result.ok)).toBe(true);
      expect(results.filter((result) => result.ok && !result.replayed)).toHaveLength(1);
      const records = results.flatMap((result) => (result.ok ? [result.record] : []));
      expect(new Set(records.map((record) => record.storageTarget?.id)).size).toBe(1);
      expect(new Set(records.map((record) => record.conversationId)).size).toBe(1);
      expect(session).not.toHaveBeenCalled();
      const model = createStoredResponseModel(db);
      expect(await model.countDocuments({ userId: input.userId })).toBe(1);
      const ownerKey = responseScopeKeys(input, input.conversationId)[0];
      expect(
        await model.collection.countDocuments({
          userId: { $exists: false },
          '_managed.ownerKey': ownerKey,
        }),
      ).toBe(0);
      expect(await createResponseScopeModel(db).findById(ownerKey).lean()).toMatchObject({
        pendingCount: 0,
      });
    });
    it('keeps the original request unchanged when an idempotency conflict supplies a shorter deadline', async () => {
      const storage = createResponseStorage(db);
      const input = rootInput();
      const first = await storage.reserve(input);
      expect(first.ok).toBe(true);
      expect(
        await storage.reserve({
          ...input,
          fingerprint: 'different',
          expiredAt: new Date(Date.now() + 1_000),
        }),
      ).toEqual({
        ok: false,
        code: 'idempotency_conflict',
      });
      expect((await storage.read(input, input.responseId))?.expiredAt).toBeUndefined();
    });
    it('denies reservation after owner closure before allocating private response data', async () => {
      const storage = createResponseStorage(db);
      const input = rootInput();
      await closeResponseScopes(db, input);
      expect(await storage.reserve(input)).toEqual({ ok: false, code: 'response_unavailable' });
      expect(await createStoredResponseModel(db).countDocuments({ userId: input.userId })).toBe(0);
    });
    it.each(['owner', 'conversation', 'retention'] as const)(
      'erases a registered allocation before a delayed %s publication can land',
      async (kind) => {
        const storage = createResponseStorage(db);
        const input = rootInput();
        let enter!: () => void;
        let release!: () => void;
        const entered = new Promise<void>((resolve) => {
          enter = resolve;
        });
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const collection = createStoredResponseModel(db).collection;
        const publish = collection.findOneAndUpdate.bind(collection);
        jest.spyOn(collection, 'findOneAndUpdate').mockImplementationOnce(async (...args) => {
          enter();
          await gate;
          return publish(...args);
        });
        const pending = storage.reserve(input);
        await entered;
        try {
          if (kind === 'retention')
            await createResponseRetention(db)(
              input,
              input.conversationId,
              new Date(Date.now() - 1),
            );
          else
            await closeResponseScopes(
              db,
              input,
              kind === 'owner' ? undefined : [input.conversationId],
            );
          await eraseResponseRecords(
            db,
            input,
            kind === 'owner' ? undefined : [input.conversationId],
          );
        } finally {
          release();
        }
        expect(await pending).toEqual({ ok: false, code: 'response_unavailable' });
        expect(await collection.countDocuments({ userId: input.userId })).toBe(0);
        expect(await storage.read(input, input.responseId)).toBeNull();
      },
    );
    it('recovers an applied reservation after a lost publication reply without replaying allocation', async () => {
      const storage = createResponseStorage(db);
      const input = rootInput();
      const collection = createStoredResponseModel(db).collection;
      const original = collection.findOneAndUpdate.bind(collection);
      jest.spyOn(collection, 'findOneAndUpdate').mockImplementationOnce(async (...args) => {
        await original(...args);
        throw new Error('reservation publication acknowledgment lost');
      });
      expect(await storage.reserve(input)).toMatchObject({ ok: true, replayed: true });
      const first = await storage.read(input, input.responseId);
      expect(first?.storageTarget).toBeDefined();
      const replay = await storage.reserve({
        ...input,
        responseId: createManagedMessageId(),
        conversationId: createManagedConversationId(),
      });
      expect(replay).toMatchObject({
        ok: true,
        replayed: true,
        record: { storageTarget: first?.storageTarget },
      });
      expect(await createStoredResponseModel(db).countDocuments({ userId: input.userId })).toBe(1);
    });
    it('keeps a stale internal response handle bound to its deleted physical root', async () => {
      const storage = createResponseStorage(db);
      const input = rootInput();
      const first = await storage.reserve(input);
      if (!first.ok || !first.record.storageTarget) throw new Error('Reservation failed');
      await createStoredResponseModel(db).deleteOne(
        managedTargetFilter(db, first.record.storageTarget),
      );
      const replacement = await storage.reserve(input);
      if (!replacement.ok) throw new Error('Replacement fixture failed');
      expect(await storage.read(first.record, input.responseId)).toBeNull();
      expect(
        await storage.publish(first.record, input.responseId, 0, {
          status: 'in_progress',
          generationCreatedAt: 1,
          responseJSON: '{}',
        }),
      ).toEqual({ ok: false, code: 'response_conflict' });
      expect(await storage.read(input, input.responseId)).toMatchObject({
        storageTarget: replacement.record.storageTarget,
        revision: 0,
      });
    });
    it('does not restore a stale response deadline after a concurrent shortening', async () => {
      const storage = createResponseStorage(db);
      const input = rootInput();
      const first = await storage.reserve(input);
      expect(first.ok).toBe(true);
      const earlier = new Date(Date.now() + 60_000);
      const later = new Date(Date.now() + 120_000);
      const retain = createResponseRetention(db);
      const collection = createStoredResponseModel(db).collection;
      const original = collection.updateMany.bind(collection);
      let delayed = false;
      jest.spyOn(collection, 'updateMany').mockImplementation(async (...args) => {
        const expiration = Array.isArray(args[1]) ? undefined : args[1].$min?.expiredAt;
        if (!delayed && expiration instanceof Date && expiration.getTime() === later.getTime()) {
          delayed = true;
          await retain(input, input.conversationId, earlier);
        }
        return original(...args);
      });
      await retain(input, input.conversationId, later);
      expect(delayed).toBe(true);
      expect((await storage.read(input, input.responseId))?.expiredAt).toEqual(earlier);
    });
    async function checkpointFixture() {
      const target = await allocateManagedTarget(db, 'response');
      const input = rootInput();
      const record = await publishResponseRoot(db, target, input);
      if (!record) throw new Error('Root publication failed');
      const reference = responseReference(record);
      const checkpoint = {
        generationCreatedAt: Date.now(),
        providerExecutionId: randomUUID(),
        ownerId: randomUUID(),
        writerId: randomUUID(),
        namespace: `${checkpointOwnerNamespacePrefix(input.userId)}${randomUUID()}`,
        configJSON: JSON.stringify({
          type: 'mongo',
          checkpointCollectionName: 'agent_checkpoints',
          checkpointWritesCollectionName: 'agent_checkpoint_writes',
        }),
      };
      const model = createStoredResponseModel(db);
      const storage = createResponseStorage(db);
      const enrolled = await storage.enrollExecution(record, checkpoint, '{}');
      if (!enrolled.ok) throw new Error('Provider enrollment failed');
      expect(await storage.bindExecution(enrolled.record, checkpoint)).toBe(true);
      return { model, reference, checkpoint, input, record: enrolled.record, storage };
    }
    it('admits only one provider and rejects stale physical enrollment without transactions', async () => {
      const storage = createResponseStorage(db);
      const input = rootInput();
      const reserved = await storage.reserve(input);
      if (!reserved.ok) throw new Error('Reservation failed');
      const session = jest.spyOn(db, 'startSession');
      const binding = { generationCreatedAt: Date.now(), providerExecutionId: randomUUID() };
      const attempts = await Promise.all([
        storage.enrollExecution(reserved.record, binding, '{}'),
        storage.enrollExecution(
          reserved.record,
          { ...binding, providerExecutionId: randomUUID() },
          '{}',
        ),
      ]);
      expect(attempts.filter((result) => result.ok)).toHaveLength(1);
      expect(session).not.toHaveBeenCalled();
      const model = createStoredResponseModel(db);
      await model.deleteOne(responseRootFilter(db, responseReference(reserved.record)));
      const replacement = await storage.reserve(input);
      if (!replacement.ok) throw new Error('Replacement failed');
      expect(await storage.enrollExecution(reserved.record, binding, '{}')).toEqual({
        ok: false,
        code: 'response_conflict',
      });
      expect(await storage.read(input, input.responseId)).toMatchObject({ revision: 0 });
    });
    it.each(['owner', 'conversation', 'retired'] as const)(
      'denies provider enrollment after %s retirement',
      async (kind) => {
        const storage = createResponseStorage(db);
        const input = rootInput();
        const reserved = await storage.reserve(input);
        if (!reserved.ok) throw new Error('Reservation failed');
        if (kind === 'retired')
          await createStoredResponseModel(db).updateOne(
            responseRootFilter(db, responseReference(reserved.record)),
            { $set: { retiredAt: new Date() } },
          );
        else
          await closeResponseScopes(
            db,
            input,
            kind === 'owner' ? undefined : [input.conversationId],
          );
        expect(
          await storage.enrollExecution(
            reserved.record,
            {
              generationCreatedAt: Date.now(),
              providerExecutionId: randomUUID(),
            },
            '{}',
          ),
        ).toEqual({ ok: false, code: 'response_conflict' });
      },
    );
    it('fences an enrollment that already passed scope admission and scrubs the retained root', async () => {
      const storage = createResponseStorage(db);
      const input = rootInput();
      const reserved = await storage.reserve(input);
      if (!reserved.ok) throw new Error('Reservation failed');
      expect(await storage.retireExecution(reserved.record)).toBe(false);
      const model = createStoredResponseModel(db);
      const collection = model.collection;
      const original = collection.findOneAndUpdate.bind(collection);
      let fenced = false;
      jest.spyOn(collection, 'findOneAndUpdate').mockImplementationOnce(async (...args) => {
        await closeResponseScopes(db, input, [input.conversationId]);
        fenced = await storage.retireExecution(reserved.record);
        return original(...args);
      });
      expect(
        await storage.enrollExecution(
          reserved.record,
          {
            generationCreatedAt: Date.now(),
            providerExecutionId: randomUUID(),
          },
          '{}',
        ),
      ).toEqual({ ok: false, code: 'response_conflict' });
      expect(fenced).toBe(true);
      expect(await storage.read(input, input.responseId)).toBeNull();
      expect(await model.findOne({ responseId: input.responseId })).toBeNull();
      const retained = await includeManagedAllocations(
        model
          .findOne(responseRootFilter(db, responseReference(reserved.record)))
          .select('+_managed')
          .lean(),
      );
      expect(retained).toMatchObject({
        _managed: { phase: 'retired' },
        storageTarget: reserved.record.storageTarget,
      });
      expect(retained).not.toHaveProperty('requestJSON');
      expect(await storage.readCleanupIdentity(reserved.record, input.responseId)).toMatchObject({
        retirement: 'conversation_deleted',
        storageTarget: reserved.record.storageTarget,
      });
    });
    it('retains exact provider drain proof after expiry without settling checkpoint writes', async () => {
      const f = await checkpointFixture();
      const checkpointStorage = createResponseCheckpointStorage(db, f.reference, f.checkpoint);
      expect(await checkpointStorage.open()).toBe(true);
      expect(
        await f.storage.settleExecution(
          f.reference,
          { ...f.checkpoint, ownerId: randomUUID() },
          'complete',
        ),
      ).toBe(false);
      expect(
        await f.storage.settleExecution(
          f.reference,
          { ...f.checkpoint, generationCreatedAt: f.checkpoint.generationCreatedAt + 1 },
          'complete',
        ),
      ).toBe(false);
      await f.model.updateOne(responseRootFilter(db, f.reference), {
        $set: { retiredAt: new Date(), expiredAt: new Date(Date.now() - 1) },
      });
      expect(await f.storage.retireExecution(f.record)).toBe(true);
      expect(await f.storage.settleExecution(f.reference, f.checkpoint, 'complete')).toBe(true);
      expect(await f.storage.settleExecution(f.reference, f.checkpoint, 'complete')).toBe(true);
      expect(await f.storage.settleExecution(f.reference, f.checkpoint, 'error')).toBe(false);
      expect(
        await includeManagedAllocations(
          f.model
            .findOne(responseRootFilter(db, f.reference))
            .select('+providerExecution +checkpoint')
            .lean(),
        ),
      ).toMatchObject({
        providerExecution: { drained: true, outcome: 'complete' },
        checkpoint: { state: 'pending' },
      });
      expect(await f.storage.readExecutionProof(f.record)).toBeNull();
      expect(await checkpointStorage.settle()).toBe(true);
      expect(await f.storage.readExecutionProof(f.record)).toMatchObject({
        generationCreatedAt: f.checkpoint.generationCreatedAt,
        providerExecutionId: f.checkpoint.providerExecutionId,
        ownerId: f.checkpoint.ownerId,
        outcome: 'complete',
        checkpointNamespace: f.checkpoint.namespace,
        checkpointConfigJSON: f.checkpoint.configJSON,
      });
      for (const change of [
        { agentId: 'wrong-agent' },
        { conversationId: createManagedConversationId() },
        { generationCreatedAt: f.checkpoint.generationCreatedAt + 1 },
      ])
        expect(await f.storage.readExecutionProof({ ...f.record, ...change })).toBeNull();
      const cleanup = await f.storage.readCleanupIdentity(f.record, f.record.responseId);
      expect(cleanup).toMatchObject({
        storageTarget: f.record.storageTarget,
        checkpointNamespace: f.checkpoint.namespace,
      });
      expect(cleanup).not.toHaveProperty('requestJSON');
      expect(cleanup).not.toHaveProperty('responseJSON');
    });
    it('does not adopt a replacement physical root as durable drain proof', async () => {
      const f = await checkpointFixture();
      expect(await f.storage.settleExecution(f.reference, f.checkpoint, 'complete')).toBe(true);
      expect(await f.storage.readExecutionProof(f.record)).toMatchObject({ outcome: 'complete' });
      await f.model.deleteOne(responseRootFilter(db, f.reference));
      const replacement = await f.storage.reserve(f.input);
      if (!replacement.ok) throw new Error('Replacement failed');
      const enrolled = await f.storage.enrollExecution(replacement.record, f.checkpoint, '{}');
      if (!enrolled.ok) throw new Error('Replacement enrollment failed');
      expect(
        await f.storage.settleExecution(
          responseReference(enrolled.record),
          f.checkpoint,
          'complete',
        ),
      ).toBe(true);
      expect(await f.storage.readExecutionProof(enrolled.record)).toMatchObject({
        outcome: 'complete',
      });
      expect(await f.storage.readExecutionProof(f.record)).toBeNull();
      expect(await f.storage.settleExecution(f.reference, f.checkpoint, 'complete')).toBe(false);
    });
    it('resumes only after provider drain and checkpoint settlement and rejects the previous closer', async () => {
      const f = await checkpointFixture();
      const checkpointStorage = createResponseCheckpointStorage(db, f.reference, f.checkpoint);
      expect(await checkpointStorage.open()).toBe(true);
      const next = {
        ...f.checkpoint,
        providerExecutionId: randomUUID(),
        ownerId: randomUUID(),
        writerId: randomUUID(),
      };
      await f.model.updateOne(responseRootFilter(db, f.reference), {
        $set: {
          resume: {
            intentId: randomUUID(),
            actionId: randomUUID(),
            previousProviderExecutionId: f.checkpoint.providerExecutionId,
            providerExecutionId: next.providerExecutionId,
            fingerprint: 'resume',
            resolutionJSON: '{}',
            state: 'admitted',
            reservedAt: Date.now(),
          },
        },
      });
      const current = await f.storage.read(f.input, f.input.responseId);
      if (!current) throw new Error('Response missing');
      expect(await f.storage.enrollExecution(current, next, '{}')).toEqual({
        ok: false,
        code: 'response_conflict',
      });
      expect(await f.storage.settleExecution(f.reference, f.checkpoint)).toBe(true);
      expect(await checkpointStorage.open()).toBe(false);
      expect(await f.storage.enrollExecution(current, next, '{}')).toEqual({
        ok: false,
        code: 'response_conflict',
      });
      expect(await checkpointStorage.settle()).toBe(true);
      const resumed = await f.storage.enrollExecution(current, next, '{}');
      if (!resumed.ok) throw new Error('Resume enrollment failed');
      const retry = { ...next, ownerId: randomUUID() };
      expect(await f.storage.enrollExecution(resumed.record, retry, '{}')).toMatchObject({
        ok: true,
      });
      // Only the attempt selected by the external start CAS binds ownership.
      expect(await f.storage.bindExecution(resumed.record, next)).toBe(true);
      expect(await f.storage.bindExecution(resumed.record, retry)).toBe(false);
      expect(await f.storage.settleExecution(f.reference, f.checkpoint, 'complete')).toBe(false);
      expect(await checkpointStorage.settle()).toBe(false);
      const nextCheckpoint = createResponseCheckpointStorage(db, f.reference, next);
      expect(await nextCheckpoint.open()).toBe(true);
      expect(await nextCheckpoint.settle()).toBe(true);
      expect(await f.storage.settleExecution(f.reference, next, 'complete')).toBe(true);
    });
    it('fences a late checkpoint marker after its opening acknowledgment fails', async () => {
      const f = await checkpointFixture();
      const storage = createResponseCheckpointStorage(db, f.reference, f.checkpoint);
      const collection = f.model.collection;
      const original = collection.updateOne.bind(collection);
      let late!: () => ReturnType<typeof original>;
      jest.spyOn(collection, 'updateOne').mockImplementationOnce(async (...args) => {
        late = () => original(...args);
        throw new Error('marker command outcome unknown');
      });
      await expect(storage.open()).rejects.toThrow('marker command outcome unknown');
      expect(await storage.settle()).toBe(true);
      expect((await late()).matchedCount).toBe(0);
      expect(await storage.open()).toBe(false);
      expect(
        await f.model.findOne(responseRootFilter(db, f.reference)).select('+checkpoint').lean(),
      ).toMatchObject({
        checkpoint: { ...f.checkpoint, state: 'settled' },
      });
    });
    it('settles a lost marker acknowledgment but cannot adopt another writer', async () => {
      const f = await checkpointFixture();
      const storage = createResponseCheckpointStorage(db, f.reference, f.checkpoint);
      const collection = f.model.collection;
      const original = collection.updateOne.bind(collection);
      jest.spyOn(collection, 'updateOne').mockImplementationOnce(async (...args) => {
        await original(...args);
        throw new Error('marker acknowledgment lost');
      });
      await expect(storage.open()).rejects.toThrow('marker acknowledgment lost');
      const other = createResponseCheckpointStorage(db, f.reference, {
        ...f.checkpoint,
        writerId: randomUUID(),
      });
      expect(await other.settle()).toBe(false);
      expect(await storage.settle()).toBe(true);
      expect(await storage.open()).toBe(false);
    });
    it('retains a private checkpoint marker and lets only its exact writer settle after retirement', async () => {
      const f = await checkpointFixture();
      const storage = createResponseCheckpointStorage(db, f.reference, f.checkpoint);
      expect(await storage.open()).toBe(true);
      expect(await storage.open()).toBe(true);
      expect(await f.model.findOne(responseRootFilter(db, f.reference)).lean()).not.toHaveProperty(
        'checkpoint',
      );
      expect(
        await f.model.findOne(responseRootFilter(db, f.reference)).select('+checkpoint').lean(),
      ).toMatchObject({
        checkpoint: { ...f.checkpoint, state: 'pending' },
      });
      await f.model.updateOne(responseRootFilter(db, f.reference), {
        $set: { retiredAt: new Date(), expiredAt: new Date(Date.now() - 1), status: 'cancelled' },
      });
      expect(await storage.open()).toBe(false);
      expect(await storage.settle()).toBe(true);
      expect(await storage.settle()).toBe(true);
      expect(
        await f.model.findOne(responseRootFilter(db, f.reference)).select('+checkpoint').lean(),
      ).toMatchObject({
        checkpoint: { state: 'settled' },
      });
    });
    it('does not let a fresh saver adopt unknown writes or reopen a settled provider segment', async () => {
      const f = await checkpointFixture();
      const original = createResponseCheckpointStorage(db, f.reference, f.checkpoint);
      const fresh = createResponseCheckpointStorage(db, f.reference, {
        ...f.checkpoint,
        writerId: randomUUID(),
      });
      expect(await original.open()).toBe(true);
      expect(await fresh.open()).toBe(false);
      expect(await fresh.settle()).toBe(false);
      expect(await original.settle()).toBe(true);
      expect(await original.open()).toBe(false);
      expect(await fresh.open()).toBe(false);
      const next = { ...f.checkpoint, providerExecutionId: randomUUID(), writerId: randomUUID() };
      await f.model.updateOne(responseRootFilter(db, f.reference), {
        $set: { 'providerExecution.id': next.providerExecutionId },
      });
      const resumed = createResponseCheckpointStorage(db, f.reference, next);
      expect(await resumed.open()).toBe(true);
      expect(await original.settle()).toBe(false);
      expect(await resumed.settle()).toBe(true);
    });
    it('rejects a stale checkpoint callback after the logical response has a replacement root', async () => {
      const f = await checkpointFixture();
      const stale = createResponseCheckpointStorage(db, f.reference, f.checkpoint);
      expect(await stale.open()).toBe(true);
      await f.model.deleteOne(responseRootFilter(db, f.reference));
      const replacement = await allocateManagedTarget(db, 'response');
      const record = await publishResponseRoot(db, replacement, f.input);
      expect(record?.storageTarget.id).toBe(replacement.id);
      expect(await stale.open()).toBe(false);
      expect(await stale.settle()).toBe(false);
      expect(
        await f.model.findOne({ responseId: f.input.responseId }).select('+checkpoint').lean(),
      ).not.toHaveProperty('checkpoint');
    });
    it('cannot mutate checkpoint authority with the wrong owner or captured provider', async () => {
      const f = await checkpointFixture();
      expect(() =>
        createResponseCheckpointStorage(db, { ...f.reference, userId: randomUUID() }, f.checkpoint),
      ).toThrow('Invalid Response checkpoint writer');
      const wrongProvider = createResponseCheckpointStorage(db, f.reference, {
        ...f.checkpoint,
        ownerId: randomUUID(),
      });
      expect(await wrongProvider.open()).toBe(false);
      const storage = createResponseCheckpointStorage(db, f.reference, f.checkpoint);
      const originalConfig = f.checkpoint.configJSON;
      f.checkpoint.configJSON = 'mutated after capture';
      expect(await storage.open()).toBe(true);
      expect(await storage.settle()).toBe(true);
      expect(
        await f.model.findOne(responseRootFilter(db, f.reference)).select('+checkpoint').lean(),
      ).toMatchObject({
        checkpoint: { configJSON: originalConfig },
      });
    });
    it('publishes one admitted Response root with indexed ownership and its dispatch intent', async () => {
      const target = await allocateManagedTarget(db, 'response');
      const input = rootInput();
      const record = await publishResponseRoot(db, target, input);
      expect(record).toMatchObject({
        userId: input.userId,
        responseId: input.responseId,
        requestKey: input.requestKey,
        requestJSON: input.requestJSON,
        status: 'queued',
        revision: 0,
        dispatchOutbox: { kind: 'create', id: input.responseId, state: 'pending' },
      });
      const keys = responseScopeKeys(input, input.conversationId);
      expect(await createStoredResponseModel(db).findById(target.id).lean()).not.toBeNull();
      const raw = await createStoredResponseModel(db).collection.findOne(
        managedTargetFilter(db, target),
      );
      expect(raw?._managed).toMatchObject({
        phase: 'published',
        ownerKey: keys[0],
        conversationKey: keys[1],
      });
      for (const key of keys)
        expect(await createResponseScopeModel(db).findById(key).lean()).toMatchObject({
          pendingCount: 0,
          pending: [],
        });
      expect(
        await publishResponseRoot(db, target, { ...input, requestJSON: 'changed' }),
      ).toBeNull();
      expect((await createStoredResponseModel(db).findById(target.id).lean())?.requestJSON).toBe(
        input.requestJSON,
      );
    });
    it('does not install private root payload when an authority is already closed', async () => {
      const target = await allocateManagedTarget(db, 'response');
      const input = rootInput();
      const key = responseScopeKeys(input, input.conversationId)[1];
      await createResponseScopeModel(db).create({ _id: key, closed: true });
      expect(await publishResponseRoot(db, target, input)).toBeNull();
      const raw = await createStoredResponseModel(db).collection.findOne(
        managedTargetFilter(db, target),
      );
      expect(raw).not.toHaveProperty('userId');
      expect(raw).not.toHaveProperty('requestJSON');
    });
    it('cannot resurrect a root deleted between admission and payload publication', async () => {
      const target = await allocateManagedTarget(db, 'response');
      const input = rootInput();
      const collection = createStoredResponseModel(db).collection;
      const original = collection.findOneAndUpdate.bind(collection);
      jest.spyOn(collection, 'findOneAndUpdate').mockImplementationOnce(async (...args) => {
        await collection.deleteOne(managedTargetFilter(db, target));
        return original(...args);
      });
      expect(await publishResponseRoot(db, target, input)).toBeNull();
      expect(await collection.findOne({ responseId: input.responseId })).toBeNull();
      expect(await collection.findOne(managedTargetFilter(db, target))).toBeNull();
    });
    it('recovers root discovery after publication applies but its acknowledgment is lost', async () => {
      const target = await allocateManagedTarget(db, 'response');
      const input = rootInput();
      const collection = createStoredResponseModel(db).collection;
      const original = collection.findOneAndUpdate.bind(collection);
      const publication = jest
        .spyOn(collection, 'findOneAndUpdate')
        .mockImplementationOnce(async (...args) => {
          await original(...args);
          throw new Error('publication acknowledgment lost');
        });
      await expect(publishResponseRoot(db, target, input)).rejects.toThrow(
        'publication acknowledgment lost',
      );
      expect(publication).toHaveBeenCalledTimes(1);
      expect(
        await createStoredResponseModel(db).findOne({ responseId: input.responseId }).lean(),
      ).toMatchObject({
        userId: input.userId,
        requestJSON: input.requestJSON,
      });
      for (const conversationId of [undefined, input.conversationId])
        expect(await reconcileResponseTargets(db, input, conversationId)).toBe(1);
      expect(
        await createStoredResponseModel(db).countDocuments({ responseId: input.responseId }),
      ).toBe(1);
    });
    it('installs the shortest admitted scope deadline on a Response root', async () => {
      const target = await allocateManagedTarget(db, 'response');
      const input = rootInput();
      const deadline = new Date(Date.now() + 600_000);
      const key = responseScopeKeys(input, input.conversationId)[1];
      await createResponseScopeModel(db).create({ _id: key, closed: false, expiredAt: deadline });
      const record = await publishResponseRoot(db, target, {
        ...input,
        expiredAt: new Date(deadline.getTime() + 600_000),
      });
      expect(record?.expiredAt).toEqual(deadline);
    });
    it('allocates response roots with unique metadata-only keys and hides them from readers', async () => {
      const first = await allocateManagedTarget(db, 'response');
      const second = await allocateManagedTarget(db, 'response');
      expect(first.id).not.toBe(second.id);
      const model = createStoredResponseModel(db);
      const row = await model.collection.findOne(managedTargetFilter(db, first));
      expect(row).toMatchObject({
        responseId: `__allocation_${first.id}`,
        requestKey: `__allocation_${first.id}`,
        _managed: { phase: 'empty', incarnation: first.incarnation },
      });
      for (const field of ['userId', 'requestJSON', 'responseJSON', 'expiredAt'])
        expect(row).not.toHaveProperty(field);
      expect(await model.findById(first.id).lean()).toBeNull();
      expect(await model.countDocuments({ _id: { $in: [first.id, second.id] } })).toBe(0);
      expect(await discardManagedAllocation(db, first)).toBe(true);
      expect(await discardManagedAllocation(db, second)).toBe(true);
    });
    it.each(['message', 'conversation'] as const)(
      'sweeps unclaimed %s allocations with keyset pages and preserves pinned rows',
      async (kind) => {
        const tenantId = randomUUID();
        await tenantStorage.run({ tenantId }, async () => {
          for (let i = 0; i < 3; i++) await allocateManagedTarget(db, kind, tenantId);
          const pinned = await allocateManagedTarget(db, kind, tenantId);
          expect(await pinManagedTarget(db, pinned, new db.Types.ObjectId().toHexString())).toBe(
            true,
          );
          const first = await sweepManagedAllocations(db, kind, { limit: 2, tenantId });
          expect(first.deleted).toBe(2);
          expect(first.next).toMatch(/^[a-f\d]{24}$/);
          expect(
            await sweepManagedAllocations(db, kind, { limit: 2, tenantId, after: first.next }),
          ).toEqual({ deleted: 1 });
          expect(
            await db
              .model(kind === 'message' ? 'Message' : 'Conversation')
              .collection.findOne(managedTargetFilter(db, pinned)),
          ).toMatchObject({ _managed: { phase: 'pinned' } });
        });
      },
    );

    it('serializes orphan disposal against pinning without deleting the winner', async () => {
      const target = await allocateManagedTarget(db, 'message');
      const [pinned, discarded] = await Promise.all([
        pinManagedTarget(db, target, new db.Types.ObjectId().toHexString()),
        discardManagedAllocation(db, target),
      ]);
      expect([pinned, discarded].filter(Boolean)).toHaveLength(1);
      const row = await db.model('Message').collection.findOne(managedTargetFilter(db, target));
      if (pinned) expect(row).toMatchObject({ _managed: { phase: 'pinned' } });
      else expect(row).toBeNull();
    });
    it.each(['legacy', 'managed'] as const)(
      'pins %s Conversation append/reply updates to the captured physical record',
      async (kind) => {
        const userId = randomUUID();
        const conversationId = kind === 'legacy' ? randomUUID() : createManagedConversationId();
        const Conversation = db.model('Conversation');
        const row = await Conversation.create({
          conversationId,
          user: userId,
          title: 'Original',
          endpoint: EModelEndpoint.agents,
        });
        const messages = createMessageMethods(db);
        const methods = createConversationMethods(db, {
          ...messages,
          conversationTarget: { id: String(row._id), conversationId, userId },
        });
        const messageId = new db.Types.ObjectId().toHexString();
        expect(
          await methods.saveConvo(
            { userId },
            { conversationId, title: 'Appended' },
            {
              appendMessageIds: [messageId],
              stampReply: true,
              replyMessageId: 'resp_confirmed',
            },
          ),
        ).toMatchObject({ title: 'Appended', lastResponseMessageId: 'resp_confirmed' });
        const beforeDelete = await db
          .model('Conversation')
          .collection.findOne({ conversationId, user: userId });
        expect(beforeDelete?.messages.map(String)).toEqual([messageId]);
        await db.model('Conversation').collection.deleteOne({ _id: row._id });
        const replacement = await Conversation.create({
          conversationId,
          user: userId,
          title: 'Replacement',
          endpoint: EModelEndpoint.agents,
        });
        expect(
          await methods.saveConvo(
            { userId },
            { conversationId, title: 'Stale writer' },
            {
              appendMessageIds: [messageId],
              stampReply: true,
              replyMessageId: 'resp_stale',
            },
          ),
        ).toBeNull();
        expect(await db.model('Conversation').findById(replacement._id)).toMatchObject({
          title: 'Replacement',
          messages: [],
        });
        await expect(methods.saveConvo({ userId: 'other' }, { conversationId })).rejects.toThrow(
          'target mismatch',
        );
      },
    );

    it.each([false, true])(
      'publishes canonical Conversation creation fields (archived: %s)',
      async (archived) => {
        const userId = randomUUID();
        const conversationId = createManagedConversationId();
        const target = await allocateManagedTarget(db, 'conversation');
        const parentId = new db.Types.ObjectId().toHexString();
        const [ownerKey, conversationKey] = responseScopeKeys({ userId }, conversationId);
        const publication = {
          target,
          parentId,
          ownerKey,
          conversationKey,
          logicalId: conversationId,
          receipt: createHash('sha256').update(randomUUID()).digest('hex'),
        };
        expect(await pinManagedTarget(db, target, parentId)).toBe(true);
        expect(await beginManagedTargetRegistration(db, target, parentId)).toBe(true);
        const entry = { key: publication.receipt, target, retentionEpoch: 0 };
        await registerResponseTarget(db, { userId }, undefined, entry);
        await registerResponseTarget(db, { userId }, conversationId, entry);
        expect(await markManagedTargetRegistered(db, publication)).toBe(true);
        const project = await db
          .model('ChatProject')
          .create({ user: userId, name: 'Managed project' });
        const deadline = new Date(Date.now() + 60000);
        await db.model('Conversation').collection.updateOne(managedTargetFilter(db, target), {
          $set: { expiredAt: deadline },
        });
        const messages = createMessageMethods(db);
        const conversations = createConversationMethods(db, {
          ...messages,
          managedPublication: publication,
        });
        const createdAt = new Date('2026-01-01T00:00:00Z');
        const messageId = new db.Types.ObjectId().toHexString();
        const params = {
          conversationId,
          title: 'Confirmed title',
          codeEnvironmentMode: 'without_attached',
          chatProjectId: String(project._id),
          isArchived: archived,
        };
        const saved = await conversations.saveConvo({ userId }, params, {
          createdAtOnInsert: createdAt,
          initialAgentId: 'initial-agent',
          appendMessageIds: [messageId],
        });
        expect(saved).toMatchObject({
          conversationId,
          title: params.title,
          codeEnvironmentMode: 'without_attached',
          createdAt,
          chatProjectId: String(project._id),
          isTemporary: false,
          isArchived: archived,
          expiredAt: deadline,
        });
        expect(saved && '_id' in saved ? String(saved._id) : undefined).toBe(target.id);
        expect(saved).not.toHaveProperty('_managed');
        const raw = await db
          .model('Conversation')
          .collection.findOne(managedTargetFilter(db, target));
        expect(raw?.initial_agent_id).toBe('initial-agent');
        expect(raw?.messages.map(String)).toEqual([messageId]);
        expect(await settleResponseTarget(db, { userId }, undefined, entry)).toBe(true);
        expect(await settleResponseTarget(db, { userId }, conversationId, entry)).toBe(true);
        expect(
          await conversations.saveConvo({ userId }, { ...params, title: 'stale retry' }),
        ).toMatchObject({ title: params.title });
        const ordinary = createConversationMethods(db, messages);
        await ordinary.saveConvo(
          { userId, isTemporary: false },
          { conversationId, title: 'Edited' },
          {
            unsetFields: {
              expiredAt: 1,
              '_managed.phase': 1,
              conversationId: 1,
              user: 1,
              tenantId: 1,
              'conversationId.nested': 1,
            },
          },
        );
        await ordinary.bulkSaveConvos([
          { conversationId, user: userId, title: 'Bulk edited', expiredAt: null },
        ]);
        expect(
          await db.model('Conversation').collection.findOne(managedTargetFilter(db, target)),
        ).toMatchObject({
          user: userId,
          conversationId,
          expiredAt: deadline,
          _managed: { phase: 'published' },
        });
        await db.model('Conversation').collection.deleteOne(managedTargetFilter(db, target));
        expect(await conversations.saveConvo({ userId }, params)).toBeNull();
        await ordinary.bulkSaveConvos([{ conversationId, user: userId, title: 'Recreate' }]);
        await expect(
          ordinary.reserveSubagentThread({
            user: userId,
            conversationId,
            conversation: { title: 'Recreate' },
          }),
        ).rejects.toThrow('Unable to reserve');
        expect(await db.model('Conversation').collection.findOne({ conversationId })).toBeNull();
      },
    );

    it('preserves native reservation in the existing host subagent UUID namespace', async () => {
      const userId = randomUUID();
      const conversationId = '33333333-3333-8333-b333-333333333333';
      const methods = createConversationMethods(db, createMessageMethods(db));
      const reserved = await methods.reserveSubagentThread({
        user: userId,
        conversationId,
        conversation: { title: 'Native child thread' },
      });
      expect(reserved).toMatchObject({
        created: true,
        conversation: { conversationId, user: userId },
      });
      expect(
        await methods.reserveSubagentThread({
          user: userId,
          conversationId,
          conversation: { title: 'Retry' },
        }),
      ).toMatchObject({ created: false, conversation: { title: 'Native child thread' } });
    });

    it.each(['fast', 'provenance', 'apps', 'apps-erased-during-budget'] as const)(
      'publishes a registered target through the canonical %s Message writer',
      async (path) => {
        const userId = randomUUID();
        const conversationId = createManagedConversationId();
        const target = await allocateManagedTarget(db, 'message');
        const parentId = new db.Types.ObjectId().toHexString();
        const [ownerKey, conversationKey] = responseScopeKeys({ userId }, conversationId);
        const publication = {
          target,
          parentId,
          ownerKey,
          conversationKey,
          logicalId: createManagedMessageId(),
          receipt: createHash('sha256').update(randomUUID()).digest('hex'),
        };
        expect(await pinManagedTarget(db, target, parentId)).toBe(true);
        expect(await beginManagedTargetRegistration(db, target, parentId)).toBe(true);
        const entry = { key: publication.receipt, target, retentionEpoch: 0 };
        expect(await registerResponseTarget(db, { userId }, undefined, entry)).toMatchObject({
          status: 'registered',
        });
        expect(await registerResponseTarget(db, { userId }, conversationId, entry)).toMatchObject({
          status: 'registered',
        });
        expect(await markManagedTargetRegistered(db, publication)).toBe(true);
        const retainedDeadline = new Date(Date.now() + 60000);
        await db.model('Message').collection.updateOne(managedTargetFilter(db, target), {
          $set: { expiredAt: retainedDeadline },
        });
        expect(await markManagedTargetRegistered(db, publication)).toBe(true);
        expect(
          await markManagedTargetRegistered(db, {
            ...publication,
            logicalId: createManagedMessageId(),
          }),
        ).toBe(false);
        const methods = createMessageMethods(db, {
          managedPublication: publication,
          ...(path === 'apps-erased-during-budget' && {
            getMCPAppMessageBudget: async () => {
              await db.model('Message').collection.deleteOne(managedTargetFilter(db, target));
              return undefined;
            },
          }),
        });
        const createdAt = new Date('2026-01-01T00:00:00Z');
        const params = {
          messageId: publication.logicalId,
          conversationId,
          createdAt,
          text: 'confirmed canonical output',
          isCreatedByUser: false,
          ...(path === 'provenance' && { userSubmittedPaths: ['/text'] }),
          ...(path.startsWith('apps') && {
            attachments: [
              {
                type: Tools.ui_resources,
                file_id: 'app',
                toolCallId: 'call',
                [Tools.ui_resources]: [
                  {
                    uri: 'ui://app/test',
                    mimeType: MCP_APP_MIME_TYPE,
                    serverName: 'server',
                    serverBinding: 'authenticated',
                    resourceId: 'resource',
                    toolName: 'show_app',
                    content: [{ type: 'text', text: 'canonical tool result' }],
                    text: 'app document',
                  },
                ],
              },
            ],
          }),
        };
        const context = {
          userId,
          interfaceConfig: {
            retentionMode: RetentionMode.ALL,
            generalChatRetention: 2160,
          },
        };
        const saved = await methods.saveMessage(context, params);
        if (path === 'apps-erased-during-budget') {
          expect(saved).toBeNull();
          expect(
            await includeManagedAllocations(
              db.model('Message').exists(managedTargetFilter(db, target)),
            ),
          ).toBeNull();
          return;
        }
        expect(saved).toMatchObject({
          messageId: publication.logicalId,
          text: params.text,
          isTemporary: false,
          isUserSubmitted: false,
          createdAt,
        });
        expect(String(saved?._id)).toBe(target.id);
        expect(saved?.expiredAt).toBeInstanceOf(Date);
        expect(saved?.expiredAt).toEqual(retainedDeadline);
        expect(saved).not.toHaveProperty('_managed');
        expect(await settleResponseTarget(db, { userId }, undefined, entry)).toBe(true);
        expect(await settleResponseTarget(db, { userId }, conversationId, entry)).toBe(true);
        // Projection recovery cannot overwrite an already-published canonical row.
        expect(
          await methods.saveMessage(context, { ...params, text: 'stale retry' }),
        ).toMatchObject({ text: params.text });
        const ordinary = createMessageMethods(db);
        await ordinary.saveMessage({ userId, isTemporary: false }, { ...params, text: 'Edited' });
        await ordinary.updateMessage(userId, { messageId: params.messageId, expiredAt: null });
        await ordinary.bulkSaveMessages([
          { ...params, user: userId, expiredAt: null, text: 'Bulk edited' },
        ]);
        await expect(
          ordinary.updateMessage(userId, { messageId: params.messageId, user: 'other' }),
        ).rejects.toThrow('owner cannot be replaced');
        for (const conversationId of [null, 42, {}]) {
          await expect(
            // @ts-expect-error Exercise invalid runtime input at the storage boundary.
            ordinary.updateMessage(userId, { messageId: params.messageId, conversationId }),
          ).rejects.toThrow('conversation ID must be a string');
          await expect(
            // @ts-expect-error Bulk inputs can arrive from untyped import data.
            ordinary.bulkSaveMessages([{ ...params, user: userId, conversationId }]),
          ).rejects.toThrow();
        }
        expect(
          await ordinary.saveMessage(
            { userId },
            {
              ...params,
              conversationId: createManagedConversationId(),
            },
          ),
        ).toBeNull();
        expect(
          await db.model('Message').collection.findOne(managedTargetFilter(db, target)),
        ).toMatchObject({ user: userId, conversationId, expiredAt: retainedDeadline });
        await db.model('Message').collection.deleteOne(managedTargetFilter(db, target));
        expect(await methods.saveMessage(context, params)).toBeNull();
        expect(await markManagedTargetRegistered(db, publication)).toBe(false);
      },
    );

    it('preserves edits of existing legacy rows in the newly reserved namespaces', async () => {
      const messages = createMessageMethods(db);
      const conversations = createConversationMethods(db, messages);
      const userId = randomUUID();
      const conversationId = createManagedConversationId();
      const messageId = createManagedMessageId();
      await db
        .model('Conversation')
        .collection.insertOne({ conversationId, user: userId, title: 'Legacy' });
      await db
        .model('Message')
        .collection.insertOne({ conversationId, messageId, user: userId, text: 'Legacy' });
      expect(
        await conversations.saveConvo({ userId }, { conversationId, title: 'Edited' }),
      ).toMatchObject({ title: 'Edited' });
      expect(
        await messages.saveMessage({ userId }, { conversationId, messageId, text: 'Edited' }),
      ).toMatchObject({ text: 'Edited' });
      await conversations.bulkSaveConvos([{ conversationId, user: userId, title: 'Bulk edited' }]);
      expect(await db.model('Conversation').findOne({ conversationId })).toMatchObject({
        title: 'Bulk edited',
      });
    });

    it.each(['fast', 'provenance', 'bulk'] as const)(
      'starts a null Message deadline through the %s writer and never extends it',
      async (path) => {
        const userId = randomUUID();
        const conversationId = createManagedConversationId();
        const messageId = createManagedMessageId();
        const collection = db.model('Message').collection;
        await collection.insertOne({ user: userId, conversationId, messageId, expiredAt: null });
        const methods = createMessageMethods(db);
        const deadline = new Date(Date.now() + 120000);
        const params = {
          messageId,
          conversationId,
          text: 'Retained',
          ...(path === 'provenance' && { userSubmittedPaths: ['/text'] }),
        };
        if (path === 'bulk')
          await methods.bulkSaveMessages([{ ...params, user: userId, expiredAt: deadline }]);
        else await methods.saveMessage({ userId, expiredAt: deadline }, params);
        expect(await collection.findOne({ messageId })).toMatchObject({ expiredAt: deadline });
        const shorter = new Date(Date.now() + 60000);
        await collection.updateOne({ messageId }, { $set: { expiredAt: null } });
        const update = collection.updateOne.bind(collection);
        jest.spyOn(collection, 'updateOne').mockImplementationOnce(async (...args) => {
          await update({ messageId }, { $set: { expiredAt: shorter } });
          return update(...args);
        });
        await methods.saveMessage({ userId, expiredAt: deadline }, params);
        expect(await collection.findOne({ messageId })).toMatchObject({ expiredAt: shorter });
      },
    );

    it.each(['save', 'bulk', 'captured'] as const)(
      'starts a null Conversation deadline through %s without changing its identity',
      async (path) => {
        const userId = randomUUID();
        const conversationId = path === 'captured' ? randomUUID() : createManagedConversationId();
        const collection = db.model('Conversation').collection;
        const row = await collection.insertOne({
          user: userId,
          conversationId,
          expiredAt: null,
          endpoint: EModelEndpoint.agents,
        });
        const methods = createConversationMethods(db, {
          ...createMessageMethods(db),
          ...(path === 'captured' && {
            conversationTarget: { id: String(row.insertedId), userId, conversationId },
          }),
        });
        const deadline = new Date(Date.now() + 120000);
        if (path === 'bulk')
          await methods.bulkSaveConvos([{ user: userId, conversationId, expiredAt: deadline }]);
        else
          await methods.saveConvo(
            { userId, expiredAt: deadline },
            { conversationId },
            {
              appendMessageIds: [],
              unsetFields: { user: 1, conversationId: 1, tenantId: 1 },
            },
          );
        expect(await collection.findOne({ _id: row.insertedId })).toMatchObject({
          user: userId,
          conversationId,
          expiredAt: deadline,
        });
        await methods.saveConvo(
          { userId, expiredAt: new Date(Date.now() + 240000) },
          { conversationId },
          { appendMessageIds: [] },
        );
        expect(await collection.findOne({ _id: row.insertedId })).toMatchObject({
          expiredAt: deadline,
        });
      },
    );

    it('cannot recreate a target deleted between deadline initialization and payload update', async () => {
      const userId = randomUUID();
      const conversationId = createManagedConversationId();
      const messageId = createManagedMessageId();
      const collection = db.model('Message').collection;
      await collection.insertOne({ user: userId, conversationId, messageId, expiredAt: null });
      const update = collection.updateOne.bind(collection);
      jest.spyOn(collection, 'updateOne').mockImplementationOnce(async (...args) => {
        const result = await update(...args);
        await collection.deleteOne({ messageId });
        return result;
      });
      expect(
        await createMessageMethods(db).saveMessage(
          { userId, expiredAt: new Date(Date.now() + 60000) },
          { conversationId, messageId, text: 'Late payload' },
        ),
      ).toBeNull();
      expect(await collection.findOne({ messageId })).toBeNull();
    });

    it('preserves a concurrent shorter deadline during forced conversion and batched message stamping', async () => {
      const userId = randomUUID();
      const conversationId = createManagedConversationId();
      const messageId = createManagedMessageId();
      const pendingId = createManagedMessageId();
      const deadline = new Date(Date.now() + 120000);
      const shorter = new Date(Date.now() + 60000);
      const conversations = db.model('Conversation').collection;
      const messages = db.model('Message').collection;
      await conversations.insertOne({
        user: userId,
        conversationId,
        expiredAt: deadline,
        isTemporary: false,
      });
      await messages.insertMany([
        { user: userId, conversationId, messageId, expiredAt: shorter },
        { user: userId, conversationId, messageId: pendingId, expiredAt: null },
      ]);
      const update = conversations.updateOne.bind(conversations);
      jest.spyOn(conversations, 'updateOne').mockImplementationOnce(async (...args) => {
        await update({ conversationId, user: userId }, { $set: { expiredAt: shorter } });
        return update(...args);
      });
      await createConversationMethods(db, createMessageMethods(db)).stampForcedRetention(
        {
          userId,
          interfaceConfig: { retentionMode: RetentionMode.EPHEMERAL, temporaryChatRetention: 1 },
        },
        { conversationId, messageIds: [messageId, pendingId] },
      );
      expect(await conversations.findOne({ conversationId })).toMatchObject({
        expiredAt: shorter,
        isTemporary: true,
      });
      expect(
        (await messages.find({ conversationId }).toArray()).map((row) => row.expiredAt),
      ).toEqual([shorter, shorter]);
    });

    it.each(['message', 'conversation'] as const)(
      'allocates unique payload-free %s rows',
      async (kind) => {
        const first = await allocateManagedTarget(db, kind);
        const second = await allocateManagedTarget(db, kind);
        expect(first.id).not.toBe(second.id);
        expect(first.incarnation).not.toBe(second.incarnation);
        const model = db.model(kind === 'message' ? 'Message' : 'Conversation');
        const row = await model.collection.findOne(managedTargetFilter(db, first));
        expect(row).toMatchObject({
          _managed: { phase: 'empty', incarnation: first.incarnation },
        });
        expect(row).not.toHaveProperty('user');
        expect(row).not.toHaveProperty('text');
        expect(row).not.toHaveProperty('content');
        expect(row).not.toHaveProperty('expiredAt');
        expect(await discardManagedAllocation(db, first)).toBe(true);
        expect(await discardManagedAllocation(db, second)).toBe(true);
      },
    );

    it('cannot pin a deleted target or recreate it through cleanup', async () => {
      const target = await allocateManagedTarget(db, 'message');
      expect(await discardManagedAllocation(db, target)).toBe(true);
      expect(await pinManagedTarget(db, target, new db.Types.ObjectId().toHexString())).toBe(false);
      expect(await discardManagedAllocation(db, target)).toBe(false);
      expect(
        await db.model('Message').collection.findOne(managedTargetFilter(db, target)),
      ).toBeNull();
    });

    it('pins to one parent, idempotently, and excludes the row from orphan cleanup', async () => {
      const target = await allocateManagedTarget(db, 'message');
      const parent = new db.Types.ObjectId().toHexString();
      const other = new db.Types.ObjectId().toHexString();
      const claims = await Promise.all([
        pinManagedTarget(db, target, parent),
        pinManagedTarget(db, target, other),
      ]);
      expect(claims.filter(Boolean)).toHaveLength(1);
      expect(await pinManagedTarget(db, target, claims[0] ? parent : other)).toBe(true);
      expect(await discardManagedAllocation(db, target)).toBe(false);
    });

    mongoOnly('MongoDB command failpoints', () => {
      it('does not retry an allocation insert after a dropped connection', async () => {
        await db.connection.db!.admin().command({
          configureFailPoint: 'failCommand',
          mode: { times: 1 },
          data: { failCommands: ['insert'], closeConnection: true },
        });
        const commands: string[] = [];
        const client = db.connection.getClient();
        const onCommand = (event: { commandName: string }) => commands.push(event.commandName);
        client.on('commandStarted', onCommand);
        try {
          await expect(allocateManagedTarget(db, 'message')).rejects.toBeInstanceOf(
            db.mongo.MongoNetworkError,
          );
          expect(commands.filter((name) => name === 'insert')).toHaveLength(1);
        } finally {
          client.off('commandStarted', onCommand);
        }
        // A later invocation uses a new physical ID and remains available.
        await expect(allocateManagedTarget(db, 'message')).resolves.toMatchObject({
          kind: 'message',
        });
      });

      it('abandons an applied insert whose write-concern acknowledgment was lost', async () => {
        await db.connection.db!.admin().command({
          configureFailPoint: 'failCommand',
          mode: { times: 1 },
          data: {
            failCommands: ['insert'],
            writeConcernError: { code: 64, errmsg: 'test acknowledgment unavailable' },
          },
        });
        const before = await db.model('Message').collection.countDocuments();
        await expect(allocateManagedTarget(db, 'message')).rejects.toBeInstanceOf(
          db.mongo.MongoWriteConcernError,
        );
        expect(await db.model('Message').collection.countDocuments()).toBe(before + 1);
      });

      it('does not retry an allocation carrying a retryable-write server label', async () => {
        await db.connection.db!.admin().command({
          configureFailPoint: 'failCommand',
          mode: { times: 1 },
          data: { failCommands: ['insert'], errorCode: 91, errorLabels: ['RetryableWriteError'] },
        });
        const commands: string[] = [];
        const client = db.connection.getClient();
        const onCommand = (event: { commandName: string }) => commands.push(event.commandName);
        client.on('commandStarted', onCommand);
        try {
          await expect(allocateManagedTarget(db, 'message')).rejects.toMatchObject({ code: 91 });
          expect(commands.filter((name) => name === 'insert')).toHaveLength(1);
        } finally {
          client.off('commandStarted', onCommand);
        }
      });
    });

    it.each([false, true])(
      'does not recreate a managed message (provenance: %s)',
      async (provenance) => {
        const messages = createMessageMethods(db);
        const messageId = createManagedMessageId();
        const conversationId = createManagedConversationId();
        const params = {
          messageId,
          conversationId,
          text: 'confirmed output',
          ...(provenance && { userSubmittedPaths: ['/text'] }),
        };
        expect(await messages.saveMessage({ userId: 'owner' }, params)).toBeNull();
        const row = {
          ...params,
          user: 'owner',
          _managed: { incarnation: 'test', phase: 'published', receipt: 'receipt' },
        };
        await db.model('Message').collection.insertOne(row);
        expect(
          await messages.saveMessage({ userId: 'owner' }, { ...params, text: 'edited' }),
        ).toMatchObject({ text: 'edited' });
        await db.model('Message').collection.deleteOne({ messageId });
        expect(await messages.saveMessage({ userId: 'owner' }, params)).toBeNull();
        expect(
          await messages.saveMessage({ userId: 'owner' }, params, { insertOnly: true }),
        ).toBeUndefined();
        await messages.bulkSaveMessages([{ ...params, user: 'owner' }]);
        expect(await db.model('Message').collection.countDocuments({ messageId })).toBe(0);
      },
    );

    it('does not recreate a managed conversation through save, title, or archive', async () => {
      const messages = createMessageMethods(db);
      const conversations = createConversationMethods(db, messages);
      const conversationId = createManagedConversationId();
      const context = { userId: 'owner' };
      expect(await conversations.saveConvo(context, { conversationId })).toBeNull();
      await db.model('Conversation').collection.insertOne({
        conversationId,
        user: 'owner',
        title: 'Original',
        _managed: { incarnation: 'test', phase: 'published', receipt: 'receipt' },
      });
      expect(
        await conversations.saveConvo(context, { conversationId, title: 'Renamed' }),
      ).toMatchObject({ title: 'Renamed' });
      await db.model('Conversation').collection.deleteOne({ conversationId });
      expect(
        await conversations.saveConvo(context, { conversationId, isArchived: true }),
      ).toBeNull();
      expect(
        await conversations.saveConvo(
          context,
          { conversationId, title: 'Generated' },
          {
            titleSource: 'generated',
          },
        ),
      ).toBeNull();
      expect(await db.model('Conversation').collection.countDocuments({ conversationId })).toBe(0);
    });

    it('strips forged internal fields from ordinary message, conversation and bulk saves', async () => {
      const messages = createMessageMethods(db);
      const conversations = createConversationMethods(db, messages);
      const conversationId = '22222222-2222-4222-8222-222222222222';
      const forged = {
        _managed: { phase: 'registered', incarnation: 'forged' },
        '_managed.phase': 'published',
      };
      const messageId = `ordinary-${new db.Types.ObjectId()}`;
      await messages.saveMessage({ userId: 'owner' }, { ...forged, conversationId, messageId });
      const collection = db.model('Message').collection;
      expect(await collection.findOne({ messageId })).not.toHaveProperty('_managed');
      await messages.bulkSaveMessages([
        { ...forged, messageId: `${messageId}-bulk`, conversationId, user: 'owner' },
      ]);
      expect(await collection.findOne({ messageId: `${messageId}-bulk` })).not.toHaveProperty(
        '_managed',
      );
      await conversations.saveConvo({ userId: 'owner' }, { ...forged, conversationId });
      expect(
        await db.model('Conversation').collection.findOne({ conversationId }),
      ).not.toHaveProperty('_managed');
    });

    it('rejects allocation placeholders and moving into/out of managed identities', async () => {
      const messages = createMessageMethods(db);
      const conversations = createConversationMethods(db, messages);
      const conversationId = createManagedConversationId();
      await expect(
        messages.saveMessage(
          { userId: 'owner' },
          {
            conversationId,
            messageId: '__allocation_reserved',
          },
        ),
      ).rejects.toThrow(TypeError);
      await expect(
        messages.saveMessage(
          { userId: 'owner' },
          {
            conversationId,
            messageId: createManagedMessageId(),
            newMessageId: 'ordinary',
          },
        ),
      ).rejects.toThrow(TypeError);
      await expect(
        messages.saveMessage(
          { userId: 'owner' },
          {
            conversationId,
            messageId: 'ordinary',
            newMessageId: createManagedMessageId(),
          },
        ),
      ).rejects.toThrow(TypeError);
      await expect(
        conversations.saveConvo(
          { userId: 'owner' },
          {
            conversationId,
            newConversationId: 'ordinary',
          },
        ),
      ).rejects.toThrow(TypeError);
      await expect(
        conversations.saveConvo(
          { userId: 'owner' },
          {
            conversationId: '__allocation_reserved',
          },
        ),
      ).rejects.toThrow(TypeError);
    });
  });

  it.each([
    { ok: 1, n: 0 },
    { ok: 1 },
    { ok: 0, n: 1 },
    { ok: 1, n: 1, writeErrors: [{ code: 11000 }] },
    { ok: 1, n: 1, writeErrors: null },
    { ok: 1, n: 1, writeErrors: '' },
    { ok: 1, n: 1, writeErrors: {} },
    { ok: 1, n: 1, writeConcernError: null },
    { ok: 1, n: 1, writeConcernError: { code: 64 } },
  ])('refuses a contradictory/malformed acknowledgment %j', async (reply) => {
    // Only command-response corruption is injected; real writes/faults are exercised above.
    const command = jest.spyOn(standalone.connection.db!, 'command').mockResolvedValueOnce(reply);
    await expect(allocateManagedTarget(standalone, 'message')).rejects.toBeInstanceOf(
      ManagedAllocationUnavailableError,
    );
    expect(command).toHaveBeenCalledTimes(1);
  });

  it('applies the configured write concern to the raw command', async () => {
    const db = standalone.connection.db!;
    const command = jest.spyOn(db, 'command').mockResolvedValueOnce({ ok: 1, n: 1 });
    const concern = jest
      .spyOn(db, 'writeConcern', 'get')
      .mockReturnValue(new mongoose.mongo.WriteConcern('majority', 10000, true));
    await allocateManagedTarget(standalone, 'message');
    expect(command.mock.calls[0][0]).toHaveProperty('writeConcern', {
      w: 'majority',
      wtimeout: 10000,
      j: true,
    });
    concern.mockRestore();
  });

  it('rejects w:0 before sending an insert', async () => {
    const db = standalone.connection.db!;
    jest.spyOn(db, 'writeConcern', 'get').mockReturnValue(new mongoose.mongo.WriteConcern(0));
    const command = jest.spyOn(db, 'command');
    await expect(allocateManagedTarget(standalone, 'message')).rejects.toBeInstanceOf(
      ManagedAllocationUnavailableError,
    );
    expect(command).not.toHaveBeenCalled();
  });

  it('checks tenant context before bypassing Mongoose for allocation', async () => {
    const command = jest.spyOn(standalone.connection.db!, 'command');
    await expect(allocateManagedTarget(standalone, 'message', 'other')).rejects.toThrow(TypeError);
    await expect(runAsSystem(() => allocateManagedTarget(standalone, 'message'))).rejects.toThrow(
      TypeError,
    );
    await tenantStorage.run({ tenantId: 'tenant-a' }, async () => {
      await expect(allocateManagedTarget(standalone, 'message', 'tenant-b')).rejects.toThrow(
        TypeError,
      );
      await expect(allocateManagedTarget(standalone, 'message')).rejects.toThrow(TypeError);
      expect(command).not.toHaveBeenCalled();
      const target = await allocateManagedTarget(standalone, 'message', 'tenant-a');
      expect(
        await standalone
          .model('Message')
          .collection.findOne(managedTargetFilter(standalone, target)),
      ).toHaveProperty('tenantId', 'tenant-a');
    });
  });

  it('rejects forged model names and target identity before issuing writes', async () => {
    const command = jest.spyOn(standalone.connection.db!, 'command');
    await expect(
      allocateManagedTarget(standalone, 'toString' as ManagedTarget['kind']),
    ).rejects.toThrow(TypeError);
    const target = { kind: 'message', id: 'bad', incarnation: 'bad' } as ManagedTarget;
    expect(() => managedTargetFilter(standalone, target)).toThrow(TypeError);
    expect(command).not.toHaveBeenCalled();
  });
});

describe('managed allocation visibility', () => {
  const db = new mongoose.Mongoose();
  let mongo: MongoMemoryServer;
  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await db.connect(mongo.getUri());
    const schema = new mongoose.Schema({ name: String });
    applyManagedStorage(schema);
    applyManagedStorage(schema);
    db.model('Visibility', schema);
    await db.model('Visibility').collection.insertMany([
      { name: 'legacy' },
      { name: 'published', _managed: { phase: 'published', incarnation: 'published' } },
      ...['empty', 'pinned', 'registering', 'registered', 'retired'].map((phase) => ({
        name: phase,
        _managed: { phase, incarnation: phase },
      })),
    ]);
  });
  afterAll(async () => {
    await db.disconnect();
    await mongo?.stop();
  });

  it('excludes metadata rows from reads, counts, distinct and aggregates', async () => {
    const model = db.model('Visibility');
    expect((await model.find()).map((row) => row.name)).toEqual(['legacy', 'published']);
    expect(await model.findOne({ name: 'empty' })).toBeNull();
    expect(await model.countDocuments()).toBe(2);
    expect(await model.distinct('name')).toEqual(['legacy', 'published']);
    expect(await model.aggregate([{ $count: 'count' }])).toEqual([{ count: 2 }]);
    expect(await model.findOne({ name: 'published' }).lean()).not.toHaveProperty('_managed');
  });

  it('allows only internally marked queries to inspect allocations', async () => {
    const model = db.model('Visibility');
    expect(await includeManagedAllocations(model.countDocuments())).toBe(7);
    expect(await includeManagedAllocations(model.aggregate([{ $count: 'count' }]))).toEqual([
      { count: 7 },
    ]);
    expect(await model.countDocuments().setOptions({ includeManagedAllocations: true })).toBe(2);
  });
});
