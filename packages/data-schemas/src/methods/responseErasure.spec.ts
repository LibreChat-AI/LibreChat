import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { ResponseOwner, StoredResponseRecord } from '~/models/response';
import { createManagedMessageId, createManagedConversationId } from '~/utils/managed';
import { checkpointOwnerNamespacePrefix } from '~/utils/checkpoint';
import { tenantStorage, runAsSystem } from '~/config/tenantContext';
import { resetTenantStrictCache } from '~/tenant/policy';
import { createResponseStorage } from './response';
import { responseReference } from './responseRoot';
import { createModels } from '~/models';
import { createMethods } from './index';

const engines = ['standalone', ...(process.env.FERRETDB_URI ? ['FerretDB'] : [])];
const owner = { userId: 'erasure-owner', tenantId: 'erasure-tenant' };
const scope = <T>(work: () => Promise<T>) => tenantStorage.run(owner, work);

async function withStrictTenants<T>(work: () => Promise<T>): Promise<T> {
  const previous = process.env.TENANT_ISOLATION_STRICT;
  process.env.TENANT_ISOLATION_STRICT = 'true';
  resetTenantStrictCache();
  try {
    return await work();
  } finally {
    if (previous === undefined) delete process.env.TENANT_ISOLATION_STRICT;
    else process.env.TENANT_ISOLATION_STRICT = previous;
    resetTenantStrictCache();
  }
}

describe.each(engines)('Response deletion discovery on %s', (engine) => {
  let mongo: MongoMemoryServer | undefined;
  let methods: ReturnType<typeof createMethods>;
  let storage: ReturnType<typeof createResponseStorage>;
  beforeAll(async () => {
    if (engine === 'standalone') mongo = await MongoMemoryServer.create();
    createModels(mongoose);
    await mongoose.connect(mongo?.getUri() ?? process.env.FERRETDB_URI!, {
      dbName: `erasure_${randomUUID().replace(/-/g, '')}`,
    });
    methods = createMethods(mongoose);
    storage = createResponseStorage(mongoose);
  }, 60000);
  afterEach(async () => {
    jest.restoreAllMocks();
    await mongoose.connection.db!.dropDatabase();
  });
  afterAll(async () => {
    await mongoose.disconnect();
    await mongo?.stop();
  });
  async function reserve(partition: ResponseOwner = owner) {
    return tenantStorage.run(partition, () =>
      storage.reserve({
        ...partition,
        responseId: createManagedMessageId(),
        conversationId: createManagedConversationId(),
        requestKey: randomUUID(),
        fingerprint: randomUUID(),
        agentId: 'agent',
        requestJSON: '{"private":"request"}',
        parentMessageId: 'root',
      }),
    );
  }
  async function root(partition: ResponseOwner = owner): Promise<StoredResponseRecord> {
    const result = await reserve(partition);
    if (!result.ok) throw new Error('Root reservation failed');
    return result.record;
  }
  it('clears a preseed Root without a Conversation and keeps fresh owner admission open', () =>
    scope(async () => {
      const record = await root();
      const other = await root({ ...owner, tenantId: 'other-tenant' });
      expect(await methods.getConvo(owner.userId, record.conversationId)).toBeNull();
      const remember = jest.fn(async () => {});
      const cleared = await methods.deleteConvos(
        owner.userId,
        {},
        { allowEmpty: true, beforeDelete: remember },
      );
      expect(cleared.conversationIds).toContain(record.conversationId);
      expect(remember).toHaveBeenCalledWith([record.conversationId]);
      expect(await methods.hasPendingResponseCheckpointCleanup(owner)).toBe(false);
      expect(
        await tenantStorage.run(other, () => storage.read(other, other.responseId)),
      ).not.toBeNull();
      expect((await reserve()).ok).toBe(true);
      expect(
        await storage.enrollExecution(
          record,
          {
            generationCreatedAt: Date.now(),
            providerExecutionId: randomUUID(),
          },
          '{}',
        ),
      ).toEqual({ ok: false, code: 'response_conflict' });
    }));
  it('includes current and historical tenantless Roots alongside ordinary Conversations', () =>
    scope(async () => {
      const current = await root();
      const legacy = await root({ userId: owner.userId });
      const ordinary = randomUUID();
      await methods.saveConvo(
        { userId: owner.userId },
        { conversationId: ordinary, title: 'Ordinary' },
      );
      const cleared = await methods.deleteConvos(owner.userId, {}, { allowEmpty: true });
      expect(new Set(cleared.conversationIds)).toEqual(
        new Set([ordinary, current.conversationId, legacy.conversationId]),
      );
      expect(await methods.hasPendingResponseCheckpointCleanup(owner)).toBe(false);
      expect((await reserve()).ok).toBe(true);
    }));
  it('retries retired preseed cleanup without interpreting a missing job as writer settlement', () =>
    scope(async () => {
      const record = await root();
      const binding = { generationCreatedAt: Date.now(), providerExecutionId: randomUUID() };
      const enrolled = await storage.enrollExecution(record, binding, '{}');
      if (!enrolled.ok || !(await storage.bindExecution(enrolled.record, binding)))
        throw new Error('Enrollment failed');
      const namespace = `${checkpointOwnerNamespacePrefix(owner.userId, owner.tenantId)}${randomUUID()}`;
      const writer = storage.createCheckpointWriter(responseReference(enrolled.record), {
        ...binding,
        writerId: randomUUID(),
        namespace,
        configJSON: JSON.stringify({
          type: 'mongo',
          checkpointCollectionName: 'response_cp',
          checkpointWritesCollectionName: 'response_writes',
        }),
      });
      expect(await writer.open()).toBe(true);
      const checkpoints = mongoose.connection.db!.collection('response_cp');
      await checkpoints.insertOne({
        thread_id: record.conversationId,
        checkpoint_ns: namespace,
        payload: 'private',
      });
      await expect(
        methods.deleteConvos(owner.userId, {}, { allowEmpty: true }),
      ).rejects.toMatchObject({ code: 'response_erasure_pending' });
      expect(await methods.hasPendingResponseCheckpointCleanup(owner)).toBe(true);
      expect(await storage.read(record, record.responseId)).toBeNull();
      expect(
        await storage.settleExecution(responseReference(enrolled.record), binding, 'aborted'),
      ).toBe(true);
      await expect(
        methods.deleteConvos(owner.userId, {}, { allowEmpty: true }),
      ).rejects.toMatchObject({ code: 'response_erasure_pending' });
      expect(await checkpoints.countDocuments()).toBe(1);
      expect(await writer.settle()).toBe(true);
      const proof = await storage.readExecutionProof(enrolled.record);
      if (!proof) throw new Error('Missing drain proof');
      await checkpoints.deleteMany({ thread_id: record.conversationId, checkpoint_ns: namespace });
      expect(await storage.acknowledgeCheckpointErasure(enrolled.record, proof)).toBe(true);
      expect(await storage.acknowledgeExecutionRelease(enrolled.record, proof)).toBe(true);
      const cleared = await methods.deleteConvos(owner.userId, {}, { allowEmpty: true });
      expect(cleared.conversationIds).toContain(record.conversationId);
      expect(await methods.hasPendingResponseCheckpointCleanup(owner)).toBe(false);
      expect((await reserve()).ok).toBe(true);
    }));
  it('seals an owner-registered allocation before its conversation registration and publication', () =>
    scope(async () => {
      // Ensure the real scope model exists before installing the command boundary interceptor.
      await root({ userId: 'unrelated-owner', tenantId: owner.tenantId });
      const collection = mongoose.models.ResponseScope.collection;
      const update = collection.findOneAndUpdate.bind(collection);
      let cleared = false;
      jest.spyOn(collection, 'findOneAndUpdate').mockImplementation(async (...args) => {
        const result = await update(...args);
        const mutation = args[1];
        if (!cleared && !Array.isArray(mutation) && mutation.$push?.pending) {
          cleared = true;
          await methods.deleteConvos(owner.userId, {}, { allowEmpty: true });
        }
        return result;
      });
      expect(await reserve()).toEqual({ ok: false, code: 'response_unavailable' });
      expect(cleared).toBe(true);
      expect(await methods.hasPendingResponseCheckpointCleanup(owner)).toBe(false);
      expect((await reserve()).ok).toBe(true);
    }));
  it('keeps a captured allocation discoverable when publication wins its seal CAS', () =>
    scope(async () => {
      await root({ userId: 'unrelated-owner', tenantId: owner.tenantId });
      const collection = mongoose.models.StoredResponse.collection;
      const publish = collection.findOneAndUpdate.bind(collection);
      const updateMany = collection.updateMany.bind(collection);
      let reached!: () => void;
      let release!: () => void;
      const atPublication = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const publicationAllowed = new Promise<void>((resolve) => {
        release = resolve;
      });
      jest.spyOn(collection, 'findOneAndUpdate').mockImplementation(async (...args) => {
        const mutation = args[1];
        if (!Array.isArray(mutation) && mutation.$set?.['_managed.phase'] === 'published') {
          reached();
          await publicationAllowed;
        }
        return publish(...args);
      });
      const reservation = reserve();
      await atPublication;
      let won = false;
      jest.spyOn(collection, 'updateMany').mockImplementation(async (...args) => {
        const mutation = args[1];
        if (!won && !Array.isArray(mutation) && mutation.$set?.['_managed.phase'] === 'retired') {
          won = true;
          release();
          await reservation;
        }
        return updateMany(...args);
      });
      try {
        const cleared = await methods.deleteConvos(owner.userId, {}, { allowEmpty: true });
        expect(won).toBe(true);
        expect(cleared.conversationIds).toHaveLength(1);
        expect(await reservation).toEqual({ ok: false, code: 'response_unavailable' });
        expect(await methods.hasPendingResponseCheckpointCleanup(owner)).toBe(false);
        expect((await reserve()).ok).toBe(true);
      } finally {
        release();
        await reservation;
      }
    }));
  it('account erasure seals a described allocation even before its owner registration exists', () =>
    scope(async () => {
      await root({ userId: 'unrelated-owner', tenantId: owner.tenantId });
      const collection = mongoose.models.StoredResponse.collection;
      const update = collection.updateOne.bind(collection);
      let erased = false;
      jest.spyOn(collection, 'updateOne').mockImplementation(async (...args) => {
        const result = await update(...args);
        const mutation = args[1];
        if (!erased && !Array.isArray(mutation) && mutation.$set?.['_managed.ownerKey']) {
          erased = true;
          await methods.prepareUserResponseErasure(owner);
          await methods.eraseUserResponses(owner);
        }
        return result;
      });
      expect(await reserve()).toEqual({ ok: false, code: 'response_unavailable' });
      expect(erased).toBe(true);
      expect(await methods.hasPendingResponseCheckpointCleanup(owner)).toBe(false);
      expect((await reserve()).ok).toBe(false);
    }));
  it.each(['all', 'specific'] as const)(
    'preserves ordinary Conversation deletion accounting for a Response-owned seed (%s)',
    (mode) =>
      scope(async () => {
        const record = await root();
        const binding = { generationCreatedAt: Date.now(), providerExecutionId: randomUUID() };
        const enrolled = await storage.enrollExecution(record, binding, '{}');
        if (!enrolled.ok || !(await storage.bindExecution(enrolled.record, binding)))
          throw new Error('Enrollment failed');
        const seeded = await storage.prepareConversation(enrolled.record, binding, {
          context: { userId: owner.userId },
          conversation: {
            conversationId: record.conversationId,
            title: 'Seeded',
            tags: ['work'],
            endpoint: 'agents',
            agent_id: 'agent',
          },
          initialAgentId: 'agent',
        });
        expect(seeded.ok).toBe(true);
        await mongoose.models.ConversationTag.create({
          user: owner.userId,
          tag: 'work',
          count: 1,
          position: 0,
        });
        const cleared = await methods.deleteConvos(
          owner.userId,
          mode === 'all' ? {} : { conversationId: record.conversationId },
          {
            allowEmpty: true,
            beforeDelete: async () => {
              expect(
                await storage.settleExecution(
                  responseReference(enrolled.record),
                  binding,
                  'aborted',
                ),
              ).toBe(true);
              expect(await storage.retireExecution(enrolled.record)).toBe(true);
              const proof = await storage.readExecutionProof(enrolled.record);
              if (!proof) throw new Error('Missing provider proof');
              expect(await storage.acknowledgeExecutionRelease(enrolled.record, proof)).toBe(true);
            },
          },
        );
        expect(cleared.deletedCount).toBe(1);
        const tag = await mongoose.models.ConversationTag.findOne({
          user: owner.userId,
          tag: 'work',
        }).lean<{ count: number }>();
        expect(tag?.count ?? 0).toBe(0);
        expect(await methods.hasPendingResponseCheckpointCleanup(owner)).toBe(false);
      }),
  );
  it.each(['account', 'history'] as const)(
    'cleans legacy Response ownership from a strict tenant-scoped %s caller',
    (mode) =>
      scope(async () => {
        await root();
        await root({ userId: owner.userId });
        await withStrictTenants(async () => {
          if (mode === 'account') await methods.prepareUserResponseErasure(owner);
          await methods.deleteConvos(owner.userId, {}, { allowEmpty: true });
          if (mode === 'account') await methods.eraseUserResponses(owner);
          expect(await methods.hasPendingResponseCheckpointCleanup(owner)).toBe(false);
        });
      }),
  );
  it.each(['all', 'specific'] as const)(
    'cleans captured history payload partitions under strict isolation (%s)',
    (mode) =>
      scope(async () => {
        const fixtures = [
          { user: owner.userId, tenantId: owner.tenantId },
          { user: owner.userId, tenantId: undefined },
          { user: owner.userId, tenantId: 'other-tenant' },
          { user: 'other-user', tenantId: undefined },
        ].map((partition) => ({ ...partition, conversationId: randomUUID() }));
        await runAsSystem(async () => {
          for (const fixture of fixtures) {
            await mongoose.models.Conversation.create({ ...fixture, endpoint: 'agents' });
            await mongoose.models.Message.create({
              ...fixture,
              messageId: `${fixture.conversationId}:assistant`,
              text: 'private history',
              subagentContent: { version: 1, throughRevision: 1 },
            });
            await mongoose.models.SubagentContent.create({
              ...fixture,
              _id: randomUUID(),
              parentConversationId: fixture.conversationId,
              taskId: fixture.conversationId,
              revision: 1,
              fragment: 0,
              fragments: 1,
              fromSequence: 0,
              throughSequence: 1,
              digest: 'fixture',
              payload: 'private tool result',
            });
            await mongoose.models.ToolApprovalGrant.create({
              ...fixture,
              agentId: 'agent',
              toolName: 'private-tool',
            });
          }
        });
        await withStrictTenants(async () => {
          const result = await methods.deleteConvos(
            owner.userId,
            mode === 'all' ? {} : { conversationId: fixtures[0].conversationId },
          );
          expect(result.messages.deletedCount).toBe(mode === 'all' ? 2 : 1);
          await runAsSystem(async () => {
            for (const [index, fixture] of fixtures.entries()) {
              const expected = index === 0 || (mode === 'all' && index === 1) ? 0 : 1;
              for (const model of [
                'Conversation',
                'Message',
                'SubagentContent',
                'ToolApprovalGrant',
              ]) {
                expect(
                  await mongoose.models[model].countDocuments({
                    user: fixture.user,
                    conversationId: fixture.conversationId,
                    tenantId: fixture.tenantId || { $in: [null, ''] },
                  }),
                ).toBe(expected);
              }
            }
          });
        });
      }),
  );
  it('keeps strict legacy cleanup pending until the exact enrolled writer settles', () =>
    scope(async () => {
      const legacyOwner = { userId: owner.userId };
      const record = await root(legacyOwner);
      const binding = { generationCreatedAt: Date.now(), providerExecutionId: randomUUID() };
      const namespace = `${checkpointOwnerNamespacePrefix(record.userId)}${randomUUID()}`;
      const writer = await tenantStorage.run(legacyOwner, async () => {
        const enrolled = await storage.enrollExecution(record, binding, '{}');
        if (!enrolled.ok || !(await storage.bindExecution(enrolled.record, binding)))
          throw new Error('Enrollment failed');
        const writer = storage.createCheckpointWriter(responseReference(enrolled.record), {
          ...binding,
          writerId: randomUUID(),
          namespace,
          configJSON: JSON.stringify({
            type: 'mongo',
            checkpointCollectionName: 'strict_cp',
            checkpointWritesCollectionName: 'strict_writes',
          }),
        });
        expect(await writer.open()).toBe(true);
        return { record: enrolled.record, writer };
      });
      const checkpoints = mongoose.connection.db!.collection('strict_cp');
      await checkpoints.insertOne({
        thread_id: record.conversationId,
        checkpoint_ns: namespace,
        payload: 'private checkpoint',
      });
      await withStrictTenants(async () => {
        // New canonical provider admission remains forbidden from system context.
        await expect(
          runAsSystem(async () => storage.enrollExecution(writer.record, binding, '{}')),
        ).rejects.toThrow(TypeError);
        await methods.prepareUserResponseErasure(owner);
        await expect(
          methods.deleteConvos(owner.userId, {}, { allowEmpty: true }),
        ).rejects.toMatchObject({ code: 'response_erasure_pending' });
        expect(await checkpoints.countDocuments()).toBe(1);
        await runAsSystem(async () => {
          const identity = await storage.readCleanupIdentity(writer.record, record.responseId);
          expect(identity).toMatchObject({
            retirement: 'owner_deleted',
            generationCreatedAt: binding.generationCreatedAt,
          });
          expect(await storage.readExecutionProof(writer.record)).toBeNull();
          expect(await writer.writer.settle()).toBe(true);
          expect(
            await storage.settleExecution(responseReference(writer.record), binding, 'aborted'),
          ).toBe(true);
          const proof = await storage.readExecutionProof(writer.record);
          if (!proof) throw new Error('Missing exact cleanup proof');
          await checkpoints.deleteMany({
            thread_id: record.conversationId,
            checkpoint_ns: namespace,
          });
          expect(await storage.acknowledgeCheckpointErasure(writer.record, proof)).toBe(true);
          expect(await storage.readReleaseAuthority(writer.record)).toMatchObject({
            kind: 'provider',
            proof: { releaseReady: true },
          });
          expect(await storage.acknowledgeExecutionRelease(writer.record, proof)).toBe(true);
        });
        await methods.deleteConvos(owner.userId, {}, { allowEmpty: true });
        await methods.eraseUserResponses(owner);
        expect(await methods.hasPendingResponseCheckpointCleanup(owner)).toBe(false);
      });
    }));
  it('supports strict accounts with no legacy data and refuses unscoped or other-tenant erasure', () =>
    scope(async () => {
      await root();
      await withStrictTenants(async () => {
        await expect(
          methods.prepareUserResponseErasure({ ...owner, tenantId: 'another-tenant' }),
        ).rejects.toThrow(TypeError);
        await expect(
          methods.eraseUserResponses({ ...owner, tenantId: 'another-tenant' }),
        ).rejects.toThrow(TypeError);
        await tenantStorage.run({}, async () => {
          await expect(
            methods.prepareUserResponseErasure({ userId: owner.userId }),
          ).rejects.toThrow('without tenant context');
          await expect(methods.eraseUserResponses({ userId: owner.userId })).rejects.toThrow(
            'without tenant context',
          );
        });
        await methods.prepareUserResponseErasure(owner);
        await methods.deleteConvos(owner.userId, {}, { allowEmpty: true });
        await methods.eraseUserResponses(owner);
        expect(await methods.hasPendingResponseCheckpointCleanup(owner)).toBe(false);
      });
    }));
  it('account preparation fences current and legacy admission before final response erasure', () =>
    scope(async () => {
      await root();
      await root({ userId: owner.userId });
      await methods.prepareUserResponseErasure(owner);
      expect((await reserve()).ok).toBe(false);
      expect((await reserve({ userId: owner.userId })).ok).toBe(false);
      await methods.deleteConvos(owner.userId, {}, { allowEmpty: true });
      await methods.eraseUserResponses(owner);
      expect(await methods.hasPendingResponseCheckpointCleanup(owner)).toBe(false);
      expect((await reserve()).ok).toBe(false);
      expect((await reserve({ ...owner, userId: 'another-owner' })).ok).toBe(true);
    }));
});
