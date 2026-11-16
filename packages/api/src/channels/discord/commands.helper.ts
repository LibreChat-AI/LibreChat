import '~/mcp/registry/__tests__/helpers/setupCredsEnv';
import mongoose from 'mongoose';
import { generateKeyPairSync } from 'node:crypto';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import {
  PermissionBits,
  Permissions,
  PermissionTypes,
  parseDiscordControl,
} from 'librechat-data-provider';
import {
  createModels,
  createMethods,
  createDiscordInstallationStorage,
  createDiscordRouteStorage,
  createDiscordInboxStorage,
  createDiscordCommandStorage,
  createDiscordGatewayStorage,
  createChannelRunStorage,
  createChannelIdentityStorage,
  tenantStorage,
  runAsSystem,
} from '@librechat/data-schemas';
import type {
  DiscordIngressAction,
  DiscordNativeAuthority,
  DiscordPrivateReply,
  DiscordAgentChannel,
} from 'librechat-data-provider';
import type { DiscordInboxRecord } from '@librechat/data-schemas';
import type { DiscordObservation } from './observe';
import { createDiscordCommandExecutor } from './commands';
import { encryptCredential } from '~/crypto/credentials';
import { createChannelAuthority } from '../authority';
const keys = generateKeyPairSync('ed25519');
const publicKey = keys.publicKey
  .export({ type: 'spki', format: 'der' })
  .subarray(-32)
  .toString('hex');
const db = new mongoose.Mongoose();
const tenantId = 'discord-commands';
const owner = '000000000000000000000001';
const other = '000000000000000000000002';
const applicationId = '123456789012345678';
const guildId = '234567890123456789';
const botUserId = '345678901234567890';
const externalChannelId = '456789012345678901';
const externalUserId = '567890123456789012';
const otherActor = '567890123456789013';
const scope = <T>(run: () => Promise<T>) => tenantStorage.run({ tenantId }, run);
const unwrap = <T>(result: { ok: true; value: T } | { ok: false; error: { code: string } }): T => {
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
};
let mongo: MongoMemoryReplSet;
let models: ReturnType<typeof createModels>;
let channels: ReturnType<typeof createMethods>;
let installations: ReturnType<typeof createDiscordInstallationStorage>;
let inbox: ReturnType<typeof createDiscordInboxStorage>;
let runs: ReturnType<typeof createChannelRunStorage>;
let authority: ReturnType<typeof createChannelAuthority>;
const observations: DiscordObservation[] = [];
let execute: ReturnType<typeof createDiscordCommandExecutor>;
let channel: DiscordAgentChannel;
let applicationRevision: string;
let sequence: number;
let enabled: boolean;
let allowed: boolean;
let now: number;
const eventId = () =>
  String((BigInt(Date.now() + 2 - 1420070400000) << BigInt(22)) + BigInt(++sequence));
async function claim(action: DiscordIngressAction, actor = externalUserId, id = eventId()) {
  unwrap(
    await inbox.submit(
      {
        eventId: id,
        applicationId,
        applicationRevision,
        guildId,
        channelId: channel.channelId,
        channelRevision: channel.revision,
        agentId: channel.agentId,
        externalChannelId,
        externalUserId: actor,
        action,
        encryptedToken: 'sealed',
        tokenHash: 'a'.repeat(64),
        expiresAt: now + 900000,
      },
      now,
    ),
  );
  const record = await inbox.claim(applicationId, 'worker', now);
  if (!record || record.routing === 'inspection' || record.eventId !== id)
    throw new Error('Missing command claim');
  return {
    record,
    fence: { applicationId, eventId: id, owner: 'worker', epoch: record.leaseEpoch },
  };
}
function native(record: DiscordInboxRecord): DiscordNativeAuthority {
  return {
    kind: 'guild_text',
    owner: {
      applicationId,
      applicationRevision: record.applicationRevision,
      ownerId: 'a'.repeat(32),
    },
    source: {
      kind: 'guild_text',
      applicationId,
      guildId,
      botUserId,
      channelId: record.externalChannelId,
      permissions: '68608',
      authorId: record.externalUserId,
      authorMember: true,
      authorPermissions: '1024',
    },
  };
}
async function invoke(
  action: DiscordIngressAction,
  actor = externalUserId,
): Promise<DiscordPrivateReply> {
  const job = await claim(action, actor);
  const reply = await execute(job.record, job.fence, native(job.record));
  unwrap(await inbox.prepareReply(job.fence, 'sealed-reply', now));
  expect(await inbox.finish(job.fence, 'completed', now)).toBe(true);
  return reply;
}
async function accept(actor = externalUserId, userId = owner) {
  const issued = await invoke({ kind: 'link' }, actor);
  const action = issued.actions?.[0];
  if (!action || !('url' in action)) throw new Error('Missing consent URL');
  const secret = new URL(action.url).hash.slice(1);
  const principal = {
    tenantId,
    userId,
    accountLabel: userId === owner ? 'Account A' : 'Account B',
  };
  const preview = unwrap(await authority.identity.preview(principal, secret));
  unwrap(await authority.identity.accept(principal, secret, preview.revision));
  const card = await invoke({ kind: 'link' }, actor);
  const button = card.actions?.[0];
  if (!button || !('reference' in button)) throw new Error('Missing confirmation');
  const confirmation = parseDiscordControl(button.reference);
  if (!confirmation) throw new Error('Invalid confirmation');
  return { card, confirmation };
}
async function linked(actor = externalUserId, userId = owner) {
  const { confirmation } = await accept(actor, userId);
  expect((await invoke(confirmation, actor)).content).toContain('Your account is linked');
}
async function allRuns() {
  return models.ChannelRun.find().sort({ receivedAt: 1, runId: 1 }).lean();
}

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await db.connect(mongo.getUri(), { autoIndex: false });
  models = createModels(db);
  channels = createMethods(db);
}, 60000);
afterAll(async () => {
  await db.disconnect();
  await mongo?.stop();
});
beforeEach(async () => {
  observations.length = 0;
  now = Date.now();
  sequence = 0;
  enabled = allowed = true;
  await runAsSystem(async () => {
    for (const name of [
      'User',
      'Role',
      'DiscordApplication',
      'DiscordGuild',
      'DiscordRoute',
      'DiscordInbox',
      'DiscordThreadRoute',
      'DiscordThreadPin',
      'AgentChannel',
      'ChannelScope',
      'ResourceLock',
      'ChannelIdentity',
      'ChannelRun',
      'ChannelLane',
      'ResponseScope',
      'StoredResponse',
      'AgentApiKey',
    ])
      await db.models[name].deleteMany({});
  });
  installations = createDiscordInstallationStorage(db);
  inbox = createDiscordInboxStorage(db);
  runs = createChannelRunStorage(db);
  await scope(async () => {
    await models.User.create([
      { _id: owner, tenantId, role: 'USER', provider: 'local', email: 'a@example.test' },
      { _id: other, tenantId, role: 'USER', provider: 'local', email: 'b@example.test' },
    ]);
    await models.Role.create({
      name: 'USER',
      permissions: {
        [PermissionTypes.REMOTE_AGENTS]: { [Permissions.USE]: true },
        [PermissionTypes.AGENTS]: { [Permissions.USE]: true },
      },
    });
    applicationRevision = unwrap(
      await installations.configureApplication({
        actorId: owner,
        applicationId,
        botUserId,
        publicKey,
        encryptedBotToken: await encryptCredential('private-bot-token'),
        encryptedClientSecret: 'secret',
      }),
    ).revision;
    if (
      !(await createDiscordGatewayStorage(db, async () => ({
        ownershipLeaseMs: 30000,
        shardCount: 1,
      })).acquire({ applicationId, applicationRevision, ownerId: 'a'.repeat(32) }, 30000))
    )
      throw new Error('Missing application lease');
    const guild = unwrap(
      await installations.connectGuild({
        actorId: owner,
        applicationId,
        applicationRevision,
        guildId,
        guildName: 'Guild',
      }),
    );
    await channels.createAgentChannel({
      type: 'discord',
      channelId: 'channel',
      agentId: 'agent',
      tenantId,
      createdBy: owner,
      credentialMode: 'per_user',
      status: 'pending_install',
      revision: 'initial',
      installationId: guild.installationId,
      installationRevision: guild.revision,
      applicationRevision,
      discord: { applicationId, guildId, botUserId, externalChannelId },
    });
    unwrap(
      await createDiscordRouteStorage(db).assign({
        actorId: owner,
        installationId: guild.installationId,
        installationRevision: guild.revision,
        applicationRevision,
        channelId: 'channel',
        channelRevision: 'initial',
        externalChannelId,
      }),
    );
    const current = await channels.getAgentChannelMetadata('channel');
    if (!current || current.type !== 'discord') throw new Error('Missing channel');
    channel = current;
  });
  authority = createChannelAuthority({
    channels,
    identityStorage: createChannelIdentityStorage(db),
    authorizeDestination: (current, admission, principal) =>
      runs.authorizeDestination(
        {
          tenantId: current.tenantId,
          channelId: current.channelId,
          agentId: current.agentId,
          admission,
          principal,
        },
        Date.now(),
      ),
    getConfig: async () => ({ enabled }),
    findUser: (id) => channels.findUser({ _id: id }),
    getRole: (name) => models.Role.findOne({ name }),
    isPrincipalActive: async () => true,
    getAgentPermissions: async () => (allowed ? PermissionBits.VIEW : 0),
    publicBaseUrl: 'https://chat.example/prefix/',
  });
  execute = createDiscordCommandExecutor({
    observe: (event) => observations.push(event),
    channels,
    authority,
    runs,
    commands: createDiscordCommandStorage(db),
    enabled: async () => enabled,
    publicBaseUrl: 'https://chat.example/prefix/',
    now: () => now,
  });
});

export function setAllowed(value: boolean) {
  allowed = value;
}
export {
  observations,
  keys,
  db,
  tenantId,
  owner,
  other,
  applicationId,
  guildId,
  botUserId,
  externalChannelId,
  externalUserId,
  otherActor,
  scope,
  unwrap,
  models,
  channels,
  installations,
  inbox,
  runs,
  authority,
  execute,
  channel,
  applicationRevision,
  enabled,
  now,
  eventId,
  claim,
  native,
  invoke,
  accept,
  linked,
  allRuns,
};

export function advanceClock(ms: number) {
  now += ms;
}
