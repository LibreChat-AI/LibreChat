import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { discordThreadAddress } from 'librechat-data-provider';
import type {
  DiscordThreadRoute,
  DiscordGuildThreadSource,
  DiscordThreadBinding,
} from 'librechat-data-provider';
import { createDiscordThreadStorage, touchDiscordThreadRoute } from './discordThread';
import { tenantStorage, runAsSystem } from '~/config/tenantContext';
import { createDiscordGatewayStorage } from './discordGateway';
import { withRequiredTransaction } from '~/utils/transactions';
import { createDiscordInstallationStorage } from './discord';
import { createDiscordRouteStorage } from './discordRoute';
import { createAgentChannelMethods } from './channel';
import { laneKey } from './channelProtocol';
import { createUserMethods } from './user';
import { createModels } from '~/models';

const db = new mongoose.Mongoose();
const models = createModels(db);
const tenantId = 'thread-storage';
const userId = '000000000000000000000001';
const applicationId = '123456789012345678';
const botUserId = '234567890123456789';
const guildId = '345678901234567890';
const parentChannelId = '456789012345678901';
const threadChannelId = '567890123456789012';
const authorId = '678901234567890123';
const required = String(BigInt(1024 | 65536) | (BigInt(1) << BigInt(38)));
const scoped = <T>(work: () => Promise<T>, tenant = tenantId) =>
  tenantStorage.run({ tenantId: tenant }, work);
const gateway = createDiscordGatewayStorage(db, async () => ({
  ownershipLeaseMs: 30000,
  shardCount: 1,
}));
const installations = createDiscordInstallationStorage(db);
const channels = createAgentChannelMethods(db);
const routes = createDiscordRouteStorage(db);
let cap: number;
let revision: string;
let binding: DiscordThreadBinding;
let installationId: string;
let installationRevision: string;
let mongo: MongoMemoryReplSet;
const threads = createDiscordThreadStorage(db, async () => ({ maxThreadRoutes: cap }));
const owner = () => ({ applicationId, applicationRevision: revision, ownerId: 'a'.repeat(32) });
const source = (id = threadChannelId): DiscordGuildThreadSource => ({
  kind: 'guild_thread',
  applicationId,
  botUserId,
  guildId,
  parentChannelId,
  threadChannelId: id,
  authorId,
  threadType: 11,
  archived: false,
  locked: false,
  permissions: { bot: required, author: required },
  membership: { bot: false, author: false },
});
const unwrap = <T>(result: { ok: true; value: T } | { ok: false; error: { code: string } }): T => {
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
};
const authority = (route: DiscordThreadRoute, actual = source()) => ({
  tenantId,
  owner: owner(),
  channelId: route.channelId,
  channelRevision: route.channelRevision,
  mappingRevision: route.mappingRevision,
  externalChannelId: actual.threadChannelId,
  externalUserId: actual.authorId,
  source: actual,
});
async function bindParent(channelId = 'channel') {
  await channels.createAgentChannel({
    type: 'discord',
    tenantId,
    channelId,
    agentId: 'agent',
    createdBy: userId,
    status: 'pending_install',
    credentialMode: 'per_user',
    revision: 'initial',
    installationId,
    installationRevision,
    applicationRevision: revision,
    discord: { applicationId, guildId, botUserId, externalChannelId: parentChannelId },
  });
  const route = unwrap(
    await routes.assign({
      actorId: userId,
      installationId,
      installationRevision,
      applicationRevision: revision,
      externalChannelId: parentChannelId,
      channelId,
      channelRevision: 'initial',
    }),
  );
  const channel = await channels.getAgentChannelMetadata(channelId);
  if (!channel) throw new Error('Fixture channel unavailable');
  return { channelId, channelRevision: channel.revision, routeRevision: route.revision };
}
beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await db.connect(mongo.getUri(), { autoIndex: false });
});
afterAll(async () => {
  await db.disconnect();
  await mongo?.stop();
});
beforeEach(async () => {
  jest.restoreAllMocks();
  cap = 10;
  await runAsSystem(async () => {
    for (const collection of Object.values(db.connection.collections))
      await collection.deleteMany({});
  });
  await scoped(async () => {
    await models.User.create({
      _id: userId,
      tenantId,
      email: 'owner@example.test',
      provider: 'local',
    });
    revision = unwrap(
      await installations.configureApplication({
        actorId: userId,
        applicationId,
        botUserId,
        publicKey: 'a'.repeat(64),
        encryptedBotToken: 'sealed',
        encryptedClientSecret: 'sealed',
      }),
    ).revision;
    const guild = unwrap(
      await installations.connectGuild({
        actorId: userId,
        applicationId,
        applicationRevision: revision,
        guildId,
        guildName: 'Guild',
      }),
    );
    installationId = guild.installationId;
    installationRevision = guild.revision;
    binding = await bindParent();
    if (!(await gateway.acquire(owner(), 30000))) throw new Error('Fixture owner unavailable');
  });
});
it('pins one actual thread and composes transaction authorization with actor and destination checks', () =>
  scoped(async () => {
    const route = unwrap(await threads.bind(owner(), source(), binding));
    expect(route).toMatchObject({
      ...binding,
      applicationId,
      botUserId,
      guildId,
      parentChannelId,
      threadChannelId,
      installationId,
      installationRevision,
    });
    expect(unwrap(await threads.bind(owner(), source(), binding))).toEqual(route);
    expect(unwrap(await threads.read(owner(), threadChannelId))).toEqual(route);
    expect(
      await withRequiredTransaction(db, (session) =>
        touchDiscordThreadRoute(db, authority(route), session),
      ),
    ).toBe(true);
    expect(
      await threads.authorize({ ...authority(route), externalChannelId: parentChannelId }),
    ).toMatchObject({ ok: false, error: { code: 'route_changed' } });
    expect(
      await threads.authorize({ ...authority(route), externalUserId: '999999999999999999' }),
    ).toMatchObject({ ok: false });
    expect(
      await threads.authorize({ ...authority(route), mappingRevision: 'other' }),
    ).toMatchObject({ ok: false });
    const address = discordThreadAddress(threadChannelId, '789012345678901234');
    expect(address.externalChannelId).toBe(threadChannelId);
    expect(address.externalThreadKey).toBe(`${threadChannelId}:${threadChannelId}`);
    const lane = (thread: string, user: string, message: string) =>
      laneKey({
        tenantId,
        channelId: route.channelId,
        agentId: 'agent',
        principal: {
          userId,
          channelRevision: route.channelRevision,
          linkId: 'link',
          linkRevision: 'link-revision',
        },
        admission: {
          ...discordThreadAddress(thread, message),
          actor: { provider: 'discord', applicationId, guildId, externalUserId: user },
        },
      });
    expect(lane(threadChannelId, authorId, '789012345678901234')).toBe(
      lane(threadChannelId, authorId, '789012345678901235'),
    );
    expect(lane(threadChannelId, authorId, '789012345678901234')).not.toBe(
      lane(threadChannelId, '678901234567890124', '789012345678901234'),
    );
    expect(lane(threadChannelId, authorId, '789012345678901234')).not.toBe(
      lane(parentChannelId, authorId, '789012345678901234'),
    );
  }));
it('serializes concurrent mapping creation and capacity against the same application owner fence', () =>
  scoped(async () => {
    cap = 1;
    const results = await Promise.all([
      threads.bind(owner(), source(), binding),
      threads.bind(owner(), source('567890123456789013'), binding),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.find((result) => !result.ok)).toMatchObject({ error: { code: 'capacity' } });
    expect(await models.DiscordThreadRoute.countDocuments()).toBe(1);
    expect(await models.DiscordThreadPin.countDocuments()).toBe(1);
  }));
it('requires fresh current membership and archive/lock checks instead of treating the persisted mapping as a grant', () =>
  scoped(async () => {
    const privateSource = {
      ...source(),
      threadType: 12 as const,
      membership: { bot: true, author: true },
    };
    const route = unwrap(await threads.bind(owner(), privateSource, binding));
    for (const blocked of [
      { ...privateSource, archived: true },
      { ...privateSource, locked: true },
      { ...privateSource, membership: { bot: true, author: false } },
      { ...privateSource, permissions: { bot: '2048', author: required } },
    ]) {
      expect(await threads.authorize(authority(route, blocked))).toMatchObject({
        ok: false,
        error: { code: 'source_unavailable' },
      });
    }
    expect(unwrap(await threads.authorize(authority(route, privateSource)))).toEqual(route);
  }));
it('survives credential rotation but refuses stale owners and cross-tenant lookups', () =>
  scoped(async () => {
    const route = unwrap(await threads.bind(owner(), source(), binding));
    const oldOwner = owner();
    revision = unwrap(
      await installations.configureApplication({
        actorId: userId,
        applicationId,
        botUserId,
        publicKey: 'b'.repeat(64),
        expectedRevision: revision,
      }),
    ).revision;
    expect(await threads.read(oldOwner, threadChannelId)).toMatchObject({
      ok: false,
      error: { code: 'owner_changed' },
    });
    await gateway.release(oldOwner);
    await gateway.acquire(owner(), 30000);
    expect(unwrap(await threads.authorize(authority(route)))).toEqual(route);
    await scoped(async () => {
      expect(await threads.read(owner(), threadChannelId)).toMatchObject({
        ok: false,
        error: { code: 'owner_changed' },
      });
    }, 'foreign');
    expect(
      await threads.bind(
        owner(),
        { ...source('567890123456789014'), parentChannelId: '999999999999999999' },
        binding,
      ),
    ).toMatchObject({ ok: false, error: { code: 'route_changed' } });
  }));
it('requires a new thread after binding replacement even after private routing rows are erased', () =>
  scoped(async () => {
    const original = unwrap(await threads.bind(owner(), source(), binding));
    unwrap(
      await routes.remove({
        actorId: userId,
        installationId,
        externalChannelId: parentChannelId,
        expectedRevision: binding.routeRevision,
      }),
    );
    const replacement = await bindParent('replacement');
    expect(await threads.authorize(authority(original))).toMatchObject({
      ok: false,
      error: { code: 'route_changed' },
    });
    expect(await threads.bind(owner(), source(), replacement)).toMatchObject({
      ok: false,
      error: { code: 'route_changed' },
    });
    expect(await channels.deleteAgentChannel(binding.channelId, userId)).toEqual({
      status: 'deleted',
    });
    expect(await models.DiscordThreadRoute.countDocuments()).toBe(0);
    expect(await threads.read(owner(), threadChannelId)).toMatchObject({
      ok: false,
      error: { code: 'route_changed' },
    });
    const pin = await models.DiscordThreadPin.findOne().lean();
    expect(Object.keys(pin!).sort()).toEqual([
      '_id',
      'applicationId',
      'fingerprint',
      'threadChannelId',
    ]);
    expect(await threads.bind(owner(), source(), replacement)).toMatchObject({
      ok: false,
      error: { code: 'route_changed' },
    });
    cap = 1;
    expect(await threads.bind(owner(), source('567890123456789014'), replacement)).toMatchObject({
      ok: false,
      error: { code: 'capacity' },
    });
    cap = 2;
    expect(
      unwrap(await threads.bind(owner(), source('567890123456789014'), replacement)).channelId,
    ).toBe('replacement');
  }));
it('retains discoverable parents on erasure failure and clears private mappings on retry while preserving opaque pins', () =>
  scoped(async () => {
    unwrap(await threads.bind(owner(), source(), binding));
    const failed = jest
      .spyOn(models.DiscordThreadRoute.collection, 'deleteMany')
      .mockRejectedValueOnce(new Error('thread storage unavailable'));
    await expect(createUserMethods(db).deleteUserById(userId)).rejects.toThrow(
      'thread storage unavailable',
    );
    failed.mockRestore();
    expect(await models.DiscordApplication.exists({ applicationId })).not.toBeNull();
    expect(await models.DiscordThreadRoute.countDocuments()).toBe(1);
    expect((await createUserMethods(db).deleteUserById(userId)).deletedCount).toBe(1);
    expect(await models.DiscordThreadRoute.countDocuments()).toBe(0);
    expect(await models.DiscordThreadPin.countDocuments()).toBe(1);
    expect(await models.DiscordApplication.exists({ applicationId })).toBeNull();
  }));
