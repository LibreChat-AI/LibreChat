import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import { MongoMemoryServer, MongoMemoryReplSet } from 'mongodb-memory-server';
import type { AgentApiKeyCreateResult } from '~/types';
import { createManagedMessageId, createManagedConversationId } from '~/utils/managed';
import { readChannelAuthority, registerChannelTarget } from './channelRegistry';
import { channelRunFence, channelRunStorageTarget } from './channelRunWrite';
import { createChannelIdentityStorage } from './channelIdentity';
import { ChannelDrainPendingError } from './channelGeneration';
import { createAgentApiKeyMethods } from './agentApiKey';
import { createChannelRunStorage } from './channelRun';
import { tenantStorage } from '~/config/tenantContext';
import { createAgentChannelMethods } from './channel';
import { channelRunKeyBinding } from './channelKey';
import { createResponseStorage } from './response';
import { managedRegistration } from './managed';
import { createModels } from '~/models';

const engines = ['standalone', 'replica', ...(process.env.FERRETDB_URI ? ['FerretDB'] : [])];
describe.each(engines)('closed-generation activation on %s', (engine) => {
  let server: MongoMemoryServer | MongoMemoryReplSet | undefined;
  beforeAll(async () => {
    if (engine === 'replica') server = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    else if (engine === 'standalone') server = await MongoMemoryServer.create();
    createModels(mongoose);
    await mongoose.connect(server?.getUri() ?? process.env.FERRETDB_URI!, {
      dbName: `channel_generation_${randomUUID().replace(/-/g, '')}`,
    });
  }, 60000);
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    await mongoose.disconnect();
    await server?.stop();
  });
  describe.each([undefined, 'generation-tenant'])('tenant %s', (tenantId) => {
    const scoped = (work: () => Promise<void>) => tenantStorage.run({ tenantId }, work);
    async function fixture(perUser = false) {
      const creator = String(new mongoose.Types.ObjectId());
      const owner = perUser ? String(new mongoose.Types.ObjectId()) : creator;
      const channelId = randomUUID();
      const channels = createAgentChannelMethods(mongoose, async () => ({ erasureBatchSize: 1 }));
      await channels.createAgentChannel({
        channelId,
        createdBy: creator,
        agentId: 'agent',
        type: 'slack',
        status: 'active',
        credentialMode: perUser ? 'per_user' : 'shared',
        revision: 'one',
        slack: { teamId: 'T', appId: 'A', botUserId: 'B' },
      });
      const identities = createChannelIdentityStorage(mongoose);
      async function link(revision: string) {
        const linkId = randomUUID();
        const linkRevision = randomUUID();
        if (perUser)
          expect(
            await identities.saveChannelIdentity(
              {
                tenantId: tenantId || '_',
                linkId,
                revision: linkRevision,
                state: 'active',
                userId: owner,
                ticketHash: randomUUID(),
                ticketExpiresAtMs: Date.now() + 60000,
                expiresAtMs: Date.now() + 600000,
                identity: {
                  tenantId: tenantId || '_',
                  channelId,
                  channelRevision: revision,
                  agentId: 'agent',
                  teamId: 'T',
                  externalUserId: 'U',
                },
              },
              null,
            ),
          ).toBe(true);
        return {
          userId: owner,
          channelRevision: revision,
          ...(perUser && { linkId, linkRevision }),
        };
      }
      const input = {
        tenantId: tenantId || '_',
        channelId,
        agentId: 'agent',
        principal: await link('one'),
        admission: {
          eventId: randomUUID(),
          externalChannelId: 'C',
          externalThreadKey: 'C:1',
          externalMessageKey: 'C:2',
          actor: { teamId: 'T', appId: 'A', externalUserId: 'U' },
          input: 'private prompt',
        },
      };
      const storage = createChannelRunStorage(mongoose);
      expect(await storage.observeThreadStop(input, 1000, 99)).toBeNull();
      const admitted = await storage.admit(input, 100);
      const claimed = (await storage.claim(input.tenantId, channelId, 'worker', 101, 1000))!;
      const prepared = await storage.prepareExecution(
        input.tenantId,
        channelRunFence(claimed),
        102,
      );
      const key = await createAgentApiKeyMethods(mongoose).createAgentApiKey({
        userId: owner,
        name: 'Unattached candidate',
        binding: channelRunKeyBinding(prepared),
      });
      const control = (await mongoose.models.ChannelLane.collection.findOne({
        channelId,
        kind: 'control',
      }))!;
      const disable = () => channels.updateAgentChannel(channelId, creator, { status: 'disabled' });
      const activate = () => channels.updateAgentChannel(channelId, creator, { status: 'active' });
      async function retire(runId = admitted.run.runId, at = 110) {
        const run = (await storage.read(input.tenantId, channelId, runId))!;
        const cleanup = (await storage.claimAuthorityLost(run, 'cleanup', at, 1000))!;
        expect(cleanup.execution?.apiKeyId).toBeUndefined();
        expect(
          await storage.finishAuthorityLost(input.tenantId, channelRunFence(cleanup), at + 1),
        ).toBe('stopped');
      }
      async function terminalGeneration(at: number) {
        const active = (await activate())!;
        const nextInput = {
          ...input,
          principal: await link(active.revision),
          admission: { ...input.admission, eventId: randomUUID() },
        };
        const next = await storage.admit(nextInput, at);
        const nextClaim = (await storage.claim(
          input.tenantId,
          channelId,
          'current-worker',
          at + 1,
          1000,
        ))!;
        const nextPrepared = await storage.prepareExecution(
          input.tenantId,
          channelRunFence(nextClaim),
          at + 2,
        );
        const nextKey = await createAgentApiKeyMethods(mongoose).createAgentApiKey({
          userId: owner,
          name: 'Current candidate',
          binding: channelRunKeyBinding(nextPrepared),
        });
        await retire(next.run.runId, at + 3);
        return { nextInput, run: next.run, key: nextKey };
      }
      return {
        creator,
        owner,
        channelId,
        channels,
        storage,
        input,
        control,
        key,
        link,
        admitted,
        disable,
        activate,
        retire,
        terminalGeneration,
      };
    }

    it.each([false, true])(
      'requires old drain, retains Stop metadata and preserves canonical history: perUser=%s',
      (perUser) =>
        scoped(async () => {
          const f = await fixture(perUser);
          const authority = (await readChannelAuthority(mongoose, {
            tenantId: f.input.tenantId,
            channelId: f.channelId,
            channelRevision: 'one',
            agentId: 'agent',
            teamId: 'T',
          }))!;
          expect(
            await registerChannelTarget(
              mongoose,
              authority,
              managedRegistration({
                kind: 'channelLane',
                id: String(f.control._id),
                incarnation: f.control._managed.incarnation,
                ...(tenantId && { tenantId }),
              }),
              { maxPendingTargetsPerScope: 1 },
            ),
          ).toMatchObject({ status: 'registered' });
          const historyId = createManagedMessageId();
          const responses = createResponseStorage(mongoose);
          expect(
            (
              await responses.reserve({
                ...(tenantId && { tenantId }),
                userId: f.owner,
                agentId: 'agent',
                responseId: historyId,
                requestKey: randomUUID(),
                fingerprint: 'history',
                requestJSON: '{}',
                conversationId: createManagedConversationId(),
                parentMessageId: 'root',
              })
            ).ok,
          ).toBe(true);
          const disabled = (await f.disable())!;
          await expect(f.activate()).rejects.toBeInstanceOf(ChannelDrainPendingError);
          expect(await f.channels.getAgentChannel(f.channelId)).toMatchObject({
            status: 'disabled',
            revision: disabled.revision,
          });
          expect(
            await mongoose.models.AgentApiKey.collection.findOne({
              _id: new mongoose.Types.ObjectId(f.key.id),
            }),
          ).not.toBeNull();
          await f.retire();
          const active = (await f.activate())!;
          expect(active.status).toBe('active');
          expect(
            await mongoose.models.ChannelRun.collection.countDocuments({ channelId: f.channelId }),
          ).toBe(1);
          expect(
            await mongoose.models.AgentApiKey.collection.findOne({
              _id: new mongoose.Types.ObjectId(f.key.id),
            }),
          ).not.toBeNull();
          expect(
            await mongoose.models.ChannelIdentity.collection.countDocuments({
              'identity.channelId': f.channelId,
            }),
          ).toBe(0);
          expect(
            await responses.read({ userId: f.owner, ...(tenantId && { tenantId }) }, historyId),
          ).not.toBeNull();
          const retained = (await mongoose.models.ChannelLane.collection.findOne({
            channelId: f.channelId,
            kind: 'control',
          }))!;
          expect(retained._id).toEqual(f.control._id);
          expect(retained.stop).toEqual(f.control.stop);
          const nextInput = {
            ...f.input,
            principal: await f.link(active.revision),
            admission: { ...f.input.admission, eventId: randomUUID() },
          };
          const next = await f.storage.admit(nextInput, 130);
          expect(
            (await f.storage.claim(f.input.tenantId, f.channelId, 'new-worker', 131, 1000))?.runId,
          ).toBe(next.run.runId);
          expect(await f.storage.observeThreadStop(nextInput, 1000, 140)).toBeNull();
          expect(
            (await mongoose.models.ChannelLane.collection.findOne({ _id: f.control._id }))!.stop,
          ).toEqual(f.control.stop);
        }),
      45000,
    );

    it('reconciles a frozen Run registration without losing its event receipt', () =>
      scoped(async () => {
        const f = await fixture();
        const run = (await f.storage.read(f.input.tenantId, f.channelId, f.admitted.run.runId))!;
        const authority = (await readChannelAuthority(mongoose, {
          tenantId: f.input.tenantId,
          channelId: f.channelId,
          channelRevision: 'one',
          agentId: 'agent',
          teamId: 'T',
        }))!;
        expect(
          await registerChannelTarget(
            mongoose,
            authority,
            managedRegistration({
              ...channelRunStorageTarget(run),
            }),
            { maxPendingTargetsPerScope: 1 },
          ),
        ).toMatchObject({ status: 'registered' });
        await f.disable();
        await f.retire();
        const active = (await f.activate())!;
        expect(active.status).toBe('active');
        expect(await f.storage.read(f.input.tenantId, f.channelId, run.runId)).toMatchObject({
          state: 'cancelled',
          cursorState: 'complete',
        });
        expect(
          await mongoose.models.AgentChannel.collection.findOne({ channelId: f.channelId }),
        ).toMatchObject({ pending: [], pendingCount: 0 });
      }));

    it.each(['cursor', 'control'] as const)(
      'repairs a durable terminal receipt interrupted before %s handoff',
      (point) =>
        scoped(async () => {
          const f = await fixture();
          await f.disable();
          const lanes = mongoose.models.ChannelLane.collection;
          const update = lanes.updateOne.bind(lanes);
          let failed = false;
          const fault = jest.spyOn(lanes, 'updateOne').mockImplementation(async (...args) => {
            if (
              !failed &&
              !Array.isArray(args[1]) &&
              (point === 'cursor' ? args[1].$set?.handoff : args[1].$unset?.assignment)
            ) {
              failed = true;
              throw new Error('Interrupted terminal handoff');
            }
            return update(...args);
          });
          await expect(f.retire()).rejects.toThrow('Interrupted terminal handoff');
          expect(failed).toBe(true);
          fault.mockRestore();
          const terminal = (await f.storage.read(
            f.input.tenantId,
            f.channelId,
            f.admitted.run.runId,
          ))!;
          expect(terminal).toMatchObject({ state: 'cancelled', terminalFence: expect.any(Object) });
          expect((await f.activate())?.status).toBe('active');
          expect(await f.storage.read(f.input.tenantId, f.channelId, terminal.runId)).toMatchObject(
            { state: 'cancelled', cursorState: 'complete', terminalFence: terminal.terminalFence },
          );
          const control = (await lanes.findOne({ _id: f.control._id }))!;
          expect(control.assignment).toBeUndefined();
          expect(control.stop).toEqual(f.control.stop);
        }),
    );

    it('does not admit an already processed Slack event again after re-enable', () =>
      scoped(async () => {
        const f = await fixture();
        await f.disable();
        await f.retire();
        const active = (await f.activate())!;
        await expect(
          f.storage.admit(
            {
              ...f.input,
              principal: await f.link(active.revision),
            },
            130,
          ),
        ).rejects.toMatchObject({ code: 'event_conflict' });
      }));

    it.each(['before-page', 'before-allocation-retirement'] as const)(
      'cannot erase a later generation when stale cleanup resumes %s',
      (point) =>
        scoped(async () => {
          const f = await fixture();
          const barrier = () => {
            let release!: () => void;
            let enter!: () => void;
            const entered = new Promise<void>((resolve) => {
              enter = resolve;
            });
            const gate = new Promise<void>((resolve) => {
              release = resolve;
            });
            return {
              release,
              entered,
              wait: async () => {
                enter();
                await gate;
              },
            };
          };
          const oldRegistration = barrier();
          const staleInspection = barrier();
          const futurePublication = barrier();
          const keys = mongoose.models.AgentApiKey.collection;
          const channels = mongoose.models.AgentChannel.collection;
          const channelUpdate = channels.updateOne.bind(channels);
          let oldProducer: Promise<AgentApiKeyCreateResult> | undefined;
          let futureProducer: Promise<AgentApiKeyCreateResult> | undefined;
          let pausedRegistration = false;
          jest.spyOn(channels, 'updateOne').mockImplementation(async (...args) => {
            if (
              point === 'before-allocation-retirement' &&
              !Array.isArray(args[1]) &&
              args[1].$push?.pending?.target?.kind === 'channelKey' &&
              !pausedRegistration
            ) {
              pausedRegistration = true;
              await oldRegistration.wait();
            }
            return channelUpdate(...args);
          });
          if (point === 'before-allocation-retirement') {
            const prepared = (await f.storage.read(
              f.input.tenantId,
              f.channelId,
              f.admitted.run.runId,
            ))!;
            oldProducer = createAgentApiKeyMethods(mongoose).createAgentApiKey({
              userId: f.owner,
              name: 'Old bootstrap',
              binding: channelRunKeyBinding(prepared),
            });
            void oldProducer.catch(() => undefined);
            await oldRegistration.entered;
          }
          await f.disable();
          await f.retire();
          let paused = false;
          const find = keys.find.bind(keys);
          const update = keys.updateOne.bind(keys);
          const publish = keys.findOneAndUpdate.bind(keys);
          jest.spyOn(keys, 'find').mockImplementation((...args) => {
            const cursor = find(...args);
            if (point === 'before-page' && args[0]['_managed.scopeKeys'] && !paused) {
              paused = true;
              const toArray = cursor.toArray.bind(cursor);
              jest.spyOn(cursor, 'toArray').mockImplementation(async () => {
                await staleInspection.wait();
                return toArray();
              });
            }
            return cursor;
          });
          jest.spyOn(keys, 'updateOne').mockImplementation(async (...args) => {
            if (
              point === 'before-allocation-retirement' &&
              !paused &&
              !Array.isArray(args[1]) &&
              args[1].$set?.['_managed.phase'] === 'retired'
            ) {
              paused = true;
              await staleInspection.wait();
            }
            return update(...args);
          });
          jest.spyOn(keys, 'findOneAndUpdate').mockImplementation(async (...args) => {
            if (
              !Array.isArray(args[1]) &&
              args[1].$set?.['_managed.phase'] === 'published' &&
              args[1].$set?.name === 'Future bootstrap'
            )
              await futurePublication.wait();
            return publish(...args);
          });
          const stale = f.activate();
          void stale.catch(() => undefined);
          const timeout = setTimeout(() => {
            oldRegistration.release();
            staleInspection.release();
            futurePublication.release();
          }, 15000);
          try {
            await staleInspection.entered;
            await f.terminalGeneration(130);
            await f.disable();
            const current = await f.terminalGeneration(150);
            const prepared = (await f.storage.read(
              f.input.tenantId,
              f.channelId,
              current.run.runId,
            ))!;
            futureProducer = createAgentApiKeyMethods(mongoose).createAgentApiKey({
              userId: f.owner,
              name: 'Future bootstrap',
              binding: channelRunKeyBinding(prepared),
            });
            void futureProducer.catch(() => undefined);
            await futurePublication.entered;
            staleInspection.release();
            expect(await stale).toBeNull();
            futurePublication.release();
            const future = await futureProducer;
            expect(
              await keys.findOne({ _id: new mongoose.Types.ObjectId(future.id) }),
            ).not.toBeNull();
            expect(
              await f.storage.read(f.input.tenantId, f.channelId, current.run.runId),
            ).toMatchObject({ state: 'cancelled' });
            expect(
              await keys.findOne({ _id: new mongoose.Types.ObjectId(current.key.id) }),
            ).not.toBeNull();
            expect(
              (await mongoose.models.ChannelLane.collection.findOne({ _id: f.control._id }))!.stop,
            ).toEqual(f.control.stop);
            oldRegistration.release();
            if (oldProducer) await expect(oldProducer).rejects.toThrow();
          } finally {
            clearTimeout(timeout);
            oldRegistration.release();
            staleInspection.release();
            futurePublication.release();
            await Promise.allSettled([stale, oldProducer, futureProducer]);
          }
        }),
      45000,
    );
  });
});
