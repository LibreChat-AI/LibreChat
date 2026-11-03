import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import { durableStorageConfigSchema } from 'librechat-data-provider';
import { MongoMemoryServer, MongoMemoryReplSet } from 'mongodb-memory-server';
import type { ManagedStorageTarget } from '~/types/managed';
import {
  allocateManagedTarget,
  managedTargetModels,
  discardManagedAllocation,
  pinManagedTarget,
  beginManagedTargetRegistration,
  markManagedTargetRegistered,
} from './managed';
import { createManagedConversationId, createManagedMessageId } from '~/utils/managed';
import { createResponseAllocationReclaimer } from './responseMaintenance';
import { tenantStorage, runAsSystem } from '~/config/tenantContext';
import { resetTenantStrictCache } from '~/tenant/policy';
import { publishResponseRoot } from './responseRoot';
import { selectResponseTarget } from './projection';
import { responseScopeKeys } from './responseScope';
import { createResponseStorage } from './response';
import { createModels } from '~/models';

const engines = ['standalone', 'replica', ...(process.env.FERRETDB_URI ? ['FerretDB'] : [])];
describe.each(engines)('allocation maintenance on %s', (engine) => {
  let server: MongoMemoryServer | MongoMemoryReplSet | undefined;
  const originalStrict = process.env.TENANT_ISOLATION_STRICT;
  const scoped = <T>(tenantId: string | undefined, work: () => Promise<T>) =>
    tenantStorage.run({ tenantId }, work);
  beforeAll(async () => {
    if (engine === 'replica') server = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    else if (engine === 'standalone') server = await MongoMemoryServer.create();
    createModels(mongoose);
    await mongoose.connect(server?.getUri() ?? process.env.FERRETDB_URI!, {
      dbName: `allocation_${randomUUID().replace(/-/g, '')}`,
    });
  }, 60000);
  afterEach(async () => {
    jest.restoreAllMocks();
    if (originalStrict === undefined) delete process.env.TENANT_ISOLATION_STRICT;
    else process.env.TENANT_ISOLATION_STRICT = originalStrict;
    resetTenantStrictCache();
    await mongoose.connection.db!.dropDatabase();
  });
  afterAll(async () => {
    await mongoose.disconnect();
    await server?.stop();
  });
  const maintenance = () =>
    createResponseAllocationReclaimer(mongoose, async () => durableStorageConfigSchema.parse({}));
  async function age(target: ManagedStorageTarget) {
    await runAsSystem(() =>
      mongoose
        .model(managedTargetModels[target.kind])
        .collection.updateOne(
          { _id: new mongoose.Types.ObjectId(target.id) },
          { $set: { createdAt: new Date(0) } },
        ),
    );
  }
  async function exists(target: ManagedStorageTarget) {
    return runAsSystem(() =>
      mongoose
        .model(managedTargetModels[target.kind])
        .collection.findOne(
          { _id: new mongoose.Types.ObjectId(target.id) },
          { projection: { _id: 1 } },
        ),
    );
  }
  it.each([false, true])(
    'reclaims abandoned root and child phases across partitions (strict=%s)',
    async (strict) => {
      const abandoned: ManagedStorageTarget[] = [];
      const fresh: ManagedStorageTarget[] = [];
      for (const tenantId of [undefined, 'tenant-a', 'tenant-b']) {
        await scoped(tenantId, async () => {
          for (const kind of ['response', 'message', 'conversation'] as const) {
            const old = await allocateManagedTarget(mongoose, kind, tenantId);
            abandoned.push(old);
            await age(old);
            fresh.push(await allocateManagedTarget(mongoose, kind, tenantId));
          }
          const parentId = new mongoose.Types.ObjectId().toHexString();
          for (const phase of ['pinned', 'registering', 'registered'] as const) {
            const target = await allocateManagedTarget(mongoose, 'message', tenantId);
            expect(await pinManagedTarget(mongoose, target, parentId)).toBe(true);
            if (phase !== 'pinned')
              expect(await beginManagedTargetRegistration(mongoose, target, parentId)).toBe(true);
            if (phase === 'registered') {
              const [ownerKey, conversationKey] = responseScopeKeys(
                { userId: 'orphan', tenantId },
                'orphan-conversation',
              );
              expect(
                await markManagedTargetRegistered(mongoose, {
                  target,
                  parentId,
                  ownerKey,
                  conversationKey,
                  logicalId: createManagedMessageId(),
                  receipt: 'a'.repeat(64),
                }),
              ).toBe(true);
            }
            abandoned.push(target);
            await age(target);
          }
          await mongoose.models.Message.create({
            user: 'owner',
            tenantId,
            conversationId: randomUUID(),
            messageId: randomUUID(),
            text: 'published private history',
          });
        });
      }
      process.env.TENANT_ISOLATION_STRICT = String(strict);
      resetTenantStrictCache();
      const sweep = maintenance();
      const activity = { found: false };
      let deleted = 0;
      for (let turn = 0; turn < 30; turn++) deleted += await sweep(2, activity);
      expect(deleted).toBe(abandoned.length);
      expect(activity.found).toBe(true);
      for (const target of abandoned) expect(await exists(target)).toBeNull();
      for (const target of fresh) expect(await exists(target)).not.toBeNull();
      expect(
        await runAsSystem(
          async () => await mongoose.models.Message.countDocuments({ user: 'owner' }),
        ),
      ).toBe(3);
      const named = fresh.find((target) => target.tenantId === 'tenant-a')!;
      await expect(
        runAsSystem(async () => allocateManagedTarget(mongoose, 'message')),
      ).rejects.toThrow(TypeError);
      await expect(
        runAsSystem(async () => discardManagedAllocation(mongoose, named)),
      ).rejects.toThrow(TypeError);
      await expect(
        scoped('tenant-b', async () => discardManagedAllocation(mongoose, named)),
      ).rejects.toThrow(TypeError);
    },
  );
  it('fences an old registered Root before a paused publisher can write private state', async () => {
    const tenantId = 'paused-publisher';
    const target = await scoped(tenantId, () =>
      allocateManagedTarget(mongoose, 'response', tenantId),
    );
    const input = {
      userId: 'owner',
      tenantId,
      responseId: createManagedMessageId(),
      conversationId: createManagedConversationId(),
      requestKey: randomUUID(),
      fingerprint: 'request',
      agentId: 'agent',
      requestJSON: '{"private":"request"}',
      parentMessageId: 'root',
    };
    let entered!: () => void;
    let release!: () => void;
    const paused = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const resumed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const model = mongoose.models.StoredResponse;
    const original = model.findOneAndUpdate.bind(model);
    const publishingQuery = jest.spyOn(model, 'findOneAndUpdate').mockImplementation((...args) => {
      const query = original(...args);
      const execute = query.exec.bind(query);
      jest.spyOn(query, 'exec').mockImplementation(async () => {
        entered();
        await resumed;
        return execute();
      });
      return query;
    });
    const publishing = scoped(tenantId, () => publishResponseRoot(mongoose, target, input));
    try {
      await paused;
      publishingQuery.mockRestore();
      await age(target);
      const sweep = maintenance();
      for (let turn = 0; turn < 3; turn++) await sweep(10, { found: false });
      expect(await exists(target)).toBeNull();
    } finally {
      publishingQuery.mockRestore();
      release();
    }
    expect(await publishing).toBeNull();
    expect(await runAsSystem(() => model.countDocuments({ userId: 'owner' }))).toBe(0);
  });
  it.each([undefined, 'selected-tenant'])(
    'preserves the exact live parent selection under strict isolation (tenant=%s)',
    async (tenantId) => {
      const selected = await scoped(tenantId, async () => {
        const storage = createResponseStorage(mongoose);
        const reserved = await storage.reserve({
          userId: 'owner',
          tenantId,
          responseId: createManagedMessageId(),
          conversationId: createManagedConversationId(),
          requestKey: randomUUID(),
          fingerprint: 'request',
          agentId: 'agent',
          requestJSON: '{}',
          parentMessageId: 'root',
        });
        if (!reserved.ok) throw new Error('Fixture reservation failed');
        const execution = { generationCreatedAt: Date.now(), providerExecutionId: randomUUID() };
        const enrolled = await storage.enrollExecution(reserved.record, execution, '{}');
        if (!enrolled.ok || !(await storage.bindExecution(enrolled.record, execution)))
          throw new Error('Fixture enrollment failed');
        const result = await selectResponseTarget(mongoose, {
          ...reserved.record,
          parentId: reserved.record.storageTarget!.id,
          logicalId: reserved.record.conversationId,
          kind: 'conversation',
          execution,
        });
        if (!result.ok) throw new Error('Fixture selection failed');
        return { target: result.publication.target, root: reserved.record.storageTarget! };
      });
      await age(selected.target);
      await age(selected.root);
      process.env.TENANT_ISOLATION_STRICT = 'true';
      resetTenantStrictCache();
      const sweep = maintenance();
      for (let turn = 0; turn < 3; turn++) await sweep(10, { found: false });
      expect(await exists(selected.target)).not.toBeNull();
      expect(await exists(selected.root)).not.toBeNull();
      // Lost parent is a physical fixture fault, not permission to replay its old allocation.
      await runAsSystem(() =>
        mongoose.models.StoredResponse.collection.deleteOne({
          _id: new mongoose.Types.ObjectId(selected.root.id),
        }),
      );
      for (let turn = 0; turn < 3; turn++) await sweep(10, { found: false });
      expect(await exists(selected.target)).toBeNull();
      if (tenantId)
        expect(
          await scoped(tenantId, () =>
            pinManagedTarget(mongoose, selected.target, selected.root.id),
          ),
        ).toBe(false);
      else
        await expect(
          runAsSystem(async () => pinManagedTarget(mongoose, selected.target, selected.root.id)),
        ).rejects.toThrow(TypeError);
    },
  );
});
