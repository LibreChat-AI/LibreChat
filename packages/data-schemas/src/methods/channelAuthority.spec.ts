import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { ChannelIdentityRecord } from '~/models/channelIdentity';
import { tenantStorage, runAsSystem } from '~/config/tenantContext';
import { createChannelIdentityStorage } from './channelIdentity';
import { createChannelRunStorage } from './channelRun';
import { closeResponseScopes } from './responseScope';
import { createAgentChannelMethods } from './channel';
import { createUserMethods } from './user';
import { createModels } from '~/models';

let mongo: MongoMemoryReplSet;
let creatorId: string;
const tenantId = 'channel-authority-test';
const scope = <T>(work: () => Promise<T>) => tenantStorage.run({ tenantId }, work);
const channels = () => createAgentChannelMethods(mongoose);
const identities = () => createChannelIdentityStorage(mongoose);
const runs = () => createChannelRunStorage(mongoose);
const event = () => ({
  tenantId,
  channelId: 'channel',
  agentId: 'agent',
  principal: { userId: 'actor', channelRevision: 'one' },
  admission: {
    eventId: 'event',
    externalChannelId: 'C1',
    externalThreadKey: 'C1:1',
    externalMessageKey: 'C1:2',
    actor: { teamId: 'T1', appId: 'A1', externalUserId: 'U1' },
    input: 'hello',
  },
});
const link = (): ChannelIdentityRecord => ({
  tenantId,
  linkId: 'link',
  revision: 'link-one',
  state: 'active',
  userId: 'actor',
  ticketHash: 'ticket',
  ticketExpiresAtMs: Date.now() + 60_000,
  expiresAtMs: Date.now() + 120_000,
  identity: {
    tenantId,
    channelId: 'channel',
    channelRevision: 'one',
    teamId: 'T1',
    externalUserId: 'U1',
    agentId: 'agent',
  },
});
const linkedEvent = () => ({
  ...event(),
  principal: { ...event().principal, linkId: 'link', linkRevision: 'link-one' },
});
function gate() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri(), { autoIndex: false });
  createModels(mongoose);
});
beforeEach(async () => {
  await runAsSystem(async () => {
    for (const name of [
      'AgentChannel',
      'AgentChannelThread',
      'ChannelScope',
      'ChannelIdentity',
      'ChannelRun',
      'ChannelLane',
      'ResponseScope',
      'User',
    ])
      await mongoose.models[name].deleteMany({});
  });
  await scope(async () => {
    const creator = await mongoose.models.User.create({
      email: 'creator@example.com',
      provider: 'local',
      tenantId,
    });
    creatorId = String(creator._id);
    await channels().createAgentChannel({
      tenantId,
      channelId: 'channel',
      agentId: 'agent',
      createdBy: creatorId,
      type: 'slack',
      status: 'active',
      credentialMode: 'shared',
      revision: 'one',
      slack: { teamId: 'T1', appId: 'A1', botUserId: 'B1' },
      encryptedBotToken: 'private-token',
    });
  });
});
afterEach(() => jest.restoreAllMocks());
afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});

it('rejects delayed events, duplicate events and full identity writes at an obsolete channel revision', () =>
  scope(async () => {
    await runs().admit(event(), Date.now());
    expect(await identities().saveChannelIdentity(link(), null)).toBe(true);
    await channels().updateAgentChannel('channel', creatorId, { revision: 'two' });
    for (const eventId of ['event', 'delayed'])
      await expect(
        runs().admit({ ...event(), admission: { ...event().admission, eventId } }, Date.now()),
      ).rejects.toMatchObject({ code: 'invalid_transition' });
    expect(
      await identities().saveChannelIdentity({ ...link(), revision: 'stale' }, 'link-one'),
    ).toBe(false);
    const fresh = event();
    fresh.principal.channelRevision = 'two';
    fresh.admission.eventId = 'fresh';
    await expect(runs().admit(fresh, Date.now())).resolves.toMatchObject({ duplicate: false });
    expect(
      await identities().saveChannelIdentity(
        { ...link(), revision: 'fresh', identity: { ...link().identity, channelRevision: 'two' } },
        'link-one',
      ),
    ).toBe(true);
  }));

it.each(['disabled', 'missing', 'team', 'app', 'agent'] as const)(
  'rejects %s canonical channel authority',
  (kind) =>
    scope(async () => {
      const input = event();
      if (kind === 'disabled')
        await channels().updateAgentChannel('channel', creatorId, { status: 'disabled' });
      else if (kind === 'missing')
        await mongoose.models.AgentChannel.deleteOne({ channelId: 'channel' });
      else if (kind === 'team') input.admission.actor.teamId = 'wrong';
      else if (kind === 'app') input.admission.actor.appId = 'wrong';
      else input.agentId = 'wrong';
      await expect(runs().admit(input, Date.now())).rejects.toMatchObject({
        code: 'invalid_transition',
      });
      expect(await mongoose.models.ChannelRun.countDocuments({})).toBe(0);
    }),
);

it('blocks other principals as soon as channel-owner account admission closes', () =>
  scope(async () => {
    await closeResponseScopes(mongoose, { userId: creatorId, tenantId });
    expect((await channels().getAgentChannel('channel'))?.status).toBe('active');
    await expect(runs().admit(event(), Date.now())).rejects.toMatchObject({
      code: 'invalid_transition',
    });
    expect(await identities().saveChannelIdentity(link(), null)).toBe(false);
    await expect(channels().getOrCreateAgentChannelThread('channel', 'late')).rejects.toThrow(
      'authority unavailable',
    );
  }));

it.each(['direct', 'account'] as const)(
  'rolls back channel status and credential changes when %s closure fails',
  (mode) =>
    scope(async () => {
      const collection = mongoose.models.ChannelScope.collection;
      const original = collection.updateOne.bind(collection);
      const failure = jest
        .spyOn(collection, 'updateOne')
        .mockImplementation(async (filter, update, options) => {
          if (!Array.isArray(update) && update.$set?.closed === true && options?.session)
            throw new Error('closure unavailable');
          return original(filter, update, options);
        });
      try {
        await expect(
          mode === 'direct'
            ? channels().beginAgentChannelDeletion('channel', creatorId)
            : createUserMethods(mongoose).deleteUserById(creatorId),
        ).rejects.toThrow('closure unavailable');
      } finally {
        failure.mockRestore();
      }
      expect(await channels().getAgentChannel('channel')).toMatchObject({
        status: 'active',
        encryptedBotToken: 'private-token',
      });
      expect(await mongoose.models.ChannelScope.findOne({ closed: true }).lean()).toBeNull();
      if (mode === 'direct')
        await expect(runs().admit(event(), Date.now())).resolves.toMatchObject({
          duplicate: false,
        });
      else
        await expect(runs().admit(event(), Date.now())).rejects.toMatchObject({
          code: 'invalid_transition',
        });
      await expect(
        channels().beginAgentChannelDeletion('channel', creatorId),
      ).resolves.toMatchObject({ status: 'deleting' });
    }),
);

it('commits closure and credential redaction before retryable account identity erasure', () =>
  scope(async () => {
    await identities().saveChannelIdentity(link(), null);
    const collection = mongoose.models.ChannelIdentity.collection;
    const erase = collection.deleteMany.bind(collection);
    const failure = jest.spyOn(collection, 'deleteMany').mockImplementation(async (...args) => {
      if (args[0]?.['identity.channelId'] === 'channel')
        throw new Error('identity erasure unavailable');
      return erase(...args);
    });
    await expect(createUserMethods(mongoose).deleteUserById(creatorId)).rejects.toThrow(
      'identity erasure unavailable',
    );
    failure.mockRestore();
    expect(await channels().getAgentChannel('channel')).toMatchObject({ status: 'deleting' });
    expect(await channels().getAgentChannel('channel')).not.toHaveProperty('encryptedBotToken');
    await expect(runs().admit(event(), Date.now())).rejects.toMatchObject({
      code: 'invalid_transition',
    });
    expect(
      await identities().saveChannelIdentity({ ...link(), revision: 'late' }, 'link-one'),
    ).toBe(false);
    await expect(createUserMethods(mongoose).deleteUserById(creatorId)).resolves.toMatchObject({
      deletedCount: 1,
    });
  }));

it('serializes a revision update already in flight before admitting an older event', () =>
  scope(async () => {
    const entered = gate();
    const release = gate();
    const parents = mongoose.models.AgentChannel.collection;
    const update = parents.findOneAndUpdate.bind(parents);
    const pause = jest.spyOn(parents, 'findOneAndUpdate').mockImplementation(async (...args) => {
      if (!Array.isArray(args[1]) && args[1].$set?.revision === 'two') {
        entered.release();
        await release.wait;
      }
      return update(...args);
    });
    const updating = channels().updateAgentChannel('channel', creatorId, { revision: 'two' });
    await entered.wait;
    const admissionReached = gate();
    const fences = mongoose.models.ChannelScope.collection;
    const touch = fences.updateOne.bind(fences);
    const observe = jest.spyOn(fences, 'updateOne').mockImplementation(async (...args) => {
      if (!Array.isArray(args[1]) && args[1].$inc?.revision === 1) admissionReached.release();
      return touch(...args);
    });
    const admission = runs().admit(event(), Date.now());
    try {
      await admissionReached.wait;
      release.release();
      await expect(updating).resolves.toMatchObject({ revision: 'two' });
      await expect(admission).rejects.toMatchObject({ code: 'invalid_transition' });
    } finally {
      release.release();
      pause.mockRestore();
      observe.mockRestore();
    }
    expect(await mongoose.models.ChannelRun.countDocuments({})).toBe(0);
  }));

it.each(['revoked', 'expired', 'revision', 'user', 'external-user'] as const)(
  'rejects a %s linked principal, including event replay',
  (kind) =>
    scope(async () => {
      const record = link();
      expect(await identities().saveChannelIdentity(record, null)).toBe(true);
      await runs().admit(linkedEvent(), Date.now());
      if (kind === 'revoked')
        await identities().revokeChannelIdentities(tenantId, 'channel', 'revoked');
      else if (kind === 'expired')
        await identities().saveChannelIdentity({ ...record, expiresAtMs: 1 }, record.revision);
      else if (kind === 'revision')
        await identities().saveChannelIdentity(
          { ...record, revision: 'new-link' },
          record.revision,
        );
      const input = linkedEvent();
      if (kind === 'user') input.principal.userId = 'different';
      if (kind === 'external-user') input.admission.actor.externalUserId = 'different';
      await expect(runs().admit(input, Date.now())).rejects.toMatchObject({
        code: 'invalid_transition',
      });
      expect(await mongoose.models.ChannelRun.countDocuments({})).toBe(1);
    }),
);

it('requires persisted link authority for a per-user channel', () =>
  scope(async () => {
    await channels().updateAgentChannel('channel', creatorId, { credentialMode: 'per_user' });
    await expect(runs().admit(event(), Date.now())).rejects.toMatchObject({
      code: 'invalid_transition',
    });
    await identities().saveChannelIdentity(link(), null);
    await expect(runs().admit(linkedEvent(), Date.now())).resolves.toMatchObject({
      duplicate: false,
    });
  }));

it('uses the indexed tenant/account path for owner deletion', () =>
  scope(async () => {
    await mongoose.models.AgentChannel.insertMany(
      Array.from({ length: 200 }, (_, index) => ({
        channelId: `other-${index}`,
        tenantId,
        agentId: 'agent',
        createdBy: `other-${index}`,
        type: 'slack',
        status: 'disabled',
        credentialMode: 'shared',
        revision: 'one',
      })),
    );
    const plan = await mongoose.models.AgentChannel.collection
      .find({
        tenantId,
        createdBy: creatorId,
      })
      .explain('executionStats');
    expect(plan.executionStats.nReturned).toBe(1);
    expect(plan.executionStats.totalDocsExamined).toBe(1);
    expect(JSON.stringify(plan.queryPlanner.winningPlan)).toContain('tenantId_1_createdBy_1');
    await createUserMethods(mongoose).deleteUserById(creatorId);
    expect(await mongoose.models.AgentChannel.countDocuments({})).toBe(200);
  }));

it('inherits the authenticated tenant before creating its owner and channel fences', () =>
  scope(async () => {
    const created = await channels().createAgentChannel({
      channelId: 'context-channel',
      agentId: 'agent',
      createdBy: creatorId,
      type: 'slack',
      status: 'active',
      credentialMode: 'shared',
      revision: 'one',
    });
    expect(created.tenantId).toBe(tenantId);
    expect(
      await channels().updateAgentChannel('context-channel', creatorId, { revision: 'two' }),
    ).toMatchObject({ tenantId, revision: 'two' });
  }));

it('lets an already admitted transaction finish before rotating authority', () =>
  scope(async () => {
    const entered = gate();
    const release = gate();
    const attempted = gate();
    const collection = mongoose.models.ChannelRun.collection;
    const insert = collection.insertOne.bind(collection);
    const pause = jest.spyOn(collection, 'insertOne').mockImplementation(async (...args) => {
      entered.release();
      await release.wait;
      return insert(...args);
    });
    const admission = runs().admit(event(), Date.now());
    await entered.wait;
    const owners = mongoose.models.ResponseScope.collection;
    const touch = owners.updateOne.bind(owners);
    const observe = jest.spyOn(owners, 'updateOne').mockImplementation(async (...args) => {
      if (!Array.isArray(args[1]) && args[1].$inc?.revision === 1) attempted.release();
      return touch(...args);
    });
    const updating = channels().updateAgentChannel('channel', creatorId, { revision: 'two' });
    try {
      await attempted.wait;
      release.release();
      await expect(admission).resolves.toMatchObject({
        run: { principal: { channelRevision: 'one' } },
      });
      await expect(updating).resolves.toMatchObject({ revision: 'two' });
    } finally {
      release.release();
      pause.mockRestore();
      observe.mockRestore();
    }
    await expect(runs().admit(event(), Date.now())).rejects.toMatchObject({
      code: 'invalid_transition',
    });
  }));

it('serializes linked admission with bulk revocation without creating another event', () =>
  scope(async () => {
    await identities().saveChannelIdentity(link(), null);
    const entered = gate();
    const release = gate();
    const attempted = gate();
    const collection = mongoose.models.ChannelIdentity.collection;
    const update = collection.updateMany.bind(collection);
    const pause = jest.spyOn(collection, 'updateMany').mockImplementation(async (...args) => {
      entered.release();
      await release.wait;
      return update(...args);
    });
    const revoking = identities().revokeChannelIdentities(tenantId, 'channel', 'revoked');
    await entered.wait;
    const fences = mongoose.models.ChannelScope.collection;
    const touch = fences.updateOne.bind(fences);
    const observe = jest.spyOn(fences, 'updateOne').mockImplementation(async (...args) => {
      if (!Array.isArray(args[1]) && args[1].$inc?.revision === 1) attempted.release();
      return touch(...args);
    });
    const admission = runs().admit(linkedEvent(), Date.now());
    try {
      await attempted.wait;
      release.release();
      await revoking;
      await expect(admission).rejects.toMatchObject({ code: 'invalid_transition' });
    } finally {
      release.release();
      pause.mockRestore();
      observe.mockRestore();
    }
    expect(await mongoose.models.ChannelRun.countDocuments({})).toBe(0);
  }));

it.each([undefined, ''] as const)(
  'preserves canonical revision fallback semantics for %s',
  (revision) =>
    scope(async () => {
      await channels().createAgentChannel({
        tenantId,
        channelId: 'legacy',
        agentId: 'agent',
        createdBy: creatorId,
        type: 'slack',
        status: 'active',
        credentialMode: 'shared',
        revision,
        slack: { teamId: 'T1', appId: 'A1', botUserId: 'B1' },
      });
      const input = {
        ...event(),
        channelId: 'legacy',
        principal: { ...event().principal, channelRevision: revision ?? 'legacy' },
      };
      await expect(runs().admit(input, Date.now())).resolves.toMatchObject({ duplicate: false });
      await channels().updateAgentChannel('legacy', creatorId, { revision: 'rotated' });
      await expect(runs().admit(input, Date.now())).rejects.toMatchObject({
        code: 'invalid_transition',
      });
    }),
);
