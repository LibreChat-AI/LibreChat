import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import { MongoMemoryServer, MongoMemoryReplSet } from 'mongodb-memory-server';
import type { ChannelAuthority, IdentityAuthority } from './channelRegistry';
import {
  channelOwnershipFields,
  registerChannelOwnership,
  settleChannelOwnership,
  reconcileAbsentChannelOwnership,
} from './channelOwnership';
import {
  registerChannelTarget,
  reconcileChannelTargets,
  settleChannelTarget,
  channelScopeKeys,
  channelRegistryKey,
} from './channelRegistry';
import {
  allocateManagedTarget,
  discardManagedAllocation,
  managedTargetFilter,
  managedRegistration,
  managedTargetModels,
} from './managed';
import {
  registerResponseTarget,
  settleResponseTarget,
  reconcileErasedResponseTargets,
} from './registration';
import { responseScopeKeys, createResponseRetention } from './responseScope';
import { tenantStorage, SYSTEM_TENANT_ID } from '~/config/tenantContext';
import { _resetStrictCache } from '~/models/plugins/tenantIsolation';
import { createResponseScopeModel } from '~/models/responseScope';
import { createAgentChannelMethods } from './channel';
import { retireAgentChannel } from './channelScope';
import { createModels } from '~/models';

const engines = ['standalone', 'replica', ...(process.env.FERRETDB_URI ? ['FerretDB'] : [])];

describe.each(engines)('canonical channel registry on %s', (engine) => {
  let server: MongoMemoryServer | MongoMemoryReplSet | undefined;
  beforeAll(async () => {
    if (engine === 'replica') server = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    else if (engine === 'standalone') server = await MongoMemoryServer.create();
    createModels(mongoose);
    await mongoose.connect(server?.getUri() ?? process.env.FERRETDB_URI!, {
      dbName: `channel_registry_${randomUUID().replace(/-/g, '')}`,
    });
    for (const kind of ['channel', 'channelIdentity', 'channelRun'] as const)
      await mongoose.model(managedTargetModels[kind]).createIndexes();
  }, 60000);
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    await mongoose.disconnect();
    await server?.stop();
  });

  describe.each([undefined, 'registry-tenant'])('logical tenant %s', (tenantId) => {
    function scoped(test: () => Promise<void>) {
      return tenantStorage.run({ tenantId }, test);
    }

    async function fixture() {
      const creator = { userId: randomUUID(), ...(tenantId && { tenantId }) };
      const owner = { ...creator, userId: randomUUID() };
      const channel: ChannelAuthority = {
        target: await allocateManagedTarget(mongoose, 'channel', tenantId),
        revision: randomUUID(),
        channelId: randomUUID(),
        agentId: randomUUID(),
        createdBy: creator.userId,
        teamId: randomUUID(),
        appId: randomUUID(),
      };
      await mongoose
        .model('AgentChannel')
        .collection.updateOne(managedTargetFilter(mongoose, channel.target), {
          $set: {
            channelId: channel.channelId,
            revision: channel.revision,
            createdBy: channel.createdBy,
            agentId: channel.agentId,
            type: 'slack',
            status: 'active',
            credentialMode: 'shared',
            slack: { teamId: channel.teamId, appId: channel.appId },
            '_managed.phase': 'published',
            encryptedBotToken: 'synthetic-private-token',
          },
        });
      const identity: IdentityAuthority = {
        target: await allocateManagedTarget(mongoose, 'channelIdentity', tenantId),
        revision: randomUUID(),
        linkId: randomUUID(),
        userId: owner.userId,
        channelId: channel.channelId,
        channelRevision: channel.revision,
        agentId: channel.agentId,
        teamId: channel.teamId,
        externalUserId: randomUUID(),
      };
      await mongoose
        .model('ChannelIdentity')
        .collection.updateOne(managedTargetFilter(mongoose, identity.target), {
          $set: {
            revision: identity.revision,
            linkId: identity.linkId,
            userId: owner.userId,
            state: 'active',
            expiresAtMs: Date.now() + 3600000,
            accountLabel: 'synthetic label',
            identity: {
              tenantId: tenantId ?? '_',
              channelId: channel.channelId,
              channelRevision: channel.revision,
              agentId: channel.agentId,
              teamId: channel.teamId,
              externalUserId: identity.externalUserId,
            },
            '_managed.phase': 'published',
          },
        });
      const target = await allocateManagedTarget(mongoose, 'channelRun', tenantId);
      const entry = managedRegistration(target);
      const conversationId = randomUUID();
      const keys = channelScopeKeys(mongoose, {
        creator,
        owner,
        channel,
        identity,
        conversationId,
      });
      async function publish(scopeKeys = keys) {
        await mongoose
          .model('ChannelRun')
          .collection.updateOne(managedTargetFilter(mongoose, target), {
            $set: { '_managed.phase': 'published', '_managed.scopeKeys': scopeKeys },
          });
      }
      async function anchor(authority: ChannelAuthority | IdentityAuthority = channel) {
        return mongoose
          .model(managedTargetModels[authority.target.kind])
          .collection.findOne(managedTargetFilter(mongoose, authority.target));
      }
      return {
        creator,
        owner,
        channel,
        identity,
        target,
        entry,
        conversationId,
        keys,
        publish,
        anchor,
      };
    }

    it('deduplicates concurrent registration/settlement without exposing metadata or credentials', () =>
      scoped(async () => {
        const f = await fixture();
        for (const authority of [f.channel, f.identity]) {
          const results = await Promise.all(
            Array.from({ length: 12 }, () => registerChannelTarget(mongoose, authority, f.entry)),
          );
          expect(results.every((result) => result.status === 'registered')).toBe(true);
          expect(await f.anchor(authority)).toMatchObject({
            pendingCount: 1,
            pending: [{ ...f.entry, retentionEpoch: 0, authorityRevision: authority.revision }],
          });
          const ordinary = await mongoose
            .model(managedTargetModels[authority.target.kind])
            .findById(authority.target.id)
            .lean();
          expect(ordinary).not.toBeNull();
          for (const key of [
            'pending',
            'pendingCount',
            'retentionEpoch',
            '_managed',
            'encryptedBotToken',
            'ticketHash',
          ])
            expect(ordinary).not.toHaveProperty(key);
          expect(await settleChannelTarget(mongoose, authority, f.entry)).toBe(false);
        }
        await f.publish();
        for (const authority of [f.channel, f.identity]) {
          const results = await Promise.all(
            Array.from({ length: 12 }, () => settleChannelTarget(mongoose, authority, f.entry)),
          );
          expect(results.filter(Boolean)).toHaveLength(1);
          expect(await f.anchor(authority)).toMatchObject({ pendingCount: 0, pending: [] });
        }
      }));

    it('bounds admission, reclaims absent allocations, and never calls hidden allocations absent', () =>
      scoped(async () => {
        const f = await fixture();
        const options = { maxPendingTargetsPerScope: 1 };
        expect((await registerChannelTarget(mongoose, f.channel, f.entry, options)).status).toBe(
          'registered',
        );
        const next = managedRegistration(
          await allocateManagedTarget(mongoose, 'channelRun', tenantId),
        );
        expect(await mongoose.model('ChannelRun').exists({ _id: f.target.id })).toBeNull();
        expect(await reconcileChannelTargets(mongoose, f.channel, true)).toBe(0);
        expect((await registerChannelTarget(mongoose, f.channel, next, options)).status).toBe(
          'capacity',
        );
        expect(await discardManagedAllocation(mongoose, f.target)).toBe(true);
        expect((await registerChannelTarget(mongoose, f.channel, next, options)).status).toBe(
          'registered',
        );
        expect(await f.anchor()).toMatchObject({ pendingCount: 1, pending: [{ key: next.key }] });
      }));

    it('rejects key collisions and corrupt counters, including duplicate requests', () =>
      scoped(async () => {
        const f = await fixture();
        await registerChannelTarget(mongoose, f.channel, f.entry);
        const target = await allocateManagedTarget(mongoose, 'channelRun', tenantId);
        expect(
          (await registerChannelTarget(mongoose, f.channel, { ...f.entry, target })).status,
        ).toBe('conflict');
        await mongoose
          .model('AgentChannel')
          .collection.updateOne(managedTargetFilter(mongoose, f.channel.target), {
            $set: { pendingCount: 0 },
          });
        await expect(registerChannelTarget(mongoose, f.channel, f.entry)).rejects.toThrow(
          'counter is inconsistent',
        );
      }));

    it('bounds competing distinct publishers without losing a pending operation', () =>
      scoped(async () => {
        const f = await fixture();
        const entries = await Promise.all(
          Array.from({ length: 12 }, async () =>
            managedRegistration(await allocateManagedTarget(mongoose, 'channelRun', tenantId)),
          ),
        );
        const results = await Promise.all(
          entries.map((entry) =>
            registerChannelTarget(mongoose, f.channel, entry, { maxPendingTargetsPerScope: 3 }),
          ),
        );
        const anchor = await f.anchor();
        expect(anchor!.pendingCount).toBe(3);
        expect(anchor!.pending).toHaveLength(3);
        expect(results.filter((result) => result.status === 'registered')).toHaveLength(3);
        expect(new Set(anchor!.pending.map((entry: { key: string }) => entry.key)).size).toBe(3);
      }));

    it('recovers an acknowledged write with a lost reply without re-registering the target', () =>
      scoped(async () => {
        const f = await fixture();
        const model = mongoose.model('AgentChannel');
        const update = model.updateOne.bind(model);
        jest.spyOn(model, 'updateOne').mockImplementationOnce((...args) => {
          const query = update(...args);
          const exec = query.exec.bind(query);
          query.exec = async (...execArgs) => {
            await exec(...execArgs);
            throw new Error('synthetic lost registration reply');
          };
          return query;
        });
        await expect(registerChannelTarget(mongoose, f.channel, f.entry)).rejects.toThrow(
          'synthetic lost registration reply',
        );
        expect((await registerChannelTarget(mongoose, f.channel, f.entry)).status).toBe(
          'registered',
        );
        expect(await f.anchor()).toMatchObject({
          pendingCount: 1,
          pending: [{ key: f.entry.key }],
        });
      }));

    it('requires both lifetime and current generation lineage before settlement', () =>
      scoped(async () => {
        const f = await fixture();
        await registerChannelTarget(mongoose, f.channel, f.entry);
        await f.publish([channelRegistryKey(f.channel, false)]);
        expect(await settleChannelTarget(mongoose, f.channel, f.entry)).toBe(false);
        await f.publish([channelRegistryKey(f.channel)]);
        expect(await settleChannelTarget(mongoose, f.channel, f.entry)).toBe(false);
        await f.publish();
        expect(await settleChannelTarget(mongoose, f.channel, f.entry)).toBe(true);
      }));

    it.each(['channel', 'identity'] as const)(
      'fences %s revocation after primary read but before registration CAS',
      (kind) =>
        scoped(async () => {
          const f = await fixture();
          const authority = f[kind];
          const model = mongoose.model(managedTargetModels[authority.target.kind]);
          const update = model.updateOne.bind(model);
          jest.spyOn(model, 'updateOne').mockImplementationOnce((...args) => {
            const query = update(...args);
            const exec = query.exec.bind(query);
            query.exec = async (...execArgs) => {
              await model.collection.updateOne(managedTargetFilter(mongoose, authority.target), {
                $set: {
                  ...(kind === 'channel' ? { status: 'disabled' } : { state: 'revoked' }),
                  revision: randomUUID(),
                },
              });
              return exec(...execArgs);
            };
            return query;
          });
          expect((await registerChannelTarget(mongoose, authority, f.entry)).status).toBe('closed');
          expect(await f.anchor(authority)).not.toHaveProperty('pending');
        }),
    );

    it('keeps revoked-generation entries discoverable until positive physical absence', () =>
      scoped(async () => {
        const f = await fixture();
        await registerChannelTarget(mongoose, f.identity, f.entry);
        await f.publish();
        const model = mongoose.model('ChannelIdentity');
        const bulkWrite = model.bulkWrite.bind(model);
        jest.spyOn(model, 'bulkWrite').mockImplementationOnce(async (...args) => {
          await model.collection.updateOne(managedTargetFilter(mongoose, f.identity.target), {
            $set: { state: 'revoked', revision: randomUUID() },
          });
          return bulkWrite(...args);
        });
        expect(await settleChannelTarget(mongoose, f.identity, f.entry)).toBe(false);
        expect(await reconcileChannelTargets(mongoose, f.identity, true)).toBe(0);
        expect(await f.anchor(f.identity)).toMatchObject({ pendingCount: 1 });
        // A completed domain eraser removes the exact target; this registry never deletes its payload.
        await mongoose
          .model('ChannelRun')
          .collection.deleteOne(managedTargetFilter(mongoose, f.target));
        expect(await reconcileChannelTargets(mongoose, f.identity, true)).toBe(1);
        expect(await reconcileChannelTargets(mongoose, f.identity, true)).toBe(0);
        expect(await f.anchor(f.identity)).toMatchObject({ pendingCount: 0 });
      }));

    it('does not allow an updated link revision to adopt an old pending child', () =>
      scoped(async () => {
        const f = await fixture();
        await registerChannelTarget(mongoose, f.identity, f.entry);
        const next = { ...f.identity, revision: randomUUID() };
        await mongoose
          .model('ChannelIdentity')
          .collection.updateOne(managedTargetFilter(mongoose, f.identity.target), {
            $set: { revision: next.revision },
          });
        expect((await registerChannelTarget(mongoose, f.identity, f.entry)).status).toBe('closed');
        expect((await registerChannelTarget(mongoose, next, f.entry)).status).toBe('conflict');
        await f.publish();
        expect(await reconcileChannelTargets(mongoose, next)).toBe(0);
      }));

    it('refuses expired, unallocated, missing or oversized authorities without creating them', () =>
      scoped(async () => {
        const f = await fixture();
        const model = mongoose.model('ChannelIdentity');
        await model.collection.updateOne(managedTargetFilter(mongoose, f.identity.target), {
          $set: { expiresAtMs: Date.now() - 1 },
        });
        expect((await registerChannelTarget(mongoose, f.identity, f.entry)).status).toBe('closed');
        const empty = {
          ...f.channel,
          target: await allocateManagedTarget(mongoose, 'channel', tenantId),
        };
        expect((await registerChannelTarget(mongoose, empty, f.entry)).status).toBe('closed');
        await discardManagedAllocation(mongoose, empty.target);
        expect((await registerChannelTarget(mongoose, empty, f.entry)).status).toBe('closed');
        await expect(
          registerChannelTarget(mongoose, { ...f.channel, revision: 'x'.repeat(512) }, f.entry),
        ).rejects.toThrow('Invalid managed registration');
      }));

    it('settles owner/conversation registration only with immutable lineage and clamped retention', () =>
      scoped(async () => {
        const f = await fixture();
        for (const user of [f.creator, f.owner])
          expect((await registerResponseTarget(mongoose, user, undefined, f.entry)).status).toBe(
            'registered',
          );
        const deadline = new Date(Date.now() + 300000);
        await createResponseRetention(mongoose)(f.owner, f.conversationId, deadline);
        expect(
          (await registerResponseTarget(mongoose, f.owner, f.conversationId, f.entry)).status,
        ).toBe('registered');
        await f.publish();
        expect(await settleResponseTarget(mongoose, f.owner, f.conversationId, f.entry)).toBe(
          false,
        );
        await mongoose
          .model('ChannelRun')
          .collection.updateOne(managedTargetFilter(mongoose, f.target), {
            $set: { '_managed.expiredAt': deadline },
          });
        expect(await settleResponseTarget(mongoose, f.owner, f.conversationId, f.entry)).toBe(true);
        for (const user of [f.creator, f.owner]) {
          expect(await settleResponseTarget(mongoose, user, undefined, f.entry)).toBe(true);
          expect(
            await createResponseScopeModel(mongoose)
              .findById(responseScopeKeys(user, '')[0])
              .lean(),
          ).toMatchObject({ pendingCount: 0 });
        }
      }));

    it('derives a bounded sorted set of structural authorities and rejects cross-owner lineage', () =>
      scoped(async () => {
        const f = await fixture();
        expect(f.keys).toHaveLength(7);
        expect(f.keys).toEqual([...new Set(f.keys)].sort());
        expect(channelScopeKeys(mongoose, { creator: f.creator, channel: f.channel })).toHaveLength(
          3,
        );
        expect(() =>
          channelScopeKeys(mongoose, {
            creator: f.creator,
            owner: f.owner,
            channel: f.channel,
            identity: { ...f.identity, userId: 'wrong-owner' },
          }),
        ).toThrow('Invalid channel ownership');
        await expect(
          registerChannelTarget(mongoose, f.channel, {
            ...f.entry,
            target: { ...f.target, tenantId: 'other-tenant' },
          }),
        ).rejects.toThrow('tenant');
      }));

    it('keeps persisted underscore partitions separate from strict authenticated tenant scope', async () => {
      const previous = process.env.TENANT_ISOLATION_STRICT;
      process.env.TENANT_ISOLATION_STRICT = 'true';
      _resetStrictCache();
      try {
        await scoped(async () => {
          if (!tenantId) {
            await expect(fixture()).rejects.toThrow();
            return;
          }
          const f = await fixture();
          expect((await registerChannelTarget(mongoose, f.identity, f.entry)).status).toBe(
            'registered',
          );
          await f.publish();
          expect(await settleChannelTarget(mongoose, f.identity, f.entry)).toBe(true);
        });
      } finally {
        if (previous === undefined) delete process.env.TENANT_ISOLATION_STRICT;
        else process.env.TENANT_ISOLATION_STRICT = previous;
        _resetStrictCache();
      }
    });

    it('composes every cleanup authority and installs all lineage in one private publication', () =>
      scoped(async () => {
        const f = await fixture();
        const roles = {
          creator: f.creator,
          owner: f.owner,
          channel: f.channel,
          identity: f.identity,
          conversationId: f.conversationId,
        };
        const result = await registerChannelOwnership(mongoose, f.target, roles);
        expect(result.status).toBe('registered');
        const responseKeys = [
          responseScopeKeys(f.creator, '')[0],
          ...responseScopeKeys(f.owner, f.conversationId),
        ];
        const scopes = createResponseScopeModel(mongoose);
        expect(await scopes.countDocuments({ _id: { $in: responseKeys }, pendingCount: 1 })).toBe(
          3,
        );
        expect(await f.anchor()).toMatchObject({ pendingCount: 1 });
        expect(await f.anchor(f.identity)).toMatchObject({ pendingCount: 1 });
        await settleChannelOwnership(mongoose, f.target, roles);
        expect(await scopes.countDocuments({ _id: { $in: responseKeys }, pendingCount: 1 })).toBe(
          3,
        );
        await mongoose.model('ChannelRun').updateOne(managedTargetFilter(mongoose, f.target), {
          $set: {
            ...channelOwnershipFields(mongoose, f.target, roles),
            '_managed.phase': 'published',
          },
        });
        await settleChannelOwnership(mongoose, f.target, roles);
        expect(await scopes.countDocuments({ _id: { $in: responseKeys }, pendingCount: 0 })).toBe(
          3,
        );
        expect(await f.anchor()).toMatchObject({ pendingCount: 0 });
        expect(await f.anchor(f.identity)).toMatchObject({ pendingCount: 0 });
      }));

    it('cleans partial admission without acquiring another owner or requiring its scope to reopen', () =>
      scoped(async () => {
        const f = await fixture();
        const roles = {
          creator: f.creator,
          owner: f.owner,
          channel: f.channel,
          identity: f.identity,
          conversationId: f.conversationId,
        };
        // Revocation can win after some earlier authority has already admitted this root.
        await registerResponseTarget(mongoose, f.creator, undefined, f.entry);
        await mongoose
          .model('ChannelIdentity')
          .collection.updateOne(managedTargetFilter(mongoose, f.identity.target), {
            $set: { state: 'revoked', revision: randomUUID() },
          });
        expect((await registerChannelOwnership(mongoose, f.target, roles)).status).toBe('closed');
        expect(await f.anchor(f.identity)).not.toHaveProperty('pending');
        expect(await discardManagedAllocation(mongoose, f.target)).toBe(true);
        await reconcileAbsentChannelOwnership(mongoose, f.target, roles);
        expect(
          await createResponseScopeModel(mongoose).countDocuments({
            _id: {
              $in: [
                responseScopeKeys(f.creator, '')[0],
                ...responseScopeKeys(f.owner, f.conversationId),
              ],
            },
            pendingCount: { $gt: 0 },
          }),
        ).toBe(0);
        const anchor = await f.anchor();
        expect(anchor!.pendingCount ?? 0).toBe(0);
      }));

    it('settles partial admission after every authority closes only with positive absence proof', () =>
      scoped(async () => {
        const f = await fixture();
        const roles = {
          creator: f.creator,
          owner: f.owner,
          channel: f.channel,
          identity: f.identity,
          conversationId: f.conversationId,
        };
        await registerChannelOwnership(mongoose, f.target, roles);
        const scopes = createResponseScopeModel(mongoose);
        const keys = [
          responseScopeKeys(f.creator, '')[0],
          ...responseScopeKeys(f.owner, f.conversationId),
        ];
        await scopes.updateMany(
          { _id: { $in: keys } },
          { $set: { closed: true }, $inc: { revision: 1 } },
        );
        await mongoose
          .model('AgentChannel')
          .collection.updateOne(managedTargetFilter(mongoose, f.channel.target), {
            $set: { status: 'disabled', revision: randomUUID() },
          });
        await mongoose
          .model('ChannelIdentity')
          .collection.updateOne(managedTargetFilter(mongoose, f.identity.target), {
            $set: { state: 'revoked', revision: randomUUID() },
          });
        await reconcileAbsentChannelOwnership(mongoose, f.target, roles);
        expect(
          await scopes.countDocuments({ _id: { $in: keys }, closed: true, pendingCount: 1 }),
        ).toBe(3);
        expect(await f.anchor()).toMatchObject({ pendingCount: 1 });
        expect(await f.anchor(f.identity)).toMatchObject({ pendingCount: 1 });
        await discardManagedAllocation(mongoose, f.target);
        await reconcileAbsentChannelOwnership(mongoose, f.target, roles);
        await reconcileAbsentChannelOwnership(mongoose, f.target, roles);
        expect(
          await scopes.countDocuments({ _id: { $in: keys }, closed: true, pendingCount: 0 }),
        ).toBe(3);
        expect(await f.anchor()).toMatchObject({ pendingCount: 0 });
        expect(await f.anchor(f.identity)).toMatchObject({ pendingCount: 0 });
      }));

    it('allows explicit strict-mode cleanup without granting system-context publication', () =>
      scoped(async () => {
        const f = await fixture();
        const roles = {
          creator: f.creator,
          owner: f.owner,
          channel: f.channel,
          identity: f.identity,
          conversationId: f.conversationId,
        };
        await registerChannelOwnership(mongoose, f.target, roles);
        const scopes = createResponseScopeModel(mongoose);
        const keys = [
          responseScopeKeys(f.creator, '')[0],
          ...responseScopeKeys(f.owner, f.conversationId),
        ];
        await scopes.updateMany(
          { _id: { $in: keys } },
          { $set: { closed: true }, $inc: { revision: 1 } },
        );
        const previous = process.env.TENANT_ISOLATION_STRICT;
        process.env.TENANT_ISOLATION_STRICT = 'true';
        _resetStrictCache();
        try {
          await tenantStorage.run({ tenantId: tenantId || SYSTEM_TENANT_ID }, async () => {
            if (!tenantId)
              await expect(registerChannelOwnership(mongoose, f.target, roles)).rejects.toThrow(
                'scope',
              );
            await reconcileAbsentChannelOwnership(mongoose, f.target, roles);
            expect(await scopes.countDocuments({ _id: { $in: keys }, pendingCount: 1 })).toBe(3);
            await discardManagedAllocation(mongoose, f.target);
            await reconcileAbsentChannelOwnership(mongoose, f.target, roles);
            expect(
              await scopes.countDocuments({ _id: { $in: keys }, closed: true, pendingCount: 0 }),
            ).toBe(3);
          });
        } finally {
          if (previous === undefined) delete process.env.TENANT_ISOLATION_STRICT;
          else process.env.TENANT_ISOLATION_STRICT = previous;
          _resetStrictCache();
        }
      }));

    it('retires canonical authority and redacts credentials without a transaction', () =>
      scoped(async () => {
        const f = await fixture();
        const sessions = jest.spyOn(mongoose, 'startSession');
        const result = await retireAgentChannel(
          mongoose,
          { channelId: f.channel.channelId, createdBy: f.creator.userId, tenantId },
          true,
        );
        expect(result).toMatchObject({ status: 'deleting' });
        expect(result).not.toHaveProperty('encryptedBotToken');
        expect(result).not.toHaveProperty('encryptedSigningSecret');
        for (const field of ['pending', 'pendingCount', '_managed'])
          expect(result).not.toHaveProperty(field);
        expect(
          await mongoose.model('ChannelIdentity').countDocuments({ linkId: f.identity.linkId }),
        ).toBe(0);
        expect((await registerChannelTarget(mongoose, f.channel, f.entry)).status).toBe('closed');
        expect(sessions).not.toHaveBeenCalled();
      }));

    it('retires a registered empty child before removing channel and link cleanup owners', () =>
      scoped(async () => {
        const f = await fixture();
        await registerChannelTarget(mongoose, f.channel, f.entry);
        await registerChannelTarget(mongoose, f.identity, f.entry);
        const methods = createAgentChannelMethods(mongoose);
        expect(await methods.deleteAgentChannel(f.channel.channelId, f.creator.userId)).toEqual({
          status: 'deleted',
        });
        expect(
          await mongoose
            .model('ChannelRun')
            .collection.findOne(managedTargetFilter(mongoose, f.target)),
        ).toBeNull();
        expect(await f.anchor()).toBeNull();
        expect(await f.anchor(f.identity)).toBeNull();
        expect(
          (
            await mongoose.model('ChannelRun').updateOne(
              managedTargetFilter(mongoose, f.target),
              {
                $set: { '_managed.phase': 'published' },
              },
              { upsert: false },
            )
          ).matchedCount,
        ).toBe(0);
      }));

    it('does not retarget retirement when the selected physical channel disappears', () =>
      scoped(async () => {
        const f = await fixture();
        const model = mongoose.model('AgentChannel');
        const write = model.findOneAndUpdate.bind(model);
        const replacement = new mongoose.Types.ObjectId();
        jest.spyOn(model, 'findOneAndUpdate').mockImplementationOnce((...args) => {
          const query = write(...args);
          const exec = query.exec.bind(query);
          query.exec = async (...execArgs) => {
            await model.collection.deleteOne(managedTargetFilter(mongoose, f.channel.target));
            await model.collection.insertOne({
              _id: replacement,
              channelId: f.channel.channelId,
              agentId: f.channel.agentId,
              createdBy: f.creator.userId,
              ...(tenantId && { tenantId }),
              revision: randomUUID(),
              type: 'slack',
              status: 'active',
              credentialMode: 'shared',
              slack: { teamId: f.channel.teamId, appId: f.channel.appId },
              encryptedBotToken: 'synthetic-replacement-token',
              _managed: { phase: 'published', incarnation: randomUUID() },
            });
            return exec(...execArgs);
          };
          return query;
        });
        expect(
          await createAgentChannelMethods(mongoose).deleteAgentChannel(
            f.channel.channelId,
            f.creator.userId,
          ),
        ).toEqual({ status: 'not_found' });
        expect(await model.collection.findOne({ _id: replacement })).toMatchObject({
          status: 'active',
          encryptedBotToken: 'synthetic-replacement-token',
        });
      }));

    it('retires strict-mode channels from explicit system cleanup without crossing partitions', () =>
      scoped(async () => {
        const f = await fixture();
        const previous = process.env.TENANT_ISOLATION_STRICT;
        process.env.TENANT_ISOLATION_STRICT = 'true';
        _resetStrictCache();
        try {
          await tenantStorage.run({ tenantId: SYSTEM_TENANT_ID }, async () => {
            expect(
              await retireAgentChannel(
                mongoose,
                { channelId: f.channel.channelId, createdBy: f.creator.userId, tenantId },
                true,
              ),
            ).toMatchObject({ status: 'deleting' });
          });
        } finally {
          if (previous === undefined) delete process.env.TENANT_ISOLATION_STRICT;
          else process.env.TENANT_ISOLATION_STRICT = previous;
          _resetStrictCache();
        }
      }));

    it('refuses invalid explicit physical selectors without falling back to a logical channel', () =>
      scoped(async () => {
        const f = await fixture();
        for (const id of ['', 'not-an-object-id'])
          await expect(
            retireAgentChannel(
              mongoose,
              { channelId: f.channel.channelId, createdBy: f.creator.userId, tenantId, id },
              true,
            ),
          ).rejects.toThrow('Invalid channel retirement identity');
        expect(await f.anchor()).toMatchObject({
          status: 'active',
          encryptedBotToken: 'synthetic-private-token',
        });
      }));

    it('retains closed-owner discovery until domain erasure proves exact physical absence', () =>
      scoped(async () => {
        const f = await fixture();
        const roles = {
          creator: f.creator,
          owner: f.owner,
          channel: f.channel,
          identity: f.identity,
          conversationId: f.conversationId,
        };
        await registerChannelOwnership(mongoose, f.target, roles);
        const scopes = createResponseScopeModel(mongoose);
        const key = responseScopeKeys(f.owner, '')[0];
        await scopes.updateOne({ _id: key }, { $set: { closed: true }, $inc: { revision: 1 } });
        await settleChannelOwnership(mongoose, f.target, roles);
        // Hidden ownerless metadata still physically exists, so it remains a cleanup obligation.
        expect(await reconcileErasedResponseTargets(mongoose, f.owner, [])).toBe(0);
        expect(await scopes.findById(key).lean()).toMatchObject({ pendingCount: 1 });
        await discardManagedAllocation(mongoose, f.target);
        expect(await reconcileErasedResponseTargets(mongoose, f.owner, [])).toBe(1);
        expect(await reconcileErasedResponseTargets(mongoose, f.owner, [])).toBe(0);
        expect(await scopes.findById(key).lean()).toMatchObject({ pendingCount: 0 });
        // A delayed private CAS cannot recreate the erased physical root.
        expect(
          (
            await mongoose.model('ChannelRun').updateOne(
              managedTargetFilter(mongoose, f.target),
              {
                $set: {
                  ...channelOwnershipFields(mongoose, f.target, roles),
                  '_managed.phase': 'published',
                },
              },
              { upsert: false },
            )
          ).matchedCount,
        ).toBe(0);
      }));
  });
});
