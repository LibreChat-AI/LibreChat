import '~/mcp/registry/__tests__/helpers/setupCredsEnv';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import {
  createModels,
  createDiscordInstallationStorage,
  createDiscordInstallStorage,
  tenantStorage,
  runAsSystem,
} from '@librechat/data-schemas';
import type { DiscordManagementService, DiscordManagementResult } from './service';
import { encryptCredential, decryptCredential } from '~/crypto/credentials';
import { createSlackWorkspaceAdminGuard } from '../workspaceRuntime';
import { createDiscordManagementService } from './service';
import { createDiscordProviderClient } from './client';

const db = new mongoose.Mongoose();
const principal = { id: '000000000000000000000001', tenantId: 'discord-service' };
const applicationId = '123456789012345678';
const guildId = '123456789012345680';
const sessionBinding = 'private-browser-session-'.repeat(3);
const config = {
  applicationId,
  botToken: 'private-bot-token',
  clientSecret: 'private-client-secret',
};
const scope = <T>(work: () => Promise<T>) =>
  tenantStorage.run({ tenantId: principal.tenantId }, work);
const value = <T>(result: DiscordManagementResult<T>): T => {
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
};
let mongo: MongoMemoryReplSet;
let models: ReturnType<typeof createModels>;
let installations: ReturnType<typeof createDiscordInstallationStorage>;
let states: ReturnType<typeof createDiscordInstallStorage>;
let service: DiscordManagementService;
let fetchProvider: jest.Mock<Promise<Response>, [string, RequestInit]>;
let payloads: Record<string, unknown>;
let onRequest: ((path: string) => Promise<void>) | undefined;
let now: number;
let enabled: boolean;
let logged: object[];
const register = () => service.configure(principal, config);
async function begin(installationId?: string) {
  if (!(await installations.readApplication(applicationId))) value(await register());
  const flow = value(
    await service.start(principal, { applicationId, installationId }, sessionBinding),
  );
  return { ...flow, state: new URL(flow.url).searchParams.get('state')! };
}
const finish = (state: string, session = sessionBinding) =>
  service.finish(
    principal,
    { state, code: 'one-time-code', issuer: 'https://discord.com' },
    session,
  );

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await db.connect(mongo.getUri(), { autoIndex: false });
  models = createModels(db);
  installations = createDiscordInstallationStorage(db);
  states = createDiscordInstallStorage(db);
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
      'DiscordInstall',
      'ResponseScope',
    ])
      await db.models[name].deleteMany({});
  });
  await scope(async () => {
    await models.User.create({
      _id: principal.id,
      tenantId: principal.tenantId,
      provider: 'local',
      email: 'admin@example.test',
      role: 'ADMIN',
    });
  });
  now = Date.now();
  enabled = true;
  logged = [];
  onRequest = undefined;
  payloads = {
    '/users/@me': { id: applicationId, bot: true },
    '/applications/@me': {
      id: applicationId,
      name: 'Bot',
      bot: { id: applicationId, bot: true },
      verify_key: 'a'.repeat(64),
      bot_require_code_grant: true,
    },
    '/oauth2/token': {
      access_token: 'private-access-token',
      token_type: 'Bearer',
      scope: 'bot applications.commands guilds',
      guild: { id: guildId, name: 'Guild' },
    },
    '/oauth2/@me': {
      application: { id: applicationId },
      scopes: ['bot', 'applications.commands', 'guilds'],
    },
    '/users/@me/guilds?limit=200': [{ id: guildId, owner: true, permissions: '0' }],
    [`/guilds/${guildId}`]: { id: guildId, name: 'Verified guild' },
  };
  fetchProvider = jest.fn<Promise<Response>, [string, RequestInit]>(async (url) => {
    const parsed = new URL(url);
    const path = parsed.pathname.replace('/api/v10', '') + parsed.search;
    await onRequest?.(path);
    if (!(path in payloads)) throw new Error('private provider diagnostic');
    return new Response(JSON.stringify(payloads[path]));
  });
  const canManage = createSlackWorkspaceAdminGuard({
    findUser: (id) => models.User.findById(id).lean(),
    isPrincipalActive: async (id) =>
      Boolean(
        await models.User.exists({ _id: id, agentTriggerDeletionStartedAt: { $exists: false } }),
      ),
    hasCapability: async (user) => user.role === 'ADMIN',
  });
  service = createDiscordManagementService({
    installations,
    states,
    canManage,
    provider: createDiscordProviderClient({
      fetch: fetchProvider,
      config: {
        redirectUri: 'https://chat.example/api/channels/discord/oauth/callback',
        requestTimeoutMs: 1000,
        maxResponseBytes: 8192,
        botPermissions: '68608',
      },
    }),
    settings: async () => ({ enabled, flowLifetimeMs: 60000 }),
    encrypt: encryptCredential,
    decrypt: decryptCredential,
    now: () => now,
    logError: (metadata) => {
      logged.push(metadata);
    },
  });
});

it('verifies and encrypts credentials while returning only safe application metadata', async () =>
  scope(async () => {
    const app = value(await register());
    expect(JSON.stringify(app)).not.toMatch(/private-|encrypted/);
    const stored = (await installations.readApplicationCredentials(applicationId))!;
    expect(stored.encryptedBotToken).toMatch(/^v3:/);
    expect(await decryptCredential(stored.encryptedBotToken)).toBe(config.botToken);
    expect(await decryptCredential(stored.encryptedClientSecret)).toBe(config.clientSecret);
    const updated = value(
      await service.configure(principal, {
        applicationId,
        name: 'Renamed',
        expectedRevision: app.revision,
      }),
    );
    expect(updated.name).toBe('Renamed');
    expect(await service.applications(principal)).toMatchObject({
      ok: true,
      value: { applications: [{ name: 'Renamed' }] },
    });
  }));

it.each(['demoted', 'deleted', 'disabled'])(
  'rejects configuration when %s during provider work',
  async (change) =>
    scope(async () => {
      onRequest = async () => {
        if (change === 'demoted')
          await models.User.updateOne({ _id: principal.id }, { $set: { role: 'USER' } });
        if (change === 'deleted') await models.User.deleteOne({ _id: principal.id });
        if (change === 'disabled') enabled = false;
      };
      expect(await register()).toMatchObject({
        ok: false,
        error: { code: change === 'disabled' ? 'not_configured' : 'forbidden' },
      });
      expect(await installations.readApplication(applicationId)).toBeNull();
    }),
);

it('persists only hashed state/session bindings and consumes before any code exchange', async () =>
  scope(async () => {
    const flow = await begin();
    const pending = value(await service.inspect(flow.state))!;
    expect(pending).toMatchObject({
      stateHash: flow.flowId,
      userId: principal.id,
      tenantId: principal.tenantId,
    });
    expect(JSON.stringify(pending)).not.toContain(sessionBinding);
    expect(pending).not.toHaveProperty('sessionHash');
    onRequest = async (path) => {
      if (path === '/oauth2/token')
        expect(await states.lookup(flow.flowId, new Date(now))).toBeNull();
    };
    const guild = value(await finish(flow.state));
    expect(guild).toMatchObject({
      applicationId,
      guildId,
      guildName: 'Verified guild',
      status: 'active',
    });
    expect(JSON.stringify(guild)).not.toMatch(/private-|encrypted/);
    expect(await service.guilds(principal)).toMatchObject({ ok: true, value: { guilds: [guild] } });
    fetchProvider.mockClear();
    expect(await finish(flow.state)).toMatchObject({ ok: false, error: { code: 'invalid_state' } });
    expect(fetchProvider).not.toHaveBeenCalled();
  }));

it('rejects cross-session callbacks and expired flows without contacting Discord', async () =>
  scope(async () => {
    const flow = await begin();
    fetchProvider.mockClear();
    expect(await finish(flow.state, 'another-private-session-'.repeat(3))).toMatchObject({
      ok: false,
      error: { code: 'invalid_state' },
    });
    expect(value(await service.inspect(flow.state))).not.toBeNull();
    now += 60001;
    expect(await finish(flow.state)).toMatchObject({ ok: false, error: { code: 'invalid_state' } });
    expect(fetchProvider).not.toHaveBeenCalled();
  }));

it('allows one concurrent callback and burns refused provider grants', async () =>
  scope(async () => {
    const flow = await begin();
    const results = await Promise.all([finish(flow.state), finish(flow.state)]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toMatchObject([
      { error: { code: 'invalid_state' } },
    ]);
    const second = await begin();
    payloads['/oauth2/token'] = { error: 'private diagnostic' };
    expect(await finish(second.state)).toMatchObject({ ok: false });
    expect(value(await service.inspect(second.state))).toBeNull();
  }));

it.each(['demoted', 'deleted', 'disabled'])(
  'rechecks %s authority after exchanging a grant',
  async (change) =>
    scope(async () => {
      const flow = await begin();
      onRequest = async (path) => {
        if (path !== '/oauth2/token') return;
        if (change === 'demoted')
          await models.User.updateOne({ _id: principal.id }, { $set: { role: 'USER' } });
        if (change === 'deleted') await models.User.deleteOne({ _id: principal.id });
        if (change === 'disabled') enabled = false;
      };
      expect(await finish(flow.state)).toMatchObject({
        ok: false,
        error: { code: change === 'disabled' ? 'not_configured' : 'forbidden' },
      });
      expect((await installations.listGuilds()).guilds).toEqual([]);
      expect(value(await service.inspect(flow.state))).toBeNull();
    }),
);

it('fences application rotation before and during provider exchange', async () =>
  scope(async () => {
    const flow = await begin();
    let app = (await installations.readApplication(applicationId))!;
    value(await service.configure(principal, { ...config, expectedRevision: app.revision }));
    fetchProvider.mockClear();
    expect(await finish(flow.state)).toMatchObject({
      ok: false,
      error: { code: 'application_changed' },
    });
    expect(fetchProvider).not.toHaveBeenCalled();
    const fresh = await begin();
    app = (await installations.readApplication(applicationId))!;
    onRequest = async (path) => {
      if (path === '/oauth2/token')
        await installations.configureApplication({
          actorId: principal.id,
          applicationId,
          botUserId: applicationId,
          publicKey: 'b'.repeat(64),
          expectedRevision: app.revision,
        });
    };
    expect(await finish(fresh.state)).toMatchObject({
      ok: false,
      error: { code: 'application_changed' },
    });
    expect((await installations.listGuilds()).guilds).toEqual([]);
  }));

it('pins reconnect guild scope and preserves revoked installation authority', async () =>
  scope(async () => {
    const flow = await begin();
    const guild = value(await finish(flow.state));
    const reconnect = await begin(guild.installationId);
    expect(new URL(reconnect.url).searchParams.get('guild_id')).toBe(guild.guildId);
    value(await service.disconnect(principal, guild.installationId, guild.revision));
    fetchProvider.mockClear();
    expect(await finish(reconnect.state)).toMatchObject({
      ok: false,
      error: { code: 'installation_changed' },
    });
    expect(fetchProvider).not.toHaveBeenCalled();
  }));

it('rejects foreign principals and validates cancellation ownership', async () =>
  scope(async () => {
    const flow = await begin();
    fetchProvider.mockClear();
    expect(
      await service.start({ ...principal, tenantId: 'foreign' }, { applicationId }, sessionBinding),
    ).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    expect(
      await service.finish(
        { ...principal, id: '000000000000000000000002' },
        { state: flow.state, code: 'code', issuer: 'https://discord.com' },
        sessionBinding,
      ),
    ).toMatchObject({ ok: false });
    expect(await service.cancel(principal, flow.flowId, sessionBinding)).toMatchObject({
      ok: true,
    });
    expect(value(await service.inspect(flow.state))).toBeNull();
    expect(fetchProvider).not.toHaveBeenCalled();
  }));

it('sanitizes operational diagnostics and burns failed provider exchanges', async () =>
  scope(async () => {
    const flow = await begin();
    onRequest = async () => {
      throw new Error(`private ${config.botToken}`);
    };
    const result = await finish(flow.state);
    expect(result).toMatchObject({ ok: false, error: { code: 'provider_unavailable' } });
    expect(JSON.stringify(result)).not.toContain('private');
    expect(value(await service.inspect(flow.state))).toBeNull();
    onRequest = undefined;
    const spy = jest
      .spyOn(models.DiscordApplication.collection, 'findOne')
      .mockRejectedValueOnce(new Error('private database diagnostic'));
    expect(await service.applications(principal)).toMatchObject({ ok: true });
    expect(await service.start(principal, { applicationId }, sessionBinding)).toEqual({
      ok: false,
      error: { code: 'unavailable' },
    });
    expect(logged).toEqual([{ type: 'Error' }]);
    spy.mockRestore();
  }));

it('rejects invalid management inputs before provider work', async () =>
  scope(async () => {
    expect(await service.start(principal, { applicationId: '0' }, sessionBinding)).toMatchObject({
      ok: false,
      error: { code: 'invalid_input' },
    });
    expect(
      await service.start(principal, { applicationId, installationId: '' }, sessionBinding),
    ).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    expect(await service.disconnect(principal, '', 'revision')).toMatchObject({
      ok: false,
      error: { code: 'invalid_input' },
    });
    expect(fetchProvider).not.toHaveBeenCalled();
  }));
