import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type {
  DiscordAgentChannel,
  DiscordChannelConfig,
  DiscordDmResult,
  DiscordNativeAuthority,
} from 'librechat-data-provider';
import type { ChannelIdentityRecord } from '~/models/channelIdentity';
import type { DiscordDmDestinationScope } from './discordDm';
import {
  createDiscordDmStorage,
  hashDiscordDmCode,
  touchDiscordDmSelection,
  touchDiscordDmDestination,
  authorizeDiscordDmDestination,
} from './discordDm';
import { createDiscordDmCodeModel, createDiscordDmSelectionModel } from '~/models/discordDm';
import { closeChannelScope, retireAgentChannel } from './channelScope';
import { tenantStorage, runAsSystem } from '~/config/tenantContext';
import { eraseChannelPersistenceForUser } from './channelErasure';
import { createChannelIdentityStorage } from './channelIdentity';
import { withRequiredTransaction } from '~/utils/transactions';
import { createDiscordGatewayStorage } from './discordGateway';
import { createDiscordInstallationStorage } from './discord';
import { createDiscordRouteStorage } from './discordRoute';
import { closeResponseScopes } from './responseScope';
import { createAgentChannelMethods } from './channel';
import { createModels } from '~/models';

const db = new mongoose.Mongoose();
const models = createModels(db);
const owner = '000000000000000000000001';
const user = '000000000000000000000002';
const outsider = '000000000000000000000003';
const applicationId = '123456789012345678';
const guildId = '234567890123456789';
const externalUserId = '345678901234567890';
const botUserId = '456789012345678901';
const dmChannelId = '567890123456789012';
let tenantId: string | undefined;
let applicationRevision: string;
let installationId: string;
let installationRevision: string;
let channel: DiscordAgentChannel;
let now: number;
let policy: Partial<DiscordChannelConfig['dm']>;
let mongo: MongoMemoryReplSet;
const scope = <T>(work: () => Promise<T>) => tenantStorage.run({ tenantId }, work);
const store = createDiscordDmStorage(db, async () => policy);
const installs = createDiscordInstallationStorage(db);
const channels = createAgentChannelMethods(db);
const identities = createChannelIdentityStorage(db);
const codes = createDiscordDmCodeModel(db);
const selections = createDiscordDmSelectionModel(db);
const value = <T>(result: DiscordDmResult<T>): T => {
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
};
const request = (index = 0, actor = externalUserId) => ({
  linkId: `link-${index}-${actor}`,
  expectedLinkRevision: 'link-revision',
});
const lookup = (code: string, actor = externalUserId) => ({
  applicationId,
  applicationRevision,
  externalUserId: actor,
  codeHash: hashDiscordDmCode(code),
});
const consume = (
  code: string,
  change: Partial<Parameters<typeof store.consume>[0]> = {},
  at = now,
) =>
  store.consume(
    { ...lookup(code), dmChannelId, confirmationEventId: '678901234567890123', ...change },
    at,
  );
const current = (at = now) =>
  store.current({ applicationId, applicationRevision, externalUserId, dmChannelId }, at);
const issue = async (index = 0, actor = externalUserId) =>
  value(await store.issue(user, request(index, actor), now));
async function link(index = 0, actor = externalUserId) {
  const record: ChannelIdentityRecord = {
    tenantId: tenantId || '_',
    linkId: request(index, actor).linkId,
    revision: 'link-revision',
    userId: user,
    state: 'active',
    ticketHash: `${index}${actor}`.padEnd(64, 'a'),
    ticketExpiresAtMs: now + 600000,
    expiresAtMs: now + 172800000,
    identity: {
      provider: 'discord',
      tenantId: tenantId || '_',
      channelId: channel.channelId,
      channelRevision: channel.revision,
      agentId: channel.agentId,
      applicationId,
      guildId,
      externalUserId: actor,
    },
  };
  if (!(await identities.saveChannelIdentity(record, null, applicationRevision)))
    throw new Error('Fixture link unavailable');
}
async function binding(index = 0) {
  const candidate = await channels.createAgentChannel({
    type: 'discord',
    tenantId,
    channelId: `channel-${index}`,
    revision: `revision-${index}`,
    agentId: `agent-${index}`,
    createdBy: owner,
    status: 'pending_install',
    credentialMode: 'per_user',
    installationId,
    installationRevision,
    applicationRevision,
    discord: {
      applicationId,
      guildId,
      botUserId,
      externalChannelId: String(BigInt('789012345678901234') + BigInt(index)),
    },
  });
  if (candidate.type !== 'discord') throw new Error('Fixture provider changed');
  const assigned = await createDiscordRouteStorage(db).assign({
    actorId: owner,
    applicationRevision,
    installationId,
    installationRevision,
    channelId: candidate.channelId,
    channelRevision: candidate.revision,
    externalChannelId: candidate.discord.externalChannelId,
  });
  if (!assigned.ok) throw new Error(assigned.error.code);
  const record = await channels.getAgentChannelMetadata(candidate.channelId);
  if (!record || record.type !== 'discord') throw new Error('Fixture channel unavailable');
  channel = record;
  await link(index);
}
async function setup() {
  for (const [id, name] of [
    [owner, 'owner'],
    [user, 'user'],
    [outsider, 'other'],
  ])
    await models.User.create({
      _id: id,
      tenantId,
      email: `${name}@example.test`,
      provider: 'local',
    });
  const app = await installs.configureApplication({
    actorId: owner,
    applicationId,
    botUserId,
    publicKey: 'a'.repeat(64),
    encryptedBotToken: 'encrypted',
    encryptedClientSecret: 'encrypted-client',
  });
  if (!app.ok) throw new Error(app.error.code);
  applicationRevision = app.value.revision;
  const guild = await installs.connectGuild({
    actorId: owner,
    applicationId,
    applicationRevision,
    guildId,
    guildName: 'Source guild',
  });
  if (!guild.ok) throw new Error(guild.error.code);
  installationId = guild.value.installationId;
  installationRevision = guild.value.revision;
  await binding();
}
beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await db.connect(mongo.getUri());
  await runAsSystem(async () => Promise.all(Object.values(db.models).map((model) => model.init())));
}, 60000);
afterAll(async () => {
  await db.disconnect();
  await mongo?.stop();
});
beforeEach(async () => {
  await runAsSystem(async () => {
    for (const collection of Object.values(db.connection.collections))
      await collection.deleteMany({});
  });
  tenantId = 'dm-org';
  now = Date.now();
  policy = { enabled: true };
  await scope(setup);
});
it('issues only for an owned active source link and persists a hidden hash, never the raw code', () =>
  scope(async () => {
    expect(await store.issue(outsider, request(), now)).toMatchObject({ ok: false });
    expect(
      await store.issue(user, { ...request(), expectedLinkRevision: 'old' }, now),
    ).toMatchObject({ ok: false });
    const issued = await issue();
    expect(issued.expiresAtMs).toBe(now + 600000);
    expect(issued.code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await codes.findOne().lean()).not.toHaveProperty('codeHash');
    const raw = await codes.collection.findOne({});
    expect(raw?.codeHash).toBe(hashDiscordDmCode(issued.code));
    expect(JSON.stringify(raw)).not.toContain(issued.code);
    expect(await store.resolvePending(lookup(issued.code), now)).toMatchObject({
      guildId,
      channelId: channel.channelId,
      userId: user,
    });
    expect(await models.ChannelRun.countDocuments()).toBe(0);
  }));
it('pages owner selections without hashes, including disabled cleanup and unavailable source records', () =>
  scope(async () => {
    const issued = await issue();
    const selected = value(await consume(issued.code));
    await selections.insertMany(
      Array.from({ length: 101 }, (_, index) => ({
        ...selected,
        selectionId: `page-${String(index).padStart(3, '0')}`,
        dmChannelId: String(9000 + index),
        state: 'active',
        purgeAt: new Date(selected.expiresAtMs),
      })),
    );
    policy = {};
    const first = await store.list(user);
    expect(first.selections).toHaveLength(100);
    expect(first.next).toBeDefined();
    const second = await store.list(user, first.next);
    expect(second.selections).toHaveLength(2);
    expect(second.next).toBeUndefined();
    expect(await store.list(outsider)).toEqual({ selections: [] });
    expect(JSON.stringify(first)).not.toContain('codeHash');
  }));
it('reissues one pending code per application actor and rejects expired rows before TTL cleanup', () =>
  scope(async () => {
    const old = await issue();
    const fresh = await issue();
    expect(await store.resolvePending(lookup(old.code), now)).toBeNull();
    expect(await codes.countDocuments()).toBe(1);
    expect(await store.resolvePending(lookup(fresh.code), fresh.expiresAtMs)).toBeNull();
    expect(await consume(fresh.code, {}, fresh.expiresAtMs)).toMatchObject({ ok: false });
    expect(await codes.countDocuments()).toBe(1);
  }));
it('consumes once and preserves first event, generation and expiry on replay beyond the pending-code lifetime', () =>
  scope(async () => {
    const issued = await issue();
    const selected = value(await consume(issued.code));
    expect(selected).toMatchObject({
      scope: 'dm',
      dmChannelId,
      confirmationEventId: '678901234567890123',
      expiresAtMs: now + 86400000,
      source: { guildId, externalChannelId: channel.discord.externalChannelId },
    });
    expect(value(await consume(issued.code, { confirmationEventId: '999' }, now + 700000))).toEqual(
      selected,
    );
    expect(await current()).toEqual(selected);
    expect(await selections.countDocuments()).toBe(1);
    expect(await current(selected.expiresAtMs)).toBeNull();
    expect(await consume(issued.code, {}, selected.expiresAtMs)).toMatchObject({ ok: false });
  }));
it('reads the active selection once per current lookup', () =>
  scope(async () => {
    const issued = await issue();
    value(await consume(issued.code));
    const reads = jest.spyOn(selections, 'findOne');
    try {
      expect(await current()).not.toBeNull();
      expect(reads).toHaveBeenCalledTimes(1);
    } finally {
      reads.mockRestore();
    }
  }));
it('acknowledges concurrent identical selections with one immutable generation and no runs', () =>
  scope(async () => {
    const issued = await issue();
    const results = await Promise.all([consume(issued.code), consume(issued.code)]);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(value(results[0])).toEqual(value(results[1]));
    expect(await selections.countDocuments()).toBe(1);
    expect(await models.ChannelRun.countDocuments()).toBe(0);
  }));
it('binds the code to application, actor, tenant and the first actual DM destination', () =>
  scope(async () => {
    const issued = await issue();
    for (const change of [
      { applicationId: '999' },
      { externalUserId: '999' },
      { applicationRevision: 'old' },
    ])
      expect(await consume(issued.code, change)).toMatchObject({ ok: false });
    await tenantStorage.run({ tenantId: 'foreign' }, async () => {
      expect(await consume(issued.code)).toMatchObject({ ok: false });
    });
    const results = await Promise.all([
      consume(issued.code),
      consume(issued.code, { dmChannelId: '999' }),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(await selections.countDocuments()).toBe(1);
  }));
it('replaces the current generation without letting the previous code or proof restore it', () =>
  scope(async () => {
    const firstCode = await issue();
    const first = value(await consume(firstCode.code));
    await binding(1);
    const nextCode = await issue(1);
    const next = value(await consume(nextCode.code, { confirmationEventId: '888' }));
    expect(next.selectionId).not.toBe(first.selectionId);
    expect(next.source.agentId).toBe('agent-1');
    expect(await consume(firstCode.code)).toMatchObject({ ok: false });
    expect(await codes.countDocuments()).toBe(1);
    const touch = (selected: typeof first) =>
      withRequiredTransaction(db, (session) =>
        touchDiscordDmSelection(
          db,
          {
            applicationId,
            applicationRevision,
            externalUserId,
            dmChannelId,
            selectionId: selected.selectionId,
            revision: selected.revision,
          },
          now,
          session,
        ),
      );
    expect(await touch(first)).toBe(false);
    expect(await touch(next)).toBe(true);
  }));
it('revokes only for the exact browser owner/revision and denies restored consumed receipts while disabled cleanup remains possible', () =>
  scope(async () => {
    const issued = await issue();
    const selected = value(await consume(issued.code));
    const receipt = await codes.collection.findOne({});
    expect(await store.revoke(outsider, selected.selectionId, selected.revision)).toBe(false);
    expect(await store.revoke(user, selected.selectionId, 'old')).toBe(false);
    policy = {};
    expect(await store.revoke(user, selected.selectionId, selected.revision)).toBe(true);
    if (!receipt) throw new Error('Missing receipt');
    await codes.collection.insertOne(receipt);
    policy = { enabled: true };
    expect(await consume(issued.code)).toMatchObject({ ok: false });
    expect(await current()).toBeNull();
  }));
it('serializes pending capacity across actors while allowing same-actor reissue at capacity', () =>
  scope(async () => {
    await link(0, '999');
    policy = { enabled: true, maxPendingPerApplication: 1 };
    const results = await Promise.all([
      store.issue(user, request(), now),
      store.issue(user, request(0, '999'), now),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      { ok: false, error: { code: 'capacity' } },
    ]);
    const winner = results[0].ok ? externalUserId : '999';
    expect((await store.issue(user, request(0, winner), now)).ok).toBe(true);
    expect(
      (await store.issue(user, request(0, winner === '999' ? externalUserId : '999'), now + 600001))
        .ok,
    ).toBe(true);
  }));
it('bounds active selection capacity independently of TTL deletion and clamps expiry to the real source consent', () =>
  scope(async () => {
    policy = { enabled: true, maxSelectionsPerApplication: 1, selectionTtlMs: 604800000 };
    const a = await issue();
    const first = value(await consume(a.code));
    expect(first.expiresAtMs).toBe(now + 172800000);
    const b = await issue();
    expect(await consume(b.code, { dmChannelId: '999' })).toEqual({
      ok: false,
      error: { code: 'capacity' },
    });
    expect(value(await consume(b.code)).selectionId).not.toBe(first.selectionId);
  }));
it('ignores an expired selection for capacity even while its TTL row is retained', () =>
  scope(async () => {
    policy = { enabled: true, maxSelectionsPerApplication: 1 };
    const issued = await issue();
    value(await consume(issued.code));
    const later = now + 86400001;
    const next = value(await store.issue(user, request(), later));
    expect((await consume(next.code, { dmChannelId: '999' }, later)).ok).toBe(true);
    expect(await selections.countDocuments()).toBe(2);
  }));
it.each(['link', 'channel', 'installation', 'user', 'application-owner'])(
  'invalidates source authority after %s changes',
  (changed) =>
    scope(async () => {
      const issued = await issue();
      value(await consume(issued.code));
      if (changed === 'link')
        await identities.revokeChannelIdentity(
          {
            tenantId: tenantId || '_',
            userId: user,
            linkId: request().linkId,
            revision: 'link-revision',
          },
          'revoked',
        );
      if (changed === 'channel') await closeChannelScope(db, tenantId, channel.channelId);
      if (changed === 'installation') {
        const disconnected = await installs.disconnectGuild({
          actorId: owner,
          installationId,
          expectedRevision: installationRevision,
        });
        if (!disconnected.ok) throw new Error(disconnected.error.code);
        expect(
          (
            await installs.connectGuild({
              actorId: owner,
              applicationId,
              applicationRevision,
              guildId,
              guildName: 'Reconnected',
              installationId,
              expectedRevision: disconnected.value.revision,
            })
          ).ok,
        ).toBe(true);
      }
      if (changed === 'user' || changed === 'application-owner')
        await models.User.updateOne(
          { _id: changed === 'user' ? user : owner },
          { $set: { agentTriggerDeletionStartedAt: new Date() } },
        );
      expect(await current()).toBeNull();
      expect(await consume(issued.code)).toMatchObject({ ok: false });
      expect(await store.issue(user, request(), now)).toMatchObject({ ok: false });
    }),
);
it('fences current application revision without changing a surviving selection generation', () =>
  scope(async () => {
    const issued = await issue();
    const selected = value(await consume(issued.code));
    const stale = lookup(issued.code);
    const rotated = await installs.configureApplication({
      actorId: owner,
      applicationId,
      botUserId,
      publicKey: 'b'.repeat(64),
      expectedRevision: applicationRevision,
    });
    if (!rotated.ok) throw new Error(rotated.error.code);
    applicationRevision = rotated.value.revision;
    expect(
      await store.consume({ ...stale, dmChannelId, confirmationEventId: '999' }, now),
    ).toMatchObject({ ok: false });
    expect(await current()).toEqual(selected);
  }));
it('fails closed on malformed restored identities, parents and mixed code source scopes', () =>
  scope(async () => {
    await models.ChannelIdentity.collection.updateOne(
      { linkId: request().linkId },
      { $set: { identity: null } },
    );
    expect(await store.issue(user, request(), now)).toMatchObject({ ok: false });
    await models.ChannelIdentity.deleteMany({});
    await link();
    const issued = await issue();
    await codes.collection.updateOne(
      { codeHash: hashDiscordDmCode(issued.code) },
      { $set: { 'source.externalUserId': '999' } },
    );
    expect(await consume(issued.code)).toMatchObject({ ok: false });
    await models.AgentChannel.collection.updateOne(
      { channelId: channel.channelId },
      { $unset: { discord: '' } },
    );
    expect(await store.issue(user, request(), now)).toMatchObject({ ok: false });
  }));
it('retains disabled defaults without persisting private data', () =>
  scope(async () => {
    policy = {};
    expect(await store.issue(user, request(), now)).toEqual({
      ok: false,
      error: { code: 'disabled' },
    });
    expect(await current()).toBeNull();
    expect(await codes.countDocuments()).toBe(0);
  }));
it('keeps exact existing selection metadata available while disabled without creating new authority', () =>
  scope(async () => {
    const issued = await issue();
    const selected = value(await consume(issued.code));
    const reference = {
      applicationId,
      externalUserId,
      dmChannelId,
      selectionId: selected.selectionId,
      revision: selected.revision,
    };
    policy = {};
    expect(await current()).toBeNull();
    expect(await store.reference(reference, now)).toEqual(selected);
    expect(await store.reference({ ...reference, revision: 'other' }, now)).toBeNull();
    expect(await store.reference(reference, selected.expiresAtMs)).toBeNull();
    await models.DiscordApplication.collection.updateOne(
      { applicationId },
      { $set: { revision: '' } },
    );
    expect(await store.reference(reference, now)).toBeNull();
    await models.DiscordApplication.collection.updateOne(
      { applicationId },
      { $set: { revision: applicationRevision } },
    );
    await models.ChannelIdentity.updateOne(
      { linkId: selected.source.linkId },
      { state: 'revoked' },
    );
    expect(await store.reference(reference, now)).toBeNull();
  }));
it('erases account-owned DM rows after admission closure and keeps unrelated account data', () =>
  scope(async () => {
    const issued = await issue();
    value(await consume(issued.code));
    await closeResponseScopes(db, { userId: user, tenantId });
    await runAsSystem(() => eraseChannelPersistenceForUser(db, { userId: user, tenantId }));
    expect(await codes.countDocuments()).toBe(0);
    expect(await selections.countDocuments()).toBe(0);
    expect(await models.User.exists({ _id: owner })).toBeTruthy();
  }));
it('erases orphaned private DM rows when the application owner drains its guilds', () =>
  scope(async () => {
    const issued = await issue();
    value(await consume(issued.code));
    await models.AgentChannel.collection.deleteMany({});
    await closeResponseScopes(db, { userId: owner, tenantId });
    await eraseChannelPersistenceForUser(db, { userId: owner, tenantId });
    expect(await codes.countDocuments()).toBe(0);
    expect(await selections.countDocuments()).toBe(0);
  }));
it('cleans channel-owned rows and supports tenantless canonical records without crossing tenants', async () => {
  await scope(async () => {
    const issued = await issue();
    value(await consume(issued.code));
    await retireAgentChannel(db, { tenantId, channelId: channel.channelId, createdBy: owner });
    expect(await selections.countDocuments()).toBe(0);
  });
  await runAsSystem(async () => {
    for (const collection of Object.values(db.connection.collections))
      await collection.deleteMany({});
  });
  tenantId = undefined;
  await scope(async () => {
    await setup();
    const issued = await issue();
    expect(value(await consume(issued.code)).source.guildId).toBe(guildId);
    expect(await current()).not.toBeNull();
  });
});

const snowflake = (at: number) => String((BigInt(at - 1420070400000) << BigInt(22)) + BigInt(1));
async function destinationScope(): Promise<DiscordDmDestinationScope> {
  const issued = await issue();
  const selected = value(await consume(issued.code, { confirmationEventId: snowflake(now) }));
  const eventId = snowflake(now + 1);
  return {
    tenantId,
    channelId: selected.source.channelId,
    agentId: selected.source.agentId,
    applicationRevision,
    principal: {
      userId: user,
      channelRevision: selected.source.channelRevision,
      linkId: selected.source.linkId,
      linkRevision: selected.source.linkRevision,
    },
    now,
    admission: {
      eventId,
      externalChannelId: dmChannelId,
      externalThreadKey: `${dmChannelId}:${selected.confirmationEventId}`,
      externalMessageKey: `${dmChannelId}:${eventId}`,
      actor: {
        provider: 'discord',
        scope: 'dm',
        applicationId,
        externalUserId,
        selectionId: selected.selectionId,
        selectionRevision: selected.revision,
      },
      discordDestination: {
        kind: 'dm',
        parentChannelId: selected.source.externalChannelId,
        selectionId: selected.selectionId,
        selectionRevision: selected.revision,
      },
      input: 'private prompt',
    },
  };
}
const touchDestination = (input: DiscordDmDestinationScope) =>
  withRequiredTransaction(db, (session) => touchDiscordDmDestination(db, input, session));
async function destinationAuthority(): Promise<Extract<DiscordNativeAuthority, { kind: 'dm' }>> {
  const gateway = createDiscordGatewayStorage(db, async () => ({
    ownershipLeaseMs: 30000,
    shardCount: 1,
  }));
  const native: Extract<DiscordNativeAuthority, { kind: 'dm' }> = {
    kind: 'dm',
    owner: { applicationId, applicationRevision, ownerId: 'a'.repeat(32) },
    source: {
      kind: 'guild_text',
      applicationId,
      botUserId,
      guildId,
      channelId: channel.discord.externalChannelId,
      permissions: '68608',
      authorId: externalUserId,
      authorMember: true,
      authorPermissions: '1024',
    },
  };
  expect(await gateway.acquire(native.owner, 30000)).toBe(true);
  return native;
}
const authorizeDestination = (
  input: DiscordDmDestinationScope,
  native: Extract<DiscordNativeAuthority, { kind: 'dm' }>,
) =>
  withRequiredTransaction(db, (session) =>
    authorizeDiscordDmDestination(db, input, native, session),
  );

it('joins exact DM destination metadata without granting fresh provider permission', () =>
  scope(async () => {
    const input = await destinationScope();
    expect(await touchDestination(input)).toBe(true);
    const native = await destinationAuthority();
    expect(await authorizeDestination(input, native)).toBe(true);
    await models.ResourceLock.deleteMany({});
    expect(await touchDestination(input)).toBe(true);
    expect(await authorizeDestination(input, native)).toBe(false);
  }));
it('requires original prompt snowflakes after both native consent and explicit DM selection', () =>
  scope(async () => {
    const input = await destinationScope();
    const prompt = { ...input, promptEventAtMs: now + 1 };
    expect(await touchDestination(prompt)).toBe(false);
    await models.ChannelIdentity.collection.updateOne(
      { linkId: input.principal.linkId },
      { $set: { discordActivatedAtMs: now - 1 } },
    );
    expect(await touchDestination(prompt)).toBe(true);
    expect(await touchDestination({ ...prompt, promptEventAtMs: now })).toBe(false);
    const eventId = snowflake(now);
    expect(
      await touchDestination({
        ...prompt,
        promptEventAtMs: now,
        admission: {
          ...input.admission,
          eventId,
          externalMessageKey: `${dmChannelId}:${eventId}`,
        },
      }),
    ).toBe(false);
    await models.ChannelIdentity.collection.updateOne(
      { linkId: input.principal.linkId },
      { $set: { discordActivatedAtMs: now + 1 } },
    );
    expect(await touchDestination(prompt)).toBe(false);
    expect(await touchDestination(input)).toBe(true);
  }));
it.each([
  'principal',
  'agent',
  'parent',
  'dm',
  'thread',
  'message',
  'actor',
  'generation',
  'application',
])('rejects a mismatched DM %s scope', (changed) =>
  scope(async () => {
    const input = await destinationScope();
    if (changed === 'principal') input.principal.linkRevision = 'other';
    if (changed === 'agent') input.agentId = 'other';
    if (changed === 'parent' && input.admission.discordDestination)
      input.admission.discordDestination.parentChannelId = '999';
    if (changed === 'dm') input.admission.externalChannelId = '999';
    if (changed === 'thread') input.admission.externalThreadKey = `${dmChannelId}:999`;
    if (changed === 'message') input.admission.externalMessageKey = `${dmChannelId}:999`;
    if (changed === 'actor') input.admission.actor.externalUserId = '999';
    if (changed === 'generation' && input.admission.actor.scope === 'dm')
      input.admission.actor.selectionRevision = 'other';
    if (changed === 'application') input.applicationRevision = 'other';
    expect(await touchDestination(input)).toBe(false);
  }),
);
it.each([
  'author',
  'membership',
  'visibility',
  'bot',
  'guild',
  'parent',
  'permissions',
  'owner',
  'application',
])('rejects fresh DM source authority with changed %s', (changed) =>
  scope(async () => {
    const input = await destinationScope();
    const native = await destinationAuthority();
    if (changed === 'author') native.source.authorId = '999';
    if (changed === 'membership') Object.assign(native.source, { authorMember: false });
    if (changed === 'visibility') native.source.authorPermissions = '0';
    if (changed === 'bot') native.source.botUserId = '999';
    if (changed === 'guild') native.source.guildId = '999';
    if (changed === 'parent') native.source.channelId = '999';
    if (changed === 'permissions') native.source.permissions = '1024';
    if (changed === 'owner') native.owner.ownerId = 'b'.repeat(32);
    if (changed === 'application') native.owner.applicationRevision = 'other';
    expect(await authorizeDestination(input, native)).toBe(false);
  }),
);
it.each([
  'replacement',
  'revocation',
  'expiry',
  'source-link',
  'source-expiry',
  'closure',
  'owner',
])('invalidates canonical DM authority after %s without relying on TTL', (changed) =>
  scope(async () => {
    const input = await destinationScope();
    const selected = await current();
    if (!selected) throw new Error('Fixture selection missing');
    if (changed === 'replacement') {
      const issued = await issue();
      value(await consume(issued.code));
    }
    if (changed === 'revocation')
      expect(await store.revoke(user, selected.selectionId, selected.revision)).toBe(true);
    if (changed === 'expiry') input.now = selected.expiresAtMs;
    if (changed === 'source-link')
      await models.ChannelIdentity.updateOne(
        { linkId: selected.source.linkId },
        { state: 'revoked' },
      );
    if (changed === 'source-expiry')
      await models.ChannelIdentity.updateOne(
        { linkId: selected.source.linkId },
        { expiresAtMs: now },
      );
    if (changed === 'closure') await closeChannelScope(db, tenantId, channel.channelId);
    if (changed === 'owner') await closeResponseScopes(db, { userId: owner, tenantId });
    expect(await touchDestination(input)).toBe(false);
  }),
);
it('rejects cross-tenant and malformed raw DM selection authority', () =>
  scope(async () => {
    const input = await destinationScope();
    await expect(touchDestination({ ...input, tenantId: 'other' })).rejects.toThrow(
      'tenant mismatch',
    );
    await selections.collection.updateOne({}, { $set: { 'source.teamId': 'T' } });
    expect(await touchDestination(input)).toBe(false);
  }));
it('cannot commit authority from a snapshot predating concurrent selection replacement', () =>
  scope(async () => {
    const input = await destinationScope();
    const issued = await issue();
    const session = await db.startSession();
    try {
      session.startTransaction();
      await selections.findOne({}).session(session).lean();
      value(await consume(issued.code));
      await expect(touchDiscordDmDestination(db, input, session)).rejects.toHaveProperty(
        'code',
        112,
      );
      expect(await touchDestination(input)).toBe(false);
    } finally {
      await session.abortTransaction();
      await session.endSession();
    }
  }));
