import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import { MongoMemoryServer, MongoMemoryReplSet } from 'mongodb-memory-server';
import type { PhysicalChannelRun } from './channelRunWrite';
import { registerResponseTarget, settleRetainedChannelOwnerTarget } from './registration';
import { allocateManagedTarget, managedRegistration } from './managed';
import { createResponseOwnerErasureMethods } from './responseErasure';
import { eraseChannelPersistenceForUser } from './channelErasure';
import { createResponseScopeModel } from '~/models/responseScope';
import { createChannelIdentityStorage } from './channelIdentity';
import { createChannelRunControl } from './channelRunControl';
import { createManagedMessageId } from '~/utils/managed';
import { createChannelRunStorage } from './channelRun';
import { tenantStorage } from '~/config/tenantContext';
import { createAgentChannelMethods } from './channel';
import { channelRunFence } from './channelRunWrite';
import { responseScopeKeys } from './responseScope';
import { createResponseStorage } from './response';
import { createModels } from '~/models';

const engines = ['standalone', 'replica', ...(process.env.FERRETDB_URI ? ['FerretDB'] : [])];
const fence = channelRunFence;
describe.each(engines)('actor control handoff on %s', (engine) => {
  let server: MongoMemoryServer | MongoMemoryReplSet | undefined;
  beforeAll(async () => {
    if (engine === 'replica') server = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    else if (engine === 'standalone') server = await MongoMemoryServer.create();
    createModels(mongoose);
    await mongoose.connect(server?.getUri() ?? process.env.FERRETDB_URI!, {
      dbName: `run_control_${randomUUID().replace(/-/g, '')}`,
    });
  }, 60000);
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    await mongoose.disconnect();
    await server?.stop();
  });
  describe.each([undefined, 'control-tenant'])('tenant %s', (tenantId) => {
    const scoped = (work: () => Promise<void>) => tenantStorage.run({ tenantId }, work);
    async function fixture(admit = true, mode: 'shared' | 'per_user' = 'shared') {
      const owner = String(new mongoose.Types.ObjectId());
      const channelId = randomUUID();
      const linkId = randomUUID();
      await createAgentChannelMethods(mongoose).createAgentChannel({
        channelId,
        createdBy: mode === 'shared' ? owner : String(new mongoose.Types.ObjectId()),
        agentId: 'agent',
        type: 'slack',
        status: 'active',
        credentialMode: mode,
        revision: 'one',
        slack: { teamId: 'T1', appId: 'A1', botUserId: 'B1' },
      });
      const input = {
        tenantId: tenantId || '_',
        channelId,
        agentId: 'agent',
        principal: {
          userId: owner,
          channelRevision: 'one',
          ...(mode === 'per_user' && { linkId, linkRevision: 'one' }),
        },
        admission: {
          eventId: 'first',
          externalChannelId: 'C1',
          externalThreadKey: 'PRIVATE-THREAD',
          externalMessageKey: 'C1:first',
          actor: { teamId: 'T1', appId: 'A1', externalUserId: 'PRIVATE-ACTOR' },
          input: 'PRIVATE-PROMPT',
        },
      };
      if (mode === 'per_user')
        await createChannelIdentityStorage(mongoose).saveChannelIdentity(
          {
            tenantId: input.tenantId,
            linkId,
            revision: 'one',
            state: 'active',
            userId: owner,
            ticketHash: randomUUID(),
            ticketExpiresAtMs: Date.now() + 60000,
            expiresAtMs: Date.now() + 600000,
            identity: {
              tenantId: input.tenantId,
              channelId,
              channelRevision: 'one',
              agentId: 'agent',
              teamId: 'T1',
              externalUserId: input.admission.actor.externalUserId,
            },
          },
          null,
        );
      const storage = createChannelRunStorage(mongoose);
      if (admit) await storage.admit(input, 100);
      return { input, storage, owner };
    }
    async function eraseOwner(userId: string) {
      const owner = { userId, ...(tenantId && { tenantId }) };
      await createResponseOwnerErasureMethods(mongoose).prepareUserResponseErasure(owner);
      await eraseChannelPersistenceForUser(mongoose, owner);
    }
    it('releases only the closed creator tickets while the actual account retains its Run and cursor', () =>
      scoped(async () => {
        const f = await fixture(true, 'per_user');
        const channel = await mongoose.models.AgentChannel.collection.findOne({
          channelId: f.input.channelId,
        });
        const creator = { userId: String(channel!.createdBy), ...(tenantId && { tenantId }) };
        const records = await mongoose.models.ChannelRun.findOne({ channelId: f.input.channelId })
          .select('+_managed')
          .lean<PhysicalChannelRun | null>();
        if (!records) throw new Error('Fixture Run missing');
        const run = managedRegistration(records.publication!.lane);
        const runEntry = managedRegistration({
          kind: 'channelRun',
          id: String(records._id),
          incarnation: records._managed.incarnation,
          ...(tenantId && { tenantId }),
        });
        for (const entry of [run, runEntry]) {
          expect(await registerResponseTarget(mongoose, creator, undefined, entry)).toMatchObject({
            status: 'registered',
          });
          expect(
            await registerResponseTarget(
              mongoose,
              { userId: f.owner, ...(tenantId && { tenantId }) },
              undefined,
              entry,
            ),
          ).toMatchObject({ status: 'registered' });
          expect(await settleRetainedChannelOwnerTarget(mongoose, creator, entry)).toBe(false);
        }
        await eraseOwner(creator.userId);
        const creatorScope = await createResponseScopeModel(mongoose)
          .findById(responseScopeKeys(creator, '')[0])
          .lean();
        expect(creatorScope!.pending).toEqual([]);
        const ownerScope = await createResponseScopeModel(mongoose)
          .findById(responseScopeKeys({ userId: f.owner, ...(tenantId && { tenantId }) }, '')[0])
          .lean();
        expect(
          (ownerScope!.pending ?? []).map((entry: { key: string }) => entry.key).sort(),
        ).toEqual([run.key, runEntry.key].sort());
        expect(
          await mongoose.models.ChannelRun.collection.findOne({ _id: records._id }),
        ).toMatchObject({ principal: { userId: f.owner } });
        await eraseOwner(f.owner);
        expect(
          await mongoose.models.ChannelRun.collection.findOne({ _id: records._id }),
        ).toBeNull();
        await createResponseOwnerErasureMethods(mongoose).assertUserStorageErased({
          userId: f.owner,
          ...(tenantId && { tenantId }),
        });
      }));
    it.each(['missing-owner', 'retired', 'control', 'self', 'wrong-parent'] as const)(
      'rejects a %s retained-owner cleanup proof',
      (failure) =>
        scoped(async () => {
          const f = await fixture(true, 'per_user');
          const channel = await mongoose.models.AgentChannel.collection.findOne({
            channelId: f.input.channelId,
          });
          const creator = {
            userId: failure === 'self' ? f.owner : String(channel!.createdBy),
            ...(tenantId && { tenantId }),
          };
          const run = await mongoose.models.ChannelRun.findOne({ channelId: f.input.channelId })
            .select('+_managed')
            .lean<PhysicalChannelRun | null>();
          if (!run) throw new Error('Fixture Run missing');
          const target =
            failure === 'control'
              ? run.publication!.control
              : {
                  kind: 'channelRun' as const,
                  id: String(run._id),
                  incarnation: run._managed.incarnation,
                  ...(tenantId && { tenantId }),
                };
          const entry = managedRegistration(target);
          await registerResponseTarget(mongoose, creator, undefined, entry);
          await createResponseOwnerErasureMethods(mongoose).prepareUserResponseErasure(creator);
          if (failure === 'missing-owner')
            await mongoose.models.ChannelRun.collection.updateOne(
              { _id: run._id },
              {
                $set: {
                  '_managed.scopeKeys': run._managed.scopeKeys?.filter(
                    (key) =>
                      key !==
                      responseScopeKeys({ userId: f.owner, ...(tenantId && { tenantId }) }, '')[0],
                  ),
                },
              },
            );
          if (failure === 'wrong-parent')
            await mongoose.models.ChannelRun.collection.updateOne(
              { _id: run._id },
              { $set: { '_managed.parentId': String(new mongoose.Types.ObjectId()) } },
            );
          if (failure === 'retired')
            await mongoose.models.ChannelRun.collection.updateOne(
              { _id: run._id },
              { $set: { '_managed.phase': 'retired' } },
            );
          expect(await settleRetainedChannelOwnerTarget(mongoose, creator, entry)).toBe(false);
          const anchor = await createResponseScopeModel(mongoose)
            .findById(responseScopeKeys(creator, '')[0])
            .lean();
          expect((anchor!.pending ?? []).map((value: { key: string }) => value.key)).toContain(
            entry.key,
          );
        }),
    );
    it('erases an owner only after fencing its control and preserves the selected Stop receipt', () =>
      scoped(async () => {
        const f = await fixture(true, 'per_user');
        const claimed = (await f.storage.claim(
          f.input.tenantId,
          f.input.channelId,
          'worker',
          101,
          1000,
        ))!;
        await f.storage.observeThreadStop(f.input, 102, 103);
        const lanes = mongoose.models.ChannelLane.collection;
        const before = await lanes.findOne({ channelId: f.input.channelId, kind: 'control' });
        await eraseOwner(f.owner);
        const after = await lanes.findOne({ _id: before!._id });
        expect(after!.assignment).toBeUndefined();
        expect(after!.stop).toEqual(before!.stop);
        expect(after!.revision).toBeGreaterThan(before!.revision);
        expect(
          await mongoose.models.ChannelRun.collection.findOne({ runId: claimed.runId }),
        ).toBeNull();
        expect(
          await lanes.findOne({ channelId: f.input.channelId, kind: 'principal', userId: f.owner }),
        ).toBeNull();
        expect(await f.storage.renew(f.input.tenantId, fence(claimed), 104, 1000)).toBe(false);
        await createResponseOwnerErasureMethods(mongoose).assertUserStorageErased({
          userId: f.owner,
          ...(tenantId && { tenantId }),
        });
      }));
    it.each(['selection', 'lease'] as const)(
      'fences a paused %s grant before completing owner erasure',
      (point) =>
        scoped(async () => {
          const f = await fixture(true, 'per_user');
          let entered!: () => void;
          let release!: () => void;
          const started = new Promise<void>((resolve) => {
            entered = resolve;
          });
          const gate = new Promise<void>((resolve) => {
            release = resolve;
          });
          let paused = false;
          const lanes = mongoose.models.ChannelLane.collection;
          const runs = mongoose.models.ChannelRun.collection;
          const update = lanes.updateOne.bind(lanes);
          const lease = runs.findOneAndUpdate.bind(runs);
          const controlSpy = jest.spyOn(lanes, 'updateOne').mockImplementation(async (...args) => {
            if (
              point === 'selection' &&
              !Array.isArray(args[1]) &&
              args[1].$set?.assignment &&
              !paused
            ) {
              paused = true;
              entered();
              await gate;
            }
            return update(...args);
          });
          const leaseSpy = jest
            .spyOn(runs, 'findOneAndUpdate')
            .mockImplementation(async (...args) => {
              if (
                point === 'lease' &&
                !Array.isArray(args[1]) &&
                args[1].$set?.leaseGrantId &&
                !paused
              ) {
                paused = true;
                entered();
                await gate;
              }
              return lease(...args);
            });
          const claiming = f.storage.claim(
            f.input.tenantId,
            f.input.channelId,
            'paused',
            101,
            1000,
          );
          const timeout = setTimeout(release, 10000);
          try {
            await started;
            await eraseOwner(f.owner);
            release();
            expect(await claiming).toBeNull();
            const control = await lanes.findOne({ channelId: f.input.channelId, kind: 'control' });
            expect(control!.assignment).toBeUndefined();
            expect(await runs.findOne({ channelId: f.input.channelId })).toBeNull();
          } finally {
            clearTimeout(timeout);
            release();
            controlSpy.mockRestore();
            leaseSpy.mockRestore();
          }
        }),
    );
    it.each(['shared', 'per_user'] as const)(
      'recovers a lost control-fence reply during %s owner erasure',
      (mode) =>
        scoped(async () => {
          const f = await fixture(true, mode);
          await mongoose.models.AgentChannel.collection.updateOne(
            { channelId: f.input.channelId },
            {
              $set: {
                encryptedBotToken: 'SYNTHETIC-BOT-SECRET',
                encryptedSigningSecret: 'SYNTHETIC-SIGNING-SECRET',
              },
            },
          );
          const claimed = (await f.storage.claim(
            f.input.tenantId,
            f.input.channelId,
            'worker',
            101,
            1000,
          ))!;
          const collection = mongoose.models.ChannelLane.collection;
          const update = collection.updateOne.bind(collection);
          let failed = false;
          const spy = jest.spyOn(collection, 'updateOne').mockImplementation(async (...args) => {
            const result = await update(...args);
            if (!Array.isArray(args[1]) && args[1].$unset?.assignment && !failed) {
              failed = true;
              throw new Error('synthetic lost control acknowledgment');
            }
            return result;
          });
          await expect(eraseOwner(f.owner)).rejects.toThrow(
            'synthetic lost control acknowledgment',
          );
          expect(
            await mongoose.models.ChannelRun.collection.findOne({ runId: claimed.runId }),
          ).toMatchObject({ _managed: { phase: 'retired' } });
          if (mode === 'shared') {
            const parent = await mongoose.models.AgentChannel.collection.findOne({
              channelId: f.input.channelId,
            });
            expect(parent).toMatchObject({ status: 'deleting' });
            expect(parent).not.toHaveProperty('encryptedBotToken');
            expect(parent).not.toHaveProperty('encryptedSigningSecret');
          }
          spy.mockRestore();
          await eraseOwner(f.owner);
          expect(
            await mongoose.models.ChannelRun.collection.findOne({ runId: claimed.runId }),
          ).toBeNull();
          const control = await collection.findOne({
            channelId: f.input.channelId,
            kind: 'control',
          });
          if (mode === 'shared') expect(control).toBeNull();
          else {
            expect(control).not.toBeNull();
            expect(control).not.toHaveProperty('assignment');
          }
        }),
    );
    it('fences private staging while its final publication command is paused', () =>
      scoped(async () => {
        const f = await fixture(false, 'per_user');
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
        const admitting = f.storage.admit(f.input, 100).then(
          () => 'published',
          () => 'rejected',
        );
        const timeout = setTimeout(release, 10000);
        try {
          await started;
          await eraseOwner(f.owner);
          release();
          expect(await admitting).toBe('rejected');
          expect(await collection.findOne({ channelId: f.input.channelId })).toBeNull();
          expect(
            await mongoose.models.ChannelLane.collection.findOne({
              channelId: f.input.channelId,
              kind: 'principal',
            }),
          ).toBeNull();
        } finally {
          clearTimeout(timeout);
          release();
          spy.mockRestore();
        }
      }));
    it('keeps the Run and control while canonical provider drain is still pending', () =>
      scoped(async () => {
        const f = await fixture(true, 'per_user');
        const claimed = (await f.storage.claim(
          f.input.tenantId,
          f.input.channelId,
          'worker',
          101,
          1000,
        ))!;
        const capability = fence(claimed);
        await f.storage.prepareExecution(f.input.tenantId, capability, 102);
        const run = await f.storage.attachResponseCredential(
          f.input.tenantId,
          capability,
          { apiKeyId: 'key', encryptedApiKey: 'synthetic' },
          103,
        );
        const responses = createResponseStorage(mongoose);
        const reserved = await responses.reserve({
          ...(tenantId && { tenantId }),
          userId: f.owner,
          agentId: 'agent',
          sourceKeyId: 'key',
          responseId: createManagedMessageId(),
          requestKey: `channel:${run.runId}`,
          fingerprint: 'accepted',
          conversationId: run.execution!.conversationId,
          parentMessageId: run.execution!.parentMessageId,
          requestJSON: JSON.stringify({
            model: 'agent',
            input: f.input.admission.input,
            background: true,
            store: true,
          }),
        });
        if (!reserved.ok) throw new Error('Reservation failed');
        await f.storage.bindResponse(f.input.tenantId, capability, reserved.record.responseId, 104);
        const binding = { generationCreatedAt: Date.now(), providerExecutionId: randomUUID() };
        const enrolled = await responses.enrollExecution(reserved.record, binding, '{}');
        if (!enrolled.ok || !(await responses.bindExecution(enrolled.record, binding)))
          throw new Error('Enrollment failed');
        await expect(eraseOwner(f.owner)).rejects.toMatchObject({
          code: 'response_erasure_pending',
        });
        expect(
          await mongoose.models.ChannelRun.collection.findOne({ runId: run.runId }),
        ).toMatchObject({ _managed: { phase: 'published' } });
        expect(
          await mongoose.models.ChannelLane.collection.findOne({
            channelId: f.input.channelId,
            kind: 'control',
          }),
        ).toMatchObject({ assignment: { run: { runId: run.runId } } });
      }));
    it('erases a queued former principal without clearing the new linked owner active assignment', () =>
      scoped(async () => {
        const f = await fixture(true, 'per_user');
        const owner = String(new mongoose.Types.ObjectId());
        const linkId = randomUUID();
        const identities = createChannelIdentityStorage(mongoose);
        const previous = await identities.readChannelIdentity({
          ...f.input.principal,
          tenantId: f.input.tenantId,
          channelId: f.input.channelId,
          agentId: 'agent',
          teamId: 'T1',
          externalUserId: f.input.admission.actor.externalUserId,
        });
        if (!previous) throw new Error('Fixture identity missing');
        expect(
          await identities.saveChannelIdentity(
            { ...previous, userId: owner, linkId, revision: 'two', ticketHash: randomUUID() },
            'one',
          ),
        ).toBe(true);
        const nextInput = {
          ...nextEvent(f),
          principal: { userId: owner, channelRevision: 'one', linkId, linkRevision: 'two' },
        };
        const admitted = await f.storage.admit(nextInput, 105);
        const exact = await mongoose.models.ChannelRun.findOne({ runId: admitted.run.runId })
          .select('+_managed')
          .lean<PhysicalChannelRun | null>();
        if (!exact) throw new Error('Fixture Run missing');
        const claimed = await createChannelRunControl(mongoose, async () => ({})).claim(
          exact,
          'new-worker',
          106,
          1000,
        );
        expect(claimed?.runId).toBe(admitted.run.runId);
        await f.storage.observeThreadStop(nextInput, 107, 107);
        const before = await mongoose.models.ChannelLane.collection.findOne({
          channelId: f.input.channelId,
          kind: 'control',
        });
        await eraseOwner(f.owner);
        const after = await mongoose.models.ChannelLane.collection.findOne({ _id: before!._id });
        expect(after!.assignment).toEqual(before!.assignment);
        expect(after!.stop).toEqual(before!.stop);
        expect(after!.revision).toBeGreaterThan(before!.revision);
        expect(
          await mongoose.models.ChannelRun.collection.findOne({
            channelId: f.input.channelId,
            'principal.userId': f.owner,
          }),
        ).toBeNull();
        expect(
          await mongoose.models.ChannelRun.collection.findOne({ runId: admitted.run.runId }),
        ).toMatchObject({ _managed: { phase: 'published' } });
        expect(
          await mongoose.models.ChannelLane.collection.findOne({
            channelId: f.input.channelId,
            kind: 'principal',
            userId: owner,
          }),
        ).not.toBeNull();
      }));
    it('retains another account execution and control assignment when its channel creator is erased', () =>
      scoped(async () => {
        const f = await fixture(true, 'per_user');
        const claimed = (await f.storage.claim(
          f.input.tenantId,
          f.input.channelId,
          'worker',
          101,
          1000,
        ))!;
        const channel = await mongoose.models.AgentChannel.collection.findOne({
          channelId: f.input.channelId,
        });
        const before = await mongoose.models.ChannelLane.collection.findOne({
          channelId: f.input.channelId,
          kind: 'control',
        });
        await eraseOwner(channel!.createdBy);
        expect(
          await mongoose.models.ChannelRun.collection.findOne({ runId: claimed.runId }),
        ).toMatchObject({ _managed: { phase: 'published' }, principal: { userId: f.owner } });
        expect(
          await mongoose.models.ChannelLane.collection.findOne({ _id: before!._id }),
        ).toMatchObject({ assignment: before!.assignment });
        expect(
          await mongoose.models.ChannelLane.collection.findOne({
            channelId: f.input.channelId,
            kind: 'principal',
            userId: f.owner,
          }),
        ).not.toBeNull();
      }));
    const nextEvent = (f: Awaited<ReturnType<typeof fixture>>) => ({
      ...f.input,
      admission: { ...f.input.admission, eventId: 'next' },
    });
    it('grants one exact epoch, fences takeover, and serializes one actor while allowing other actors', () =>
      scoped(async () => {
        const f = await fixture();
        const sessions = jest.spyOn(mongoose, 'startSession');
        const first = (await f.storage.claim(f.input.tenantId, f.input.channelId, 'one', 101, 10))!;
        expect(first).toMatchObject({ leaseEpoch: 1, leaseOwner: 'one' });
        await f.storage.admit(nextEvent(f), 102);
        const other = {
          ...nextEvent(f),
          admission: {
            ...nextEvent(f).admission,
            eventId: 'other',
            actor: { ...f.input.admission.actor, externalUserId: 'OTHER-ACTOR' },
          },
        };
        const admitted = await f.storage.admit(other, 102);
        expect(
          (await f.storage.claim(f.input.tenantId, f.input.channelId, 'other', 103, 1000))!.runId,
        ).toBe(admitted.run.runId);
        expect(
          await f.storage.claim(f.input.tenantId, f.input.channelId, 'blocked', 104, 1000),
        ).toBeNull();
        const taken = (await f.storage.claim(
          f.input.tenantId,
          f.input.channelId,
          'two',
          112,
          1000,
        ))!;
        expect(taken).toMatchObject({ runId: first.runId, leaseEpoch: 2 });
        await expect(
          f.storage.prepareExecution(f.input.tenantId, fence(first), 105),
        ).rejects.toMatchObject({ code: 'stale_fence' });
        expect(sessions).not.toHaveBeenCalled();
      }));
    it('rejects the old capability after physical replacement even with the same public ID owner and epoch', () =>
      scoped(async () => {
        const f = await fixture();
        const first = (await f.storage.claim(
          f.input.tenantId,
          f.input.channelId,
          'worker',
          101,
          1000,
        ))!;
        const prior = fence(first);
        const collection = mongoose.models.ChannelRun.collection;
        const old = await collection.findOne({ runId: first.runId });
        const id = new mongoose.Types.ObjectId();
        await collection.deleteOne({ _id: old!._id });
        await collection.insertOne({
          ...old!,
          _id: id,
          _managed: { ...old!._managed, parentId: String(id), incarnation: randomUUID() },
        });
        expect(await f.storage.renew(f.input.tenantId, prior, 102, 1000)).toBe(false);
        await expect(
          f.storage.prepareExecution(f.input.tenantId, prior, 102),
        ).rejects.toMatchObject({ code: 'stale_fence' });
        await expect(f.storage.commitDelivery(f.input.tenantId, prior, 102)).rejects.toMatchObject({
          code: 'stale_fence',
        });
        expect(await f.storage.claimAuthorityLost(first, 'cleanup', 102, 1000)).toBeNull();
        expect((await collection.findOne({ _id: id }))!.execution).toBeUndefined();
      }));

    it('bounds scheduling pages to metadata and loads private payload only after selecting a grant', () =>
      scoped(async () => {
        const f = await fixture();
        const collection = mongoose.models.ChannelRun.collection;
        const find = collection.find.bind(collection);
        const findOne = collection.findOne.bind(collection);
        const controls = mongoose.models.ChannelLane.collection;
        const update = controls.updateOne.bind(controls);
        let granted = false;
        let earlyPayloads = 0;
        const pages: Array<{ projection?: Record<string, number>; limit?: number }> = [];
        jest.spyOn(collection, 'find').mockImplementation((...args) => {
          pages.push({ projection: args[1]?.projection, limit: args[1]?.limit });
          return find(...args);
        });
        jest.spyOn(collection, 'findOne').mockImplementation(async (...args) => {
          if (!granted && args[1]?.projection?.runId !== 1) earlyPayloads++;
          return findOne(...args);
        });
        jest.spyOn(controls, 'updateOne').mockImplementation(async (...args) => {
          const result = await update(...args);
          if (
            !Array.isArray(args[1]) &&
            args[1].$set?.assignment?.phase === 'granting' &&
            result.matchedCount
          )
            granted = true;
          return result;
        });
        const constrained = createChannelRunStorage(mongoose, { claimBatchSize: 1 });
        expect(
          await constrained.claim(f.input.tenantId, f.input.channelId, 'worker', 101, 1000),
        ).not.toBeNull();
        expect(earlyPayloads).toBe(0);
        expect(pages.length).toBeGreaterThanOrEqual(2);
        for (const page of pages) {
          expect(page.limit).toBe(1);
          expect(page.projection?.runId).toBe(1);
          for (const field of [
            'admission',
            'admission.input',
            'snapshot',
            'plan',
            'receipts',
            'execution',
          ])
            expect(page.projection?.[field]).not.toBe(1);
        }
      }));

    it('persists an empty Stop only in a metadata control and never retargets its retry', () =>
      scoped(async () => {
        const f = await fixture(false);
        expect(await f.storage.observeThreadStop(f.input, 120, 100)).toBeNull();
        const controls = await mongoose.models.ChannelLane.collection
          .find({ channelId: f.input.channelId })
          .toArray();
        expect(controls).toHaveLength(1);
        expect(controls[0]).toMatchObject({
          kind: 'control',
          stop: { phase: 'selected', selection: { result: 'none' }, before: 100 },
        });
        expect(JSON.stringify(controls[0])).not.toContain('PRIVATE-');
        expect(controls[0]).not.toHaveProperty('userId');
        await f.storage.admit(f.input, 101);
        await f.storage.claim(f.input.tenantId, f.input.channelId, 'worker', 102, 1000);
        expect(await f.storage.observeThreadStop(f.input, 120, 110)).toBeNull();
        expect(await f.storage.observeThreadStop(f.input, 121, 111)).toMatchObject({
          run: { leaseEpoch: 1 },
          before: 111,
        });
      }));
    it('recovers an applied control grant whose reply was lost before resolving Stop', () =>
      scoped(async () => {
        const f = await fixture();
        const collection = mongoose.models.ChannelLane.collection;
        const update = collection.updateOne.bind(collection);
        let lost = false;
        const spy = jest.spyOn(collection, 'updateOne').mockImplementation(async (...args) => {
          const result = await update(...args);
          if (!Array.isArray(args[1]) && args[1].$set?.assignment?.phase === 'granting' && !lost) {
            lost = true;
            throw new Error('synthetic lost grant reply');
          }
          return result;
        });
        await expect(
          f.storage.claim(f.input.tenantId, f.input.channelId, 'worker', 101, 1000),
        ).rejects.toThrow('synthetic lost grant reply');
        spy.mockRestore();
        const observed = await f.storage.observeThreadStop(f.input, 105, 106);
        expect(observed).toMatchObject({
          run: { leaseEpoch: 1, leaseOwner: 'worker' },
          before: 105,
        });
        expect(
          await f.storage.requestCancel(f.input, observed!.run.runId, {
            epoch: 1,
            before: observed!.before,
          }),
        ).toBe(true);
        expect(
          (await f.storage.read(f.input.tenantId, f.input.channelId, observed!.run.runId))!
            .cancellationRequested,
        ).toBe(true);
      }));
    it.each(['initial', 'takeover'] as const)(
      'recovers a paused %s Run grant before selecting a Stop epoch',
      (kind) =>
        scoped(async () => {
          const f = await fixture();
          if (kind === 'takeover')
            await f.storage.claim(f.input.tenantId, f.input.channelId, 'old', 101, 10);
          const collection = mongoose.models.ChannelRun.collection;
          const update = collection.findOneAndUpdate.bind(collection);
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
              if (!Array.isArray(args[1]) && args[1].$set?.leaseGrantId && !paused) {
                paused = true;
                entered();
                await gate;
              }
              return update(...args);
            });
          const claiming = f.storage.claim(
            f.input.tenantId,
            f.input.channelId,
            'new',
            kind === 'initial' ? 101 : 112,
            1000,
          );
          const timeout = setTimeout(release, 5000);
          try {
            await started;
            const eventAt = kind === 'initial' ? 105 : 110;
            const observed = await f.storage.observeThreadStop(f.input, eventAt, 113);
            if (kind === 'initial') expect(observed).toMatchObject({ run: { leaseEpoch: 1 } });
            else expect(observed).toBeNull();
            release();
            const claimed = (await claiming)!;
            expect(claimed.leaseEpoch).toBe(kind === 'initial' ? 1 : 2);
            const raw = await mongoose.models.ChannelLane.collection.findOne({
              channelId: f.input.channelId,
              kind: 'control',
            });
            expect(raw!.stop.selection).toMatchObject(
              kind === 'initial' ? { result: 'run', epoch: 1 } : { result: 'none' },
            );
            if (kind === 'takeover')
              expect(await f.storage.observeThreadStop(f.input, eventAt, 114)).toBeNull();
          } finally {
            clearTimeout(timeout);
            release();
            spy.mockRestore();
          }
        }),
    );
    it('recovers a paused Stop selector before takeover without changing the old receipt', () =>
      scoped(async () => {
        const f = await fixture();
        await f.storage.claim(f.input.tenantId, f.input.channelId, 'old', 101, 10);
        const collection = mongoose.models.ChannelLane.collection;
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
          if (!Array.isArray(args[1]) && args[1].$set?.stop?.phase === 'selected' && !paused) {
            paused = true;
            entered();
            await gate;
          }
          return update(...args);
        });
        const observing = f.storage.observeThreadStop(f.input, 110, 105);
        const timeout = setTimeout(release, 5000);
        try {
          await started;
          const taken = (await f.storage.claim(
            f.input.tenantId,
            f.input.channelId,
            'new',
            112,
            1000,
          ))!;
          expect(taken.leaseEpoch).toBe(2);
          release();
          expect(await observing).toBeNull();
          const control = await collection.findOne({
            channelId: f.input.channelId,
            kind: 'control',
          });
          expect(control!.stop.selection).toMatchObject({ result: 'run', epoch: 1 });
          expect(await f.storage.observeThreadStop(f.input, 110, 114)).toBeNull();
        } finally {
          clearTimeout(timeout);
          release();
          spy.mockRestore();
        }
      }));
    it('keeps unknown ownership blocked when the granted physical Run disappears', () =>
      scoped(async () => {
        const f = await fixture();
        const first = (await f.storage.claim(
          f.input.tenantId,
          f.input.channelId,
          'worker',
          101,
          1000,
        ))!;
        await mongoose.models.ChannelRun.deleteOne({ runId: first.runId });
        await f.storage.admit(nextEvent(f), 102);
        expect(
          await f.storage.claim(f.input.tenantId, f.input.channelId, 'another', 103, 1000),
        ).toBeNull();
        expect(await f.storage.observeThreadStop(f.input, 104, 105)).toBeNull();
        const control = await mongoose.models.ChannelLane.collection.findOne({
          channelId: f.input.channelId,
          kind: 'control',
        });
        expect(control!.assignment.run.runId).toBe(first.runId);
      }));
    it('keeps relinked work behind the old actor assignment and does not retarget its Stop', () =>
      scoped(async () => {
        const f = await fixture(true, 'per_user');
        const first = (await f.storage.claim(
          f.input.tenantId,
          f.input.channelId,
          'old-worker',
          101,
          1000,
        ))!;
        expect(await f.storage.observeThreadStop(f.input, 104, 104)).toMatchObject({
          run: { runId: first.runId },
        });
        const owner = String(new mongoose.Types.ObjectId());
        const identities = createChannelIdentityStorage(mongoose);
        const previous = await identities.readChannelIdentity({
          ...f.input.principal,
          tenantId: f.input.tenantId,
          channelId: f.input.channelId,
          agentId: 'agent',
          teamId: 'T1',
          externalUserId: f.input.admission.actor.externalUserId,
        });
        if (!previous) throw new Error('Fixture identity missing');
        expect(
          await identities.saveChannelIdentity(
            {
              ...previous,
              userId: owner,
              linkId: 'link-two',
              revision: 'two',
              ticketHash: randomUUID(),
            },
            'one',
          ),
        ).toBe(true);
        const nextInput = {
          ...nextEvent(f),
          principal: {
            userId: owner,
            channelRevision: 'one',
            linkId: 'link-two',
            linkRevision: 'two',
          },
        };
        const admitted = await f.storage.admit(nextInput, 105);
        expect(
          await f.storage.claim(f.input.tenantId, f.input.channelId, 'new-worker', 106, 1000),
        ).toBeNull();
        const cleanup = (await f.storage.claimAuthorityLost(first, 'cleanup', 107, 1000))!;
        expect(cleanup).toMatchObject({
          errorCode: 'channel_authority_changed',
          cancellationRequested: true,
        });
        await f.storage.finishAuthorityLost(f.input.tenantId, fence(cleanup), 108);
        const next = (await f.storage.claim(
          f.input.tenantId,
          f.input.channelId,
          'new-worker',
          109,
          1000,
        ))!;
        expect(next.runId).toBe(admitted.run.runId);
        expect(await f.storage.observeThreadStop(nextInput, 104, 110)).toBeNull();
        expect(await f.storage.observeThreadStop(nextInput, 111, 111)).toMatchObject({
          run: { runId: next.runId },
        });
        const raw = await mongoose.models.ChannelLane.collection.findOne({
          channelId: f.input.channelId,
          kind: 'control',
        });
        expect(JSON.stringify(raw)).not.toContain(f.owner);
        expect(JSON.stringify(raw)).not.toContain(owner);
      }));
    it('resolves an existing control Stop without another admission slot', () =>
      scoped(async () => {
        const f = await fixture();
        const first = (await f.storage.claim(
          f.input.tenantId,
          f.input.channelId,
          'worker',
          101,
          1000,
        ))!;
        const target = await allocateManagedTarget(mongoose, 'channelRun', tenantId);
        expect(
          await registerResponseTarget(
            mongoose,
            { userId: f.owner, ...(tenantId && { tenantId }) },
            undefined,
            managedRegistration(target),
            { maxPendingTargetsPerScope: 1 },
          ),
        ).toMatchObject({ status: 'registered' });
        const constrained = createChannelRunStorage(mongoose, {}, async () => ({
          maxPendingTargetsPerScope: 1,
        }));
        expect(await constrained.observeThreadStop(f.input, 105, 105)).toMatchObject({
          run: { runId: first.runId },
        });
      }));

    it('commits terminal evidence before cursor repair and never clears the next assignment', () =>
      scoped(async () => {
        const f = await fixture();
        const first = (await f.storage.claim(
          f.input.tenantId,
          f.input.channelId,
          'worker',
          101,
          1000,
        ))!;
        const prepared = await f.storage.prepareExecution(f.input.tenantId, fence(first), 102);
        const responseId = createManagedMessageId();
        const reserved = await createResponseStorage(mongoose).reserve({
          tenantId,
          userId: f.owner,
          responseId,
          requestKey: `channel:${first.runId}`,
          fingerprint: 'request',
          agentId: 'agent',
          requestJSON: JSON.stringify({
            model: 'agent',
            input: f.input.admission.input,
            background: true,
            store: true,
          }),
          conversationId: prepared.execution!.conversationId,
          parentMessageId: prepared.execution!.parentMessageId,
        });
        expect(reserved.ok).toBe(true);
        await f.storage.bindResponse(f.input.tenantId, fence(first), responseId, 103);
        await f.storage.saveSnapshot(
          f.input.tenantId,
          fence(first),
          { status: 'completed', responseId, text: 'answer', elapsedMs: 1 },
          104,
        );
        await f.storage.savePlan(
          f.input.tenantId,
          fence(first),
          {
            revision: 'plan',
            rendererVersion: 'test',
            parts: [{ operationId: 'message', kind: 'message', required: true, text: 'answer' }],
          },
          105,
        );
        await f.storage.beginDelivery(f.input.tenantId, fence(first), 'message', 106);
        await f.storage.settleDelivery(
          f.input.tenantId,
          fence(first),
          {
            operationId: 'message',
            outcome: 'confirmed',
            attempts: 1,
            externalMessageKey: 'C1:answer',
          },
          107,
        );
        await f.storage.admit(nextEvent(f), 108);
        const collection = mongoose.models.ChannelLane.collection;
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
          if (!Array.isArray(args[1]) && args[1].$set?.handoff && !paused) {
            paused = true;
            entered();
            await gate;
          }
          return update(...args);
        });
        const committing = f.storage.commitDelivery(f.input.tenantId, fence(first), 109);
        const timeout = setTimeout(release, 5000);
        try {
          await started;
          expect(
            await f.storage.read(f.input.tenantId, f.input.channelId, first.runId),
          ).toMatchObject({ state: 'delivered', cursorState: 'pending' });
          const next = (await f.storage.claim(
            f.input.tenantId,
            f.input.channelId,
            'next',
            110,
            1000,
          ))!;
          const continuation = await f.storage.prepareExecution(f.input.tenantId, fence(next), 111);
          expect(continuation.execution).toMatchObject({
            conversationId: prepared.execution!.conversationId,
            parentMessageId: responseId,
          });
          release();
          expect(await committing).toMatchObject({ state: 'delivered', cursorState: 'complete' });
          const control = await collection.findOne({
            channelId: f.input.channelId,
            kind: 'control',
          });
          expect(control!.assignment.run.runId).toBe(next.runId);
          const lane = await collection.findOne({
            channelId: f.input.channelId,
            kind: 'principal',
          });
          const key = responseScopeKeys(
            { userId: f.owner, ...(tenantId && { tenantId }) },
            prepared.execution!.conversationId,
          )[1];
          expect(lane!._managed.scopeKeys).toContain(key);
          expect(lane!.handoff.run.runId).toBe(first.runId);
        } finally {
          clearTimeout(timeout);
          release();
          spy.mockRestore();
        }
      }));
  });
});
