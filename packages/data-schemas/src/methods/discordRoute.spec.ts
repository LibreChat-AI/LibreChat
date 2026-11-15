import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { DiscordAgentChannel } from 'librechat-data-provider';
import type { AssignDiscordRoute, DiscordRouteResult } from './discordRoute';
import { tenantStorage, runAsSystem, SYSTEM_TENANT_ID } from '~/config/tenantContext';
import { createChannelIdentityStorage } from './channelIdentity';
import { withRequiredTransaction } from '~/utils/transactions';
import { createDiscordInstallationStorage } from './discord';
import { createDiscordRouteStorage } from './discordRoute';
import { touchDiscordRoute } from './discordRouteScope';
import { createChannelRunStorage } from './channelRun';
import { createAgentChannelMethods } from './channel';
import { closeResponseScopes } from './responseScope';
import { waitForPause } from './test-helpers';
import { createModels } from '~/models';

const db = new mongoose.Mongoose();
const tenantId = 'discord-routes';
const owner = '000000000000000000000001';
const member = '000000000000000000000002';
const applicationId = '123456789012345678';
const guildId = '234567890123456789';
const botUserId = '345678901234567890';
const externalChannelId = '456789012345678901';
const scope = <T>(work: () => Promise<T>, partition = tenantId) =>
  tenantStorage.run({ tenantId: partition }, work);
const value = <T>(result: DiscordRouteResult<T>): T => {
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
};
let mongo: MongoMemoryReplSet;
let applicationRevision: string;
let base: DiscordAgentChannel;
const channels = () => createAgentChannelMethods(db);
const routes = () => createDiscordRouteStorage(db);
const identities = () => createChannelIdentityStorage(db);
const runs = () => createChannelRunStorage(db);
const installations = () => createDiscordInstallationStorage(db);
async function candidate(channelId = 'first'): Promise<AssignDiscordRoute> {
  await channels().createAgentChannel({ ...base, channelId, applicationRevision });
  return {
    actorId: owner,
    installationId: base.installationId,
    installationRevision: base.installationRevision,
    applicationRevision,
    externalChannelId: base.discord.externalChannelId,
    channelId,
    channelRevision: base.revision,
  };
}
async function event(channelId = 'first') {
  const channel = await channels().getAgentChannelMetadata(channelId);
  if (!channel) throw new Error('Missing channel');
  const identity = {
    provider: 'discord' as const,
    tenantId,
    channelId,
    channelRevision: channel.revision,
    agentId: channel.agentId,
    applicationId,
    guildId,
    externalUserId: '567890123456789012',
  };
  expect(
    await identities().saveChannelIdentity(
      {
        tenantId,
        identity,
        linkId: `link-${channelId}`,
        revision: 'link-revision',
        state: 'active',
        userId: member,
        ticketHash: 'ticket',
        ticketExpiresAtMs: Date.now() + 60000,
        expiresAtMs: Date.now() + 60000,
      },
      null,
      applicationRevision,
    ),
  ).toBe(true);
  return {
    tenantId,
    channelId,
    agentId: channel.agentId,
    applicationRevision,
    principal: {
      userId: member,
      channelRevision: channel.revision,
      linkId: `link-${channelId}`,
      linkRevision: 'link-revision',
    },
    admission: {
      actor: {
        provider: 'discord' as const,
        applicationId,
        guildId,
        externalUserId: identity.externalUserId,
      },
      eventId: '678901234567890123',
      externalChannelId,
      externalThreadKey: `${externalChannelId}:678901234567890123`,
      externalMessageKey: `${externalChannelId}:678901234567890123`,
      input: 'hello',
    },
  };
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
  await db.connect(mongo.getUri(), { autoIndex: false });
  createModels(db);
}, 60000);
afterAll(async () => {
  await db.disconnect();
  await mongo?.stop();
});
beforeEach(async () => {
  await runAsSystem(async () => {
    for (const name of [
      'User',
      'DiscordApplication',
      'DiscordGuild',
      'DiscordRoute',
      'AgentChannel',
      'ChannelScope',
      'ChannelIdentity',
      'ChannelRun',
      'ChannelLane',
      'ResponseScope',
    ])
      await db.models[name].deleteMany({});
  });
  await scope(async () => {
    await db.models.User.create([
      { _id: owner, email: 'owner@example.test', tenantId, provider: 'local' },
      { _id: member, email: 'member@example.test', tenantId, provider: 'local' },
    ]);
    const app = await installations().configureApplication({
      actorId: owner,
      applicationId,
      botUserId,
      publicKey: 'a'.repeat(64),
      encryptedBotToken: 'encrypted',
      encryptedClientSecret: 'encrypted-secret',
    });
    if (!app.ok) throw new Error(app.error.code);
    applicationRevision = app.value.revision;
    const guild = await installations().connectGuild({
      actorId: owner,
      applicationId,
      applicationRevision,
      guildId,
      guildName: 'Guild',
    });
    if (!guild.ok) throw new Error(guild.error.code);
    base = {
      tenantId,
      channelId: 'first',
      agentId: 'agent',
      createdBy: owner,
      revision: 'pending',
      type: 'discord',
      status: 'pending_install',
      credentialMode: 'per_user',
      installationId: guild.value.installationId,
      installationRevision: guild.value.revision,
      discord: { applicationId, guildId, botUserId, externalChannelId },
    };
  });
});
afterEach(() => jest.restoreAllMocks());

it('activates a pending candidate with its slot and requires that slot for authority', () =>
  scope(async () => {
    const input = await candidate();
    expect((await channels().getAgentChannelMetadata('first'))?.status).toBe('pending_install');
    const route = value(await routes().assign(input));
    expect(await routes().read(base.installationId, externalChannelId)).toMatchObject(route);
    expect(route).not.toHaveProperty('encryptedBotToken');
    const channel = await channels().getAgentChannelMetadata('first');
    expect(channel?.status).toBe('active');
    expect(channel?.revision).not.toBe(input.channelRevision);
    const admission = await event();
    expect((await runs().admit(admission, Date.now())).duplicate).toBe(false);
    await db.models.DiscordRoute.deleteOne({ installationId: base.installationId });
    expect(await channels().getActiveAgentChannel('first')).toBeNull();
    await expect(runs().admit(admission, Date.now())).rejects.toMatchObject({
      code: 'invalid_transition',
    });
    expect(
      await identities().saveChannelIdentity(
        {
          tenantId,
          identity: {
            provider: 'discord',
            tenantId,
            channelId: 'first',
            channelRevision: channel!.revision,
            agentId: 'agent',
            applicationId,
            guildId,
            externalUserId: '789012345678901234',
          },
          linkId: 'unbound',
          revision: 'one',
          state: 'pending',
          ticketHash: 'ticket-two',
          ticketExpiresAtMs: Date.now() + 1000,
          expiresAtMs: Date.now() + 1000,
        },
        null,
        applicationRevision,
      ),
    ).toBe(false);
  }));

it('replaces with a fresh channel and keeps delayed cleanup from removing its successor', () =>
  scope(async () => {
    const initial = value(await routes().assign(await candidate()));
    const stale = await event();
    const next = await candidate('second');
    expect(await routes().assign(next)).toMatchObject({
      ok: false,
      error: { code: 'route_changed' },
    });
    const replacement = value(
      await routes().assign({ ...next, expectedRevision: initial.revision }),
    );
    expect(replacement.channelId).toBe('second');
    expect(replacement.revision).not.toBe(initial.revision);
    expect((await channels().getAgentChannel('first'))?.status).toBe('deleting');
    expect(await channels().getActiveAgentChannel('first')).toBeNull();
    expect((await channels().getAgentChannelMetadata('second'))?.status).toBe('active');
    await expect(runs().admit(stale, Date.now())).rejects.toMatchObject({
      code: 'invalid_transition',
    });
    expect(
      await routes().remove({
        actorId: owner,
        installationId: base.installationId,
        externalChannelId,
        expectedRevision: initial.revision,
      }),
    ).toMatchObject({ ok: false, error: { code: 'route_changed' } });
    await channels().beginAgentChannelDeletion('first', owner);
    expect(await channels().deleteAgentChannel('first', owner)).toEqual({ status: 'deleted' });
    expect(await routes().read(base.installationId, externalChannelId)).toEqual(
      expect.objectContaining(replacement),
    );
  }));

it.each([
  'destination',
  'installation',
  'channel-revision',
  'application-revision',
  'owner',
] as const)('rejects a stale or mismatched %s without changing the pending channel', (kind) =>
  scope(async () => {
    const input = await candidate();
    if (kind === 'destination') input.externalChannelId = '789012345678901234';
    if (kind === 'installation') input.installationRevision = 'obsolete';
    if (kind === 'channel-revision') input.channelRevision = 'obsolete';
    if (kind === 'application-revision') input.applicationRevision = 'obsolete';
    if (kind === 'owner') input.actorId = member;
    expect((await routes().assign(input)).ok).toBe(false);
    expect(await routes().read(base.installationId, externalChannelId)).toBeNull();
    expect((await channels().getAgentChannel('first'))?.status).toBe('pending_install');
  }),
);

it('serializes competing first assignments into one active binding', () =>
  scope(async () => {
    const first = await candidate();
    const second = await candidate('second');
    const results = await Promise.all([routes().assign(first), routes().assign(second)]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      { ok: false, error: { code: 'route_changed' } },
    ]);
    expect(await db.models.DiscordRoute.countDocuments({})).toBe(1);
    expect(await db.models.AgentChannel.countDocuments({ status: 'active' })).toBe(1);
    expect(await db.models.AgentChannel.countDocuments({ status: 'pending_install' })).toBe(1);
  }));

it('serializes replacement with removal using the same slot revision', () =>
  scope(async () => {
    const initial = value(await routes().assign(await candidate()));
    const next = await candidate('second');
    const results = await Promise.all([
      routes().assign({ ...next, expectedRevision: initial.revision }),
      routes().remove({
        actorId: owner,
        installationId: base.installationId,
        externalChannelId,
        expectedRevision: initial.revision,
      }),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      { ok: false, error: { code: 'route_changed' } },
    ]);
    expect((await channels().getAgentChannel('first'))?.status).toBe('deleting');
    const current = await routes().read(base.installationId, externalChannelId);
    expect(current?.channelId ?? null).toBe(results[0].ok ? 'second' : null);
  }));

it('blocks admission that races a replacement already closing the old scope', () =>
  scope(async () => {
    const initial = value(await routes().assign(await candidate()));
    const admission = await event();
    const next = await candidate('second');
    const entered = gate();
    const release = gate();
    const attempted = gate();
    const collection = db.models.AgentChannel.collection;
    const update = collection.updateOne.bind(collection);
    const pause = jest.spyOn(collection, 'updateOne').mockImplementation(async (...args) => {
      if (!Array.isArray(args[1]) && args[1].$set?.status === 'deleting') {
        entered.release();
        await release.wait;
      }
      return update(...args);
    });
    const replacement = routes().assign({ ...next, expectedRevision: initial.revision });
    await waitForPause(entered.wait, replacement);
    const fences = db.models.ChannelScope.collection;
    const touch = fences.updateOne.bind(fences);
    const observe = jest.spyOn(fences, 'updateOne').mockImplementation(async (...args) => {
      if (!Array.isArray(args[1]) && args[1].$inc?.revision === 1) attempted.release();
      return touch(...args);
    });
    const admitting = runs().admit(admission, Date.now());
    const drained = Promise.allSettled([replacement, admitting]);
    try {
      await waitForPause(attempted.wait, admitting);
      release.release();
      expect((await replacement).ok).toBe(true);
      await expect(admitting).rejects.toMatchObject({ code: 'invalid_transition' });
    } finally {
      release.release();
      pause.mockRestore();
      observe.mockRestore();
      await drained;
    }
    expect(await db.models.ChannelRun.countDocuments({})).toBe(0);
  }));

it('rolls back retirement and activation when persisting a replacement fails', () =>
  scope(async () => {
    const initial = value(await routes().assign(await candidate()));
    const next = await candidate('second');
    const failed = new Error('Database write unavailable');
    jest.spyOn(db.models.DiscordRoute.collection, 'updateOne').mockRejectedValueOnce(failed);
    await expect(routes().assign({ ...next, expectedRevision: initial.revision })).rejects.toBe(
      failed,
    );
    expect((await channels().getAgentChannelMetadata('first'))?.status).toBe('active');
    expect((await channels().getAgentChannel('second'))?.status).toBe('pending_install');
    expect((await routes().read(base.installationId, externalChannelId))?.revision).toBe(
      initial.revision,
    );
  }));

it.each(['disconnected', 'owner-erased'] as const)(
  'allows an active manager to remove a binding when its installation is %s',
  (kind) =>
    scope(async () => {
      const initial = value(await routes().assign(await candidate()));
      if (kind === 'disconnected')
        await installations().disconnectGuild({
          actorId: owner,
          installationId: base.installationId,
          expectedRevision: base.installationRevision,
        });
      else await closeResponseScopes(db, { userId: owner, tenantId });
      expect(
        await routes().remove({
          actorId: member,
          installationId: base.installationId,
          externalChannelId,
          expectedRevision: initial.revision,
        }),
      ).toEqual({ ok: true, value: null });
      expect(await routes().read(base.installationId, externalChannelId)).toBeNull();
      expect((await channels().getAgentChannel('first'))?.status).toBe('deleting');
    }),
);

it('rejects foreign tenants and system scope without leaking or changing a route', async () => {
  const initial = await scope(async () => value(await routes().assign(await candidate())));
  await scope(async () => {
    expect(await routes().read(base.installationId, externalChannelId)).toBeNull();
    expect(
      await routes().remove({
        actorId: member,
        installationId: base.installationId,
        externalChannelId,
        expectedRevision: initial.revision,
      }),
    ).toMatchObject({ ok: false, error: { code: 'principal_unavailable' } });
  }, 'foreign');
  await scope(async () => {
    await expect(routes().read(base.installationId, externalChannelId)).rejects.toThrow(
      'tenant scope',
    );
  }, SYSTEM_TENANT_ID);
  expect((await scope(() => routes().read(base.installationId, externalChannelId)))?.revision).toBe(
    initial.revision,
  );
});

it('binds the transaction fence to the exact tenant, destination and current channel', () =>
  scope(async () => {
    await routes().assign(await candidate());
    const touch = (
      overrides: Partial<{ tenantId: string; channelId: string; externalChannelId: string }> = {},
    ) =>
      withRequiredTransaction(db, (session) =>
        touchDiscordRoute(
          db,
          {
            tenantId,
            installationId: base.installationId,
            externalChannelId,
            channelId: 'first',
            ...overrides,
          },
          session,
        ),
      );
    expect(await touch()).toBe(true);
    expect(await touch({ channelId: 'other' })).toBe(false);
    expect(await touch({ externalChannelId: '789012345678901234' })).toBe(false);
    await expect(touch({ tenantId: 'foreign' })).rejects.toThrow('tenant');
  }));

it.each(['closed', 'deleting', 'deleted'] as const)(
  'rejects %s managers before route mutations',
  (kind) =>
    scope(async () => {
      const input = await candidate();
      if (kind === 'closed') await closeResponseScopes(db, { userId: owner, tenantId });
      if (kind === 'deleting')
        await db.models.User.updateOne(
          { _id: owner },
          { $set: { agentTriggerDeletionStartedAt: new Date() } },
        );
      if (kind === 'deleted') await db.models.User.deleteOne({ _id: owner });
      expect(await routes().assign(input)).toMatchObject({
        ok: false,
        error: { code: 'principal_unavailable' },
      });
      expect(await routes().read(base.installationId, externalChannelId)).toBeNull();
    }),
);

it('rejects runtime selector objects before querying a slot', () =>
  scope(async () => {
    await routes().assign(await candidate());
    // @ts-expect-error Exercise the untyped boundary that must reject Mongo selectors.
    await expect(routes().read({ $ne: null }, externalChannelId)).rejects.toThrow('identity');
    const input = await candidate('second');
    // @ts-expect-error Exercise the untyped boundary that must reject Mongo selectors.
    await expect(routes().assign({ ...input, channelId: { $ne: null } })).rejects.toThrow(
      'identity',
    );
    expect((await routes().read(base.installationId, externalChannelId))?.channelId).toBe('first');
  }));

it('keeps sibling guild bindings independent under the same application', () =>
  scope(async () => {
    const first = base;
    await routes().assign(await candidate());
    const guild = await installations().connectGuild({
      actorId: owner,
      applicationId,
      applicationRevision,
      guildId: '789012345678901234',
      guildName: 'Second guild',
    });
    if (!guild.ok) throw new Error(guild.error.code);
    base = {
      ...base,
      installationId: guild.value.installationId,
      installationRevision: guild.value.revision,
      discord: {
        ...base.discord,
        guildId: guild.value.guildId,
        externalChannelId: '890123456789012345',
      },
    };
    const second = value(await routes().assign(await candidate('second-guild')));
    await installations().disconnectGuild({
      actorId: owner,
      installationId: first.installationId,
      expectedRevision: first.installationRevision,
    });
    expect(await channels().getActiveAgentChannel('first')).toBeNull();
    expect((await channels().getActiveAgentChannel('second-guild'))?.status).toBe('active');
    expect(
      (await routes().read(base.installationId, base.discord.externalChannelId))?.revision,
    ).toBe(second.revision);
  }));

it('removes the current slot during channel deletion and permits a fresh candidate', () =>
  scope(async () => {
    await routes().assign(await candidate());
    await channels().beginAgentChannelDeletion('first', owner);
    expect(await routes().read(base.installationId, externalChannelId)).toBeNull();
    expect(await channels().updateAgentChannel('first', owner, { status: 'active' })).toBeNull();
    const next = value(await routes().assign(await candidate('second')));
    expect(next.channelId).toBe('second');
    expect((await channels().getAgentChannelMetadata('second'))?.status).toBe('active');
  }));
