import mongoose from 'mongoose';
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
  createChannelRunStorage,
  createChannelIdentityStorage,
  tenantStorage,
  runAsSystem,
} from '@librechat/data-schemas';
import type {
  DiscordIngressAction,
  DiscordPrivateReply,
  DiscordAgentChannel,
} from 'librechat-data-provider';
import type { DiscordInboxRecord } from '@librechat/data-schemas';
import { createDiscordCommandExecutor } from './commands';
import { createChannelAuthority } from '../authority';

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
let execute: ReturnType<typeof createDiscordCommandExecutor>;
let channel: DiscordAgentChannel;
let applicationRevision: string;
let sequence: number;
let enabled: boolean;
let allowed: boolean;
let now: number;
const eventId = () => String(BigInt('700000000000000000') + BigInt(++sequence));
async function claim(action: DiscordIngressAction, actor = externalUserId) {
  const id = eventId();
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
async function invoke(
  action: DiscordIngressAction,
  actor = externalUserId,
): Promise<DiscordPrivateReply> {
  const job = await claim(action, actor);
  const reply = await execute(job.record, job.fence);
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
      'AgentChannel',
      'ChannelScope',
      'ChannelIdentity',
      'ChannelRun',
      'ChannelLane',
      'ResponseScope',
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
        publicKey: 'a'.repeat(64),
        encryptedBotToken: 'sealed',
        encryptedClientSecret: 'secret',
      }),
    ).revision;
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
    getConfig: async () => ({ enabled }),
    findUser: (id) => channels.findUser({ _id: id }),
    getRole: (name) => models.Role.findOne({ name }),
    isPrincipalActive: async () => true,
    getAgentPermissions: async () => (allowed ? PermissionBits.VIEW : 0),
    publicBaseUrl: 'https://chat.example/prefix/',
  });
  execute = createDiscordCommandExecutor({
    channels,
    authority,
    runs,
    commands: createDiscordCommandStorage(db),
    enabled: async () => enabled,
    publicBaseUrl: 'https://chat.example/prefix/',
    now: () => now,
  });
});

it('requires browser consent and confirmation by the original Discord actor before admission', () =>
  scope(async () => {
    const first = await invoke({ kind: 'ask', prompt: 'Private prompt' });
    expect(first.content).toContain('visible to members');
    expect(first.content).toContain('will not run automatically');
    expect(await allRuns()).toHaveLength(0);
    const { card, confirmation } = await accept();
    expect(card.content).toContain('Account A');
    expect((await invoke(confirmation, otherActor)).content).toContain('no longer available');
    expect(await allRuns()).toHaveLength(0);
    expect((await invoke(confirmation)).content).toContain('Your account is linked');
    expect((await invoke({ kind: 'ask', prompt: 'New prompt' })).content).toContain('queued');
    const stored = await allRuns();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      principal: { userId: owner },
      admission: { input: 'New prompt', actor: { provider: 'discord', externalUserId } },
    });
    expect(stored[0].admission.externalThreadKey).toBe(
      `${externalChannelId}:${stored[0].admission.eventId}`,
    );
  }));

it('deduplicates ask retries and keeps separate commands in separate conversation lanes', () =>
  scope(async () => {
    await linked();
    const job = await claim({ kind: 'ask', prompt: 'Once' });
    await execute(job.record, job.fence);
    await execute(job.record, job.fence);
    expect(await allRuns()).toHaveLength(1);
    unwrap(await inbox.prepareReply(job.fence, 'reply', now));
    await inbox.finish(job.fence, 'completed', now);
    await invoke({ kind: 'ask', prompt: 'Separate' });
    const stored = await allRuns();
    expect(stored).toHaveLength(2);
    expect(new Set(stored.map((run) => run.laneId)).size).toBe(2);
  }));

it('shows owned status and preserves proxy prefixes in authenticated review links', () =>
  scope(async () => {
    await linked();
    expect((await invoke({ kind: 'status' })).content).toContain('no retained run');
    await invoke({ kind: 'ask', prompt: 'Question' });
    const [run] = await allRuns();
    await models.ChannelRun.updateOne(
      { runId: run.runId },
      {
        $set: {
          state: 'requires_action',
          execution: {
            protocol: 'responses',
            responseId: 'response',
            conversationId: 'conversation',
            requestId: 'request',
            parentMessageId: 'parent',
          },
        },
      },
    );
    const reply = await invoke({ kind: 'status' });
    expect(reply.content).toContain('waiting for your review');
    expect(reply.actions).toEqual([
      {
        label: 'Review in LibreChat',
        url: 'https://chat.example/prefix/responses/response/review',
      },
    ]);
    await linked(otherActor, other);
    expect((await invoke({ kind: 'status' }, otherActor)).content).toContain('no retained run');
  }));

it('freezes cancellation across a replay even if another run is admitted later', () =>
  scope(async () => {
    await linked();
    await invoke({ kind: 'ask', prompt: 'First' });
    const [first] = await allRuns();
    const job = await claim({ kind: 'cancel' });
    expect((await execute(job.record, job.fence)).content).toContain('Cancellation requested');
    const second = await runs.admit(
      {
        tenantId,
        channelId: channel.channelId,
        agentId: channel.agentId,
        applicationRevision,
        principal: first.principal,
        admission: {
          ...first.admission,
          eventId: eventId(),
          externalThreadKey: `${externalChannelId}:later`,
          input: 'Later',
        },
      },
      now + 1,
    );
    expect((await execute(job.record, job.fence)).content).toContain('Cancellation requested');
    const persisted = await models.ChannelRun.findOne({ runId: second.run.runId }).lean();
    expect(persisted?.cancellationRequested).toBe(false);
    unwrap(await inbox.prepareReply(job.fence, 'reply', now));
    await inbox.finish(job.fence, 'completed', now);
    expect(
      await db
        .model<DiscordInboxRecord>('DiscordInbox')
        .findOne({ eventId: job.record.eventId })
        .select('+commandResult')
        .lean(),
    ).not.toHaveProperty('commandResult');
  }));

it('binds native cancellation to the current actor and a confirmed source message', () =>
  scope(async () => {
    await linked();
    await invoke({ kind: 'ask', prompt: 'Working' });
    const [run] = await allRuns();
    const messageId = '890123456789012345';
    await models.ChannelRun.updateOne(
      { runId: run.runId },
      {
        $set: {
          progress: {
            revision: 1,
            rendererVersion: 'discord-progress-v1',
            text: 'Working',
            outcome: 'confirmed',
            attempts: 1,
            externalMessageKey: `${externalChannelId}:${messageId}`,
          },
        },
      },
    );
    expect(
      (await invoke({ kind: 'cancel', reference: run.runId, messageId: '890123456789012346' }))
        .content,
    ).toContain('no active run');
    await linked(otherActor, other);
    expect(
      (await invoke({ kind: 'cancel', reference: run.runId, messageId }, otherActor)).content,
    ).toContain('no active run');
    expect((await invoke({ kind: 'cancel', reference: run.runId, messageId })).content).toContain(
      'Cancellation requested',
    );
  }));

it('fails closed on revoked permissions, stale application authority and stale command leases', () =>
  scope(async () => {
    await linked();
    const denied = await claim({ kind: 'ask', prompt: 'Denied' });
    allowed = false;
    await execute(denied.record, denied.fence);
    expect(await allRuns()).toHaveLength(0);
    allowed = true;
    now += 30000;
    const reclaimed = await inbox.claim(applicationId, 'replacement', now);
    expect(reclaimed?.eventId).toBe(denied.record.eventId);
    await expect(execute(denied.record, denied.fence)).rejects.toMatchObject({
      code: 'stale_fence',
    });
    const fresh = { ...denied.fence, owner: 'replacement', epoch: reclaimed!.leaseEpoch };
    unwrap(
      await installations.configureApplication({
        actorId: owner,
        applicationId,
        botUserId,
        publicKey: 'b'.repeat(64),
        encryptedBotToken: 'new',
        expectedRevision: applicationRevision,
      }),
    );
    await expect(execute(denied.record, fresh)).rejects.toMatchObject({
      code: 'invalid_transition',
    });
    expect(await allRuns()).toHaveLength(0);
  }));
