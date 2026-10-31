import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { ChannelIdentityRecord } from './channelIdentity';
import { closeChannelScope, retireAgentChannel } from './channelScope';
import { tenantStorage, runAsSystem } from '~/config/tenantContext';
import { createChannelIdentityStorage } from './channelIdentity';
import { createChannelRunStorage } from './channelRun';
import { createAgentChannelMethods } from './channel';
import { createUserMethods } from './user';
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
    await mongoose.models.AgentChannel.deleteMany({});
    await mongoose.models.ChannelScope.deleteMany({});
    for (const [partition, channelId] of [
      [tenantId, 'channel'],
      [tenantId, 'other-channel'],
      ['another-tenant', 'tenant-channel'],
    ]) {
      await tenantStorage.run({ tenantId: partition }, async () =>
        createAgentChannelMethods(mongoose).createAgentChannel({
          tenantId: partition,
          channelId,
          agentId: 'agent',
          createdBy: 'connection-owner',
          type: 'slack',
          status: 'active',
          credentialMode: 'per_user',
          revision: 'channel-one',
          slack: { teamId: 'team', appId: 'app', botUserId: 'bot' },
        }),
      );
    }
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
        identity: {
          ...identity().identity,
          tenantId: 'another-tenant',
          channelId: 'tenant-channel',
        },
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

it('fences an in-flight personal-link acceptance before erasing its account', () =>
  scope(async () => {
    const user = await mongoose.models.User.create({
      email: 'personal-link-owner@example.com',
      provider: 'local',
      tenantId,
    });
    const userId = String(user._id);
    await storage.saveChannelIdentity(identity(), null);
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const collection = mongoose.models.ChannelIdentity.collection;
    const update = collection.updateOne.bind(collection);
    const paused = jest.spyOn(collection, 'updateOne').mockImplementation(async (...args) => {
      entered();
      await gate;
      return update(...args);
    });
    const accepted = {
      ...identity(),
      state: 'accepted' as const,
      revision: 'accepted',
      userId,
      accountLabel: 'Private account',
    };
    const acceptance = storage.saveChannelIdentity(accepted, 'one');
    await started;
    let deleted = false;
    const deletion = createUserMethods(mongoose)
      .deleteUserById(userId)
      .then((value) => {
        deleted = true;
        return value;
      });
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(deleted).toBe(false);
    } finally {
      release();
      paused.mockRestore();
    }
    expect(await acceptance).toBe(true);
    await deletion;
    expect(await storage.readChannelLink(tenantId, 'link')).toBeNull();
    expect(await storage.saveChannelIdentity(accepted, null)).toBe(false);
  }));

it('rejects new tickets and delayed acceptance after irreversible channel closure', () =>
  scope(async () => {
    await storage.saveChannelIdentity(identity(), null);
    await closeChannelScope(mongoose, tenantId, 'channel');
    expect(
      await storage.saveChannelIdentity(
        { ...identity(), state: 'accepted', userId: 'owner', revision: 'two' },
        'one',
      ),
    ).toBe(false);
    expect(
      await storage.saveChannelIdentity({ ...identity(), linkId: 'new', ticketHash: 'new' }, null),
    ).toBe(false);
    expect(await storage.readChannelLink(tenantId, 'link')).toMatchObject({
      state: 'pending',
      revision: 'one',
    });
    await storage.revokeChannelIdentities(tenantId, 'channel', 'revoked');
    expect(await storage.readChannelLink(tenantId, 'link')).toMatchObject({ state: 'revoked' });
  }));

it('serializes live identity insertion with channel closure', () =>
  scope(async () => {
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const collection = mongoose.models.ChannelIdentity.collection;
    const insert = collection.insertOne.bind(collection);
    const paused = jest.spyOn(collection, 'insertOne').mockImplementation(async (...args) => {
      entered();
      await gate;
      return insert(...args);
    });
    const pending = storage.saveChannelIdentity(identity(), null);
    await started;
    let closed = false;
    const closure = closeChannelScope(mongoose, tenantId, 'channel').then(() => {
      closed = true;
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(closed).toBe(false);
    } finally {
      release();
      paused.mockRestore();
    }
    expect(await pending).toBe(true);
    await closure;
    expect(await storage.saveChannelIdentity({ ...identity(), revision: 'late' }, 'one')).toBe(
      false,
    );
  }));

const identityStates = ['pending', 'accepted', 'active', 'revoked'] as const;
function inState(state: ChannelIdentityRecord['state'], suffix: string): ChannelIdentityRecord {
  const base = identity();
  return {
    ...base,
    state,
    linkId: `link-${suffix}`,
    ticketHash: `hash-${suffix}`,
    revision: `revision-${suffix}`,
    ...(['accepted', 'active'].includes(state) ? { userId: 'owner' } : {}),
    identity: { ...base.identity, externalUserId: `external-${suffix}` },
  };
}

it.each(identityStates)('fences new %s records after complete channel retirement', (state) =>
  scope(async () => {
    await storage.saveChannelIdentity(identity(), null);
    await retireAgentChannel(mongoose, {
      tenantId,
      channelId: 'channel',
      createdBy: 'connection-owner',
    });
    expect(await storage.saveChannelIdentity(inState(state, state), null)).toBe(false);
    expect(
      await mongoose.models.ChannelIdentity.countDocuments({
        tenantId,
        'identity.channelId': 'channel',
      }),
    ).toBe(0);
  }),
);

it.each(identityStates)('fences full %s replacements after admission closes', (state) =>
  scope(async () => {
    await storage.saveChannelIdentity(identity(), null);
    await closeChannelScope(mongoose, tenantId, 'channel');
    expect(
      await storage.saveChannelIdentity(
        {
          ...identity(),
          state,
          revision: `closed-${state}`,
          ticketHash: `replacement-${state}`,
          ...(['accepted', 'active'].includes(state) ? { userId: 'owner' } : {}),
        },
        'one',
      ),
    ).toBe(false);
    expect(await storage.readChannelLink(tenantId, 'link')).toMatchObject({
      state: 'pending',
      revision: 'one',
      ticketHash: 'private-hash',
    });
  }),
);

it.each(['owner-a', 'owner-b'])(
  'clears an omitted label when replacing account metadata for %s',
  (userId) =>
    scope(async () => {
      await storage.saveChannelIdentity(
        { ...identity(), state: 'active', userId: 'owner-a', accountLabel: 'Private Alice' },
        null,
      );
      expect(
        await storage.saveChannelIdentity(
          { ...identity(), state: 'active', userId, revision: 'next' },
          'one',
        ),
      ).toBe(true);
      const stored = await storage.readChannelLink(tenantId, 'link');
      expect(stored).toMatchObject({ userId, revision: 'next' });
      expect(stored).not.toHaveProperty('accountLabel');
    }),
);

it('preserves an explicitly supplied empty label and clears account metadata on full revocation', () =>
  scope(async () => {
    await storage.saveChannelIdentity(
      { ...identity(), state: 'active', userId: 'owner', accountLabel: 'Private Alice' },
      null,
    );
    expect(
      await storage.saveChannelIdentity(
        {
          ...identity(),
          state: 'active',
          userId: 'owner',
          accountLabel: '',
          revision: 'empty-label',
        },
        'one',
      ),
    ).toBe(true);
    expect((await storage.readChannelLink(tenantId, 'link'))?.accountLabel).toBe('');
    expect(
      await storage.saveChannelIdentity(
        { ...identity(), state: 'revoked', revision: 'revoked' },
        'empty-label',
      ),
    ).toBe(true);
    const revoked = await storage.readChannelLink(tenantId, 'link');
    expect(revoked).not.toHaveProperty('userId');
    expect(revoked).not.toHaveProperty('accountLabel');
  }));

it.each(['channelId', 'teamId', 'externalUserId', 'agentId'] as const)(
  'keeps the external identity anchor %s immutable during CAS replacement',
  (field) =>
    scope(async () => {
      await storage.saveChannelIdentity(identity(), null);
      const replacement = identity();
      replacement.identity = { ...replacement.identity, [field]: `different-${field}` };
      replacement.revision = 'moved';
      expect(await storage.saveChannelIdentity(replacement, 'one')).toBe(false);
      expect(await storage.readChannelLink(tenantId, 'link')).toMatchObject({
        identity: identity().identity,
        revision: 'one',
      });
    }),
);

it('cannot move a revoked full record out of a closed channel to escape retirement', () =>
  scope(async () => {
    await storage.saveChannelIdentity(identity(), null);
    await closeChannelScope(mongoose, tenantId, 'channel');
    const replacement = {
      ...identity(),
      state: 'revoked' as const,
      revision: 'moved',
      identity: { ...identity().identity, channelId: 'other-channel' },
    };
    expect(await storage.saveChannelIdentity(replacement, 'one')).toBe(false);
    await retireAgentChannel(mongoose, {
      tenantId,
      channelId: 'channel',
      createdBy: 'connection-owner',
    });
    expect(await mongoose.models.ChannelIdentity.countDocuments({ tenantId })).toBe(0);
  }));

it('serializes revoked insertion with retirement and erases its private payload before returning', () =>
  scope(async () => {
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const collection = mongoose.models.ChannelIdentity.collection;
    const insert = collection.insertOne.bind(collection);
    const paused = jest.spyOn(collection, 'insertOne').mockImplementation(async (...args) => {
      entered();
      await gate;
      return insert(...args);
    });
    const insertion = storage.saveChannelIdentity(inState('revoked', 'revoked-race'), null);
    await started;
    let retired = false;
    const retirement = retireAgentChannel(mongoose, {
      tenantId,
      channelId: 'channel',
      createdBy: 'connection-owner',
    }).then(() => {
      retired = true;
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(retired).toBe(false);
    } finally {
      release();
      paused.mockRestore();
    }
    expect(await insertion).toBe(true);
    await retirement;
    expect(await mongoose.models.ChannelIdentity.countDocuments({ tenantId })).toBe(0);
  }));

it('creates and activates a per-user link at an empty canonical channel revision and admits its run', () =>
  scope(async () => {
    await createAgentChannelMethods(mongoose).updateAgentChannel('channel', 'connection-owner', {
      revision: '',
    });
    const pending = { ...identity(), identity: { ...identity().identity, channelRevision: '' } };
    expect(await storage.saveChannelIdentity(pending, null)).toBe(true);
    const active = {
      ...pending,
      state: 'active' as const,
      userId: 'linked-owner',
      revision: 'active',
    };
    expect(await storage.saveChannelIdentity(active, 'one')).toBe(true);
    expect((await storage.readChannelLink(tenantId, 'link'))?.identity.channelRevision).toBe('');
    const input = {
      tenantId,
      channelId: 'channel',
      agentId: 'agent',
      principal: {
        userId: 'linked-owner',
        channelRevision: '',
        linkId: 'link',
        linkRevision: 'active',
      },
      admission: {
        eventId: 'empty-revision',
        externalChannelId: 'C1',
        externalThreadKey: '123.456',
        externalMessageKey: '123.457',
        actor: { teamId: 'team', appId: 'app', externalUserId: 'external-user' },
        input: 'hello',
      },
    };
    const runs = createChannelRunStorage(mongoose);
    await expect(runs.admit(input, 100)).resolves.toMatchObject({
      run: { principal: { channelRevision: '' } },
    });
    await createAgentChannelMethods(mongoose).updateAgentChannel('channel', 'connection-owner', {
      revision: 'rotated',
    });
    await expect(
      runs.admit({ ...input, admission: { ...input.admission, eventId: 'stale-empty' } }, 101),
    ).rejects.toMatchObject({ code: 'invalid_transition' });
  }));

it.each([undefined, null])(
  'still requires a channel revision when its value is %s',
  (channelRevision) =>
    scope(async () => {
      const model = new mongoose.models.ChannelIdentity({
        ...identity(),
        identity: { ...identity().identity, channelRevision },
      });
      await expect(model.validate()).rejects.toThrow('channelRevision');
    }),
);

it.each(['channelId', 'ticketHash'] as const)(
  'does not relax required nonempty %s validation',
  (field) =>
    scope(async () => {
      const record = { ...identity(), identity: { ...identity().identity, channelRevision: '' } };
      const model = new mongoose.models.ChannelIdentity(
        field === 'ticketHash'
          ? { ...record, ticketHash: '' }
          : { ...record, identity: { ...record.identity, channelId: '' } },
      );
      await expect(model.validate()).rejects.toThrow(field);
    }),
);

it('uses the same full-record schema validation on insertion and replacement', () =>
  scope(async () => {
    await expect(
      storage.saveChannelIdentity({ ...identity(), ticketHash: '' }, null),
    ).rejects.toThrow('ticketHash');
    expect(await storage.saveChannelIdentity(identity(), null)).toBe(true);
    await expect(
      storage.saveChannelIdentity({ ...identity(), revision: 'bad', ticketHash: '' }, 'one'),
    ).rejects.toThrow('ticketHash');
    expect(await storage.readChannelLink(tenantId, 'link')).toMatchObject({
      revision: 'one',
      ticketHash: 'private-hash',
    });
  }));
