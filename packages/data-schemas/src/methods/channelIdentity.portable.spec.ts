import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import { MongoMemoryServer, MongoMemoryReplSet } from 'mongodb-memory-server';
import { allocateManagedTarget, managedRegistration, discardManagedAllocation } from './managed';
import { registerResponseTarget, reconcileResponseTargets } from './registration';
import { registerChannelTarget, readChannelAuthority } from './channelRegistry';
import { createResponseScopeModel } from '~/models/responseScope';
import { createChannelIdentityStorage } from './channelIdentity';
import { tenantStorage } from '~/config/tenantContext';
import { createAgentChannelMethods } from './channel';
import { responseScopeKeys } from './responseScope';
import { createUserMethods } from './user';
import { createModels } from '~/models';

const engines = ['standalone', 'replica', ...(process.env.FERRETDB_URI ? ['FerretDB'] : [])];
describe.each(engines)('portable identity on %s', (engine) => {
  let server: MongoMemoryServer | MongoMemoryReplSet | undefined;
  beforeAll(async () => {
    if (engine === 'replica') server = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    else if (engine === 'standalone') server = await MongoMemoryServer.create();
    createModels(mongoose);
    await mongoose.connect(server?.getUri() ?? process.env.FERRETDB_URI!, {
      dbName: `identity_portable_${randomUUID().replace(/-/g, '')}`,
    });
  }, 60000);
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    await mongoose.disconnect();
    await server?.stop();
  });
  describe.each([undefined, 'identity-tenant'])('tenant %s', (tenantId) => {
    const scope = (test: () => Promise<void>) => tenantStorage.run({ tenantId }, test);
    async function fixture() {
      const user = async () =>
        String(
          (
            await mongoose.model('User').create({
              provider: 'local',
              email: `${randomUUID()}@example.test`,
            })
          )._id,
        );
      const creator = await user();
      const owner = await user();
      const channels = createAgentChannelMethods(mongoose);
      const storage = createChannelIdentityStorage(mongoose);
      const channelId = randomUUID();
      await channels.createAgentChannel({
        channelId,
        createdBy: creator,
        agentId: 'agent',
        type: 'slack',
        status: 'active',
        credentialMode: 'per_user',
        revision: 'channel-revision',
        slack: { teamId: 'T1', appId: 'A1', botUserId: 'B1' },
      });
      const record = {
        tenantId: tenantId || '_',
        linkId: randomUUID(),
        revision: 'pending',
        state: 'pending' as const,
        ticketHash: randomUUID(),
        ticketExpiresAtMs: Date.now() + 60_000,
        expiresAtMs: Date.now() + 120_000,
        identity: {
          tenantId: tenantId || '_',
          channelId,
          channelRevision: 'channel-revision',
          teamId: 'T1',
          externalUserId: 'U1',
          agentId: 'agent',
        },
      };
      return { channels, storage, record, owner, creator, user };
    }
    it('selects one first owner and requires a fresh physical root to relink', () =>
      scope(async () => {
        const f = await fixture();
        const sessions = jest.spyOn(mongoose, 'startSession');
        expect(await f.storage.saveChannelIdentity(f.record, null)).toBe(true);
        const other = await f.user();
        const accepted = [f.owner, other].map((userId) => ({
          ...f.record,
          userId,
          state: 'accepted' as const,
          revision: `accepted-${userId}`,
          accountLabel: 'synthetic label',
        }));
        const results = await Promise.all(
          accepted.map((r) => f.storage.saveChannelIdentity(r, 'pending')),
        );
        expect(results.filter(Boolean)).toHaveLength(1);
        const winner = accepted[results.findIndex(Boolean)];
        const active = { ...winner, state: 'active' as const, revision: 'active' };
        expect(await f.storage.saveChannelIdentity(active, winner.revision)).toBe(true);
        expect(
          await f.storage.saveChannelIdentity(
            { ...active, userId: 'another', revision: 'transfer' },
            'active',
          ),
        ).toBe(false);
        expect(
          await f.storage.revokeChannelIdentity(
            {
              tenantId: active.tenantId,
              linkId: active.linkId,
              userId: winner.userId,
              revision: active.revision,
            },
            'withdrawn',
          ),
        ).toBe(true);
        expect(
          await f.storage.saveChannelIdentity({ ...active, revision: 'resurrected' }, 'withdrawn'),
        ).toBe(false);
        const old = await mongoose
          .model('ChannelIdentity')
          .collection.findOne({ linkId: f.record.linkId });
        const next = {
          ...f.record,
          linkId: randomUUID(),
          revision: 'new-ticket',
          ticketHash: randomUUID(),
        };
        expect(await f.storage.saveChannelIdentity(next, 'withdrawn')).toBe(true);
        const fresh = await mongoose
          .model('ChannelIdentity')
          .collection.findOne({ linkId: next.linkId });
        expect(String(fresh!._id)).not.toBe(String(old!._id));
        expect(await f.storage.readChannelLink(f.record.tenantId, f.record.linkId)).toBeNull();
        expect(await f.storage.saveChannelIdentity({ ...active, revision: 'late' }, 'active')).toBe(
          false,
        );
        expect(
          await f.storage.saveChannelIdentity(
            { ...next, state: 'accepted', userId: other, revision: 'new-owner' },
            next.revision,
          ),
        ).toBe(true);
        expect(sessions).not.toHaveBeenCalled();
      }));

    it('honors the live registry capacity and recovers without replacing a disputed child', () =>
      scope(async () => {
        const f = await fixture();
        const channel = (await readChannelAuthority(mongoose, f.record.identity))!;
        const disputed = await allocateManagedTarget(mongoose, 'channelRun', tenantId);
        expect(
          await registerChannelTarget(mongoose, channel, managedRegistration(disputed)),
        ).toMatchObject({ status: 'registered' });
        let capacity = 1;
        const storage = createChannelIdentityStorage(mongoose, async () => ({
          maxPendingTargetsPerScope: capacity,
        }));
        expect(await storage.saveChannelIdentity(f.record, null)).toBe(false);
        expect(await storage.readChannelLink(f.record.tenantId, f.record.linkId)).toBeNull();
        capacity = 2;
        expect(await storage.saveChannelIdentity(f.record, null)).toBe(true);
        expect(
          await mongoose
            .model('ChannelRun')
            .collection.findOne({ _id: new mongoose.Types.ObjectId(disputed.id) }),
        ).toMatchObject({ _managed: { phase: 'empty', incarnation: disputed.incarnation } });
      }));

    it('rejects an oversized replacement before closing its prior authority', () =>
      scope(async () => {
        const f = await fixture();
        await f.storage.saveChannelIdentity(f.record, null);
        const original = await mongoose
          .model('ChannelIdentity')
          .collection.findOne({ linkId: f.record.linkId });
        await expect(
          f.storage.saveChannelIdentity(
            {
              ...f.record,
              linkId: randomUUID(),
              revision: 'oversized',
              ticketHash: 'x'.repeat(16 * 1024 * 1024),
            },
            f.record.revision,
          ),
        ).rejects.toMatchObject({ code: 'document_limit' });
        expect(await f.storage.readChannelLink(f.record.tenantId, f.record.linkId)).toMatchObject({
          revision: f.record.revision,
        });
        expect(
          await mongoose.model('ChannelIdentity').collection.findOne({ _id: original!._id }),
        ).toMatchObject({ _managed: { phase: 'published' } });
      }));

    it.each(['private-owner', 'owner-registration', 'private-ticket', 'private-revoked'] as const)(
      'fences a paused %s write before erasure completes',
      (point) =>
        scope(async () => {
          const f = await fixture();
          const ticket = point === 'private-ticket' || point === 'private-revoked';
          if (!ticket) await f.storage.saveChannelIdentity(f.record, null);
          let entered!: () => void;
          let release!: () => void;
          const started = new Promise<void>((resolve) => {
            entered = resolve;
          });
          const gate = new Promise<void>((resolve) => {
            release = resolve;
          });
          const ownerKey = responseScopeKeys({ userId: f.owner, tenantId }, '')[0];
          const collection = mongoose.model(
            point === 'owner-registration' ? 'ResponseScope' : 'ChannelIdentity',
          ).collection;
          let paused = false;
          if (point === 'owner-registration') {
            const write = collection.findOneAndUpdate.bind(collection);
            jest.spyOn(collection, 'findOneAndUpdate').mockImplementation(async (...args) => {
              if (
                !paused &&
                String(args[0]._id) === ownerKey &&
                !Array.isArray(args[1]) &&
                args[1].$push
              ) {
                paused = true;
                entered();
                await gate;
              }
              return write(...args);
            });
          } else {
            const write = collection.updateOne.bind(collection);
            jest.spyOn(collection, 'updateOne').mockImplementation(async (...args) => {
              const set = Array.isArray(args[1]) ? undefined : args[1].$set;
              const match =
                point === 'private-owner'
                  ? set?.state === 'accepted'
                  : set?.['_managed.phase'] === 'published';
              if (!paused && match) {
                paused = true;
                entered();
                await gate;
              }
              return write(...args);
            });
          }
          const publishing = ticket
            ? f.storage.saveChannelIdentity(
                point === 'private-revoked'
                  ? {
                      ...f.record,
                      state: 'revoked',
                      userId: f.owner,
                      accountLabel: 'synthetic revoked label',
                    }
                  : f.record,
                null,
              )
            : f.storage.saveChannelIdentity(
                {
                  ...f.record,
                  userId: f.owner,
                  accountLabel: 'synthetic private label',
                  state: 'accepted',
                  revision: 'accepted',
                },
                'pending',
              );
          let timedOut = false;
          const timeout = setTimeout(() => {
            timedOut = true;
            release();
          }, 5000);
          try {
            await started;
            if (ticket)
              expect(
                await f.channels.deleteAgentChannel(f.record.identity.channelId, f.creator),
              ).toEqual({ status: 'deleted' });
            else
              expect(await createUserMethods(mongoose).deleteUserById(f.owner)).toMatchObject({
                deletedCount: 1,
              });
            expect(timedOut).toBe(false);
          } finally {
            clearTimeout(timeout);
            release();
          }
          expect(await publishing).toBe(false);
          expect(await f.storage.readChannelLink(f.record.tenantId, f.record.linkId)).toBeNull();
          if (!ticket) {
            const anchor = await createResponseScopeModel(mongoose).findById(ownerKey).lean();
            expect(anchor).toMatchObject({ closed: true });
            expect(anchor!.pendingCount ?? 0).toBe(0);
            expect(anchor!.pending ?? []).toEqual([]);
          }
        }),
    );

    it('recovers an applied publication with a lost reply through actual owner erasure', () =>
      scope(async () => {
        const f = await fixture();
        const collection = mongoose.model('ChannelIdentity').collection;
        const write = collection.updateOne.bind(collection);
        let injected = false;
        jest.spyOn(collection, 'updateOne').mockImplementation(async (...args) => {
          const result = await write(...args);
          if (
            !injected &&
            !Array.isArray(args[1]) &&
            args[1].$set?.['_managed.phase'] === 'published'
          ) {
            injected = true;
            throw new Error('synthetic lost publication reply');
          }
          return result;
        });
        await expect(
          f.storage.saveChannelIdentity({ ...f.record, userId: f.owner, state: 'active' }, null),
        ).rejects.toThrow('synthetic lost publication reply');
        expect(await f.storage.readChannelLink(f.record.tenantId, f.record.linkId)).not.toBeNull();
        expect(await createUserMethods(mongoose).deleteUserById(f.owner)).toMatchObject({
          deletedCount: 1,
        });
        expect(await f.storage.readChannelLink(f.record.tenantId, f.record.linkId)).toBeNull();
      }));

    it('retains a redacted child registry without reserving the old actor slot', () =>
      scope(async () => {
        const f = await fixture();
        const active = {
          ...f.record,
          userId: f.owner,
          accountLabel: 'synthetic label',
          state: 'active' as const,
        };
        await f.storage.saveChannelIdentity(active, null);
        const old = await mongoose
          .model('ChannelIdentity')
          .collection.findOne({ linkId: f.record.linkId });
        const target = {
          kind: 'channelIdentity' as const,
          id: String(old!._id),
          incarnation: old!._managed.incarnation,
          ...(tenantId && { tenantId }),
        };
        const owner = { userId: f.owner, ...(tenantId && { tenantId }) };
        expect(
          await registerResponseTarget(mongoose, owner, undefined, managedRegistration(target)),
        ).toMatchObject({ status: 'registered' });
        const child = await allocateManagedTarget(mongoose, 'channelRun', tenantId);
        expect(
          await registerChannelTarget(
            mongoose,
            {
              target: {
                kind: 'channelIdentity',
                id: String(old!._id),
                incarnation: old!._managed.incarnation,
                ...(tenantId && { tenantId }),
              },
              revision: active.revision,
              linkId: active.linkId,
              userId: f.owner,
              channelId: active.identity.channelId,
              channelRevision: active.identity.channelRevision,
              agentId: active.identity.agentId,
              teamId: active.identity.teamId,
              externalUserId: active.identity.externalUserId,
            },
            managedRegistration(child),
          ),
        ).toMatchObject({ status: 'registered' });
        const next = {
          ...f.record,
          linkId: randomUUID(),
          revision: 'fresh',
          ticketHash: randomUUID(),
        };
        expect(await f.storage.saveChannelIdentity(next, active.revision)).toBe(true);
        const retained = await mongoose
          .model('ChannelIdentity')
          .collection.findOne({ _id: old!._id });
        expect(retained).toMatchObject({
          state: 'revoked',
          _managed: { phase: 'retired' },
          pendingCount: 1,
        });
        await mongoose.model('ChannelIdentity').collection.updateOne(
          { _id: old!._id },
          {
            $set: { accountLabel: 'synthetic unexpected private field' },
          },
        );
        expect(await reconcileResponseTargets(mongoose, owner)).toBe(0);
        await mongoose.model('ChannelIdentity').collection.updateOne(
          { _id: old!._id },
          {
            $unset: { accountLabel: 1 },
          },
        );
        expect(await reconcileResponseTargets(mongoose, owner)).toBe(1);
        expect(retained).not.toHaveProperty('userId');
        expect(retained).not.toHaveProperty('accountLabel');
        expect(retained!.ticketHash).not.toBe(f.record.ticketHash);
        expect(retained!.identity.externalUserId).not.toBe(active.identity.externalUserId);
        expect(await f.storage.readChannelIdentity(next.identity)).toMatchObject({
          linkId: next.linkId,
        });
        expect(
          await f.storage.saveChannelIdentity({ ...active, revision: 'late' }, active.revision),
        ).toBe(false);
        expect(await f.channels.deleteAgentChannel(f.record.identity.channelId, f.creator)).toEqual(
          { status: 'pending_drain' },
        );
        expect(await discardManagedAllocation(mongoose, child)).toBe(true);
        expect(await f.channels.deleteAgentChannel(f.record.identity.channelId, f.creator)).toEqual(
          { status: 'deleted' },
        );
      }));
  });
});
