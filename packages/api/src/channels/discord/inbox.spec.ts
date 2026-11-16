import '~/mcp/registry/__tests__/helpers/setupCredsEnv';
import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { discordInboxResolutionSchema } from 'librechat-data-provider';
import {
  createModels,
  createMethods,
  createDiscordInstallationStorage,
  createDiscordRouteStorage,
  createDiscordInboxStorage,
  createDiscordGatewayStorage,
  createDiscordThreadStorage,
  createDiscordInboxResolutionStorage,
  tenantStorage,
  runAsSystem,
  getTenantId,
} from '@librechat/data-schemas';
import type {
  DiscordInboxSubmission,
  DiscordPrivateReply,
  DiscordGuildThreadSource,
} from 'librechat-data-provider';
import type { DiscordInboxRecord } from '@librechat/data-schemas';
import type { DiscordInboxServiceDependencies } from './inbox';
import type { DiscordObservation } from './observe';
import { createDiscordInboxService, discordInteractionExpiry } from './inbox';
import { encryptCredential, decryptCredential } from '~/crypto/credentials';
import { createDiscordInboxHandlers } from './inboxHttp';
import { createDiscordRouteResolver } from './routes';

const db = new mongoose.Mongoose();
const tenantId = 'discord-inbox-api';
const owner = '000000000000000000000001';
const applicationId = '123456789012345678';
const guildId = '234567890123456789';
const botUserId = '345678901234567890';
const externalChannelId = '456789012345678901';
const externalUserId = '567890123456789012';
const token = 'private-interaction-token';
const serviceToken = 'service-private-'.repeat(4);
const scope = <T>(run: () => Promise<T>) => tenantStorage.run({ tenantId }, run);
const unwrap = <T>(result: { ok: true; value: T } | { ok: false; error: { code: string } }): T => {
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
};
const observations: DiscordObservation[] = [];
let mongo: MongoMemoryReplSet;
let installations: ReturnType<typeof createDiscordInstallationStorage>;
let storage: ReturnType<typeof createDiscordInboxStorage>;
let resolver: ReturnType<typeof createDiscordRouteResolver>;
let service: ReturnType<typeof createDiscordInboxService>;
let deps: DiscordInboxServiceDependencies;
let app: express.Express;
let applicationRevision: string;
let now: number;
let eventId: string;
let enabled: boolean;
let executions: number;
let execute: () => Promise<DiscordPrivateReply>;
function input(overrides: Partial<DiscordInboxSubmission> = {}): DiscordInboxSubmission {
  return {
    applicationId,
    expectedApplicationRevision: applicationRevision,
    guildId,
    externalChannelId,
    externalUserId,
    eventId,
    token,
    action: { kind: 'status' },
    ...overrides,
  };
}
function mount(instance = service) {
  const handlers = createDiscordInboxHandlers({
    service: instance,
    observe: (event) => observations.push(event),
    serviceToken: () => serviceToken,
  });
  app = express();
  app.use(express.json());
  for (const name of ['submit', 'claim', 'resolve', 'finish', 'defer'] as const)
    app.post(`/${name}`, handlers[name]);
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
  observations.length = 0;
  now = Date.now();
  eventId = ((BigInt(now - 10) - BigInt(1420070400000)) << BigInt(22)).toString();
  enabled = true;
  executions = 0;
  await runAsSystem(async () => {
    for (const name of [
      'User',
      'DiscordApplication',
      'DiscordGuild',
      'DiscordRoute',
      'DiscordInbox',
      'AgentChannel',
      'ChannelScope',
      'ResourceLock',
      'DiscordThreadRoute',
      'DiscordThreadPin',
    ])
      await db.models[name].deleteMany({});
  });
  installations = createDiscordInstallationStorage(db);
  const channels = createMethods(db);
  const routes = createDiscordRouteStorage(db);
  storage = createDiscordInboxStorage(db);
  resolver = createDiscordRouteResolver({
    installations,
    channels,
    routes,
    enabled: async () => enabled,
  });
  await scope(async () => {
    await db.models.User.create({
      _id: owner,
      tenantId,
      email: 'owner@example.test',
      provider: 'local',
    });
    const application = unwrap(
      await installations.configureApplication({
        actorId: owner,
        applicationId,
        botUserId,
        publicKey: 'a'.repeat(64),
        encryptedBotToken: 'sealed',
        encryptedClientSecret: 'sealed-secret',
      }),
    );
    applicationRevision = application.revision;
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
      tenantId,
      channelId: 'channel',
      agentId: 'agent',
      createdBy: owner,
      status: 'pending_install',
      credentialMode: 'per_user',
      revision: 'initial',
      installationId: guild.installationId,
      installationRevision: guild.revision,
      applicationRevision,
      discord: { applicationId, guildId, botUserId, externalChannelId },
    });
    unwrap(
      await routes.assign({
        actorId: owner,
        installationId: guild.installationId,
        installationRevision: guild.revision,
        applicationRevision,
        externalChannelId,
        channelId: 'channel',
        channelRevision: 'initial',
      }),
    );
  });
  execute = async () => ({ content: 'Accepted.' });
  deps = {
    observe: (event) => observations.push(event),
    storage,
    resolver,
    encrypt: encryptCredential,
    decrypt: decryptCredential,
    retryDelayMs: async () => 1000,
    now: () => now,
    execute: async (record, fence) => {
      expect(getTenantId()).toBe(tenantId);
      expect(record.applicationRevision).toBe(applicationRevision);
      expect(fence).toMatchObject({ applicationId, eventId });
      executions++;
      return execute();
    },
  };
  service = createDiscordInboxService(deps);
  mount();
});

it('persists before admission and exposes tokens only through authenticated claims', async () => {
  const response = await request(app)
    .post('/submit')
    .set('authorization', `Bearer ${serviceToken}`)
    .send(input())
    .expect(201);
  expect(JSON.stringify(response.body)).not.toContain(token);
  expect(response.headers['cache-control']).toBe('no-store');
  await scope(async () => {
    const record = await db
      .model<DiscordInboxRecord>('DiscordInbox')
      .findOne({ eventId })
      .select('+encryptedToken')
      .lean();
    expect(record?.encryptedToken).not.toContain(token);
    if (!record?.encryptedToken) throw new Error('Missing encrypted token');
    expect(await decryptCredential(record.encryptedToken)).toBe(token);
  });
  const claimed = await request(app)
    .post('/claim')
    .set('authorization', `Bearer ${serviceToken}`)
    .send({ applicationId, owner: 'worker' })
    .expect(200);
  expect(claimed.body).toMatchObject({
    token,
    reply: { content: 'Accepted.' },
    fence: { applicationId, eventId, owner: 'worker' },
  });
  expect(executions).toBe(1);
  await request(app)
    .post('/finish')
    .set('authorization', `Bearer ${serviceToken}`)
    .send({ fence: claimed.body.fence, result: 'completed' })
    .expect(204);
  await request(app)
    .post('/submit')
    .set('authorization', `Bearer ${serviceToken}`)
    .send(input())
    .expect(200);
  await scope(async () => {
    const record = await db
      .model<DiscordInboxRecord>('DiscordInbox')
      .findOne({ eventId })
      .select('+encryptedToken +encryptedReply +action')
      .lean();
    expect(record).toMatchObject({ state: 'done' });
    for (const key of ['encryptedToken', 'encryptedReply', 'action'])
      expect(record).not.toHaveProperty(key);
  });
});

it('requires service authentication and rejects tenant injection on every route', async () => {
  for (const path of ['submit', 'claim', 'resolve', 'finish', 'defer']) {
    await request(app).post(`/${path}`).send(input()).expect(401);
    await request(app)
      .post(`/${path}`)
      .set('authorization', `Bearer ${serviceToken}`)
      .send({ ...input(), tenantId: 'foreign' })
      .expect(400);
  }
  expect(await scope(async () => db.models.DiscordInbox.countDocuments())).toBe(0);
});

it('derives the tenant from canonical ownership despite the caller context', async () => {
  await tenantStorage.run({ tenantId: 'foreign' }, async () => {
    expect((await service.submit(input())).ok).toBe(true);
    expect(await service.claim(applicationId, 'worker')).toMatchObject({ token });
  });
  expect(await scope(async () => db.models.DiscordInbox.countDocuments())).toBe(1);
});

it('uses the interaction timestamp for a stable token expiry and deduplication', async () => {
  expect(discordInteractionExpiry(eventId)).toBe(now - 10 + 900000);
  unwrap(await service.submit(input()));
  now += 5000;
  expect(unwrap(await service.submit(input())).duplicate).toBe(true);
  const expired = ((BigInt(now - 900001) - BigInt(1420070400000)) << BigInt(22)).toString();
  expect(await service.submit(input({ eventId: expired }))).toMatchObject({
    ok: false,
    error: { code: 'expired' },
  });
  const future = ((BigInt(now + 60000) - BigInt(1420070400000)) << BigInt(22)).toString();
  expect(await service.submit(input({ eventId: future }))).toMatchObject({
    ok: false,
    error: { code: 'expired' },
  });
});

it('replays a prepared reply after lease loss without executing the command twice', async () => {
  unwrap(await service.submit(input()));
  const first = await service.claim(applicationId, 'worker');
  expect(first).not.toBeNull();
  now += 30000;
  const second = await service.claim(applicationId, 'replacement');
  if (!first || !second || 'inspection' in first || 'inspection' in second)
    throw new Error('Expected prepared replies');
  expect(second.reply).toEqual(first.reply);
  expect(second.token).toBe(token);
  expect(executions).toBe(1);
  expect(await service.finish(first!.fence, 'completed')).toBe(false);
  expect(await service.finish(second!.fence, 'completed')).toBe(true);
});

it('defers operational failures and never exposes sensitive diagnostics', async () => {
  execute = async () => {
    throw new Error(`provider echo ${token}`);
  };
  unwrap(await service.submit(input()));
  const response = await request(app)
    .post('/claim')
    .set('authorization', `Bearer ${serviceToken}`)
    .send({ applicationId, owner: 'worker' })
    .expect(503);
  expect(response.body).toEqual({ error: 'discord_interaction_unavailable' });
  expect(await service.claim(applicationId, 'worker')).toBeNull();
  now += 1000;
  execute = async () => ({ content: 'Recovered.' });
  expect(await service.claim(applicationId, 'worker')).toMatchObject({
    reply: { content: 'Recovered.' },
  });
});

it('rejects stale routes, disabled ingress and rotated application authority', async () => {
  expect(await service.submit(input({ expectedApplicationRevision: 'stale' }))).toMatchObject({
    ok: false,
  });
  expect(await service.submit(input({ guildId: '789012345678901234' }))).toMatchObject({
    ok: false,
  });
  unwrap(await service.submit(input()));
  await scope(async () =>
    unwrap(
      await installations.configureApplication({
        actorId: owner,
        applicationId,
        botUserId,
        publicKey: 'b'.repeat(64),
        encryptedBotToken: 'rotated',
        expectedRevision: applicationRevision,
      }),
    ),
  );
  expect(await service.claim(applicationId, 'worker')).toBeNull();
  enabled = false;
  expect(await service.submit(input())).toMatchObject({
    ok: false,
    error: { code: 'authority_changed' },
  });
  expect(await service.claim(applicationId, 'worker')).toBeNull();
  expect(executions).toBe(0);
});

it('validates private reply size and link protocols before persistence', async () => {
  execute = async () => ({
    content: 'Unsafe',
    actions: [{ label: 'Open', url: 'javascript:alert(1)' }],
  });
  unwrap(await service.submit(input()));
  await request(app)
    .post('/claim')
    .set('authorization', `Bearer ${serviceToken}`)
    .send({ applicationId, owner: 'worker' })
    .expect(503);
  await scope(async () =>
    expect(
      await db.models.DiscordInbox.findOne({ eventId }).select('+encryptedReply').lean(),
    ).not.toHaveProperty('encryptedReply'),
  );
});

it('drops expired tokens even when command execution finishes after their lifetime', async () => {
  execute = async () => {
    now += 900000;
    return { content: 'Too late' };
  };
  unwrap(await service.submit(input()));
  expect(await service.claim(applicationId, 'worker')).toBeNull();
  await scope(async () => {
    const record = await db
      .model<DiscordInboxRecord>('DiscordInbox')
      .findOne({ eventId })
      .select('+encryptedToken')
      .lean();
    expect(record).not.toHaveProperty('encryptedToken');
  });
});

it('erases expired credentials when command execution fails after expiry', async () => {
  execute = async () => {
    now += 900000;
    throw new Error('Unavailable');
  };
  unwrap(await service.submit(input()));
  await expect(service.claim(applicationId, 'worker')).rejects.toThrow('Unavailable');
  await scope(async () => {
    const record = await db
      .model<DiscordInboxRecord>('DiscordInbox')
      .findOne({ eventId })
      .select('+encryptedToken')
      .lean();
    expect(record).toMatchObject({ state: 'failed', result: 'expired' });
    expect(record).not.toHaveProperty('encryptedToken');
  });
});

it('returns a nonsecret inspection lease without decrypting or executing an unresolved command', async () => {
  await scope(async () => {
    const guild = await installations.resolveGuild(applicationId, guildId);
    if (!guild) throw new Error('Missing guild');
    unwrap(
      await storage.submit(
        {
          routing: 'inspection',
          applicationId,
          applicationRevision,
          guildId,
          installationId: guild.installationId,
          installationRevision: guild.revision,
          externalChannelId: '678901234567890123',
          externalUserId,
          eventId,
          action: { kind: 'ask', prompt: 'Never expose this prompt' },
          encryptedToken: 'deliberately-not-decryptable',
          tokenHash: 'a'.repeat(64),
          expiresAt: now + 60000,
        },
        now,
      ),
    );
  });
  const response = await request(app)
    .post('/claim')
    .set('Authorization', `Bearer ${serviceToken}`)
    .send({ applicationId, owner: 'worker' });
  expect(response.status).toBe(200);
  expect(response.body).toEqual({
    fence: { applicationId, eventId, owner: 'worker', epoch: 1 },
    applicationRevision,
    expiresAt: now + 60000,
    inspection: { guildId, externalChannelId: '678901234567890123', externalUserId },
  });
  expect(executions).toBe(0);
  expect(JSON.stringify(response.body)).not.toMatch(/token|prompt|agentId|channelRevision/);
});

describe('owned thread resolution', () => {
  const threadChannelId = '678901234567890123';
  const ownerScope = () => ({ applicationId, applicationRevision, ownerId: 'a'.repeat(32) });
  const source = (): DiscordGuildThreadSource => ({
    kind: 'guild_thread',
    applicationId,
    botUserId,
    guildId,
    parentChannelId: externalChannelId,
    threadChannelId,
    authorId: externalUserId,
    threadType: 11,
    archived: false,
    locked: false,
    permissions: { bot: String(BigInt(1024 | 65536) | (BigInt(1) << BigInt(38))), author: '1024' },
    membership: { bot: false, author: false },
  });
  let threadExecutions: jest.Mock;
  async function pending() {
    const gateway = createDiscordGatewayStorage(db, async () => ({
      ownershipLeaseMs: 30000,
      shardCount: 1,
    }));
    await scope(async () => {
      expect(await gateway.acquire(ownerScope(), 30000)).toBe(true);
      const guild = await installations.resolveGuild(applicationId, guildId);
      if (!guild) throw new Error('Missing guild');
      unwrap(
        await storage.submit(
          {
            routing: 'inspection',
            applicationId,
            applicationRevision,
            guildId,
            installationId: guild.installationId,
            installationRevision: guild.revision,
            externalChannelId: threadChannelId,
            externalUserId,
            eventId,
            action: { kind: 'ask', prompt: 'Original thread prompt' },
            encryptedToken: await encryptCredential(token),
            tokenHash: 'a'.repeat(64),
            expiresAt: now + 60000,
          },
          now,
        ),
      );
    });
    threadExecutions = jest.fn(async () => ({ content: 'Thread accepted.' }));
    deps.inspection = {
      storage: createDiscordInboxResolutionStorage(db),
      threads: createDiscordThreadStorage(db, async () => ({ maxThreadRoutes: 10 })),
      execute: threadExecutions,
    };
    service = createDiscordInboxService(deps);
    mount();
    const claimed = await request(app)
      .post('/claim')
      .set('Authorization', `Bearer ${serviceToken}`)
      .send({ applicationId, owner: 'worker' })
      .expect(200);
    return { fence: claimed.body.fence, owner: ownerScope(), source: source() };
  }
  const resolve = (value: object) =>
    request(app).post('/resolve').set('Authorization', `Bearer ${serviceToken}`).send(value);
  it('derives the parent binding server-side and replays only the committed private reply', async () => {
    const value = await pending();
    const result = await resolve(value).expect(200);
    expect(result.body.reply).toEqual({ content: 'Thread accepted.' });
    expect(threadExecutions).toHaveBeenCalledTimes(1);
    expect(threadExecutions.mock.calls[0]).toEqual([
      expect.objectContaining({
        eventId,
        externalChannelId: threadChannelId,
        externalUserId,
        channelId: 'channel',
        thread: expect.objectContaining({ parentChannelId: externalChannelId }),
      }),
      value.fence,
      { kind: 'guild_thread', owner: value.owner, source: value.source },
    ]);
    expect(executions).toBe(0);
    expect((await resolve(value).expect(200)).body).toEqual(result.body);
    expect(threadExecutions).toHaveBeenCalledTimes(1);
  });
  it('reserves one executor per lease epoch across concurrent resolve requests', async () => {
    const value = await pending();
    let entered: () => void = () => {};
    let release: () => void = () => {};
    const started = new Promise<void>((done) => {
      entered = done;
    });
    const gate = new Promise<void>((done) => {
      release = done;
    });
    threadExecutions.mockImplementation(async () => {
      entered();
      await gate;
      return { content: 'Once.' };
    });
    const first = resolve(value).then((response) => response);
    await started;
    await resolve(value).expect(409);
    await resolve({ ...value, source: null }).expect(409);
    release();
    expect((await first).status).toBe(200);
    expect(threadExecutions).toHaveBeenCalledTimes(1);
  });
  it('prepares a terminal safe unavailable reply and cannot later turn it into executable work', async () => {
    const value = await pending();
    const failed = await resolve({ ...value, source: null }).expect(200);
    expect(failed.body.reply.content).toContain('destination is unavailable');
    expect(threadExecutions).not.toHaveBeenCalled();
    expect((await resolve(value).expect(200)).body).toEqual(failed.body);
    expect(threadExecutions).not.toHaveBeenCalled();
    now += 30000;
    const retry = await request(app)
      .post('/claim')
      .set('Authorization', `Bearer ${serviceToken}`)
      .send({ applicationId, owner: 'next-worker' })
      .expect(200);
    expect(retry.body.reply).toEqual(failed.body.reply);
    expect(retry.body.token).toBe(token);
    expect(threadExecutions).not.toHaveBeenCalled();
  });
  it('rejects expired fences and protects the resolver without disclosing prompts', async () => {
    const value = await pending();
    await request(app).post('/resolve').send(value).expect(401);
    await resolve({ ...value, tenantId: 'forged' }).expect(400);
    now += 30000;
    const result = await resolve(value).expect(409);
    expect(JSON.stringify(result.body)).not.toContain('Original thread prompt');
    expect(threadExecutions).not.toHaveBeenCalled();
  });
  it('defers operational failure through the same inbox and requires a new inspected lease for recovery', async () => {
    const value = await pending();
    threadExecutions.mockRejectedValueOnce(new Error('secret token Original thread prompt'));
    const failure = await resolve(value).expect(503);
    expect(failure.body).toEqual({ error: 'discord_interaction_unavailable' });
    now += 1000;
    const next = await request(app)
      .post('/claim')
      .set('Authorization', `Bearer ${serviceToken}`)
      .send({ applicationId, owner: 'replacement' })
      .expect(200);
    expect(next.body.inspection.externalChannelId).toBe(threadChannelId);
    expect(next.body.fence.epoch).toBe(value.fence.epoch + 1);
    await resolve({ ...value, fence: next.body.fence }).expect(200);
    expect(threadExecutions).toHaveBeenCalledTimes(2);
    expect(executions).toBe(0);
  });
});

describe('owned guild text prompt preflight', () => {
  const ownerScope = () => ({ applicationId, applicationRevision, ownerId: 'a'.repeat(32) });
  const source = () => ({
    kind: 'guild_text' as const,
    applicationId,
    botUserId,
    guildId,
    channelId: externalChannelId,
    permissions: '68608',
    authorId: externalUserId,
    authorMember: true as const,
    authorPermissions: '1024',
  });
  async function pending() {
    await scope(async () => {
      expect(
        await createDiscordGatewayStorage(db, async () => ({
          ownershipLeaseMs: 30000,
          shardCount: 1,
        })).acquire(ownerScope(), 30000),
      ).toBe(true);
    });
    const effect = jest.fn(async () => ({ content: 'Authorized prompt.' }));
    deps.inspection = { storage: createDiscordInboxResolutionStorage(db), execute: effect };
    service = createDiscordInboxService(deps);
    unwrap(
      await service.submit(input({ action: { kind: 'ask', prompt: 'Retained original prompt' } })),
    );
    const job = await service.claim(applicationId, 'worker');
    if (!job || !('inspection' in job)) throw new Error('Missing inspection');
    expect(JSON.stringify(job)).not.toMatch(/Retained|token|agentId|channelRevision/);
    expect(executions).toBe(0);
    return { effect, value: { fence: job.fence, owner: ownerScope(), source: source() } };
  }
  it('joins a fresh actor observation to the original immutable prompt and prepares only once', async () => {
    const { value, effect } = await pending();
    const reply = await service.resolve(value);
    expect(reply?.reply.content).toBe('Authorized prompt.');
    expect(effect).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId,
        externalChannelId,
        externalUserId,
        action: { kind: 'ask', prompt: 'Retained original prompt' },
      }),
      value.fence,
      { kind: 'guild_text', owner: value.owner, source: value.source },
    );
    expect(await service.resolve(value)).toEqual(reply);
    expect(effect).toHaveBeenCalledTimes(1);
  });
  it('reserves text execution once per inspected lease even across concurrent resolution', async () => {
    const { value, effect } = await pending();
    let entered: () => void = () => {};
    let release: () => void = () => {};
    const started = new Promise<void>((done) => {
      entered = done;
    });
    const gate = new Promise<void>((done) => {
      release = done;
    });
    effect.mockImplementation(async () => {
      entered();
      await gate;
      return { content: 'Once.' };
    });
    const first = service.resolve(value);
    await started;
    expect(await service.resolve(value)).toBeNull();
    expect(await service.resolve({ ...value, source: null })).toBeNull();
    release();
    expect((await first)?.reply.content).toBe('Once.');
    expect(effect).toHaveBeenCalledTimes(1);
  });
  it('rejects bot or destination observations that do not match the canonical binding', async () => {
    const { value, effect } = await pending();
    expect(
      await service.resolve({
        ...value,
        source: { ...value.source, botUserId: '345678901234567891' },
      }),
    ).toBeNull();
    expect(effect).not.toHaveBeenCalled();
    expect((await service.resolve(value))?.reply.content).toBe('Authorized prompt.');
    expect(effect).toHaveBeenCalledTimes(1);
  });
  it.each(['missing', 'denied', 'foreign-author', 'legacy'] as const)(
    'never executes %s visibility proof',
    async (kind) => {
      const { value, effect } = await pending();
      if (kind === 'legacy') {
        const { authorId, authorMember, authorPermissions, ...legacy } = value.source;
        expect(authorId && authorMember && authorPermissions).toBeTruthy();
        expect(discordInboxResolutionSchema.safeParse({ ...value, source: legacy }).success).toBe(
          false,
        );
      } else {
        const observed =
          kind === 'missing'
            ? null
            : {
                ...value.source,
                authorPermissions: kind === 'denied' ? '0' : '1024',
                authorId: kind === 'foreign-author' ? '567890123456789013' : externalUserId,
              };
        expect((await service.resolve({ ...value, source: observed }))?.reply.content).toContain(
          'destination is unavailable',
        );
        expect((await service.resolve(value))?.reply.content).toContain(
          'destination is unavailable',
        );
      }
      expect(effect).not.toHaveBeenCalled();
    },
  );
  it('rejects a stale owner and revoked canonical route before reserving execution', async () => {
    const { value, effect } = await pending();
    expect(
      await service.resolve({ ...value, owner: { ...value.owner, ownerId: 'b'.repeat(32) } }),
    ).toBeNull();
    await scope(async () => {
      await db.models.AgentChannel.updateOne(
        { channelId: 'channel' },
        { $set: { status: 'inactive' } },
      );
    });
    expect(await service.resolve(value)).toBeNull();
    expect(effect).not.toHaveBeenCalled();
  });
  it('retries operational outages through a fresh inspected lease, never the old inspection epoch', async () => {
    const { value, effect } = await pending();
    effect.mockRejectedValueOnce(new Error('private provider outage'));
    await expect(service.resolve(value)).rejects.toThrow('private provider outage');
    expect(await service.resolve(value)).toBeNull();
    now += 1000;
    const next = await service.claim(applicationId, 'replacement');
    if (!next || !('inspection' in next)) throw new Error('Missing retry inspection');
    expect(next.fence.epoch).toBe(value.fence.epoch + 1);
    expect((await service.resolve({ ...value, fence: next.fence }))?.reply.content).toBe(
      'Authorized prompt.',
    );
    expect(effect).toHaveBeenCalledTimes(2);
  });
});

it('observes actual submission deduplication, claim age and successful state transitions without identities', async () => {
  await request(app)
    .post('/submit')
    .set('authorization', `Bearer ${serviceToken}`)
    .send(input())
    .expect(201);
  await request(app)
    .post('/submit')
    .set('authorization', `Bearer ${serviceToken}`)
    .send(input())
    .expect(200);
  now += 250;
  const claimed = await service.claim(applicationId, 'metrics-worker');
  expect(claimed).not.toBeNull();
  const fence = claimed!.fence;
  expect(await service.defer(fence, now + 1000)).toBe(true);
  expect(await service.defer(fence, now + 1000)).toBe(false);
  now += 1001;
  const reclaimed = await service.claim(applicationId, 'metrics-worker');
  expect(reclaimed).not.toBeNull();
  now = reclaimed!.expiresAt;
  expect(await service.finish(reclaimed!.fence, 'expired')).toBe(true);
  expect(observations).toEqual([
    { type: 'submission', kind: 'interaction', result: 'accepted' },
    { type: 'submission', kind: 'interaction', result: 'duplicate' },
    { type: 'queue', seconds: 0.25 },
    { type: 'inbox', event: 'deferred' },
    { type: 'queue', seconds: 1.251 },
    { type: 'inbox', event: 'expired' },
  ]);
  for (const secret of [applicationId, guildId, externalUserId, token])
    expect(JSON.stringify(observations)).not.toContain(secret);
});

it('preserves a committed submission when the optional observer throws', async () => {
  const handlers = createDiscordInboxHandlers({
    service,
    serviceToken: () => serviceToken,
    observe: () => {
      throw new Error('Broken metrics backend');
    },
  });
  app.post('/metrics-failure', handlers.submit);
  await request(app)
    .post('/metrics-failure')
    .set('authorization', `Bearer ${serviceToken}`)
    .send(input())
    .expect(201);
  expect(unwrap(await service.submit(input())).duplicate).toBe(true);
});
