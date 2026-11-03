import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import { MongoMemoryServer, MongoMemoryReplSet } from 'mongodb-memory-server';
import { allocateManagedTarget, managedRegistration } from './managed';
import { createResponseScopeModel } from '~/models/responseScope';
import { registerResponseTarget } from './registration';
import { tenantStorage } from '~/config/tenantContext';
import { MAX_BSON_DOCUMENT_BYTES } from '~/utils/bson';
import { responseScopeKeys } from './responseScope';
import { createUserMethods } from './user';
import { createModels } from '~/models';
import { createMethods } from './index';

const engines = ['standalone', 'replica', ...(process.env.FERRETDB_URI ? ['FerretDB'] : [])];
describe.each(engines)('portable channel creation on %s', (engine) => {
  let server: MongoMemoryServer | MongoMemoryReplSet | undefined;
  beforeAll(async () => {
    if (engine === 'replica') server = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    else if (engine === 'standalone') server = await MongoMemoryServer.create();
    createModels(mongoose);
    await mongoose.connect(server?.getUri() ?? process.env.FERRETDB_URI!, {
      dbName: `channel_creation_${randomUUID().replace(/-/g, '')}`,
    });
  }, 60000);
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    await mongoose.disconnect();
    await server?.stop();
  });
  describe.each([undefined, 'channel-creation-tenant'])('tenant %s', (tenantId) => {
    const scoped = (test: () => Promise<void>) => tenantStorage.run({ tenantId }, test);
    async function fixture() {
      const user = await mongoose
        .model('User')
        .create({ email: `${randomUUID()}@example.test`, provider: 'local' });
      const owner = { userId: String(user._id), ...(tenantId && { tenantId }) };
      const methods = createMethods(mongoose);
      const input = {
        channelId: randomUUID(),
        agentId: 'agent',
        createdBy: owner.userId,
        type: 'slack' as const,
        status: 'active' as const,
        credentialMode: 'shared' as const,
        revision: randomUUID(),
        slack: { teamId: 'T1', appId: 'A1', botUserId: 'B1' },
        encryptedBotToken: 'synthetic-token',
        encryptedSigningSecret: 'synthetic-signing-secret',
      };
      return { owner, methods, input, key: responseScopeKeys(owner, '')[0] };
    }
    it('publishes and erases credentials without sessions and rejects late owner admission', () =>
      scoped(async () => {
        const f = await fixture();
        const sessions = jest.spyOn(mongoose, 'startSession');
        const created = await f.methods.createAgentChannel(f.input);
        expect(created).toMatchObject({
          channelId: f.input.channelId,
          encryptedBotToken: 'synthetic-token',
        });
        for (const field of ['_managed', 'pending', 'pendingCount', 'retentionEpoch'])
          expect(created).not.toHaveProperty(field);
        const stored = await mongoose
          .model('AgentChannel')
          .collection.findOne({ channelId: f.input.channelId });
        expect(stored).toMatchObject({
          __v: 0,
          _managed: { phase: 'published', parentId: String(stored!._id), scopeKeys: [f.key] },
        });
        expect(await createUserMethods(mongoose).deleteUserById(f.owner.userId)).toMatchObject({
          deletedCount: 1,
        });
        expect(
          await mongoose.model('AgentChannel').collection.findOne({ channelId: f.input.channelId }),
        ).toBeNull();
        expect(await createResponseScopeModel(mongoose).findById(f.key).lean()).toMatchObject({
          closed: true,
          pendingCount: 0,
        });
        await expect(
          f.methods.createAgentChannel({ ...f.input, channelId: randomUUID() }),
        ).rejects.toThrow('owner unavailable');
        expect(sessions).not.toHaveBeenCalled();
      }));
    it('cannot publish a paused credential writer after completed account erasure', () =>
      scoped(async () => {
        const f = await fixture();
        let entered!: () => void;
        let release!: () => void;
        const started = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const collection = mongoose.model('AgentChannel').collection;
        const write = collection.findOneAndUpdate.bind(collection);
        jest.spyOn(collection, 'findOneAndUpdate').mockImplementationOnce(async (...args) => {
          entered();
          await gate;
          return write(...args);
        });
        const creation = f.methods.createAgentChannel(f.input).then(
          () => null,
          (error: unknown) => error,
        );
        await started;
        let timedOut = false;
        const timeout = setTimeout(() => {
          timedOut = true;
          release();
        }, 5000);
        try {
          expect(await createUserMethods(mongoose).deleteUserById(f.owner.userId)).toMatchObject({
            deletedCount: 1,
          });
          expect(timedOut).toBe(false);
        } finally {
          clearTimeout(timeout);
          release();
        }
        expect(await creation).toMatchObject({ message: 'Channel storage target unavailable' });
        expect(await collection.findOne({ channelId: f.input.channelId })).toBeNull();
        expect(await createResponseScopeModel(mongoose).findById(f.key).lean()).toMatchObject({
          closed: true,
          pendingCount: 0,
        });
      }));
    it('retains cleanup ownership after a lost publication reply and erases the applied write', () =>
      scoped(async () => {
        const f = await fixture();
        const collection = mongoose.model('AgentChannel').collection;
        const write = collection.findOneAndUpdate.bind(collection);
        jest.spyOn(collection, 'findOneAndUpdate').mockImplementationOnce(async (...args) => {
          await write(...args);
          throw new Error('synthetic publication reply lost');
        });
        await expect(f.methods.createAgentChannel(f.input)).rejects.toThrow(
          'synthetic publication reply lost',
        );
        expect(await collection.findOne({ channelId: f.input.channelId })).toMatchObject({
          _managed: { phase: 'published' },
        });
        expect(await createResponseScopeModel(mongoose).findById(f.key).lean()).toMatchObject({
          pendingCount: 1,
        });
        expect(await createUserMethods(mongoose).deleteUserById(f.owner.userId)).toMatchObject({
          deletedCount: 1,
        });
        expect(await collection.findOne({ channelId: f.input.channelId })).toBeNull();
      }));
    it('releases only redacted creator metadata while another principal still drains', () =>
      scoped(async () => {
        const f = await fixture();
        await f.methods.createAgentChannel(f.input);
        const channels = mongoose.model('AgentChannel');
        const root = await channels.collection.findOne({ channelId: f.input.channelId });
        const target = {
          kind: 'channel' as const,
          id: String(root!._id),
          incarnation: root!._managed.incarnation,
          ...(tenantId && { tenantId }),
        };
        // Recover an interrupted root settlement, then close the creator with that entry retained.
        await registerResponseTarget(mongoose, f.owner, undefined, managedRegistration(target));
        const other = new mongoose.Types.ObjectId().toHexString();
        await mongoose.model('ChannelRun').create({
          tenantId: tenantId || '_',
          channelId: f.input.channelId,
          agentId: 'agent',
          laneId: randomUUID(),
          runId: randomUUID(),
          state: 'executing',
          principal: { userId: other, channelRevision: f.input.revision },
          payloadHash: 'synthetic-hash',
          admission: {
            eventId: randomUUID(),
            actor: { teamId: 'T1', appId: 'A1' },
            input: 'other user input',
          },
          sequence: 1,
          receivedAt: Date.now(),
        });
        expect(await createUserMethods(mongoose).deleteUserById(f.owner.userId)).toMatchObject({
          deletedCount: 1,
        });
        const retained = await channels.collection.findOne({ _id: root!._id });
        expect(retained).toMatchObject({ status: 'deleting' });
        expect(retained).not.toHaveProperty('encryptedBotToken');
        expect(retained).not.toHaveProperty('encryptedSigningSecret');
        expect(
          await mongoose.model('ChannelRun').exists({ 'principal.userId': other }),
        ).not.toBeNull();
        expect(await createResponseScopeModel(mongoose).findById(f.key).lean()).toMatchObject({
          closed: true,
          pendingCount: 0,
        });
      }));
    it('uses live configured registry capacity and preserves a disputed existing allocation', () =>
      scoped(async () => {
        const f = await fixture();
        const pending = await allocateManagedTarget(mongoose, 'channel', tenantId);
        await registerResponseTarget(mongoose, f.owner, undefined, managedRegistration(pending));
        const limits = jest.fn().mockResolvedValue({ maxPendingTargetsPerScope: 1 });
        const methods = createMethods(mongoose, { getDurableStorageConfig: limits });
        await expect(methods.createAgentChannel(f.input)).rejects.toThrow('admission unavailable');
        limits.mockResolvedValue({ maxPendingTargetsPerScope: 2 });
        await expect(methods.createAgentChannel(f.input)).resolves.toMatchObject({
          channelId: f.input.channelId,
        });
        expect(limits).toHaveBeenCalledTimes(2);
        expect(await createResponseScopeModel(mongoose).findById(f.key).lean()).toMatchObject({
          pendingCount: 1,
        });
      }));
    it('budgets the complete persisted channel before allocating or storing credential payload', () =>
      scoped(async () => {
        const f = await fixture();
        await expect(
          f.methods.createAgentChannel({
            ...f.input,
            encryptedBotToken: 'x'.repeat(MAX_BSON_DOCUMENT_BYTES),
          }),
        ).rejects.toMatchObject({ code: 'document_limit' });
        expect(
          await mongoose.model('AgentChannel').collection.findOne({ channelId: f.input.channelId }),
        ).toBeNull();
        expect(await createResponseScopeModel(mongoose).findById(f.key).lean()).toBeNull();
      }));
  });
});
