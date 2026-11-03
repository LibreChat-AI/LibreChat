import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import { MongoMemoryServer, MongoMemoryReplSet } from 'mongodb-memory-server';
import { createManagedMessageId, createManagedConversationId } from '~/utils/managed';
import { createChannelIdentityStorage } from './channelIdentity';
import { createAgentApiKeyMethods } from './agentApiKey';
import { createChannelRunStorage } from './channelRun';
import { tenantStorage } from '~/config/tenantContext';
import { createAgentChannelMethods } from './channel';
import { channelRunFence } from './channelRunWrite';
import { channelRunKeyBinding } from './channelKey';
import { createResponseStorage } from './response';
import { createModels } from '~/models';

const engines = ['standalone', 'replica', ...(process.env.FERRETDB_URI ? ['FerretDB'] : [])];
describe.each(engines)('closed channel copy erasure on %s', (engine) => {
  let server: MongoMemoryServer | MongoMemoryReplSet | undefined;
  beforeAll(async () => {
    if (engine === 'replica') server = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    else if (engine === 'standalone') server = await MongoMemoryServer.create();
    createModels(mongoose);
    await mongoose.connect(server?.getUri() ?? process.env.FERRETDB_URI!, {
      dbName: `channel_copies_${randomUUID().replace(/-/g, '')}`,
    });
  }, 60000);
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    await mongoose.disconnect();
    await server?.stop();
  });
  describe.each([undefined, 'copies-tenant'])('tenant %s', (tenantId) => {
    const scoped = (work: () => Promise<void>) => tenantStorage.run({ tenantId }, work);
    async function fixture(admit = true) {
      const creator = String(new mongoose.Types.ObjectId());
      const owner = String(new mongoose.Types.ObjectId());
      const channelId = randomUUID();
      const channels = createAgentChannelMethods(mongoose, async () => ({ erasureBatchSize: 1 }));
      await channels.createAgentChannel({
        channelId,
        createdBy: creator,
        agentId: 'agent',
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
          userId: owner,
          ticketHash: randomUUID(),
          ticketExpiresAtMs: Date.now() + 60000,
          expiresAtMs: Date.now() + 600000,
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
      const input = {
        tenantId: tenantId || '_',
        channelId,
        agentId: 'agent',
        principal: { userId: owner, channelRevision: 'one', linkId, linkRevision: 'one' },
        admission: {
          eventId: 'event',
          externalChannelId: 'C',
          externalThreadKey: 'thread',
          externalMessageKey: 'C:1',
          actor: { teamId: 'T', appId: 'A', externalUserId: 'U' },
          input: 'private prompt',
        },
      };
      const storage = createChannelRunStorage(mongoose);
      if (admit) await storage.admit(input, 100);
      const erase = () => channels.deleteAgentChannel(channelId, creator);
      async function retire() {
        const saved = (await storage.read(
          input.tenantId,
          channelId,
          (await mongoose.models.ChannelRun.findOne({ channelId }).lean<{ runId: string }>())!
            .runId,
        ))!;
        const claimed = (await storage.claimAuthorityLost(saved, 'cleanup', 103, 1000))!;
        expect(claimed.execution?.apiKeyId).toBeUndefined();
        await storage.finishAuthorityLost(input.tenantId, channelRunFence(claimed), 104);
        return (await storage.read(input.tenantId, channelId, claimed.runId))!;
      }
      return { creator, owner, channelId, channels, storage, input, erase, retire };
    }
    it('drains first, removes every private copy in bounded pages, and preserves canonical owner history', () =>
      scoped(async () => {
        const f = await fixture();
        const claimed = (await f.storage.claim(
          f.input.tenantId,
          f.channelId,
          'worker',
          101,
          1000,
        ))!;
        const prepared = await f.storage.prepareExecution(
          f.input.tenantId,
          channelRunFence(claimed),
          102,
        );
        const candidate = await createAgentApiKeyMethods(mongoose).createAgentApiKey({
          userId: f.owner,
          name: 'Unattached candidate',
          binding: channelRunKeyBinding(prepared),
        });
        const responses = createResponseStorage(mongoose);
        const historyId = createManagedMessageId();
        const history = await responses.reserve({
          ...(tenantId && { tenantId }),
          userId: f.owner,
          agentId: 'agent',
          responseId: historyId,
          sourceKeyId: 'history',
          requestKey: randomUUID(),
          fingerprint: 'history',
          conversationId: createManagedConversationId(),
          parentMessageId: '00000000-0000-0000-0000-000000000000',
          requestJSON: '{}',
        });
        if (!history.ok) throw new Error('Fixture history reservation failed');
        const messageId = randomUUID();
        await mongoose.models.Message.create({
          ...(tenantId && { tenantId }),
          user: f.owner,
          conversationId: randomUUID(),
          messageId,
          sender: 'User',
          text: 'preserve canonical history',
          isCreatedByUser: true,
        });
        expect(await f.erase()).toEqual({ status: 'pending_drain' });
        expect(
          await mongoose.models.AgentApiKey.collection.findOne({
            _id: new mongoose.Types.ObjectId(candidate.id),
          }),
        ).not.toBeNull();
        await f.retire();
        expect(await f.erase()).toEqual({ status: 'deleted' });
        for (const model of ['ChannelRun', 'ChannelLane', 'ChannelIdentity'])
          expect(
            await mongoose.model(model).collection.countDocuments({ channelId: f.channelId }),
          ).toBe(0);
        expect(
          await mongoose.models.ChannelIdentity.collection.countDocuments({
            'identity.channelId': f.channelId,
          }),
        ).toBe(0);
        expect(
          await mongoose.models.AgentApiKey.collection.findOne({
            _id: new mongoose.Types.ObjectId(candidate.id),
          }),
        ).toBeNull();
        expect(
          await responses.read({ userId: f.owner, ...(tenantId && { tenantId }) }, historyId),
        ).not.toBeNull();
        expect(await mongoose.models.Message.findOne({ messageId }).lean()).toMatchObject({
          text: 'preserve canonical history',
        });
        expect(await f.erase()).toEqual({ status: 'not_found' });
      }));
    it('recovers a lost control-fence reply with the private Run retained until acknowledgment', () =>
      scoped(async () => {
        const f = await fixture();
        const terminal = await f.retire();
        const lanes = mongoose.models.ChannelLane.collection;
        const update = lanes.updateOne.bind(lanes);
        let failed = false;
        const spy = jest.spyOn(lanes, 'updateOne').mockImplementation(async (...args) => {
          const result = await update(...args);
          if (
            args[0].kind === 'control' &&
            !Array.isArray(args[1]) &&
            args[1].$inc?.revision &&
            !failed
          ) {
            failed = true;
            throw new Error('synthetic lost fence acknowledgment');
          }
          return result;
        });
        await expect(f.erase()).rejects.toThrow('synthetic lost fence acknowledgment');
        expect(
          await mongoose.models.ChannelRun.collection.findOne({ runId: terminal.runId }),
        ).toMatchObject({ _managed: { phase: 'retired' } });
        expect(await f.channels.getAgentChannel(f.channelId)).toMatchObject({ status: 'deleting' });
        spy.mockRestore();
        expect(await f.erase()).toEqual({ status: 'deleted' });
      }));
    it.each(['unfenced', 'required-unknown', 'inflight-progress', 'optional-unknown'] as const)(
      'uses positive terminal and delivery disposition for %s',
      (evidence) =>
        scoped(async () => {
          const f = await fixture();
          const terminal = await f.retire();
          const runs = mongoose.models.ChannelRun.collection;
          if (evidence === 'unfenced')
            await runs.updateOne({ runId: terminal.runId }, { $unset: { terminalFence: 1 } });
          if (evidence === 'inflight-progress')
            await runs.updateOne(
              { runId: terminal.runId },
              { $set: { progress: { outcome: 'inflight' } } },
            );
          if (evidence.endsWith('unknown'))
            await runs.updateOne(
              { runId: terminal.runId },
              {
                $set: {
                  plan: {
                    parts: [
                      { operationId: 'operation', required: evidence === 'required-unknown' },
                    ],
                  },
                  receipts: [{ operationId: 'operation', outcome: 'unknown', attempts: 1 }],
                },
              },
            );
          expect(await f.erase()).toEqual({
            status: evidence === 'optional-unknown' ? 'deleted' : 'pending_drain',
          });
          if (evidence !== 'optional-unknown')
            expect(await runs.findOne({ runId: terminal.runId })).not.toBeNull();
        }),
    );
    it('fences a registered private publisher before deleting its principal and control lanes', () =>
      scoped(async () => {
        const f = await fixture(false);
        const collection = mongoose.models.ChannelRun.collection;
        const update = collection.updateOne.bind(collection);
        let entered!: () => void;
        let release!: () => void;
        const started = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        let paused = false;
        const spy = jest.spyOn(collection, 'updateOne').mockImplementation(async (...args) => {
          if (
            !Array.isArray(args[1]) &&
            args[1].$set?.['_managed.phase'] === 'published' &&
            !paused
          ) {
            paused = true;
            entered();
            await gate;
          }
          return update(...args);
        });
        const admission = f.storage.admit(f.input, 100).then(
          () => 'published',
          () => 'rejected',
        );
        const timeout = setTimeout(release, 10000);
        try {
          await started;
          expect(await f.erase()).toEqual({ status: 'deleted' });
          release();
          expect(await admission).toBe('rejected');
          expect(await collection.countDocuments({ channelId: f.channelId })).toBe(0);
          expect(
            await mongoose.models.ChannelLane.collection.countDocuments({ channelId: f.channelId }),
          ).toBe(0);
        } finally {
          clearTimeout(timeout);
          release();
          spy.mockRestore();
        }
      }));
    it('does not delete a replacement canonical nonce after cleaning the captured parent copies', () =>
      scoped(async () => {
        const f = await fixture();
        await f.retire();
        const collection = mongoose.models.AgentChannel.collection;
        const remove = collection.deleteOne.bind(collection);
        let changed = false;
        jest.spyOn(collection, 'deleteOne').mockImplementation(async (...args) => {
          if (!changed) {
            changed = true;
            await collection.updateOne(
              { channelId: f.channelId },
              {
                $set: {
                  '_managed.incarnation': randomUUID(),
                  status: 'active',
                  encryptedBotToken: 'replacement-private-token',
                },
              },
            );
          }
          return remove(...args);
        });
        expect(await f.erase()).toEqual({ status: 'not_found' });
        expect(await collection.findOne({ channelId: f.channelId })).toMatchObject({
          status: 'active',
          encryptedBotToken: 'replacement-private-token',
        });
      }));
  });
});
