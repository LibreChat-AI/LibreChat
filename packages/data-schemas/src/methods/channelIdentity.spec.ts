import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { ChannelIdentityRecord } from './channelIdentity';
import { tenantStorage, runAsSystem } from '~/config/tenantContext';
import { createChannelIdentityStorage } from './channelIdentity';
import { createModels } from '~/models';

let mongo: MongoMemoryReplSet;
let storage: ReturnType<typeof createChannelIdentityStorage>;
const tenantId = 'channel-identity-test';
const scope = <T>(fn: () => Promise<T>) => tenantStorage.run({ tenantId }, fn);
const identity = (): ChannelIdentityRecord => ({
  tenantId,
  linkId: 'link',
  revision: 'one',
  state: 'pending',
  ticketHash: 'private-hash',
  ticketExpiresAtMs: 1000,
  expiresAtMs: 2000,
  identity: {
    tenantId,
    channelId: 'channel',
    channelRevision: 'channel-one',
    teamId: 'team',
    externalUserId: 'external-user',
    agentId: 'agent',
  },
});

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri(), { autoIndex: false });
  createModels(mongoose);
  storage = createChannelIdentityStorage(mongoose);
});
beforeEach(async () =>
  runAsSystem(async () => {
    await mongoose.models.ChannelIdentity.deleteMany({});
  }),
);
afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});

it('builds unique identity and ticket indexes before concurrent creation', () =>
  scope(async () => {
    const attempts = await Promise.all(
      Array.from({ length: 8 }, () => storage.saveChannelIdentity(identity(), null)),
    );
    expect(attempts.filter(Boolean)).toHaveLength(1);
    expect(await mongoose.models.ChannelIdentity.countDocuments({})).toBe(1);
    expect(await storage.readChannelTicket(tenantId, 'private-hash')).toMatchObject({
      linkId: 'link',
    });
  }));

it('lets only one concurrent revision transition win and preserves the selected account', () =>
  scope(async () => {
    await storage.saveChannelIdentity(identity(), null);
    const candidates = ['owner-a', 'owner-b'].map((userId) => ({
      ...identity(),
      userId,
      accountLabel: userId,
      state: 'accepted' as const,
      revision: `accepted-${userId}`,
    }));
    const attempts = await Promise.all(
      candidates.map((record) => storage.saveChannelIdentity(record, 'one')),
    );
    expect(attempts.filter(Boolean)).toHaveLength(1);
    const winner = candidates[attempts.findIndex(Boolean)];
    expect(await storage.readChannelLink(tenantId, 'link')).toMatchObject({
      userId: winner.userId,
      revision: winner.revision,
      state: 'accepted',
    });
    expect(await storage.saveChannelIdentity({ ...identity(), revision: 'stale' }, 'one')).toBe(
      false,
    );
  }));

it('removes prior account metadata when a replacement ticket is issued', () =>
  scope(async () => {
    await storage.saveChannelIdentity(
      { ...identity(), state: 'active', userId: 'owner', accountLabel: 'Private account' },
      null,
    );
    expect(
      await storage.saveChannelIdentity(
        { ...identity(), revision: 'two', ticketHash: 'new-hash' },
        'one',
      ),
    ).toBe(true);
    const next = await storage.readChannelLink(tenantId, 'link');
    expect(next).not.toHaveProperty('userId');
    expect(next).not.toHaveProperty('accountLabel');
    expect(await storage.readChannelTicket(tenantId, 'private-hash')).toBeNull();
    expect(await storage.readChannelTicket(tenantId, 'new-hash')).toMatchObject({
      state: 'pending',
    });
  }));

it('revokes only the selected channel and leaves other owners and tenants intact', () =>
  scope(async () => {
    await storage.saveChannelIdentity({ ...identity(), state: 'active', userId: 'owner' }, null);
    await storage.saveChannelIdentity(
      {
        ...identity(),
        linkId: 'other-link',
        ticketHash: 'other-hash',
        userId: 'other-owner',
        identity: { ...identity().identity, channelId: 'other-channel' },
      },
      null,
    );
    await storage.revokeChannelIdentities(tenantId, 'channel', 'revoked-revision');
    expect(await storage.readChannelLink(tenantId, 'link')).toMatchObject({
      state: 'revoked',
      revision: 'revoked-revision',
    });
    expect(await storage.readChannelLink(tenantId, 'other-link')).toMatchObject({
      state: 'pending',
    });
    expect(await storage.listChannelLinks(tenantId, 'owner')).toHaveLength(1);
    expect((await storage.listChannelLinks(tenantId, 'owner'))[0]).not.toHaveProperty('ticketHash');
  }));

it('rejects a mismatched request tenant rather than letting middleware replace the explicit partition', async () => {
  await runAsSystem(async () => {
    await storage.saveChannelIdentity(identity(), null);
    await storage.saveChannelIdentity(
      {
        ...identity(),
        tenantId: 'another-tenant',
        identity: { ...identity().identity, tenantId: 'another-tenant' },
      },
      null,
    );
  });
  await scope(async () => {
    await expect(storage.readChannelTicket('another-tenant', 'private-hash')).rejects.toThrow(
      'tenant',
    );
    await expect(storage.readChannelLink('another-tenant', 'link')).rejects.toThrow('tenant');
    await expect(
      storage.revokeChannelIdentities('another-tenant', 'channel', 'wrong'),
    ).rejects.toThrow('tenant');
    await expect(
      storage.saveChannelIdentity(
        { ...identity(), identity: { ...identity().identity, tenantId: 'another-tenant' } },
        'one',
      ),
    ).rejects.toThrow('tenant');
    expect(await storage.readChannelLink(tenantId, 'link')).toMatchObject({ revision: 'one' });
  });
});

it('propagates database failures separately from absent records', () =>
  scope(async () => {
    expect(await storage.readChannelLink(tenantId, 'missing')).toBeNull();
    jest
      .spyOn(mongoose.models.ChannelIdentity.collection, 'findOne')
      .mockRejectedValueOnce(new Error('database unavailable'));
    await expect(storage.readChannelLink(tenantId, 'missing')).rejects.toThrow(
      'database unavailable',
    );
  }));
