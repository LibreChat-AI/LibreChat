import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import { MongoMemoryServer, MongoMemoryReplSet } from 'mongodb-memory-server';
import { createManagedMessageId, createManagedConversationId } from '~/utils/managed';
import { channelResponseOwner } from './channelRunResponse';
import { createChannelRunStorage } from './channelRun';
import { tenantStorage } from '~/config/tenantContext';
import { createAgentChannelMethods } from './channel';
import { closeResponseScopes } from './responseScope';
import { channelRunFence } from './channelRunWrite';
import { createResponseStorage } from './response';
import { createModels } from '~/models';

const engines = ['standalone', 'replica', ...(process.env.FERRETDB_URI ? ['FerretDB'] : [])];
describe.each(engines)('canonical channel Response binding on %s', (engine) => {
  let server: MongoMemoryServer | MongoMemoryReplSet | undefined;
  beforeAll(async () => {
    if (engine === 'replica') server = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    else if (engine === 'standalone') server = await MongoMemoryServer.create();
    createModels(mongoose);
    await mongoose.connect(server?.getUri() ?? process.env.FERRETDB_URI!, {
      dbName: `channel_response_${randomUUID().replace(/-/g, '')}`,
    });
  }, 60000);
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    await mongoose.disconnect();
    await server?.stop();
  });
  describe.each([undefined, 'binding-tenant'])('tenant %s', (tenantId) => {
    const scoped = (work: () => Promise<void>) => tenantStorage.run({ tenantId }, work);
    async function fixture(
      change:
        | 'owner'
        | 'key'
        | 'agent'
        | 'conversation'
        | 'parent'
        | 'input'
        | undefined = undefined,
    ) {
      const userId = String(new mongoose.Types.ObjectId());
      const channelId = randomUUID();
      await createAgentChannelMethods(mongoose).createAgentChannel({
        channelId,
        createdBy: userId,
        agentId: 'agent',
        type: 'slack',
        status: 'active',
        credentialMode: 'shared',
        revision: 'one',
        slack: { teamId: 'T1', appId: 'A1', botUserId: 'B1' },
      });
      const input = {
        tenantId: tenantId || '_',
        channelId,
        agentId: 'agent',
        principal: { userId, channelRevision: 'one' },
        admission: {
          eventId: 'event',
          externalChannelId: 'C1',
          externalThreadKey: 'C1:1',
          externalMessageKey: 'C1:event',
          actor: { teamId: 'T1', appId: 'A1', externalUserId: 'U1' },
          input: 'hello',
        },
      };
      const storage = createChannelRunStorage(mongoose);
      await storage.admit(input, 100);
      const claimed = (await storage.claim(input.tenantId, channelId, 'worker', 101, 10000))!;
      const fence = channelRunFence(claimed);
      await storage.prepareExecution(input.tenantId, fence, 102);
      const run = await storage.attachResponseCredential(
        input.tenantId,
        fence,
        { apiKeyId: 'key', encryptedApiKey: 'synthetic-encrypted' },
        103,
      );
      const responses = createResponseStorage(mongoose);
      const responseId = createManagedMessageId();
      const reservation = await responses.reserve({
        ...(tenantId && { tenantId }),
        userId: change === 'owner' ? String(new mongoose.Types.ObjectId()) : userId,
        agentId: change === 'agent' ? 'other' : 'agent',
        sourceKeyId: change === 'key' ? 'other' : 'key',
        responseId,
        requestKey: `channel:${run.runId}`,
        fingerprint: 'accepted-request',
        conversationId:
          change === 'conversation' ? createManagedConversationId() : run.execution!.conversationId,
        parentMessageId: change === 'parent' ? 'another-parent' : run.execution!.parentMessageId,
        requestJSON: JSON.stringify({
          model: 'agent',
          input: change === 'input' ? 'other input' : input.admission.input,
          background: true,
          store: true,
        }),
      });
      if (!reservation.ok) throw new Error('Fixture reservation failed');
      return {
        input,
        owner: { userId, ...(tenantId && { tenantId }) },
        run,
        fence,
        responseId,
        storage,
        responses,
        accepted: reservation.record,
      };
    }
    it('captures the exact canonical Root and request fingerprint', () =>
      scoped(async () => {
        const f = await fixture();
        const bound = await f.storage.bindResponse(f.input.tenantId, f.fence, f.responseId, 104);
        expect(bound.execution).toMatchObject({
          responseId: f.responseId,
          responseTarget: f.accepted.storageTarget,
          responseFingerprint: 'accepted-request',
        });
        expect(
          (await f.responses.read(channelResponseOwner(bound), f.responseId))!.storageTarget,
        ).toEqual(f.accepted.storageTarget);
      }));
    it.each(['owner', 'key', 'agent', 'conversation', 'parent', 'input'] as const)(
      'refuses mismatched canonical %s',
      (change) =>
        scoped(async () => {
          const f = await fixture(change);
          await expect(
            f.storage.bindResponse(f.input.tenantId, f.fence, f.responseId, 104),
          ).rejects.toMatchObject({ code: 'invalid_transition' });
          expect(
            (await f.storage.read(f.input.tenantId, f.input.channelId, f.run.runId))!.execution!
              .responseId,
          ).toBeUndefined();
        }),
    );
    it.each(['expired', 'closed'] as const)(
      'rejects normal %s work but recovers its original metadata for cancellation',
      (state) =>
        scoped(async () => {
          const f = await fixture();
          if (state === 'expired')
            await mongoose.models.StoredResponse.collection.updateOne(
              { responseId: f.responseId },
              { $set: { expiredAt: new Date(0), requestJSON: '' } },
            );
          else await closeResponseScopes(mongoose, f.owner, [f.run.execution!.conversationId]);
          await expect(
            f.storage.bindResponse(f.input.tenantId, f.fence, f.responseId, 104),
          ).rejects.toMatchObject({ code: 'invalid_transition' });
          expect(await f.storage.requestCancel(f.input, f.run.runId)).toBe(true);
          const recovered = await f.storage.recoverResponse(f.input.tenantId, f.fence, 105);
          expect(recovered!.execution).toMatchObject({
            responseId: f.responseId,
            responseTarget: f.accepted.storageTarget,
            responseFingerprint: 'accepted-request',
          });
          expect(await f.responses.read(channelResponseOwner(recovered!), f.responseId)).toBeNull();
        }),
    );
    it('cannot adopt a replacement canonical Root with identical logical metadata', () =>
      scoped(async () => {
        const f = await fixture();
        const bound = await f.storage.bindResponse(f.input.tenantId, f.fence, f.responseId, 104);
        const collection = mongoose.models.StoredResponse.collection;
        const old = await collection.findOne({ responseId: f.responseId });
        const id = new mongoose.Types.ObjectId();
        const incarnation = randomUUID();
        await collection.deleteOne({ _id: old!._id });
        await collection.insertOne({
          ...old!,
          _id: id,
          storageTarget: { ...old!.storageTarget, id: String(id), incarnation },
          _managed: { ...old!._managed, parentId: String(id), incarnation },
        });
        expect(await f.responses.read(f.owner, f.responseId)).not.toBeNull();
        expect(await f.responses.read(channelResponseOwner(bound), f.responseId)).toBeNull();
        await expect(
          f.storage.bindResponse(f.input.tenantId, f.fence, f.responseId, 105),
        ).rejects.toMatchObject({ code: 'invalid_transition' });
        expect(
          (await f.storage.read(f.input.tenantId, f.input.channelId, f.run.runId))!.execution!
            .responseTarget,
        ).toEqual(f.accepted.storageTarget);
      }));
    it('pins selection before a paused visible read instead of resolving the public ID again', () =>
      scoped(async () => {
        const f = await fixture();
        const collection = mongoose.models.StoredResponse.collection;
        const read = collection.findOne.bind(collection);
        let entered!: () => void;
        let release!: () => void;
        const started = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        let paused = false;
        const spy = jest.spyOn(collection, 'findOne').mockImplementation(async (...args) => {
          const result = await read(...args);
          if (args[1]?.projection?.fingerprint === 1 && !paused) {
            paused = true;
            entered();
            await gate;
          }
          return result;
        });
        const outcome = f.storage.bindResponse(f.input.tenantId, f.fence, f.responseId, 104).then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
        const timeout = setTimeout(release, 5000);
        try {
          await started;
          const old = await read({ responseId: f.responseId });
          const id = new mongoose.Types.ObjectId();
          const incarnation = randomUUID();
          await collection.deleteOne({ _id: old!._id });
          await collection.insertOne({
            ...old!,
            _id: id,
            storageTarget: { ...old!.storageTarget, id: String(id), incarnation },
            _managed: { ...old!._managed, parentId: String(id), incarnation },
          });
          release();
          expect(await outcome).toMatchObject({ error: { code: 'invalid_transition' } });
        } finally {
          clearTimeout(timeout);
          release();
          spy.mockRestore();
        }
      }));
    it('rejects changed request fingerprints within an already bound physical Root', () =>
      scoped(async () => {
        const f = await fixture();
        await f.storage.bindResponse(f.input.tenantId, f.fence, f.responseId, 104);
        await mongoose.models.StoredResponse.collection.updateOne(
          { responseId: f.responseId },
          { $set: { fingerprint: 'changed' } },
        );
        await expect(
          f.storage.bindResponse(f.input.tenantId, f.fence, f.responseId, 105),
        ).rejects.toMatchObject({ code: 'invalid_transition' });
      }));
  });
});
