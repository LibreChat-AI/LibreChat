import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import { MongoMemoryServer, MongoMemoryReplSet } from 'mongodb-memory-server';
import { readChannelAuthority, registerChannelTarget, channelRegistryKey } from './channelRegistry';
import { createResponseOwnerErasureMethods } from './responseErasure';
import { eraseChannelPersistenceForUser } from './channelErasure';
import { createChannelIdentityStorage } from './channelIdentity';
import { createChannelRunStorage } from './channelRun';
import { tenantStorage } from '~/config/tenantContext';
import { createAgentChannelMethods } from './channel';
import { closeResponseScopes } from './responseScope';
import { channelRunFence } from './channelRunWrite';
import { managedRegistration } from './managed';
import { createModels } from '~/models';

const engines = ['standalone', 'replica', ...(process.env.FERRETDB_URI ? ['FerretDB'] : [])];
describe.each(engines)('stable actor control across revisions on %s', (engine) => {
  let server: MongoMemoryServer | MongoMemoryReplSet | undefined;
  beforeAll(async () => {
    if (engine === 'replica') server = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    else if (engine === 'standalone') server = await MongoMemoryServer.create();
    createModels(mongoose);
    await mongoose.connect(server?.getUri() ?? process.env.FERRETDB_URI!, {
      dbName: `control_revision_${randomUUID().replace(/-/g, '')}`,
    });
  }, 60000);
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    await mongoose.disconnect();
    await server?.stop();
  });
  describe.each([undefined, 'revision-tenant'])('tenant %s', (tenantId) => {
    const scoped = (work: () => Promise<void>) => tenantStorage.run({ tenantId }, work);
    async function fixture(perUser = false) {
      const creatorId = String(new mongoose.Types.ObjectId());
      const ownerId = perUser ? String(new mongoose.Types.ObjectId()) : creatorId;
      const channelId = randomUUID();
      const channels = createAgentChannelMethods(mongoose);
      await channels.createAgentChannel({
        channelId,
        createdBy: creatorId,
        agentId: 'agent',
        type: 'slack',
        status: 'active',
        credentialMode: perUser ? 'per_user' : 'shared',
        revision: 'one',
        slack: { teamId: 'T', appId: 'A', botUserId: 'B' },
      });
      const linkId = randomUUID();
      const input = {
        tenantId: tenantId || '_',
        channelId,
        agentId: 'agent',
        principal: {
          userId: ownerId,
          channelRevision: 'one',
          ...(perUser && { linkId, linkRevision: 'one' }),
        },
        admission: {
          eventId: 'first',
          externalChannelId: 'C',
          externalThreadKey: 'thread',
          externalMessageKey: 'C:1',
          actor: { teamId: 'T', appId: 'A', externalUserId: 'U' },
          input: 'hello',
        },
      };
      const identities = createChannelIdentityStorage(mongoose);
      const originalLink = {
        tenantId: input.tenantId,
        linkId,
        revision: 'one',
        state: 'active' as const,
        userId: ownerId,
        ticketHash: randomUUID(),
        ticketExpiresAtMs: Date.now() + 60000,
        expiresAtMs: Date.now() + 600000,
        identity: {
          tenantId: input.tenantId,
          channelId,
          channelRevision: 'one',
          agentId: 'agent',
          teamId: 'T',
          externalUserId: 'U',
        },
      };
      if (perUser) expect(await identities.saveChannelIdentity(originalLink, null)).toBe(true);
      const storage = createChannelRunStorage(mongoose);
      const { run } = await storage.admit(input, 100);
      async function rotate() {
        expect(
          await channels.updateAgentChannel(channelId, creatorId, { revision: 'two' }),
        ).not.toBeNull();
        const nextLinkId = randomUUID();
        if (perUser)
          expect(
            await identities.saveChannelIdentity(
              {
                ...originalLink,
                linkId: nextLinkId,
                revision: 'two',
                ticketHash: randomUUID(),
                identity: { ...originalLink.identity, channelRevision: 'two' },
              },
              'one',
            ),
          ).toBe(true);
        return {
          ...input,
          principal: {
            userId: ownerId,
            channelRevision: 'two',
            ...(perUser && { linkId: nextLinkId, linkRevision: 'two' }),
          },
          admission: { ...input.admission, eventId: 'second' },
        };
      }
      const controlId = new mongoose.Types.ObjectId(run.publication!.control.id);
      return { channels, creatorId, ownerId, input, run, storage, rotate, controlId };
    }
    it('preserves the original clamped empty Stop across rotation and cannot retarget its retry', () =>
      scoped(async () => {
        const f = await fixture();
        expect(await f.storage.observeThreadStop(f.input, 1000, 105)).toBeNull();
        const before = await mongoose.models.ChannelLane.collection.findOne({ _id: f.controlId });
        expect(before!.stop).toMatchObject({
          eventAt: 1000,
          before: 105,
          selection: { result: 'none' },
        });
        const nextInput = await f.rotate();
        const admitted = await f.storage.admit(nextInput, 110);
        const cleanup = (await f.storage.claimAuthorityLost(f.run, 'cleanup', 111, 1000))!;
        expect(cleanup.execution).toBeUndefined();
        await f.storage.finishAuthorityLost(f.input.tenantId, channelRunFence(cleanup), 112);
        const next = (await f.storage.claim(
          f.input.tenantId,
          f.input.channelId,
          'worker',
          113,
          1000,
        ))!;
        expect(next.runId).toBe(admitted.run.runId);
        expect(await f.storage.observeThreadStop(nextInput, 1000, 120)).toBeNull();
        const after = await mongoose.models.ChannelLane.collection.findOne({ _id: f.controlId });
        expect(after!.stop).toEqual(before!.stop);
        expect(after!._managed.scopeKeys).toEqual(before!._managed.scopeKeys);
        expect(after!.channelRef.revision).toBe('one');
        expect(next.publication!.channel.revision).toBe('two');
        expect(
          await mongoose.models.ChannelLane.countDocuments({
            channelId: f.input.channelId,
            kind: 'control',
          }),
        ).toBe(1);
      }));
    it.each([false, true])(
      'keeps the old assignment until actual retirement before current-revision work: perUser=%s',
      (perUser) =>
        scoped(async () => {
          const f = await fixture(perUser);
          const old = (await f.storage.claim(
            f.input.tenantId,
            f.input.channelId,
            'old',
            101,
            1000,
          ))!;
          const nextInput = await f.rotate();
          const admitted = await f.storage.admit(nextInput, 105);
          expect(
            await f.storage.claim(f.input.tenantId, f.input.channelId, 'new', 106, 1000),
          ).toBeNull();
          expect(await f.storage.observeThreadStop(f.input, 107, 107)).toBeNull();
          const cleanup = (await f.storage.claimAuthorityLost(old, 'cleanup', 108, 1000))!;
          expect(cleanup.execution).toBeUndefined();
          await f.storage.finishAuthorityLost(f.input.tenantId, channelRunFence(cleanup), 109);
          const current = (await f.storage.claim(
            f.input.tenantId,
            f.input.channelId,
            'new',
            110,
            1000,
          ))!;
          expect(current.runId).toBe(admitted.run.runId);
          const prepared = await f.storage.prepareExecution(
            f.input.tenantId,
            channelRunFence(current),
            111,
          );
          expect(prepared.principal).toEqual(nextInput.principal);
          expect(await f.storage.observeThreadStop(nextInput, 112, 112)).toMatchObject({
            run: { runId: current.runId },
          });
        }),
    );
    it.each([false, true])(
      'erases current-generation owner data through a creation-generation control: perUser=%s',
      (perUser) =>
        scoped(async () => {
          const f = await fixture(perUser);
          const nextInput = await f.rotate();
          await f.storage.admit(nextInput, 110);
          const owner = { userId: f.ownerId, ...(tenantId && { tenantId }) };
          const erasure = createResponseOwnerErasureMethods(mongoose);
          await erasure.prepareUserResponseErasure(owner);
          await eraseChannelPersistenceForUser(mongoose, owner);
          await erasure.assertUserStorageErased(owner);
          expect(
            await mongoose.models.ChannelRun.collection.countDocuments({
              channelId: f.input.channelId,
              'principal.userId': f.ownerId,
            }),
          ).toBe(0);
          expect(
            await mongoose.models.ChannelLane.collection.countDocuments({
              channelId: f.input.channelId,
              kind: 'principal',
              userId: f.ownerId,
            }),
          ).toBe(0);
          const control = await mongoose.models.ChannelLane.collection.findOne({
            _id: f.controlId,
          });
          expect(control!.channelRef.revision).toBe('one');
          expect(control!.assignment).toBeUndefined();
        }),
    );
    it('recovers a lost creation receipt at bounded capacity without inventing new control-generation ownership', () =>
      scoped(async () => {
        const f = await fixture();
        const authority = await readChannelAuthority(mongoose, {
          tenantId: f.input.tenantId,
          channelId: f.input.channelId,
          agentId: 'agent',
          channelRevision: 'one',
          teamId: 'T',
        });
        if (!authority) throw new Error('Fixture authority missing');
        expect(
          await registerChannelTarget(
            mongoose,
            authority,
            managedRegistration(f.run.publication!.control),
            { maxPendingTargetsPerScope: 1 },
          ),
        ).toMatchObject({ status: 'registered' });
        const nextInput = await f.rotate();
        const bounded = createChannelRunStorage(mongoose, {}, async () => ({
          maxPendingTargetsPerScope: 1,
        }));
        await expect(bounded.admit(nextInput, 110)).resolves.toMatchObject({
          run: { principal: { channelRevision: 'two' } },
        });
        const control = await mongoose.models.ChannelLane.collection.findOne({ _id: f.controlId });
        expect(control!._managed.scopeKeys).toContain(channelRegistryKey(authority));
        expect(control!._managed.scopeKeys).not.toContain(
          channelRegistryKey({ ...authority, revision: 'two' }),
        );
        const parent = await mongoose.models.AgentChannel.collection.findOne({
          channelId: f.input.channelId,
        });
        expect(parent!.pendingCount).toBe(0);
      }));
    it.each(['disabled', 'owner-closed', 'replaced-parent', 'foreign-lineage'] as const)(
      'rejects %s reuse before publishing another private Run',
      (failure) =>
        scoped(async () => {
          const f = await fixture();
          if (failure === 'disabled')
            await f.channels.updateAgentChannel(f.input.channelId, f.creatorId, {
              status: 'disabled',
            });
          if (failure === 'owner-closed')
            await closeResponseScopes(mongoose, {
              userId: f.ownerId,
              ...(tenantId && { tenantId }),
            });
          if (failure === 'replaced-parent')
            await mongoose.models.AgentChannel.collection.updateOne(
              { channelId: f.input.channelId },
              { $set: { '_managed.incarnation': randomUUID() } },
            );
          if (failure === 'foreign-lineage')
            await mongoose.models.ChannelLane.collection.updateOne(
              { _id: f.controlId },
              { $set: { '_managed.scopeKeys': [] } },
            );
          await expect(
            f.storage.admit(
              { ...f.input, admission: { ...f.input.admission, eventId: 'denied' } },
              110,
            ),
          ).rejects.toMatchObject({ code: 'invalid_transition' });
          expect(
            await mongoose.models.ChannelRun.collection.countDocuments({
              channelId: f.input.channelId,
            }),
          ).toBe(1);
        }),
    );
  });
});
