import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { discordThreadAddress } from 'librechat-data-provider';
import type {
  DiscordThreadRoute,
  DiscordRunEffectAuthority,
  DiscordGuildThreadSource,
  DiscordThreadBinding,
} from 'librechat-data-provider';
import type { ChannelRunEnrollment } from './channelProtocol';
import { createDiscordThreadStorage, touchDiscordThreadRoute } from './discordThread';
import { createDiscordInboxResolutionStorage } from './discordInboxResolution';
import { tenantStorage, runAsSystem } from '~/config/tenantContext';
import { createChannelIdentityStorage } from './channelIdentity';
import { createDiscordGatewayStorage } from './discordGateway';
import { withRequiredTransaction } from '~/utils/transactions';
import { createDiscordInstallationStorage } from './discord';
import { createDiscordInboxStorage } from './discordInbox';
import { createDiscordRouteStorage } from './discordRoute';
import { touchDiscordInbox } from './discordInboxScope';
import { createChannelRunStorage } from './channelRun';
import { createAgentChannelMethods } from './channel';
import { laneKey, digest } from './channelProtocol';
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

describe('owned interaction preflight', () => {
  const inbox = createDiscordInboxStorage(db);
  const resolution = createDiscordInboxResolutionStorage(db);
  async function job() {
    const now = Date.now();
    const eventId = '789012345678901234';
    const input = {
      routing: 'inspection' as const,
      eventId,
      applicationId,
      applicationRevision: revision,
      guildId,
      installationId,
      installationRevision,
      externalChannelId: threadChannelId,
      externalUserId: authorId,
      action: { kind: 'ask' as const, prompt: 'Private original prompt' },
      encryptedToken: 'sealed-token',
      tokenHash: 'a'.repeat(64),
      expiresAt: now + 900000,
    };
    unwrap(await inbox.submit(input, now));
    const claimed = await inbox.claim(applicationId, 'worker', now);
    if (!claimed) throw new Error('Missing pending job');
    const route = unwrap(await threads.bind(owner(), source(), binding));
    return {
      now,
      input,
      claimed,
      route,
      fence: { applicationId, eventId, owner: 'worker', epoch: claimed.leaseEpoch },
    };
  }
  it('resolves once per lease epoch and preserves original signed physical identity and dedup fingerprint', () =>
    scoped(async () => {
      const work = await job();
      const results = await Promise.all([
        resolution.resolve(work.fence, owner(), source(), work.route, work.now),
        resolution.resolve(work.fence, owner(), source(), work.route, work.now),
      ]);
      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(results.find((result) => !result.ok)).toEqual({
        ok: false,
        error: { code: 'stale_fence' },
      });
      const record = unwrap(results.find((result) => result.ok)!);
      expect(record).toMatchObject({
        routing: 'bound',
        eventId: work.input.eventId,
        applicationId,
        applicationRevision: revision,
        guildId,
        externalChannelId: threadChannelId,
        externalUserId: authorId,
        action: work.input.action,
        fingerprint: work.claimed.fingerprint,
        encryptedToken: 'sealed-token',
        channelId: binding.channelId,
        channelRevision: binding.channelRevision,
        agentId: 'agent',
        thread: { parentChannelId, mappingRevision: work.route.mappingRevision },
        inspectionEpoch: work.fence.epoch,
      });
      expect(
        await resolution.unavailable(work.fence, owner(), 'different-reply', work.now),
      ).toEqual({ ok: false, error: { code: 'stale_fence' } });
      expect(await inbox.submit(work.input, work.now)).toMatchObject({
        ok: true,
        value: { duplicate: true },
      });
      expect(await inbox.defer(work.fence, work.now + 1000, work.now)).toBe(true);
      const recovered = await inbox.claim(applicationId, 'replacement', work.now + 1000);
      expect(recovered).toMatchObject({
        routing: 'bound',
        externalChannelId: threadChannelId,
        thread: record.thread,
      });
      const next = { ...work.fence, owner: 'replacement', epoch: recovered!.leaseEpoch };
      expect(
        (await resolution.resolve(next, owner(), source(), work.route, work.now + 1000)).ok,
      ).toBe(true);
      expect(
        (await resolution.resolve(work.fence, owner(), source(), work.route, work.now + 1000)).ok,
      ).toBe(false);
    }));
  it('does not reuse the same parent inbox lease to authorize another actual thread', () =>
    scoped(async () => {
      const work = await job();
      unwrap(await resolution.resolve(work.fence, owner(), source(), work.route, work.now));
      const scope = {
        tenantId,
        channelId: binding.channelId,
        externalUserId: authorId,
        applicationRevision: revision,
      };
      expect(
        await withRequiredTransaction(db, (session) =>
          touchDiscordInbox(
            db,
            { ...scope, externalChannelId: parentChannelId },
            work.fence,
            work.now,
            session,
          ),
        ),
      ).toBe(false);
      expect(
        await withRequiredTransaction(db, (session) =>
          touchDiscordInbox(
            db,
            { ...scope, externalChannelId: threadChannelId },
            work.fence,
            work.now,
            session,
          ),
        ),
      ).toBe(true);
    }));
  it('rejects a changed actor or physical destination before reserving execution', () =>
    scoped(async () => {
      const work = await job();
      for (const changed of [
        { authorId: parentChannelId },
        { threadChannelId: authorId },
        { guildId: parentChannelId },
        { parentChannelId: authorId },
      ])
        expect(
          await resolution.resolve(
            work.fence,
            owner(),
            { ...source(), ...changed },
            work.route,
            work.now,
          ),
        ).toEqual({ ok: false, error: { code: 'authority_changed' } });
      expect(
        (await resolution.resolve(work.fence, owner(), source(), work.route, work.now)).ok,
      ).toBe(true);
    }));
  it('prepares an immutable terminal unavailable reply without fabricating a channel binding', () =>
    scoped(async () => {
      const work = await job();
      const prepared = unwrap(
        await resolution.unavailable(work.fence, owner(), 'sealed-unavailable', work.now),
      );
      expect(prepared).toMatchObject({
        routing: 'inspection',
        state: 'reply',
        encryptedReply: 'sealed-unavailable',
      });
      expect(prepared).not.toHaveProperty('channelId');
      expect(
        unwrap(await resolution.unavailable(work.fence, owner(), 'replacement', work.now))
          .encryptedReply,
      ).toBe('sealed-unavailable');
      expect(
        (await resolution.resolve(work.fence, owner(), source(), work.route, work.now)).ok,
      ).toBe(false);
      const reply = await inbox.claim(applicationId, 'next-worker', work.now + 30000);
      expect(reply).toMatchObject({
        state: 'reply',
        routing: 'inspection',
        encryptedReply: 'sealed-unavailable',
      });
    }));
  it('rejects expired inbox leases and lost application ownership for inspection, resolution and unavailable replies', () =>
    scoped(async () => {
      const work = await job();
      expect(await resolution.inspect(work.fence, owner(), work.now + 30000)).toBeNull();
      expect(
        (await resolution.resolve(work.fence, owner(), source(), work.route, work.now + 30000)).ok,
      ).toBe(false);
      expect(
        (await resolution.unavailable(work.fence, owner(), 'sealed', work.now + 30000)).ok,
      ).toBe(false);
      expect(await gateway.release(owner())).toBe(true);
      expect(await resolution.inspect(work.fence, owner(), work.now)).toBeNull();
      expect(
        (await resolution.resolve(work.fence, owner(), source(), work.route, work.now)).ok,
      ).toBe(false);
      expect((await resolution.unavailable(work.fence, owner(), 'sealed', work.now)).ok).toBe(
        false,
      );
    }));
  it('does not expose a bound prepared reply through resolution after the parent route is revoked', () =>
    scoped(async () => {
      const work = await job();
      unwrap(await resolution.resolve(work.fence, owner(), source(), work.route, work.now));
      unwrap(await inbox.prepareReply(work.fence, 'sealed-private-reply', work.now));
      unwrap(
        await routes.remove({
          actorId: userId,
          installationId,
          externalChannelId: parentChannelId,
          expectedRevision: binding.routeRevision,
        }),
      );
      expect(await resolution.inspect(work.fence, owner(), work.now)).toBeNull();
      expect((await resolution.unavailable(work.fence, owner(), 'replacement', work.now)).ok).toBe(
        false,
      );
    }));
  it('fences parent replacement and source permissions without exposing stored prompts across tenants', () =>
    scoped(async () => {
      const work = await job();
      expect(
        await scoped(() => resolution.inspect(work.fence, owner(), work.now), 'other-tenant'),
      ).toBeNull();
      expect(
        (
          await resolution.resolve(
            work.fence,
            owner(),
            { ...source(), locked: true },
            work.route,
            work.now,
          )
        ).ok,
      ).toBe(false);
      unwrap(
        await routes.remove({
          actorId: userId,
          installationId,
          externalChannelId: parentChannelId,
          expectedRevision: binding.routeRevision,
        }),
      );
      expect(
        (await resolution.resolve(work.fence, owner(), source(), work.route, work.now)).ok,
      ).toBe(false);
    }));
});

describe('native run authority', () => {
  const runs = createChannelRunStorage(db);
  async function candidate(): Promise<{
    input: ChannelRunEnrollment;
    now: number;
    proof: DiscordRunEffectAuthority;
  }> {
    const now = Date.now();
    const eventId = ((BigInt(now) - BigInt(1420070400000)) << BigInt(22)).toString();
    const route = unwrap(await threads.bind(owner(), source(), binding));
    expect(
      await createChannelIdentityStorage(db).saveChannelIdentity(
        {
          tenantId,
          linkId: 'thread-link',
          revision: 'link-revision',
          state: 'active',
          userId,
          ticketHash: 'private-ticket',
          ticketExpiresAtMs: now + 900000,
          expiresAtMs: now + 900000,
          identity: {
            tenantId,
            channelId: binding.channelId,
            channelRevision: binding.channelRevision,
            agentId: 'agent',
            provider: 'discord',
            applicationId,
            guildId,
            externalUserId: authorId,
          },
        },
        null,
        revision,
      ),
    ).toBe(true);
    // Fixture represents server-confirmed consent preceding the physical event.
    await models.ChannelIdentity.updateOne(
      { linkId: 'thread-link' },
      { $set: { discordActivatedAtMs: now - 1 } },
    );
    const native = { kind: 'guild_thread' as const, owner: owner(), source: source() };
    const input: ChannelRunEnrollment = {
      tenantId,
      channelId: binding.channelId,
      agentId: 'agent',
      applicationRevision: revision,
      discordAuthority: native,
      principal: {
        userId,
        channelRevision: binding.channelRevision,
        linkId: 'thread-link',
        linkRevision: 'link-revision',
      },
      admission: {
        actor: { provider: 'discord', applicationId, guildId, externalUserId: authorId },
        eventId,
        input: 'Original native prompt',
        ...discordThreadAddress(threadChannelId, eventId),
        discordDestination: {
          kind: 'guild_thread',
          parentChannelId,
          mappingRevision: route.mappingRevision,
        },
      },
    };
    return { input, now, proof: { applicationRevision: revision, native } };
  }
  async function claimed() {
    const value = await candidate();
    const admitted = await runs.admit(value.input, value.now);
    const run = await runs.claim(tenantId, binding.channelId, 'worker', value.now, 60000);
    if (!run) throw new Error('Missing native run');
    return {
      ...value,
      run: admitted.run,
      fence: { runId: run.runId, owner: 'worker', epoch: run.leaseEpoch },
    };
  }
  it('persists only immutable destination metadata and separates lanes by mapping generation', () =>
    scoped(async () => {
      const { input, now } = await candidate();
      const admitted = await runs.admit(input, now);
      expect(admitted.run.admission).toEqual(input.admission);
      expect(admitted.run.payloadHash).toBe(digest(input.admission));
      expect(admitted.run).not.toHaveProperty('discordAuthority');
      expect(admitted.run).not.toHaveProperty('applicationRevision');
      expect(JSON.stringify(admitted.run)).not.toContain('permissions');
      const original = laneKey(input);
      expect(
        laneKey({
          ...input,
          admission: {
            ...input.admission,
            discordDestination: {
              kind: 'guild_thread',
              parentChannelId,
              mappingRevision: 'different',
            },
          },
        }),
      ).not.toBe(original);
      expect(await runs.authorizeDestination(input, now)).toBe(true);
      await expect(
        runs.authorizeDestination(
          { ...input, admission: { ...input.admission, externalChannelId: parentChannelId } },
          now,
        ),
      ).rejects.toThrow();
    }));
  it('rejects missing, stale-owner or mismatched physical source proofs before admission', () =>
    scoped(async () => {
      const { input, now } = await candidate();
      await expect(
        runs.admit({ ...input, discordAuthority: undefined }, now),
      ).rejects.toMatchObject({ code: 'invalid_transition' });
      if (input.discordAuthority?.kind !== 'guild_thread') throw new Error('Missing thread proof');
      for (const actual of [
        { ...source(), authorId: botUserId },
        { ...source(), threadChannelId: authorId },
        { ...source(), locked: true },
      ])
        await expect(
          runs.admit(
            { ...input, discordAuthority: { ...input.discordAuthority, source: actual } },
            now,
          ),
        ).rejects.toMatchObject({ code: 'invalid_transition' });
      expect(await gateway.release(owner())).toBe(true);
      await expect(runs.admit(input, now)).rejects.toMatchObject({ code: 'invalid_transition' });
      expect(await models.ChannelRun.countDocuments()).toBe(0);
    }));
  it('keeps original consent time and refuses old prompts after a new link activation', () =>
    scoped(async () => {
      const { input, now } = await candidate();
      await models.ChannelIdentity.updateOne(
        { linkId: 'thread-link' },
        { $set: { discordActivatedAtMs: now } },
      );
      await expect(runs.admit(input, now + 1000)).rejects.toMatchObject({
        code: 'invalid_transition',
      });
      expect(await models.ChannelRun.countDocuments()).toBe(0);
    }));
  it('requires fresh source for first execution while continuation retains the granted identity', () =>
    scoped(async () => {
      const value = await claimed();
      await expect(
        runs.prepareExecution(tenantId, value.fence, value.now, revision),
      ).rejects.toMatchObject({ code: 'invalid_transition' });
      const prepared = await runs.prepareExecution(tenantId, value.fence, value.now, value.proof);
      expect(prepared.execution?.requestId).toBe(value.run.runId);
      expect(await gateway.release(owner())).toBe(true);
      const continued = await runs.prepareExecution(tenantId, value.fence, value.now, revision);
      expect(continued.execution).toEqual(prepared.execution);
      unwrap(
        await routes.remove({
          actorId: userId,
          installationId,
          externalChannelId: parentChannelId,
          expectedRevision: binding.routeRevision,
        }),
      );
      await expect(
        runs.prepareExecution(tenantId, value.fence, value.now, revision),
      ).rejects.toMatchObject({ code: 'invalid_transition' });
      expect(await runs.authorizeDestination(value.input, value.now)).toBe(false);
    }));
  it.each(['progress', 'delivery'] as const)(
    'joins every %s begin to fresh owned source but permits receipt settlement after owner loss',
    async (effect) =>
      scoped(async () => {
        const value = await claimed();
        if (effect === 'progress')
          await runs.planProgress(
            tenantId,
            value.fence,
            { revision: 1, rendererVersion: 'discord-progress-v1', text: 'Working' },
            value.now,
          );
        else {
          await runs.prepareExecution(tenantId, value.fence, value.now, value.proof);
          await models.StoredResponse.create({
            tenantId,
            userId,
            responseId: 'response',
            requestKey: `channel:${value.run.runId}`,
            fingerprint: 'request',
            agentId: 'agent',
            requestJSON: JSON.stringify({
              model: 'agent',
              input: value.input.admission.input,
              background: true,
              store: true,
            }),
            conversationId: 'conversation',
            parentMessageId: 'parent',
            status: 'queued',
            revision: 0,
          });
          await runs.bindResponse(tenantId, value.fence, 'response', value.now);
          await runs.saveSnapshot(
            tenantId,
            value.fence,
            { status: 'completed', text: 'Answer', responseId: 'response', elapsedMs: 1 },
            value.now,
          );
          await runs.savePlan(
            tenantId,
            value.fence,
            {
              revision: 'plan',
              rendererVersion: 'discord-text-v1',
              parts: [{ operationId: 'answer', kind: 'message', required: true, text: 'Answer' }],
            },
            value.now,
          );
        }
        const begin = (proof?: string | DiscordRunEffectAuthority) =>
          effect === 'progress'
            ? runs.beginProgress(tenantId, value.fence, 1, value.now, proof)
            : runs.beginDelivery(tenantId, value.fence, 'answer', value.now, proof);
        await expect(begin(revision)).rejects.toMatchObject({ code: 'invalid_transition' });
        expect(value.proof.native?.kind).toBe('guild_thread');
        if (value.proof.native?.kind !== 'guild_thread') throw new Error('Missing proof');
        await expect(
          begin({
            ...value.proof,
            native: { ...value.proof.native, source: { ...source(), archived: true } },
          }),
        ).rejects.toMatchObject({ code: 'invalid_transition' });
        await begin(value.proof);
        expect(await gateway.release(owner())).toBe(true);
        await expect(begin(value.proof)).rejects.toMatchObject({ code: 'invalid_transition' });
        const externalMessageKey = `${threadChannelId}:789012345678901234`;
        const settled =
          effect === 'progress'
            ? await runs.settleProgress(
                tenantId,
                value.fence,
                { revision: 1, outcome: 'confirmed', attempts: 1, externalMessageKey },
                value.now,
              )
            : await runs.settleDelivery(
                tenantId,
                value.fence,
                { operationId: 'answer', outcome: 'confirmed', attempts: 1, externalMessageKey },
                value.now,
              );
        expect(
          effect === 'progress' ? settled.progress?.outcome : settled.receipts[0].outcome,
        ).toBe('confirmed');
      }),
  );
});
