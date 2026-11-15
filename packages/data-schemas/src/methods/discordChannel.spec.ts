import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { DiscordAgentChannel, DiscordChannelExternalIdentity } from 'librechat-data-provider';
import type { ChannelIdentityRecord } from '~/models/channelIdentity';
import { tenantStorage, runAsSystem } from '~/config/tenantContext';
import { createChannelIdentityStorage } from './channelIdentity';
import { createDiscordInstallationStorage } from './discord';
import { createDiscordRouteStorage } from './discordRoute';
import { createChannelRunStorage } from './channelRun';
import { createAgentChannelMethods } from './channel';
import { createModels } from '~/models';

const db = new mongoose.Mongoose();
let mongo: MongoMemoryReplSet;
const tenantId = 'discord-channel';
const owner = '000000000000000000000001';
const user = '000000000000000000000002';
const applicationId = '123456789012345678';
const guildId = '234567890123456789';
const botUserId = '345678901234567890';
const scope = <T>(work: () => Promise<T>) => tenantStorage.run({ tenantId }, work);
let channels: ReturnType<typeof createAgentChannelMethods>;
let installations: ReturnType<typeof createDiscordInstallationStorage>;
let identities: ReturnType<typeof createChannelIdentityStorage>;
let runs: ReturnType<typeof createChannelRunStorage>;
let channel: DiscordAgentChannel;
let applicationRevision: string;
function identity(): DiscordChannelExternalIdentity {
  return {
    provider: 'discord',
    tenantId,
    channelId: channel.channelId,
    channelRevision: channel.revision,
    agentId: channel.agentId,
    applicationId,
    guildId,
    externalUserId: '456789012345678901',
  };
}
function link(): ChannelIdentityRecord {
  return {
    tenantId,
    linkId: 'link',
    ticketHash: 'a'.repeat(64),
    revision: 'link-rev',
    identity: identity(),
    state: 'active',
    userId: user,
    ticketExpiresAtMs: Date.now() + 60000,
    expiresAtMs: Date.now() + 60000,
  };
}
function event() {
  return {
    tenantId,
    channelId: channel.channelId,
    agentId: channel.agentId,
    applicationRevision,
    principal: {
      userId: user,
      channelRevision: channel.revision,
      linkId: 'link',
      linkRevision: 'link-rev',
    },
    admission: {
      actor: {
        provider: 'discord' as const,
        applicationId,
        guildId,
        externalUserId: identity().externalUserId,
      },
      eventId: '567890123456789012',
      externalChannelId: '678901234567890123',
      externalThreadKey: '678901234567890123:567890123456789012',
      externalMessageKey: '678901234567890123:567890123456789012',
      input: 'hello',
    },
  };
}

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await db.connect(mongo.getUri(), { autoIndex: false });
  createModels(db);
  channels = createAgentChannelMethods(db);
  installations = createDiscordInstallationStorage(db);
  identities = createChannelIdentityStorage(db);
  runs = createChannelRunStorage(db);
}, 60000);
afterAll(async () => {
  await db.disconnect();
  await mongo?.stop();
});
beforeEach(async () => {
  await runAsSystem(async () => {
    for (const name of [
      'User',
      'AgentChannel',
      'DiscordApplication',
      'DiscordGuild',
      'DiscordRoute',
      'ChannelIdentity',
      'ChannelRun',
      'ChannelLane',
      'ChannelScope',
      'ResponseScope',
    ])
      await db.models[name].deleteMany({});
  });
  await scope(async () => {
    await db.models.User.create([
      { _id: owner, email: 'owner@example.test', tenantId, provider: 'local' },
      { _id: user, email: 'user@example.test', tenantId, provider: 'local' },
    ]);
    const app = await installations.configureApplication({
      actorId: owner,
      applicationId,
      botUserId,
      publicKey: 'a'.repeat(64),
      encryptedBotToken: 'encrypted',
      encryptedClientSecret: 'encrypted-secret',
    });
    if (!app.ok) throw new Error(app.error.code);
    applicationRevision = app.value.revision;
    const installed = await installations.connectGuild({
      actorId: owner,
      applicationId,
      applicationRevision,
      guildId,
      guildName: 'Guild',
    });
    if (!installed.ok) throw new Error(installed.error.code);
    channel = {
      type: 'discord',
      channelId: 'channel',
      agentId: 'agent',
      tenantId,
      createdBy: owner,
      status: 'active',
      credentialMode: 'per_user',
      revision: 'channel-rev',
      installationId: installed.value.installationId,
      installationRevision: installed.value.revision,
      discord: { applicationId, guildId, botUserId, externalChannelId: '678901234567890123' },
    };
  });
});
const create = async () => {
  const candidate = await channels.createAgentChannel({
    ...channel,
    status: 'pending_install',
    applicationRevision,
  });
  const assigned = await createDiscordRouteStorage(db).assign({
    actorId: owner,
    installationId: channel.installationId,
    installationRevision: channel.installationRevision,
    applicationRevision,
    externalChannelId: channel.discord.externalChannelId,
    channelId: channel.channelId,
    channelRevision: channel.revision,
  });
  if (!assigned.ok) throw new Error(assigned.error.code);
  const current = await channels.getAgentChannelMetadata(channel.channelId);
  if (!current || current.type !== 'discord') throw new Error('Missing Discord channel');
  channel = current;
  return candidate;
};

it('keeps credentials application-owned and returns authority only in private service reads', () =>
  scope(async () => {
    const created = await create();
    expect(created).not.toHaveProperty('applicationRevision');
    expect(created).not.toHaveProperty('encryptedBotToken');
    const metadata = await channels.getAgentChannelMetadata('channel');
    expect(metadata).toMatchObject(channel);
    expect(metadata).not.toHaveProperty('applicationRevision');
    expect(metadata).not.toHaveProperty('encryptedBotToken');
    expect(await channels.getActiveAgentChannel('channel')).toMatchObject({
      applicationRevision,
      encryptedBotToken: 'encrypted',
    });
  }));

it('admits only a current linked Discord actor and keeps Slack authority separate', () =>
  scope(async () => {
    await create();
    expect(await identities.saveChannelIdentity(link(), null, applicationRevision)).toBe(true);
    expect(await identities.readChannelIdentity(identity())).toMatchObject({ linkId: 'link' });
    const admitted = await runs.admit(event(), Date.now());
    expect(admitted.duplicate).toBe(false);
    expect((await runs.admit(event(), Date.now())).duplicate).toBe(true);
    expect(admitted.run).not.toHaveProperty('applicationRevision');
    await expect(
      runs.admit({ ...event(), applicationRevision: undefined }, Date.now()),
    ).rejects.toMatchObject({ code: 'invalid_transition' });
    await expect(
      runs.admit(
        {
          ...event(),
          admission: {
            ...event().admission,
            actor: {
              teamId: guildId,
              appId: applicationId,
              externalUserId: identity().externalUserId,
            },
          },
        },
        Date.now(),
      ),
    ).rejects.toMatchObject({ code: 'invalid_transition' });
  }));

it.each(['applicationId', 'guildId', 'botUserId'] as const)(
  'rejects mismatched %s at creation',
  (field) =>
    scope(async () => {
      await expect(
        channels.createAgentChannel({
          ...channel,
          applicationRevision,
          discord: { ...channel.discord, [field]: '789012345678901234' },
        }),
      ).rejects.toThrow();
      expect(await channels.getAgentChannel('channel')).toBeNull();
    }),
);

it('prevents provider and installation reassignment through generic updates', () =>
  scope(async () => {
    await create();
    for (const update of [
      { type: 'slack' as const },
      { installationId: 'other' },
      { installationRevision: 'other' },
      { discord: channel.discord },
      { credentialMode: 'shared' as const },
      { encryptedBotToken: 'secret' },
    ]) {
      expect(await channels.updateAgentChannel('channel', owner, update)).toBeNull();
    }
    expect(
      await channels.updateAgentChannel('channel', owner, {
        status: 'disabled',
        revision: 'disabled',
      }),
    ).toMatchObject({ status: 'disabled' });
  }));

it('fences credential rotation without changing consent identity', () =>
  scope(async () => {
    await create();
    expect(await identities.saveChannelIdentity(link(), null, applicationRevision)).toBe(true);
    const rotated = await installations.configureApplication({
      actorId: owner,
      applicationId,
      botUserId,
      publicKey: 'b'.repeat(64),
      encryptedBotToken: 'rotated',
      expectedRevision: applicationRevision,
    });
    if (!rotated.ok) throw new Error(rotated.error.code);
    await expect(runs.admit(event(), Date.now())).rejects.toMatchObject({
      code: 'invalid_transition',
    });
    expect(
      await identities.saveChannelIdentity(
        { ...link(), revision: 'next' },
        'link-rev',
        applicationRevision,
      ),
    ).toBe(false);
    expect((await channels.getAgentChannelMetadata('channel'))?.status).toBe('active');
    expect(await identities.readChannelIdentity(identity())).toMatchObject({
      revision: 'link-rev',
    });
    expect(
      (await runs.admit({ ...event(), applicationRevision: rotated.value.revision }, Date.now()))
        .duplicate,
    ).toBe(false);
  }));

it('disconnect disables admission and reconnect cannot revive old bindings', () =>
  scope(async () => {
    await create();
    expect(await identities.saveChannelIdentity(link(), null, applicationRevision)).toBe(true);
    const disconnected = await installations.disconnectGuild({
      actorId: owner,
      installationId: channel.installationId,
      expectedRevision: channel.installationRevision,
    });
    if (!disconnected.ok) throw new Error(disconnected.error.code);
    expect((await channels.getAgentChannelMetadata('channel'))?.status).toBe('disabled');
    expect(await channels.getActiveAgentChannel('channel')).toBeNull();
    await expect(runs.admit(event(), Date.now())).rejects.toMatchObject({
      code: 'invalid_transition',
    });
    const reconnected = await installations.connectGuild({
      actorId: owner,
      applicationId,
      applicationRevision,
      guildId,
      guildName: 'Guild',
      installationId: channel.installationId,
      expectedRevision: disconnected.value.revision,
    });
    expect(reconnected.ok).toBe(true);
    expect((await channels.getAgentChannelMetadata('channel'))?.status).toBe('disabled');
    expect(await channels.updateAgentChannel('channel', owner, { status: 'active' })).toBeNull();
  }));

it('blocks an erased owner and retires Discord links through existing cleanup', () =>
  scope(async () => {
    await create();
    expect(await identities.saveChannelIdentity(link(), null, applicationRevision)).toBe(true);
    await db.models.User.updateOne(
      { _id: owner },
      { $set: { agentTriggerDeletionStartedAt: new Date() } },
    );
    expect(await channels.getActiveAgentChannel('channel')).toBeNull();
    await expect(runs.admit(event(), Date.now())).rejects.toMatchObject({
      code: 'invalid_transition',
    });
    expect(await channels.beginAgentChannelDeletion('channel', owner)).toMatchObject({
      status: 'deleting',
    });
    expect(await identities.readChannelIdentity(identity())).toBeNull();
    expect(await channels.deleteAgentChannel('channel', owner)).toEqual({ status: 'deleted' });
  }));

it('rejects delivery destinations outside the immutable channel binding', () =>
  scope(async () => {
    await create();
    expect(await identities.saveChannelIdentity(link(), null, applicationRevision)).toBe(true);
    await expect(
      runs.admit(
        {
          ...event(),
          admission: {
            ...event().admission,
            externalChannelId: '789012345678901234',
            externalThreadKey: '789012345678901234:567890123456789012',
            externalMessageKey: '789012345678901234:567890123456789012',
          },
        },
        Date.now(),
      ),
    ).rejects.toMatchObject({ code: 'invalid_transition' });
  }));

it('batches installation and owner reads across a page of Discord channels', () =>
  scope(async () => {
    await create();
    channel = {
      ...channel,
      channelId: 'second',
      discord: { ...channel.discord, externalChannelId: '789012345678901234' },
    };
    await create();
    const apps = jest.spyOn(db.models.DiscordApplication.collection, 'find');
    const guilds = jest.spyOn(db.models.DiscordGuild.collection, 'find');
    const owners = jest.spyOn(db.models.User.collection, 'find');
    const routes = jest.spyOn(db.models.DiscordRoute.collection, 'find');
    try {
      const page = await channels.listAgentChannels('agent');
      expect(page).toHaveLength(2);
      expect(page.every((record) => record.status === 'active')).toBe(true);
      expect(apps).toHaveBeenCalledTimes(1);
      expect(guilds).toHaveBeenCalledTimes(1);
      expect(owners).toHaveBeenCalledTimes(1);
      expect(routes).toHaveBeenCalledTimes(1);
    } finally {
      apps.mockRestore();
      guilds.mockRestore();
      owners.mockRestore();
      routes.mockRestore();
    }
  }));
