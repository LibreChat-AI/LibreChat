import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import { MongoMemoryServer, MongoMemoryReplSet } from 'mongodb-memory-server';
import type { ManagedState } from '~/types/managed';
import { eraseChannelKeysForOwner, channelRunKeyBinding } from './channelKey';
import { closeResponseScopes, responseScopeKeys } from './responseScope';
import { createResponseScopeModel } from '~/models/responseScope';
import { createChannelIdentityStorage } from './channelIdentity';
import { createAgentApiKeyMethods } from './agentApiKey';
import { createChannelRunStorage } from './channelRun';
import { tenantStorage } from '~/config/tenantContext';
import { createAgentChannelMethods } from './channel';
import { channelRunFence } from './channelRunWrite';
import { createModels } from '~/models';

const engines = ['standalone', 'replica', ...(process.env.FERRETDB_URI ? ['FerretDB'] : [])];
describe.each(engines)('portable bound-key storage on %s', (engine) => {
  let server: MongoMemoryServer | MongoMemoryReplSet | undefined;
  beforeAll(async () => {
    if (engine === 'replica') server = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    else if (engine === 'standalone') server = await MongoMemoryServer.create();
    createModels(mongoose);
    await mongoose.connect(server?.getUri() ?? process.env.FERRETDB_URI!, {
      dbName: `channel_keys_${randomUUID().replace(/-/g, '')}`,
    });
  }, 60000);
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    await mongoose.disconnect();
    await server?.stop();
  });
  describe.each([undefined, 'key-tenant'])('tenant %s', (tenantId) => {
    const scoped = (work: () => Promise<void>) => tenantStorage.run({ tenantId }, work);
    async function fixture() {
      const userId = String(new mongoose.Types.ObjectId());
      const owner = { userId, ...(tenantId && { tenantId }) };
      const methods = createAgentApiKeyMethods(mongoose);
      const input = {
        userId,
        name: 'Synthetic source',
        binding: { kind: 'synthetic', id: 'grant' },
      };
      const key = responseScopeKeys(owner, '')[0];
      const erase = async () => {
        await closeResponseScopes(mongoose, owner);
        const anchor = await createResponseScopeModel(mongoose).findById(key).lean();
        await eraseChannelKeysForOwner(mongoose, owner, anchor!.pending ?? []);
      };
      return { userId, owner, methods, input, key, erase };
    }
    it('publishes an owner-registered key without sessions and preserves ordinary authentication', () =>
      scoped(async () => {
        const f = await fixture();
        const sessions = jest.spyOn(mongoose, 'startSession');
        const created = await f.methods.createAgentApiKey(f.input);
        expect(await f.methods.validateAgentApiKey(created.key)).toBeNull();
        expect(await f.methods.validateBoundAgentApiKey(created.key)).toMatchObject({
          userId: f.userId,
        });
        const stored = await mongoose.models.AgentApiKey.findById(created.id)
          .select('+_managed')
          .lean<{ _managed: ManagedState }>();
        expect(stored!._managed).toMatchObject({
          phase: 'published',
          parentId: created.id,
          scopeKeys: [f.key],
        });
        await mongoose.models.AgentApiKey.updateOne(
          { _id: created.id },
          {
            $set: {
              userId: new mongoose.Types.ObjectId(),
              binding: { kind: 'changed', id: 'changed' },
            },
          },
        );
        expect(await f.methods.validateBoundAgentApiKey(created.key)).toMatchObject({
          userId: f.userId,
          binding: f.input.binding,
        });
        await f.erase();
        expect(await f.methods.validateBoundAgentApiKey(created.key)).toBeNull();
        await expect(f.methods.createAgentApiKey(f.input)).rejects.toThrow('owner unavailable');
        expect(sessions).not.toHaveBeenCalled();
      }));
    it.each(['before', 'after'] as const)(
      'fences a publisher paused %s private publication',
      (point) =>
        scoped(async () => {
          const f = await fixture();
          const collection = mongoose.models.AgentApiKey.collection;
          const command = collection.findOneAndUpdate.bind(collection);
          let entered!: () => void;
          let release!: () => void;
          const started = new Promise<void>((resolve) => {
            entered = resolve;
          });
          const gate = new Promise<void>((resolve) => {
            release = resolve;
          });
          const intercepted = jest
            .spyOn(collection, 'findOneAndUpdate')
            .mockImplementation(async (...args) => {
              if (point === 'after') {
                await command(...args);
                entered();
                await gate;
                throw new Error('Synthetic lost publication reply');
              }
              entered();
              await gate;
              return command(...args);
            });
          const creating = f.methods.createAgentApiKey(f.input);
          const outcome = creating.then(
            () => 'unexpected success',
            () => 'rejected',
          );
          const timer = setTimeout(release, 5000);
          try {
            await started;
            await f.erase();
            release();
            expect(await outcome).toBe('rejected');
          } finally {
            clearTimeout(timer);
            release();
            intercepted.mockRestore();
          }
          expect(
            await collection.countDocuments({ userId: new mongoose.Types.ObjectId(f.userId) }),
          ).toBe(0);
          const anchor = await createResponseScopeModel(mongoose).findById(f.key).lean();
          expect(anchor!.pendingCount).toBe(0);
        }),
    );
    it('does not replay an ambiguous allocation or persist any private fields', () =>
      scoped(async () => {
        const f = await fixture();
        const db = mongoose.connection.db!;
        const command = db.command.bind(db);
        let inserts = 0;
        jest.spyOn(db, 'command').mockImplementation(async (...args) => {
          const result = await command(...args);
          if (args[0].insert === mongoose.models.AgentApiKey.collection.name) {
            inserts++;
            throw new Error('Synthetic lost allocation reply');
          }
          return result;
        });
        await expect(f.methods.createAgentApiKey(f.input)).rejects.toThrow('lost allocation');
        expect(inserts).toBe(1);
        expect(
          await mongoose.models.AgentApiKey.collection.countDocuments({
            userId: new mongoose.Types.ObjectId(f.userId),
          }),
        ).toBe(0);
      }));
    it('releases only a deleted creator ticket while preserving another account key', () =>
      scoped(async () => {
        const f = await fixture();
        const creator = { ...f.owner, userId: String(new mongoose.Types.ObjectId()) };
        const channelId = randomUUID();
        await createAgentChannelMethods(mongoose).createAgentChannel({
          channelId,
          agentId: 'agent',
          createdBy: creator.userId,
          type: 'slack',
          status: 'active',
          credentialMode: 'per_user',
          revision: 'one',
          slack: { teamId: 'T', appId: 'A', botUserId: 'B' },
        });
        const linkId = randomUUID();
        await createChannelIdentityStorage(mongoose).saveChannelIdentity(
          {
            tenantId: tenantId || '_',
            linkId,
            revision: 'one',
            state: 'active',
            userId: f.userId,
            ticketHash: randomUUID(),
            ticketExpiresAtMs: Date.now() + 60000,
            expiresAtMs: Date.now() + 60000,
            identity: {
              tenantId: tenantId || '_',
              channelId,
              channelRevision: 'one',
              agentId: 'agent',
              teamId: 'T',
              externalUserId: 'U',
            },
          },
          null,
        );
        const storage = createChannelRunStorage(mongoose);
        const input = {
          tenantId: tenantId || '_',
          channelId,
          agentId: 'agent',
          principal: { userId: f.userId, channelRevision: 'one', linkId, linkRevision: 'one' },
          admission: {
            eventId: 'event',
            externalChannelId: 'C',
            externalThreadKey: 'C:1',
            externalMessageKey: 'C:2',
            actor: { teamId: 'T', appId: 'A', externalUserId: 'U' },
            input: 'hello',
          },
        };
        await storage.admit(input, 100);
        const claimed = (await storage.claim(input.tenantId, channelId, 'worker', 101, 10000))!;
        const run = await storage.prepareExecution(input.tenantId, channelRunFence(claimed), 102);
        const collection = mongoose.models.AgentApiKey.collection;
        const publish = collection.findOneAndUpdate.bind(collection);
        const lost = jest
          .spyOn(collection, 'findOneAndUpdate')
          .mockImplementation(async (...args) => {
            await publish(...args);
            throw new Error('Synthetic lost reply');
          });
        await expect(
          f.methods.createAgentApiKey({ ...f.input, binding: channelRunKeyBinding(run) }),
        ).rejects.toThrow('lost reply');
        lost.mockRestore();
        await closeResponseScopes(mongoose, creator);
        const creatorKey = responseScopeKeys(creator, '')[0];
        const anchor = await createResponseScopeModel(mongoose).findById(creatorKey).lean();
        const tickets = anchor!.pending!.filter((entry) => entry.target.kind === 'channelKey');
        expect(tickets).toHaveLength(1);
        await eraseChannelKeysForOwner(mongoose, creator, tickets);
        expect(
          await collection.countDocuments({ userId: new mongoose.Types.ObjectId(f.userId) }),
        ).toBe(1);
        const current = await createResponseScopeModel(mongoose).findById(creatorKey).lean();
        expect(
          current!.pending!.filter((entry) => entry.target.kind === 'channelKey'),
        ).toHaveLength(0);
        await f.erase();
        expect(
          await collection.countDocuments({ userId: new mongoose.Types.ObjectId(f.userId) }),
        ).toBe(0);
      }));
    it('registers canonical Run roles and refuses a replacement physical Run', () =>
      scoped(async () => {
        const f = await fixture();
        const channelId = randomUUID();
        await createAgentChannelMethods(mongoose).createAgentChannel({
          channelId,
          agentId: 'agent',
          createdBy: f.userId,
          type: 'slack',
          status: 'active',
          credentialMode: 'shared',
          revision: 'one',
          slack: { teamId: 'T', appId: 'A', botUserId: 'B' },
        });
        const storage = createChannelRunStorage(mongoose);
        const input = {
          tenantId: tenantId || '_',
          channelId,
          agentId: 'agent',
          principal: { userId: f.userId, channelRevision: 'one' },
          admission: {
            eventId: 'event',
            externalChannelId: 'C',
            externalThreadKey: 'C:1',
            externalMessageKey: 'C:2',
            actor: { teamId: 'T', appId: 'A', externalUserId: 'U' },
            input: 'hello',
          },
        };
        await storage.admit(input, 100);
        const claimed = (await storage.claim(input.tenantId, channelId, 'worker', 101, 10000))!;
        const run = await storage.prepareExecution(input.tenantId, channelRunFence(claimed), 102);
        const binding = channelRunKeyBinding(run);
        const created = await f.methods.createAgentApiKey({ ...f.input, binding });
        expect((await f.methods.validateBoundAgentApiKey(created.key))!.binding).toEqual(binding);
        const stored = await mongoose.models.AgentApiKey.findById(created.id)
          .select('+_managed')
          .lean<{ _managed: ManagedState }>();
        expect(stored!._managed.scopeKeys).toHaveLength(4);
        await expect(
          f.methods.createAgentApiKey({
            ...f.input,
            binding: { ...binding, incarnation: randomUUID() },
          }),
        ).rejects.toThrow('Run unavailable');
      }));
  });
});
