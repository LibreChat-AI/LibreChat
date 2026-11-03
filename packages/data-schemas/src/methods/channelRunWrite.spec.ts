import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import { MongoMemoryServer, MongoMemoryReplSet } from 'mongodb-memory-server';
import type { PhysicalChannelRun } from './channelRunWrite';
import { channelRunFence, writeChannelRunPatch } from './channelRunWrite';
import { responseScopeKeys, closeResponseScopes } from './responseScope';
import { createResponseScopeModel } from '~/models/responseScope';
import { createManagedConversationId } from '~/utils/managed';
import { createChannelRunStorage } from './channelRun';
import { tenantStorage } from '~/config/tenantContext';
import { createAgentChannelMethods } from './channel';
import { createModels } from '~/models';

const engines = ['standalone', 'replica', ...(process.env.FERRETDB_URI ? ['FerretDB'] : [])];
describe.each(engines)('versioned Run mutations on %s', (engine) => {
  let server: MongoMemoryServer | MongoMemoryReplSet | undefined;
  beforeAll(async () => {
    if (engine === 'replica') server = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    else if (engine === 'standalone') server = await MongoMemoryServer.create();
    createModels(mongoose);
    await mongoose.connect(server?.getUri() ?? process.env.FERRETDB_URI!, {
      dbName: `run_writes_${randomUUID().replace(/-/g, '')}`,
    });
  }, 60000);
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    await mongoose.disconnect();
    await server?.stop();
  });
  describe.each([undefined, 'write-tenant'])('tenant %s', (tenantId) => {
    const scoped = (work: () => Promise<void>) => tenantStorage.run({ tenantId }, work);
    async function fixture() {
      const owner = String(new mongoose.Types.ObjectId());
      const channelId = randomUUID();
      await createAgentChannelMethods(mongoose).createAgentChannel({
        channelId,
        createdBy: owner,
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
        principal: { userId: owner, channelRevision: 'one' },
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
      const { run } = await storage.admit(input, 100);
      const claimed = await storage.claim(input.tenantId, channelId, 'worker', 100, 10000);
      if (!claimed) throw new Error('Fixture claim failed');
      const fence = channelRunFence(claimed);
      return { input, storage, run, fence, owner };
    }
    async function prepared() {
      const f = await fixture();
      await f.storage.prepareExecution(f.input.tenantId, f.fence, 101);
      return f;
    }
    it('makes the private Run owner and publication plus principal cursor owner immutable', () =>
      scoped(async () => {
        const f = await fixture();
        const runs = mongoose.models.ChannelRun;
        const current = await runs
          .findOne({ runId: f.run.runId })
          .select('+_managed')
          .lean<PhysicalChannelRun | null>();
        if (!current?.publication) throw new Error('Fixture publication missing');
        for (const patch of [
          { principal: undefined },
          { publication: undefined },
          { principal: { ...current.principal, userId: 'replacement' } },
          { publication: { ...current.publication, creatorId: 'replacement' } },
        ])
          await expect(
            writeChannelRunPatch(mongoose, current, patch, {}, async () => ({})),
          ).rejects.toMatchObject({ code: 'invalid_transition' });
        for (const update of [
          {
            $set: {
              principal: { ...current.principal, userId: 'replacement' },
              publication: { ...current.publication, creatorId: 'replacement' },
            },
          },
          { $set: { 'principal.userId': 'replacement', 'publication.creatorId': 'replacement' } },
          { $set: { 'publication.control.id': String(new mongoose.Types.ObjectId()) } },
          { $unset: { 'publication.channel.target': 1, 'publication.lane.incarnation': 1 } },
          { $unset: { principal: 1, publication: 1 } },
        ])
          await runs.updateOne({ _id: current._id }, update);
        const after = await runs.collection.findOne({ _id: current._id });
        expect(after!.principal).toEqual(current.principal);
        expect(after!.publication).toEqual(current.publication);
        const laneId = new mongoose.Types.ObjectId(current.publication.lane.id);
        await mongoose.models.ChannelLane.updateOne(
          { _id: laneId },
          { $set: { userId: 'replacement' } },
        );
        await mongoose.models.ChannelLane.updateOne({ _id: laneId }, { $unset: { userId: 1 } });
        expect(await mongoose.models.ChannelLane.collection.findOne({ _id: laneId })).toMatchObject(
          { userId: f.owner },
        );
      }));
    it('prepares one stable registered conversation across concurrent calls without sessions', () =>
      scoped(async () => {
        const f = await fixture();
        const sessions = jest.spyOn(mongoose, 'startSession');
        const results = await Promise.all(
          Array.from({ length: 4 }, () =>
            f.storage.prepareExecution(f.input.tenantId, f.fence, 101),
          ),
        );
        expect(new Set(results.map((run) => run.execution!.conversationId)).size).toBe(1);
        const conversationId = results[0].execution!.conversationId;
        expect(conversationId).toMatch(
          /^[a-f\d]{8}-[a-f\d]{4}-8[a-f\d]{3}-a[a-f\d]{3}-[a-f\d]{12}$/,
        );
        const key = responseScopeKeys(
          { userId: f.owner, ...(tenantId && { tenantId }) },
          conversationId,
        )[1];
        const anchor = await createResponseScopeModel(mongoose).findById(key).lean();
        expect(anchor).toMatchObject({ pendingCount: 0 });
        const raw = await mongoose.models.ChannelRun.collection.findOne({ runId: f.run.runId });
        expect(raw!._managed.scopeKeys).toContain(key);
        expect(sessions).not.toHaveBeenCalled();
      }));
    it('refuses first execution publication into a closed continuation conversation', () =>
      scoped(async () => {
        const f = await fixture();
        const conversationId = createManagedConversationId();
        await mongoose.models.ChannelLane.updateOne(
          { laneId: f.run.laneId },
          { $set: { conversationId } },
        );
        await closeResponseScopes(mongoose, { userId: f.owner, ...(tenantId && { tenantId }) }, [
          conversationId,
        ]);
        await expect(
          f.storage.prepareExecution(f.input.tenantId, f.fence, 101),
        ).rejects.toMatchObject({ code: 'invalid_transition' });
        const raw = await mongoose.models.ChannelRun.collection.findOne({ runId: f.run.runId });
        expect(raw!.execution).toBeUndefined();
        expect(raw!.state).toBe('queued');
      }));

    it('preserves the progress receipt state machine without opening a transaction', () =>
      scoped(async () => {
        const f = await prepared();
        const sessions = jest.spyOn(mongoose, 'startSession');
        await f.storage.planProgress(
          f.input.tenantId,
          f.fence,
          { revision: 1, rendererVersion: 'test', text: 'working' },
          102,
        );
        const sending = await f.storage.beginProgress(f.input.tenantId, f.fence, 1, 103);
        expect(sending.progress).toMatchObject({ outcome: 'inflight', attempts: 1 });
        const confirmed = await f.storage.settleProgress(
          f.input.tenantId,
          f.fence,
          { revision: 1, outcome: 'confirmed', attempts: 1, externalMessageKey: 'C1:progress' },
          104,
        );
        expect(confirmed.progress).toMatchObject({ outcome: 'confirmed', attempts: 1 });
        expect(sessions).not.toHaveBeenCalled();
      }));
    it('compares concurrent immutable progress proposals against the winning version', () =>
      scoped(async () => {
        const f = await prepared();
        const results = await Promise.allSettled(
          ['one', 'two'].map((text) =>
            f.storage.planProgress(
              f.input.tenantId,
              f.fence,
              { revision: 1, rendererVersion: 'test', text },
              102,
            ),
          ),
        );
        expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
        expect(results.find((item) => item.status === 'rejected')).toMatchObject({
          reason: { code: 'invalid_transition' },
        });
      }));
    it.each(['cancel', 'takeover', 'replace'] as const)(
      'fences a paused private write across %s',
      (action) =>
        scoped(async () => {
          const f = await prepared();
          await f.storage.planProgress(
            f.input.tenantId,
            f.fence,
            { revision: 1, rendererVersion: 'test', text: 'working' },
            102,
          );
          const collection = mongoose.models.ChannelRun.collection;
          const write = collection.findOneAndUpdate.bind(collection);
          let entered!: () => void;
          let release!: () => void;
          const started = new Promise<void>((resolve) => {
            entered = resolve;
          });
          const gate = new Promise<void>((resolve) => {
            release = resolve;
          });
          let paused = false;
          const spy = jest
            .spyOn(collection, 'findOneAndUpdate')
            .mockImplementation(async (...args) => {
              if (
                !Array.isArray(args[1]) &&
                args[1].$set?.progress?.outcome === 'inflight' &&
                !paused
              ) {
                paused = true;
                entered();
                await gate;
              }
              return write(...args);
            });
          const pending = f.storage.beginProgress(f.input.tenantId, f.fence, 1, 103);
          const outcome = pending.then(
            (value) => ({ value }),
            (error) => ({ error }),
          );
          const timeout = setTimeout(release, 5000);
          try {
            await started;
            if (action === 'cancel')
              expect(await f.storage.requestCancel(f.input, f.run.runId)).toBe(true);
            else if (action === 'takeover')
              await collection.updateOne(
                { runId: f.run.runId },
                { $set: { leaseEpoch: 2, leaseOwner: 'new-worker' }, $inc: { __v: 1 } },
              );
            else {
              const old = await collection.findOne({ runId: f.run.runId });
              await collection.deleteOne({ _id: old!._id });
              await collection.insertOne({
                ...old!,
                _id: new mongoose.Types.ObjectId(),
                _managed: { ...old!._managed, incarnation: randomUUID() },
              });
            }
            release();
            const result = await outcome;
            if (action === 'cancel')
              expect(result).toMatchObject({
                value: {
                  cancellationRequested: true,
                  progress: { outcome: 'inflight', attempts: 1 },
                },
              });
            else {
              expect(result).toMatchObject({ error: { code: 'stale_fence' } });
              expect((await collection.findOne({ runId: f.run.runId }))!.progress.outcome).toBe(
                'planned',
              );
            }
          } finally {
            clearTimeout(timeout);
            release();
            spy.mockRestore();
          }
        }),
    );
    it('does not replay an applied private update after losing its reply', () =>
      scoped(async () => {
        const f = await prepared();
        await f.storage.planProgress(
          f.input.tenantId,
          f.fence,
          { revision: 1, rendererVersion: 'test', text: 'working' },
          102,
        );
        const collection = mongoose.models.ChannelRun.collection;
        const write = collection.findOneAndUpdate.bind(collection);
        let attempts = 0;
        jest.spyOn(collection, 'findOneAndUpdate').mockImplementation(async (...args) => {
          const result = await write(...args);
          if (!Array.isArray(args[1]) && args[1].$set?.progress?.outcome === 'inflight') {
            attempts++;
            throw new Error('synthetic lost reply');
          }
          return result;
        });
        await expect(f.storage.beginProgress(f.input.tenantId, f.fence, 1, 103)).rejects.toThrow(
          'synthetic lost reply',
        );
        expect(attempts).toBe(1);
        expect((await collection.findOne({ runId: f.run.runId }))!.progress).toMatchObject({
          outcome: 'inflight',
          attempts: 1,
        });
      }));
    it('includes retained unknown fields in the whole-document BSON budget', () =>
      scoped(async () => {
        const f = await prepared();
        await mongoose.models.ChannelRun.collection.updateOne(
          { runId: f.run.runId },
          {
            $set: {
              extension: 'x'.repeat(8 * 1024 * 1024),
              'execution.extension': 'y'.repeat(6 * 1024 * 1024),
            },
          },
        );
        await expect(
          f.storage.planProgress(
            f.input.tenantId,
            f.fence,
            { revision: 1, rendererVersion: 'test', text: 'z'.repeat(3 * 1024 * 1024) },
            102,
          ),
        ).rejects.toMatchObject({ code: 'document_limit' });
        expect(
          (await mongoose.models.ChannelRun.collection.findOne({ runId: f.run.runId }))!.progress,
        ).toBeUndefined();
      }));
  });
});
