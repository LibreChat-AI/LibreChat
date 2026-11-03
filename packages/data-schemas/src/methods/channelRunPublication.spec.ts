import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import { MongoMemoryServer, MongoMemoryReplSet } from 'mongodb-memory-server';
import type { ChannelRunRecord } from '~/models/channelRun';
import { createChannelRunPublication } from './channelRunPublication';
import { createChannelRunStorage } from './channelRun';
import { tenantStorage } from '~/config/tenantContext';
import { createAgentChannelMethods } from './channel';
import { channelRunFence } from './channelRunWrite';
import { createModels } from '~/models';

const engines = ['standalone', 'replica', ...(process.env.FERRETDB_URI ? ['FerretDB'] : [])];
describe.each(engines)('portable Run publication on %s', (engine) => {
  let server: MongoMemoryServer | MongoMemoryReplSet | undefined;
  beforeAll(async () => {
    if (engine === 'replica') server = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    else if (engine === 'standalone') server = await MongoMemoryServer.create();
    createModels(mongoose);
    await mongoose.connect(server?.getUri() ?? process.env.FERRETDB_URI!, {
      dbName: `run_publication_${randomUUID().replace(/-/g, '')}`,
    });
  }, 60000);
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    await mongoose.disconnect();
    await server?.stop();
  });
  describe.each([undefined, 'publication-tenant'])('tenant %s', (tenantId) => {
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
          externalThreadKey: 'PRIVATE-THREAD',
          externalMessageKey: 'C1:event',
          actor: { teamId: 'T1', appId: 'A1', externalUserId: 'PRIVATE-ACTOR' },
          input: 'PRIVATE-PROMPT',
        },
      };
      return {
        input,
        storage: createChannelRunStorage(mongoose),
        recovery: createChannelRunPublication(mongoose, async () => ({})),
      };
    }
    it('converges retries and distinct events without transactions or sequence holes', () =>
      scoped(async () => {
        const f = await fixture();
        const sessions = jest.spyOn(mongoose, 'startSession');
        const same = await Promise.all(
          Array.from({ length: 5 }, () => f.storage.admit(f.input, 100)),
        );
        expect(new Set(same.map(({ run }) => run.runId)).size).toBe(1);
        expect(same.filter(({ duplicate }) => !duplicate)).toHaveLength(1);
        const distinct = await Promise.all(
          Array.from({ length: 5 }, (_, i) =>
            f.storage.admit(
              {
                ...f.input,
                admission: { ...f.input.admission, eventId: `distinct-${i}` },
              },
              101,
            ),
          ),
        );
        expect(distinct.map(({ run }) => run.sequence).sort((a, b) => a - b)).toEqual([
          2, 3, 4, 5, 6,
        ]);
        const lane = await mongoose.models.ChannelLane.findOne({
          channelId: f.input.channelId,
          kind: 'principal',
        }).lean();
        expect(lane).toMatchObject({ nextSequence: 6, publishedThrough: 6 });
        expect(lane).not.toHaveProperty('publisher');
        expect(sessions).not.toHaveBeenCalled();
        const control = await mongoose.models.ChannelLane.collection.findOne({
          channelId: f.input.channelId,
          kind: 'control',
        });
        expect(JSON.stringify(control)).not.toContain('PRIVATE-');
      }));
    it('repairs publication and cleanup lease acknowledgments without gateway claims', () =>
      scoped(async () => {
        const f = await fixture();
        const collection = mongoose.models.ChannelRun.collection;
        const update = collection.updateOne.bind(collection);
        let lost = false;
        const spy = jest.spyOn(collection, 'updateOne').mockImplementation(async (...args) => {
          const result = await update(...args);
          if (
            !Array.isArray(args[1]) &&
            args[1].$set?.['_managed.phase'] === 'published' &&
            !lost
          ) {
            lost = true;
            throw new Error('synthetic lost publication acknowledgment');
          }
          return result;
        });
        await expect(f.storage.admit(f.input, 100)).rejects.toThrow(
          'synthetic lost publication acknowledgment',
        );
        spy.mockRestore();
        const saved = (await mongoose.models.ChannelRun.findOne({
          channelId: f.input.channelId,
        })
          .select('+_managed')
          .lean<ChannelRunRecord>())!;
        const channels = createAgentChannelMethods(mongoose);
        await channels.updateAgentChannel(f.input.channelId, f.input.principal.userId, {
          status: 'disabled',
        });
        const controls = mongoose.models.ChannelLane.collection;
        const write = controls.updateOne.bind(controls);
        let interrupted = false;
        const acknowledgment = jest
          .spyOn(controls, 'updateOne')
          .mockImplementation(async (...args) => {
            if (
              !Array.isArray(args[1]) &&
              args[1].$set?.assignment?.phase === 'active' &&
              !interrupted
            ) {
              interrupted = true;
              throw new Error('synthetic lost cleanup acknowledgment');
            }
            return write(...args);
          });
        await expect(f.storage.claimAuthorityLost(saved, 'cleanup', 101, 1000)).rejects.toThrow(
          'synthetic lost cleanup acknowledgment',
        );
        acknowledgment.mockRestore();
        const pending = (await f.storage.read(f.input.tenantId, f.input.channelId, saved.runId))!;
        const cleanup = (await f.storage.claimAuthorityLost(pending, 'cleanup', 102, 1000))!;
        expect(cleanup).toMatchObject({
          runId: saved.runId,
          leaseEpoch: pending.leaseEpoch,
          cancellationRequested: true,
          errorCode: 'channel_authority_changed',
        });
        expect(
          await f.storage.finishAuthorityLost(f.input.tenantId, channelRunFence(cleanup), 103),
        ).toBe('stopped');
        const lane = await mongoose.models.ChannelLane.findOne({
          channelId: f.input.channelId,
          kind: 'principal',
        }).lean();
        expect(lane).toMatchObject({ publishedThrough: 1 });
        expect(lane).not.toHaveProperty('publisher');
      }));
    it.each(['stage', 'intent', 'publish'] as const)(
      'recovers an applied %s command whose reply was lost',
      (point) =>
        scoped(async () => {
          const f = await fixture();
          const model =
            point === 'intent' ? mongoose.models.ChannelLane : mongoose.models.ChannelRun;
          const collection = model.collection;
          const write = collection.updateOne.bind(collection);
          let lost = false;
          const spy = jest.spyOn(collection, 'updateOne').mockImplementation(async (...args) => {
            const patch = args[1];
            const match =
              !Array.isArray(patch) &&
              (point === 'intent'
                ? patch.$set?.publisher !== undefined
                : patch.$set?.['_managed.phase'] ===
                  (point === 'stage' ? 'registered' : 'published'));
            const result = await write(...args);
            if (match && !lost) {
              lost = true;
              throw new Error('synthetic lost reply');
            }
            return result;
          });
          await expect(f.storage.admit(f.input, 100)).rejects.toThrow('synthetic lost reply');
          spy.mockRestore();
          expect(lost).toBe(true);
          const saved = await mongoose.models.ChannelRun.collection.findOne({
            channelId: f.input.channelId,
          });
          expect(saved).not.toBeNull();
          if (point !== 'publish')
            expect(
              await f.storage.read(f.input.tenantId, f.input.channelId, saved!.runId),
            ).toBeNull();
          await f.recovery.recoverPending(f.input.tenantId, f.input.channelId, 101, 25);
          const replay = await f.storage.admit(f.input, 102);
          expect(replay).toMatchObject({
            duplicate: true,
            run: { runId: saved!.runId, sequence: 1 },
          });
          expect(
            await mongoose.models.ChannelRun.collection.countDocuments({
              channelId: f.input.channelId,
            }),
          ).toBe(1);
          expect(
            await mongoose.models.ChannelLane.findOne({
              channelId: f.input.channelId,
              kind: 'principal',
            }).lean(),
          ).toMatchObject({ nextSequence: 1, publishedThrough: 1 });
        }),
    );
    it('helps an exact paused publisher before assigning the next event', () =>
      scoped(async () => {
        const f = await fixture();
        const collection = mongoose.models.ChannelRun.collection;
        const write = collection.updateOne.bind(collection);
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
          return write(...args);
        });
        const first = f.storage.admit(f.input, 100);
        const timeout = setTimeout(release, 5000);
        try {
          await started;
          expect(
            await mongoose.models.ChannelLane.findOne({
              channelId: f.input.channelId,
              kind: 'principal',
            }).lean(),
          ).toMatchObject({ nextSequence: 1, publishedThrough: 0, publisher: { sequence: 1 } });
          const next = await f.storage.admit(
            { ...f.input, admission: { ...f.input.admission, eventId: 'next' } },
            101,
          );
          expect(next.run.sequence).toBe(2);
          release();
          expect((await first).run.sequence).toBe(1);
        } finally {
          clearTimeout(timeout);
          release();
          spy.mockRestore();
        }
      }));
    it('advances past a physically absent staging target without recreating it', () =>
      scoped(async () => {
        const f = await fixture();
        const collection = mongoose.models.ChannelLane.collection;
        const write = collection.updateOne.bind(collection);
        let lost = false;
        const spy = jest.spyOn(collection, 'updateOne').mockImplementation(async (...args) => {
          const result = await write(...args);
          if (!Array.isArray(args[1]) && args[1].$set?.publisher && !lost) {
            lost = true;
            throw new Error('synthetic lost intent reply');
          }
          return result;
        });
        await expect(f.storage.admit(f.input, 100)).rejects.toThrow('synthetic lost intent reply');
        spy.mockRestore();
        const saved = await mongoose.models.ChannelRun.collection.findOne({
          channelId: f.input.channelId,
        });
        await mongoose.models.ChannelRun.collection.deleteOne({ _id: saved!._id });
        const next = await f.storage.admit(
          { ...f.input, admission: { ...f.input.admission, eventId: 'next' } },
          101,
        );
        expect(next.run.sequence).toBe(2);
        expect(await mongoose.models.ChannelRun.collection.findOne({ _id: saved!._id })).toBeNull();
        expect(
          await mongoose.models.ChannelLane.findOne({
            channelId: f.input.channelId,
            kind: 'principal',
          }).lean(),
        ).toMatchObject({ publishedThrough: 2 });
      }));
    it('retires expired staging before releasing its sequence slot', () =>
      scoped(async () => {
        const f = await fixture();
        const collection = mongoose.models.ChannelRun.collection;
        const write = collection.updateOne.bind(collection);
        let lost = false;
        const spy = jest.spyOn(collection, 'updateOne').mockImplementation(async (...args) => {
          const result = await write(...args);
          if (
            !Array.isArray(args[1]) &&
            args[1].$set?.['_managed.phase'] === 'registered' &&
            !lost
          ) {
            lost = true;
            throw new Error('synthetic lost stage reply');
          }
          return result;
        });
        await expect(f.storage.admit(f.input, 100)).rejects.toThrow('synthetic lost stage reply');
        spy.mockRestore();
        const saved = await collection.findOne({ channelId: f.input.channelId });
        await collection.updateOne(
          { _id: saved!._id },
          { $set: { '_managed.expiredAt': new Date(0) } },
        );
        await f.recovery.recoverPending(f.input.tenantId, f.input.channelId, 101, 25);
        expect(await collection.findOne({ _id: saved!._id })).toBeNull();
        const next = await f.storage.admit(
          { ...f.input, admission: { ...f.input.admission, eventId: 'next' } },
          102,
        );
        expect(next.run.sequence).toBe(2);
        expect(
          await mongoose.models.ChannelLane.findOne({
            channelId: f.input.channelId,
            kind: 'principal',
          }).lean(),
        ).toMatchObject({ nextSequence: 2, publishedThrough: 2 });
      }));

    it('retires hidden staging after canonical authority changes', () =>
      scoped(async () => {
        const f = await fixture();
        const collection = mongoose.models.ChannelRun.collection;
        const write = collection.updateOne.bind(collection);
        let lost = false;
        const spy = jest.spyOn(collection, 'updateOne').mockImplementation(async (...args) => {
          const result = await write(...args);
          if (
            !Array.isArray(args[1]) &&
            args[1].$set?.['_managed.phase'] === 'registered' &&
            !lost
          ) {
            lost = true;
            throw new Error('synthetic lost stage reply');
          }
          return result;
        });
        await expect(f.storage.admit(f.input, 100)).rejects.toThrow('synthetic lost stage reply');
        spy.mockRestore();
        await createAgentChannelMethods(mongoose).updateAgentChannel(
          f.input.channelId,
          f.input.principal.userId,
          { status: 'disabled' },
        );
        await f.recovery.recoverPending(f.input.tenantId, f.input.channelId, 101, 25);
        expect(
          await mongoose.models.ChannelRun.collection.countDocuments({
            channelId: f.input.channelId,
          }),
        ).toBe(0);
      }));
  });
});
