import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import { MongoMemoryServer, MongoMemoryReplSet } from 'mongodb-memory-server';
import type { ChannelRunRecord } from '~/models/channelRun';
import { allocateManagedTarget, managedRegistration } from './managed';
import { createChannelIdentityStorage } from './channelIdentity';
import { createManagedMessageId } from '~/utils/managed';
import { registerResponseTarget } from './registration';
import { createChannelRunStorage } from './channelRun';
import { tenantStorage } from '~/config/tenantContext';
import { createAgentChannelMethods } from './channel';
import { responseScopeKeys } from './responseScope';
import { createResponseStorage } from './response';
import { createModels } from '~/models';

const engines = ['standalone', 'replica', ...(process.env.FERRETDB_URI ? ['FerretDB'] : [])];
const fence = (run: ChannelRunRecord) => ({
  runId: run.runId,
  owner: run.leaseOwner!,
  epoch: run.leaseEpoch,
});
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
          ...(mode === 'per_user' && { linkId: 'link-one', linkRevision: 'one' }),
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
            linkId: 'link-one',
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
