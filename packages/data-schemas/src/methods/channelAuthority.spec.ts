import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { ChannelIdentityRecord } from '~/models/channelIdentity';
import { tenantStorage, runAsSystem } from '~/config/tenantContext';
import { createChannelIdentityStorage } from './channelIdentity';
import { createChannelRunStorage } from './channelRun';
import { closeResponseScopes } from './responseScope';
import { createAgentChannelMethods } from './channel';
import { channelRunFence } from './channelRunWrite';
import { createUserMethods } from './user';
import { createModels } from '~/models';

let mongo: MongoMemoryReplSet;
let creatorId: string;
let currentRevision = 'one';
const tenantId = 'channel-authority-test';
const scope = <T>(work: () => Promise<T>) => tenantStorage.run({ tenantId }, work);
const channels = () => createAgentChannelMethods(mongoose);
const identities = () => createChannelIdentityStorage(mongoose);
const runs = () => createChannelRunStorage(mongoose);
const event = () => ({
  tenantId,
  channelId: 'channel',
  agentId: 'agent',
  principal: { userId: creatorId, channelRevision: currentRevision },
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
    channelRevision: currentRevision,
    teamId: 'T1',
    externalUserId: 'U1',
    agentId: 'agent',
  },
});
const linkedEvent = () => ({
  ...event(),
  principal: { ...event().principal, userId: 'actor', linkId: 'link', linkRevision: 'link-one' },
});
async function personalMode() {
  const current = await channels().updateAgentChannel('channel', creatorId, {
    credentialMode: 'per_user',
  });
  if (!current) throw new Error('Expected personal channel fixture');
  currentRevision = current.revision;
}

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
  currentRevision = 'one';
  await runAsSystem(async () => {
    for (const name of [
      'AgentChannel',
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
        {
          ...link(),
          linkId: 'fresh-link',
          ticketHash: 'fresh-ticket',
          revision: 'fresh',
          identity: { ...link().identity, channelRevision: 'two' },
        },
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
    await personalMode();
    expect(await identities().saveChannelIdentity(link(), null)).toBe(true);
    await closeResponseScopes(mongoose, { userId: creatorId, tenantId });
    expect((await channels().getAgentChannel('channel'))?.status).toBe('active');
    await expect(runs().admit(linkedEvent(), Date.now())).rejects.toMatchObject({
      code: 'invalid_transition',
    });
    expect(await identities().saveChannelIdentity(link(), null)).toBe(false);
  }));

it('commits closure and credential redaction before retryable account identity erasure', () =>
  scope(async () => {
    await identities().saveChannelIdentity(link(), null);
    const collection = mongoose.models.ChannelIdentity.collection;
    const erase = collection.updateOne.bind(collection);
    const failure = jest.spyOn(collection, 'updateOne').mockImplementation(async (...args) => {
      if (!Array.isArray(args[1]) && args[1].$set?.['_managed.phase'] === 'retired')
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

it('rejects an obsolete event after the revision CAS even while its reply is paused', () =>
  scope(async () => {
    const entered = gate();
    const release = gate();
    const parents = mongoose.models.AgentChannel.collection;
    const update = parents.findOneAndUpdate.bind(parents);
    const pause = jest.spyOn(parents, 'findOneAndUpdate').mockImplementation(async (...args) => {
      if (!Array.isArray(args[1]) && args[1].$set?.revision === 'two') {
        const result = await update(...args);
        entered.release();
        await release.wait;
        return result;
      }
      return update(...args);
    });
    const updating = channels().updateAgentChannel('channel', creatorId, { revision: 'two' });
    await entered.wait;
    try {
      await expect(runs().admit(event(), Date.now())).rejects.toMatchObject({
        code: 'invalid_transition',
      });
      release.release();
      await expect(updating).resolves.toMatchObject({ revision: 'two' });
    } finally {
      release.release();
      pause.mockRestore();
    }
    expect(await mongoose.models.ChannelRun.countDocuments({})).toBe(0);
  }));

it.each(['revoked', 'expired', 'revision', 'user', 'external-user'] as const)(
  'rejects a %s linked principal, including event replay',
  (kind) =>
    scope(async () => {
      await personalMode();
      const record = link();
      expect(await identities().saveChannelIdentity(record, null)).toBe(true);
      await runs().admit(linkedEvent(), Date.now());
      if (kind === 'revoked')
        await identities().revokeChannelIdentities(tenantId, 'channel', 'revoked');
      else if (kind === 'revision')
        await identities().saveChannelIdentity(
          { ...record, revision: 'new-link' },
          record.revision,
        );
      const input = linkedEvent();
      if (kind === 'user') input.principal.userId = 'different';
      if (kind === 'external-user') input.admission.actor.externalUserId = 'different';
      await expect(
        runs().admit(input, kind === 'expired' ? record.expiresAtMs! + 1 : Date.now()),
      ).rejects.toMatchObject({
        code: 'invalid_transition',
      });
      expect(await mongoose.models.ChannelRun.countDocuments({})).toBe(1);
    }),
);

it('requires persisted link authority for the current per-user channel generation', () =>
  scope(async () => {
    const channel = await channels().updateAgentChannel('channel', creatorId, {
      credentialMode: 'per_user',
    });
    const input = event();
    input.principal.channelRevision = channel!.revision;
    await expect(runs().admit(input, Date.now())).rejects.toMatchObject({
      code: 'invalid_transition',
    });
    const linked = {
      ...link(),
      identity: { ...link().identity, channelRevision: channel!.revision },
    };
    expect(await identities().saveChannelIdentity(linked, null)).toBe(true);
    await expect(
      runs().admit(
        {
          ...input,
          principal: {
            ...input.principal,
            userId: linked.userId!,
            linkId: linked.linkId,
            linkRevision: linked.revision,
          },
        },
        Date.now(),
      ),
    ).resolves.toMatchObject({ duplicate: false });
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

it.each(['channel', 'link'] as const)(
  'retains an admitted publisher for cleanup after its %s authority changes',
  (kind) =>
    scope(async () => {
      if (kind === 'link') {
        await personalMode();
        expect(await identities().saveChannelIdentity(link(), null)).toBe(true);
      }
      const input = kind === 'link' ? linkedEvent() : event();
      const entered = gate();
      const release = gate();
      const collection = mongoose.models.ChannelRun.collection;
      const update = collection.updateOne.bind(collection);
      let paused = false;
      const pause = jest.spyOn(collection, 'updateOne').mockImplementation(async (...args) => {
        if (
          !paused &&
          !Array.isArray(args[1]) &&
          args[1].$set?.['_managed.phase'] === 'published'
        ) {
          paused = true;
          entered.release();
          await release.wait;
        }
        return update(...args);
      });
      const admitting = runs().admit(input, Date.now());
      void admitting.catch(() => undefined);
      const timeout = setTimeout(release.release, 10000);
      try {
        await entered.wait;
        if (kind === 'channel')
          expect(
            await channels().updateAgentChannel('channel', creatorId, { revision: 'two' }),
          ).not.toBeNull();
        else await identities().revokeChannelIdentities(tenantId, 'channel', 'revoked');
        release.release();
        const accepted = await admitting;
        expect(accepted.run.principal).toEqual(input.principal);
        expect(accepted.run.execution).toBeUndefined();
        await expect(runs().admit(input, Date.now())).rejects.toMatchObject({
          code: 'invalid_transition',
        });
        const cleanup = (await runs().claimAuthorityLost(
          accepted.run,
          'cleanup',
          Date.now(),
          60000,
        ))!;
        expect(cleanup).not.toBeNull();
        expect(
          await runs().finishAuthorityLost(tenantId, channelRunFence(cleanup), Date.now()),
        ).toBe('stopped');
        expect(await runs().read(tenantId, 'channel', accepted.run.runId)).toMatchObject({
          state: 'cancelled',
          cursorState: 'complete',
        });
      } finally {
        clearTimeout(timeout);
        release.release();
        pause.mockRestore();
        await admitting.catch(() => undefined);
      }
    }),
);

it('keeps configuration timestamps unchanged by admission serialization writes', () =>
  scope(async () => {
    await personalMode();
    await identities().saveChannelIdentity(link(), null);
    const before = new Date(0);
    await mongoose.models.AgentChannel.collection.updateOne(
      { channelId: 'channel' },
      { $set: { updatedAt: before } },
    );
    await mongoose.models.ChannelIdentity.collection.updateOne(
      { linkId: 'link' },
      { $set: { updatedAt: before } },
    );
    await expect(runs().admit(linkedEvent(), Date.now())).resolves.toMatchObject({
      duplicate: false,
    });
    const parent = await mongoose.models.AgentChannel.collection.findOne({ channelId: 'channel' });
    const identity = await mongoose.models.ChannelIdentity.collection.findOne({ linkId: 'link' });
    expect(parent!.updatedAt).toEqual(before);
    expect(identity!.updatedAt).toEqual(before);
  }));

it.each(['opaque-revision'] as const)('preserves an explicit opaque revision %s', (revision) =>
  scope(async () => {
    await channels().createAgentChannel({
      tenantId,
      channelId: 'opaque-channel',
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
      channelId: 'opaque-channel',
      principal: { ...event().principal, channelRevision: revision },
    };
    await expect(runs().admit(input, Date.now())).resolves.toMatchObject({ duplicate: false });
    await channels().updateAgentChannel('opaque-channel', creatorId, { revision: 'rotated' });
    await expect(runs().admit(input, Date.now())).rejects.toMatchObject({
      code: 'invalid_transition',
    });
  }),
);
