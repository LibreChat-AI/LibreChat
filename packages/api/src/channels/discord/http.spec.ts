import '~/mcp/registry/__tests__/helpers/setupCredsEnv';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { channelConfigSchema } from 'librechat-data-provider';
import {
  createModels,
  createDiscordInstallationStorage,
  createDiscordInstallStorage,
  createDiscordBrowserSessionStorage,
  hashToken,
  tenantStorage,
  runAsSystem,
} from '@librechat/data-schemas';
import type { DiscordHttpConfig } from './runtime';
import { createDiscordManagementRuntime, createDiscordManagementSettingsReader } from './runtime';
import { DISCORD_MANAGEMENT_PATH, DISCORD_FLOW_COOKIE, DISCORD_CALLBACK_PATH } from './http';
import { preAuthTenantMiddleware } from '~/middleware/preAuthTenant';
import { createSameOriginGuard } from '~/middleware/origin';
import { setOAuthSession } from '~/oauth/csrf';

const db = new mongoose.Mongoose();
const userId = '000000000000000000000001';
const tenantId = 'discord-http';
const applicationId = '123456789012345678';
const guildId = '123456789012345680';
const secret = 'private-jwt-secret-for-discord-http-tests';
const publicBaseUrl = 'https://api.example/base';
const clientBaseUrl = 'https://chat.example';
const refreshToken = 'private-refresh-token';
const scoped = <T>(work: () => Promise<T>) => tenantStorage.run({ tenantId }, work);
const base = DISCORD_MANAGEMENT_PATH;
let mongo: MongoMemoryReplSet;
let app: express.Express;
let models: ReturnType<typeof createModels>;
let settings: DiscordHttpConfig | undefined;
let payloads: Record<string, unknown>;
let providerFetch: jest.Mock<Promise<Response>, [string, RequestInit]>;
let sessionId: string;
let authenticate = true;
let callbackUser: string | undefined;
const previous = {
  JWT_SECRET: process.env.JWT_SECRET,
  DOMAIN_SERVER: process.env.DOMAIN_SERVER,
  SESSION_COOKIE_SECURE: process.env.SESSION_COOKIE_SECURE,
  TRUST_TENANT_HEADER: process.env.TRUST_TENANT_HEADER,
};
const cookies = (res: request.Response): string[] => {
  const header = res.headers['set-cookie'];
  return (Array.isArray(header) ? header : [header])
    .filter(Boolean)
    .map((value) => value.split(';')[0]);
};
const authorize = (path: string) =>
  request(app)
    .post(path)
    .set('Authorization', 'Bearer admin')
    .set('Origin', clientBaseUrl)
    .set('Cookie', `refreshToken=${refreshToken}`);
async function register() {
  return request(app)
    .put(`${base}/apps`)
    .set('Authorization', 'Bearer admin')
    .set('Origin', clientBaseUrl)
    .send({ applicationId, botToken: 'private-bot-token', clientSecret: 'private-client-secret' })
    .expect(200);
}
async function connect() {
  await register();
  const response = await authorize(`${base}/connect`).send({ applicationId }).expect(200);
  return {
    response,
    cookies: cookies(response),
    state: new URL(response.body.url).searchParams.get('state')!,
    flowId: response.body.flowId,
  };
}
const callback = (state: string, currentCookies: string[]) =>
  request(app)
    .get(`${base}/oauth/callback`)
    .query({ state, code: 'one-time-code', iss: 'https://discord.com', guild_id: '999' })
    .set('Cookie', currentCookies);
beforeAll(async () => {
  process.env.JWT_SECRET = secret;
  process.env.DOMAIN_SERVER = publicBaseUrl;
  process.env.SESSION_COOKIE_SECURE = 'true';
  process.env.TRUST_TENANT_HEADER = 'true';
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await db.connect(mongo.getUri(), { autoIndex: false });
  models = createModels(db);
}, 60000);
afterAll(async () => {
  await db.disconnect();
  await mongo?.stop();
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
beforeEach(async () => {
  await runAsSystem(async () => {
    for (const name of [
      'User',
      'Session',
      'DiscordApplication',
      'DiscordGuild',
      'DiscordInstall',
      'ResponseScope',
    ])
      await db.models[name].deleteMany({});
  });
  await scoped(async () => {
    await models.User.create({
      _id: userId,
      tenantId,
      provider: 'local',
      email: 'admin@example.test',
      role: 'ADMIN',
    });
    const session = await models.Session.create({
      user: userId,
      tenantId,
      refreshTokenHash: await hashToken(refreshToken),
      expiration: new Date(Date.now() + 3600000),
    });
    sessionId = String(session._id);
  });
  settings = {
    enabled: true,
    flowLifetimeMs: 60000,
    requestTimeoutMs: 1000,
    maxResponseBytes: 8192,
    botPermissions: '274877975552',
  };
  authenticate = true;
  callbackUser = undefined;
  payloads = {
    '/applications/@me': {
      id: applicationId,
      name: 'Bot',
      verify_key: 'a'.repeat(64),
      bot_require_code_grant: true,
    },
    '/users/@me': { id: applicationId, bot: true },
    '/oauth2/token': {
      token_type: 'Bearer',
      access_token: 'private-access-token',
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
  providerFetch = jest.fn<Promise<Response>, [string, RequestInit]>(async (url) => {
    const parsed = new URL(url);
    const path = parsed.pathname.replace('/api/v10', '') + parsed.search;
    if (!(path in payloads)) throw new Error('private provider diagnostic');
    return new Response(JSON.stringify(payloads[path]));
  });
  const handlers = createDiscordManagementRuntime({
    installations: createDiscordInstallationStorage(db),
    states: createDiscordInstallStorage(db),
    browserSessions: createDiscordBrowserSessionStorage(db),
    readSettings: async () => settings,
    sessionSecret: secret,
    publicBaseUrl,
    clientBaseUrl,
    findUser: (id) => models.User.findById(id).lean(),
    isPrincipalActive: async (id) =>
      Boolean(
        await models.User.exists({ _id: id, agentTriggerDeletionStartedAt: { $exists: false } }),
      ),
    hasCapability: async (user) => user.role === 'ADMIN',
    fetch: providerFetch,
    logError: () => {},
  });
  app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const pairs = (req.get('cookie') ?? '').split(';').map((pair) => pair.trim().split('='));
    req.cookies = Object.fromEntries(pairs.filter(([name]) => name));
    next();
  });
  app.get(
    `${base}/oauth/callback`,
    preAuthTenantMiddleware,
    (req, _res, next) => {
      if (callbackUser) req.user = { id: callbackUser, tenantId };
      next();
    },
    handlers.callback,
  );
  app.use(base, (req, res, next) => {
    if (!authenticate || req.get('authorization') !== 'Bearer admin') {
      res.sendStatus(401);
      return;
    }
    req.user = { id: userId, tenantId };
    tenantStorage.run({ tenantId }, () => next());
  });
  const origin = createSameOriginGuard({ trustedOrigins: [publicBaseUrl, clientBaseUrl] });
  app.get(`${base}/apps`, handlers.applications);
  app.put(`${base}/apps`, origin, handlers.configure);
  app.get(`${base}/guilds`, handlers.guilds);
  app.post(`${base}/connect`, origin, setOAuthSession, handlers.connect);
  app.delete(`${base}/attempts/:flowId`, origin, handlers.cancel);
  app.delete(`${base}/guilds/:installationId`, origin, handlers.disconnect);
});

it('issues secure proxy-scoped per-flow cookies without exposing private browser JSON', async () => {
  const flow = await connect();
  const headers = flow.response.headers['set-cookie'];
  const set = Array.isArray(headers) ? headers : [headers];
  expect(set).toEqual(
    expect.arrayContaining([
      expect.stringContaining('Path=/base/api/channels/discord;'),
      expect.stringContaining('Path=/base/api/channels/discord/oauth/callback;'),
    ]),
  );
  expect(set.filter((value: string) => value.startsWith(`${DISCORD_FLOW_COOKIE}=`))[0]).toMatch(
    /HttpOnly; Secure; SameSite=Lax/,
  );
  const token = flow.cookies
    .find((cookie) => cookie.startsWith(`${DISCORD_FLOW_COOKIE}=`))!
    .split('=')[1];
  const claims = jwt.verify(token, secret, {
    algorithms: ['HS256'],
    issuer: 'librechat:discord:oauth',
    audience: 'discord-installation',
  });
  expect(claims).toMatchObject({ userId, tenantId, sessionId, flowId: flow.flowId });
  expect(JSON.stringify(flow.response.body)).not.toMatch(/private-|sessionId|nonce/);
});

it('restores the signed tenant, ignores callback hints and consumes a callback once', async () => {
  const flow = await connect();
  providerFetch.mockClear();
  const response = await callback(flow.state, flow.cookies).expect(302);
  expect(response.headers.location).toContain(
    'https://chat.example/oauth/success?serverName=Discord',
  );
  expect(response.headers['cache-control']).toBe('no-store');
  await scoped(async () => {
    const guild = await models.DiscordGuild.findOne({ guildId }).lean();
    expect(guild).toMatchObject({ tenantId, guildId, applicationId, status: 'active' });
    expect(await models.DiscordInstall.countDocuments()).toBe(0);
  });
  providerFetch.mockClear();
  expect((await callback(flow.state, flow.cookies).expect(302)).headers.location).toContain(
    'discord_invalid_state',
  );
  expect(providerFetch).not.toHaveBeenCalled();
});

it.each(['missing', 'tampered', 'expired', 'wrong_session', 'missing_csrf', 'missing_marker'])(
  'rejects %s browser callback proof before provider exchange',
  async (kind) => {
    const flow = await connect();
    providerFetch.mockClear();
    let sent = [...flow.cookies];
    const item = sent.find((cookie) => cookie.startsWith(`${DISCORD_FLOW_COOKIE}=`))!;
    if (kind === 'missing')
      sent = sent.filter((cookie) => !cookie.startsWith(`${DISCORD_FLOW_COOKIE}=`));
    if (kind === 'tampered') sent = sent.map((cookie) => (cookie === item ? `${cookie}x` : cookie));
    if (kind === 'missing_csrf') sent = sent.filter((cookie) => !cookie.startsWith('oauth_csrf='));
    if (kind === 'missing_marker')
      sent = sent.filter((cookie) => !cookie.startsWith('oauth_session='));
    if (kind === 'expired' || kind === 'wrong_session') {
      const decoded = jwt.decode(item.split('=')[1]);
      if (!decoded || typeof decoded === 'string') throw new Error('Missing claims');
      const token = jwt.sign(
        {
          userId,
          tenantId,
          sessionId,
          nonce: kind === 'wrong_session' ? 'x'.repeat(43) : decoded.nonce,
          flowId: flow.flowId,
        },
        secret,
        {
          algorithm: 'HS256',
          issuer: 'librechat:discord:oauth',
          audience: 'discord-installation',
          expiresIn: kind === 'expired' ? -1 : 60,
        },
      );
      sent = sent.map((cookie) => (cookie === item ? `${DISCORD_FLOW_COOKIE}=${token}` : cookie));
    }
    const response = await callback(flow.state, sent).expect(302);
    expect(response.headers.location).toContain('discord_invalid_state');
    expect(providerFetch).not.toHaveBeenCalled();
  },
);

it.each(['logout', 'account_swap', 'expired_session', 'foreign_host'])(
  'rejects %s after the flow starts',
  async (kind) => {
    const flow = await connect();
    providerFetch.mockClear();
    if (kind === 'logout')
      await scoped(async () => {
        await models.Session.deleteOne({ _id: sessionId });
      });
    if (kind === 'account_swap') callbackUser = '000000000000000000000002';
    if (kind === 'expired_session')
      await scoped(async () => {
        await models.Session.updateOne(
          { _id: sessionId },
          { $set: { expiration: new Date(Date.now() - 1000) } },
        );
      });
    const pending = callback(flow.state, flow.cookies);
    if (kind === 'foreign_host') pending.set('x-tenant-id', 'foreign');
    expect((await pending.expect(302)).headers.location).toContain('discord_invalid_state');
    expect(providerFetch).not.toHaveBeenCalled();
  },
);

it('requires JWT and same-origin writes plus a valid original refresh session', async () => {
  await request(app).put(`${base}/apps`).send({ applicationId }).expect(401);
  await request(app)
    .put(`${base}/apps`)
    .set('Authorization', 'Bearer admin')
    .set('Origin', 'https://attacker.example')
    .set('Sec-Fetch-Site', 'cross-site')
    .send({ applicationId })
    .expect(403);
  await register();
  await request(app)
    .post(`${base}/connect`)
    .set('Authorization', 'Bearer admin')
    .set('Origin', clientBaseUrl)
    .send({ applicationId })
    .expect(401);
  await request(app)
    .post(`${base}/connect`)
    .set('Authorization', 'Bearer admin')
    .set('Origin', clientBaseUrl)
    .set('Cookie', 'refreshToken=wrong')
    .send({ applicationId })
    .expect(401);
  expect(await scoped(async () => models.DiscordInstall.countDocuments())).toBe(0);
});

it('cancels only the active session flow and disconnects with revision checks', async () => {
  const flow = await connect();
  await request(app)
    .delete(`${base}/attempts/${flow.flowId}`)
    .set('Authorization', 'Bearer admin')
    .set('Origin', clientBaseUrl)
    .set('Cookie', flow.cookies)
    .expect(200);
  expect((await callback(flow.state, flow.cookies).expect(302)).headers.location).toContain(
    'discord_invalid_state',
  );
  const started = await authorize(`${base}/connect`).send({ applicationId }).expect(200);
  const state = new URL(started.body.url).searchParams.get('state')!;
  await callback(state, cookies(started)).expect(302);
  const guild = await scoped(async () => models.DiscordGuild.findOne({ guildId }).lean());
  if (!guild) throw new Error('Missing guild');
  await request(app)
    .delete(`${base}/guilds/${guild.installationId}`)
    .set('Authorization', 'Bearer admin')
    .set('Origin', clientBaseUrl)
    .send({ revision: 'old' })
    .expect(409);
  const response = await request(app)
    .delete(`${base}/guilds/${guild.installationId}`)
    .set('Authorization', 'Bearer admin')
    .set('Origin', clientBaseUrl)
    .send({ revision: guild.revision })
    .expect(200);
  expect(response.body.status).toBe('disconnected');
});

it('keeps disabled configuration and operational failures safe', async () => {
  const configured = settings;
  settings = configured ? { ...configured, enabled: false } : undefined;
  await request(app).get(`${base}/apps`).set('Authorization', 'Bearer admin').expect(404);
  settings = undefined;
  await request(app).get(`${base}/apps`).set('Authorization', 'Bearer admin').expect(404);
  expect((await callback('s'.repeat(43), []).expect(302)).headers.location).toContain(
    'discord_not_configured',
  );
  settings = configured;
  providerFetch.mockRejectedValue(new Error('private provider diagnostics'));
  const failed = await request(app)
    .put(`${base}/apps`)
    .set('Authorization', 'Bearer admin')
    .set('Origin', clientBaseUrl)
    .send({ applicationId, botToken: 'token', clientSecret: 'secret' })
    .expect(503);
  expect(failed.body).toEqual({ ok: false, error: { code: 'provider_unavailable' } });
});

it('reads only the enabled operator policy through the injected config boundary', async () => {
  const raw = Object.assign(channelConfigSchema.parse({ enabled: true }), { discord: settings });
  const reader = createDiscordManagementSettingsReader({
    readAppConfig: async () => ({ endpoints: { agents: { channels: raw } } }),
  });
  expect(await reader()).toEqual(settings);
  raw.enabled = false;
  expect(await reader()).toBeUndefined();
  expect(DISCORD_CALLBACK_PATH).toBe('/api/channels/discord/oauth/callback');
});
