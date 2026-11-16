import { once } from 'node:events';
import { Registry } from 'prom-client';
import { createServer } from 'node:http';
import { generateKeyPairSync, sign } from 'node:crypto';
import { ApplicationFlags, GatewayDispatchEvents } from 'discord-api-types/v10';
import {
  discordChannelConfigSchema,
  discordCredentialStateSchema,
  discordGatewayOwnerSchema,
} from 'librechat-data-provider';
import type { DiscordCredentialState, DiscordGatewayOwner } from 'librechat-data-provider';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { DiscordGatewayDriverOptions } from './socket';
import type { DiscordTelemetry } from './observe';
import { createDiscordTelemetry } from './observe';
import { DiscordGatewayApp } from './app';
import { loadBootstrap } from '../config';
import { DiscordHealth } from './health';

/**
 * The real composition main.ts builds: a registry, the health registry, the telemetry adapter and
 * the app behind a real listener. Only Discord, the control plane and the Gateway socket are fake.
 */
const applicationId = '123456789012345678';
const botUserId = '234567890123456789';
const guildId = '345678901234567890';
const channelId = '456789012345678901';
const actorId = '678901234567890123';
const eventId = '567890123456789012';
const interactionToken = 'interaction-token-sentinel';
const keys = generateKeyPairSync('ed25519');
const publicKey = keys.publicKey
  .export({ type: 'spki', format: 'der' })
  .subarray(-32)
  .toString('hex');
const config = loadBootstrap({
  CHANNEL_PROVIDER: 'discord',
  CHANNEL_SERVICE_TOKEN: 'private-service-token',
  LIBRECHAT_INTERNAL_URL: 'http://localhost:3080',
}).config;
const policy = (gateway: boolean) =>
  discordChannelConfigSchema.parse({
    enabled: true,
    gateway: {
      enabled: gateway,
      pollIntervalMs: 100,
      ownershipLeaseMs: 5000,
      maxApplications: 1,
      recovery: { fatalRetryMinMs: 1000, fatalRetryMaxMs: 2000 },
    },
  });
const interaction = {
  type: 2,
  id: eventId,
  application_id: applicationId,
  token: interactionToken,
  version: 1,
  guild_id: guildId,
  context: 0,
  authorizing_integration_owners: { '0': guildId },
  channel_id: channelId,
  member: { user: { id: actorId } },
  data: {
    id: '789012345678901234',
    name: 'librechat',
    type: 1,
    options: [{ name: 'ask', type: 1, options: [{ name: 'prompt', type: 3, value: 'Hello' }] }],
  },
};
const bot = {
  id: botUserId,
  bot: true,
  username: 'bot',
  discriminator: '0',
  global_name: null,
  avatar: null,
};

interface World {
  revision: string;
  channels: boolean;
  inbox: 'idle' | 'unavailable' | 'reply';
  runs: 'idle' | 'unavailable';
  submit: 'accepted' | 'conflict';
  replyStatus: number;
  credentialStatus: number;
}
type Sample = { labels: Record<string, string | number>; value: number };

let controller: AbortController;
let servers: Server[] = [];
beforeEach(() => {
  controller = new AbortController();
});
afterEach(async () => {
  controller.abort();
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  servers = [];
});

function compose(
  options: {
    gateway?: boolean;
    telemetry?: (real: DiscordTelemetry) => DiscordTelemetry;
    driver?: (attempt: number, options: DiscordGatewayDriverOptions) => Promise<void>;
    credentialWrite?: () => Promise<void>;
  } = {},
) {
  const world: World = {
    revision: 'revision-a',
    channels: false,
    inbox: 'idle',
    runs: 'idle',
    submit: 'accepted',
    replyStatus: 200,
    credentialStatus: 204,
  };
  const registry = new Registry();
  const health = new DiscordHealth();
  const real = createDiscordTelemetry({ registry, health });
  const drivers: DiscordGatewayDriverOptions[] = [];
  const calls: string[] = [];
  const credentials: { owner: DiscordGatewayOwner; state: DiscordCredentialState }[] = [];
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const path = url.pathname;
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
    calls.push(path);
    if (path.endsWith('/gateway/observeCredentials')) {
      expect(Object.keys(body).sort()).toEqual(['owner', 'state']);
      expect(new Headers(init?.headers).get('authorization')).toBe(
        `Bearer ${config.CHANNEL_SERVICE_TOKEN}`,
      );
      credentials.push({
        owner: discordGatewayOwnerSchema.parse(body.owner),
        state: discordCredentialStateSchema.parse(body.state),
      });
      await options.credentialWrite?.();
      return world.credentialStatus === 204
        ? new Response(null, { status: 204 })
        : Response.json({ error: 'unavailable' }, { status: world.credentialStatus });
    }
    if (url.hostname === 'discord.com') {
      if (path.includes('/webhooks/'))
        return Response.json({ id: eventId }, { status: world.replyStatus });
      if (path.endsWith(`/permissions/member/${botUserId}`))
        return Response.json({ permissions: '68608' });
      if (path.endsWith(`/permissions/member/${actorId}`))
        return Response.json({ permissions: '1024' });
      if (path === `/api/v10/guilds/${guildId}/members/${actorId}`)
        return Response.json({ user: { id: actorId } });
      return Response.json({ id: channelId, guild_id: guildId, type: 0 });
    }
    if (path.endsWith('/runtime/applications'))
      return Response.json({
        applications: [
          { applicationId, applicationRevision: world.revision, tenantId: 'canonical' },
        ],
      });
    if (path.endsWith('/runtime/channels'))
      return Response.json({
        channels: world.channels
          ? [
              {
                applicationId,
                applicationRevision: world.revision,
                tenantId: 'canonical',
                channelId: 'channel-one',
              },
            ]
          : [],
      });
    if (path.endsWith(`/security/${applicationId}`))
      return Response.json({
        applicationId,
        applicationRevision: world.revision,
        botUserId,
        publicKey,
        tenantId: 'canonical',
      });
    if (path.endsWith('/inbox/submit'))
      return world.submit === 'conflict'
        ? Response.json({}, { status: 409 })
        : Response.json(
            { ok: true, value: { eventId: body.eventId, state: 'queued', duplicate: false } },
            { status: 201 },
          );
    if (path.endsWith('/gateway/bootstrap'))
      return Response.json({
        applicationId,
        applicationRevision: body.owner.applicationRevision,
        botUserId,
        botToken: 'private-bot-token',
        policy: policy(true).gateway,
      });
    if (path.endsWith('/gateway/load'))
      return Response.json({
        applicationId,
        applicationRevision: body.owner.applicationRevision,
        botUserId,
        checkpoints: [],
      });
    if (/\/gateway\/(acquire|renew|release|save)$/.test(path))
      return new Response(null, { status: 204 });
    if (path.endsWith('/inbox/claim')) {
      if (world.inbox === 'unavailable') return Response.json({}, { status: 503 });
      if (world.inbox === 'idle') return new Response(null, { status: 204 });
      world.inbox = 'idle';
      return Response.json({
        fence: { applicationId, eventId, owner: body.owner, epoch: 1 },
        applicationRevision: world.revision,
        token: interactionToken,
        expiresAt: Date.now() + 10_000,
        reply: { content: 'Private reply' },
      });
    }
    if (path.endsWith('/inbox/finish')) return new Response(null, { status: 204 });
    if (path.endsWith('/runs/claim'))
      return world.runs === 'unavailable'
        ? Response.json({}, { status: 503 })
        : new Response(null, { status: 204 });
    if (path.endsWith('/service/messages')) return Response.json({ outcome: 'admitted' });
    throw new Error('Unexpected service request ' + path);
  };
  let attempts = 0;
  const createDriver = (driver: DiscordGatewayDriverOptions) => {
    drivers.push(driver);
    const attempt = ++attempts;
    return {
      destroy: async () => undefined,
      async connect() {
        if (options.driver) return options.driver(attempt, driver);
        await driver.updateSessionInfo(0, {
          sessionId: 'session',
          sequence: 1,
          shardId: 0,
          shardCount: 1,
          resumeURL: 'wss://gateway.discord.gg',
        });
        driver.ready({
          shardId: 0,
          data: {
            v: 10,
            user: bot,
            application: {
              id: applicationId,
              flags: ApplicationFlags.GatewayMessageContentLimited,
              flags_new: '0',
            },
            session_id: 'session',
            resume_gateway_url: 'wss://gateway.discord.gg',
            guilds: [],
          },
        });
      },
    };
  };
  const gateway = options.gateway ?? false;
  const app = new DiscordGatewayApp(
    config,
    policy(gateway),
    { info: () => undefined, warn: () => undefined, error: () => undefined },
    transport,
    gateway ? createDriver : undefined,
    { telemetry: options.telemetry ? options.telemetry(real) : real, health },
  );
  const server = createServer((request, response) => {
    void app.http(request, response);
  });
  servers.push(server);
  const listening = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  const base = (async () => {
    await listening;
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  })();
  const send = async (payload: object | string, changes: { signature?: string } = {}) => {
    const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature =
      changes.signature ??
      sign(
        null,
        Buffer.concat([Buffer.from(timestamp), Buffer.from(text)]),
        keys.privateKey,
      ).toString('hex');
    return fetch(`${await base}/discord/${applicationId}/interactions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-signature-timestamp': timestamp,
        'x-signature-ed25519': signature,
      },
      body: text,
    });
  };
  const url = async (path: string) => (await base) + path;
  const get = async (path: string) => fetch(await url(path));
  const detail = async () => (await get('/healthz/detail')).json();
  const samples = async (metric: string): Promise<Sample[]> => {
    const found = (await registry.getMetricsAsJSON()).find(
      (item) => item.name === `channel_gateway_discord_${metric}`,
    );
    return (found?.values ?? []) as Sample[];
  };
  const count = async (metric: string, labels: Record<string, string> = {}) =>
    (await samples(metric))
      .filter((sample) =>
        Object.entries(labels).every(([key, value]) => sample.labels[key] === value),
      )
      .reduce((total, sample) => total + sample.value, 0);
  const until = async (check: () => Promise<boolean>, what: string) => {
    for (let attempt = 0; attempt < 250; attempt++) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`Timed out waiting for ${what}`);
  };
  const run = () => {
    app.ready = true;
    const running = app.run(controller.signal);
    return running;
  };
  return {
    app,
    world,
    registry,
    health,
    drivers,
    calls,
    credentials,
    send,
    get,
    url,
    detail,
    count,
    until,
    run,
    ready: () => until(async () => (await get('/readyz')).status === 200, 'readiness'),
  };
}
const only = (counts: Record<string, number>) =>
  Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([level]) => level)
    .join(',');
jest.setTimeout(30_000);

describe('Discord health and metrics in the running app', () => {
  it('records token evidence through the private owner-scoped API independently of metrics', async () => {
    const f = compose({
      gateway: true,
      telemetry: (real) => ({
        observe: real.observe,
        application: () => ({
          observe: () => {
            throw new Error('metrics unavailable');
          },
          release: () => undefined,
        }),
      }),
    });
    const running = f.run();
    await f.until(async () => f.credentials.length === 1, 'recorded READY credential');
    expect(f.credentials[0]).toMatchObject({
      owner: { applicationId, applicationRevision: 'revision-a' },
      state: 'valid',
    });
    f.drivers[0].resumed(0);
    f.drivers[0].closed(4004, 0);
    await f.until(async () => f.credentials.length === 2, 'recorded rejected credential');
    expect(f.credentials[1]).toEqual({ ...f.credentials[0], state: 'invalid' });
    expect((await f.get('/readyz')).status).toBe(200);
    controller.abort();
    await running;
  });

  it('flushes credential evidence before releasing the application lease', async () => {
    let finish: () => void = () => undefined;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const f = compose({ gateway: true, credentialWrite: () => pending });
    const running = f.run();
    await f.until(async () => f.credentials.length === 1, 'an in-flight credential write');
    controller.abort();
    await new Promise((resolve) => setImmediate(resolve));
    expect(f.calls.some((path) => path.endsWith('/gateway/release'))).toBe(false);
    finish();
    await running;
    expect(f.calls.filter((path) => path.endsWith('/gateway/release'))).toHaveLength(1);
    expect(f.credentials).toHaveLength(1);
  });

  it('does not block serving or repeatedly write unchanged evidence during a private API outage', async () => {
    const f = compose({ gateway: true });
    f.world.credentialStatus = 503;
    const running = f.run();
    await f.until(async () => f.credentials.length === 1, 'an attempted credential write');
    for (let index = 0; index < 20; index++) f.drivers[0].resumed(0);
    expect((await f.send({ type: 1 })).status).toBe(200);
    expect((await f.get('/readyz')).status).toBe(200);
    controller.abort();
    await running;
    expect(f.credentials).toHaveLength(1);
    expect(f.credentials[0].state).toBe('valid');
  });

  it('counts signed HTTP outcomes and acknowledgement time, and keeps an idle application unknown', async () => {
    const f = compose();
    const running = f.run();
    await f.ready();
    expect((await f.send({ type: 1 })).status).toBe(200);
    expect((await f.send(interaction)).status).toBe(200);
    expect((await f.send(interaction, { signature: '0'.repeat(128) })).status).toBe(401);
    expect((await f.send('not json')).status).toBe(400);
    f.world.submit = 'conflict';
    expect((await f.send(interaction)).status).toBe(409);
    expect((await f.get('/discord/other')).status).toBe(404);
    for (const [outcome, expected] of [
      ['ping', 1],
      ['accepted', 1],
      ['bad_signature', 1],
      ['bad_payload', 1],
      ['conflict', 1],
      ['not_found', 1],
    ] as const)
      expect(await f.count('ingress_total', { outcome })).toBe(expected);
    expect(await f.count('ack_seconds', { le: '+Inf' })).toBe(5);
    // Nothing about the bot has been observed, so the application is unknown, never healthy.
    const detail = await f.detail();
    expect(detail).toMatchObject({
      status: 'ready',
      process: { level: 'healthy' },
      workers: { level: 'healthy' },
      applications: 1,
      quarantined: 0,
    });
    expect(only(detail.credentials)).toBe('unknown');
    expect(only(detail.permissions)).toBe('unknown');
    expect(only(detail.native)).toBe('disabled');
    expect(Object.keys(detail).sort()).toEqual([
      'applications',
      'credentials',
      'native',
      'permissions',
      'process',
      'quarantined',
      'status',
      'workers',
    ]);
    const text = JSON.stringify(detail);
    for (const secret of [
      applicationId,
      botUserId,
      guildId,
      channelId,
      actorId,
      'revision',
      'canonical',
    ])
      expect(text).not.toContain(secret);
    controller.abort();
    await running;
  });

  it('serves the detail privately and never changes readiness or liveness', async () => {
    const f = compose();
    const before = await f.get('/readyz');
    expect(before.status).toBe(503);
    expect(await before.json()).toEqual({ status: 'not_ready' });
    const early = await f.get('/healthz/detail');
    expect(early.status).toBe(200);
    expect(early.headers.get('cache-control')).toBe('no-store');
    expect(early.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(await early.json()).toMatchObject({ status: 'not_ready', applications: 0 });
    const running = f.run();
    await f.ready();
    expect(await (await f.get('/readyz')).json()).toEqual({ status: 'ready' });
    expect(await (await f.get('/healthz')).json()).toEqual({ status: 'ready' });
    expect(await (await f.get('/livez')).json()).toEqual({ status: 'ok' });
    expect((await f.get('/healthz/detail?verbose=1')).status).toBe(200);
    expect((await fetch(await f.url('/healthz/detail'), { method: 'POST' })).status).toBe(404);
    controller.abort();
    await running;
    expect((await f.detail()).applications).toBe(0);
  });

  it('reports the native Gateway per application, and a held one stays failing without touching readiness', async () => {
    const f = compose({ gateway: true });
    const running = f.run();
    await f.ready();
    await f.until(async () => (await f.detail()).native.healthy === 1, 'a READY shard');
    expect(only((await f.detail()).credentials)).toBe('healthy');
    const [session] = f.drivers;
    session.heartbeat?.(0, 42);
    session.closed(1006, 0);
    expect(only((await f.detail()).native)).toBe('degraded');
    session.resumed(0);
    expect(only((await f.detail()).native)).toBe('healthy');
    // A mention makes the Gateway inspect the destination with the bot's own permissions.
    session.dispatch({
      shardId: 0,
      data: {
        op: 0,
        s: 2,
        t: GatewayDispatchEvents.MessageCreate,
        d: {
          id: '700',
          channel_id: channelId,
          guild_id: guildId,
          author: { ...bot, id: actorId, bot: false },
          content: `<@${botUserId}> hello`,
          timestamp: '2026-11-15T00:00:00Z',
          edited_timestamp: null,
          tts: false,
          mention_everyone: false,
          mentions: [bot],
          mention_roles: [],
          attachments: [],
          embeds: [],
          pinned: false,
          type: 0,
        },
      },
    });
    await f.until(async () => (await f.detail()).permissions.healthy === 1, 'a bot inspection');
    expect(await f.count('gateway_session_total', { event: 'ready' })).toBe(1);
    expect(await f.count('gateway_session_total', { event: 'closed_transient' })).toBe(1);
    expect(await f.count('gateway_session_total', { event: 'resumed' })).toBe(1);
    expect(await f.count('heartbeat_seconds', { le: '+Inf' })).toBe(1);
    expect(await f.count('rest_total', { route: 'channel_read', status: '2xx' })).toBeGreaterThan(
      0,
    );
    expect(await f.count('rest_total', { route: 'permissions_read', status: '2xx' })).toBe(2);
    // A fatal close holds the next session. The application keeps its lease and stays owned.
    session.closed(4014, 0);
    await f.until(async () => (await f.detail()).native.failing === 1, 'a held Gateway');
    let detail = await f.detail();
    expect(detail.applications).toBe(1);
    expect(detail.quarantined).toBe(0);
    expect(detail.status).toBe('ready');
    expect((await f.get('/readyz')).status).toBe(200);
    expect(await f.count('gateway_stop_total', { reason: 'configuration' })).toBe(1);
    expect(await f.count('applications_owned')).toBe(1);
    // The next session, after the fatal delay, recovers it.
    await f.until(async () => (await f.detail()).native.healthy === 1, 'the next session');
    expect(f.drivers).toHaveLength(2);
    detail = await f.detail();
    expect(only(detail.credentials)).toBe('healthy');
    controller.abort();
    await running;
    // The health entry ends with the lease: nothing remains for a scrape to report.
    detail = await f.detail();
    expect(detail).toMatchObject({ applications: 0 });
    expect(only(detail.native)).toBe('');
    expect(await f.count('applications_owned')).toBe(0);
    expect(await f.count('health', { concern: 'native', level: 'healthy' })).toBe(0);
    expect(await f.count('gateway_stop_total', { reason: 'shutdown' })).toBe(1);
  });

  it('starts a rotated revision unknown and inherits nothing from the previous owner', async () => {
    const f = compose({
      gateway: true,
      driver: async (attempt, driver) => {
        if (attempt > 1) return new Promise<void>(() => undefined);
        await driver.updateSessionInfo(0, {
          sessionId: 'session',
          sequence: 1,
          shardId: 0,
          shardCount: 1,
          resumeURL: 'wss://gateway.discord.gg',
        });
        driver.ready({
          shardId: 0,
          data: {
            v: 10,
            user: bot,
            application: {
              id: applicationId,
              flags: ApplicationFlags.GatewayMessageContentLimited,
              flags_new: '0',
            },
            session_id: 'session',
            resume_gateway_url: 'wss://gateway.discord.gg',
            guilds: [],
          },
        });
      },
    });
    const running = f.run();
    await f.ready();
    await f.until(async () => (await f.detail()).native.healthy === 1, 'the first revision');
    await f.until(async () => f.credentials.length === 1, 'the first credential observation');
    f.world.revision = 'revision-b';
    await f.until(async () => f.drivers.length === 2, 'the second owner');
    const detail = await f.detail();
    expect(detail.applications).toBe(1);
    expect(only(detail.credentials)).toBe('unknown');
    expect(only(detail.native)).toBe('unknown');
    expect(await f.count('applications_owned')).toBe(1);
    f.drivers[0].resumed(0);
    controller.abort();
    await running;
    expect(f.credentials).toHaveLength(1);
    expect(f.credentials[0].owner.applicationRevision).toBe('revision-a');
  });

  it('fails a worker round only after every recent task failed, and never readiness', async () => {
    const f = compose();
    f.world.channels = true;
    const running = f.run();
    await f.ready();
    await f.until(
      async () => (await f.count('turn_total', { outcome: 'idle' })) > 0,
      'an idle turn',
    );
    expect((await f.detail()).workers.level).toBe('healthy');
    f.world.runs = 'unavailable';
    f.world.inbox = 'unavailable';
    await f.until(async () => (await f.detail()).workers.level === 'degraded', 'failed tasks');
    expect(await f.count('turn_total', { outcome: 'held' })).toBeGreaterThan(0);
    expect(
      await f.count('recovery_total', { event: 'channel_service_unavailable' }),
    ).toBeGreaterThan(0);
    expect((await f.get('/readyz')).status).toBe(200);
    f.world.runs = 'idle';
    f.world.inbox = 'idle';
    await f.until(async () => (await f.detail()).workers.level === 'healthy', 'recovered tasks');
    controller.abort();
    await running;
  });

  it('does not count a rejected interaction callback token as a rejected bot credential', async () => {
    const f = compose();
    f.world.replyStatus = 401;
    f.world.inbox = 'reply';
    const running = f.run();
    await f.ready();
    await f.until(
      async () =>
        (await f.count('rest_total', { route: 'interaction_reply', status: '401' })) === 1,
      'a rejected callback',
    );
    const detail = await f.detail();
    expect(only(detail.credentials)).toBe('unknown');
    expect(only(detail.permissions)).toBe('unknown');
    controller.abort();
    await running;
    expect(f.credentials).toEqual([]);
  });

  it.each([
    [
      'every call',
      (): DiscordTelemetry => ({
        observe: () => {
          throw new Error('sink unavailable');
        },
        application: () => {
          throw new Error('sink unavailable');
        },
      }),
    ],
    [
      'every call on the application scope',
      (real: DiscordTelemetry): DiscordTelemetry => ({
        observe: real.observe,
        application: () => ({
          observe: () => {
            throw new Error('sink unavailable');
          },
          release: () => {
            throw new Error('sink unavailable');
          },
        }),
      }),
    ],
  ])(
    'keeps serving and delivering when the telemetry sink throws on %s',
    async (_name, telemetry) => {
      const f = compose({ telemetry });
      f.world.inbox = 'reply';
      const running = f.run();
      await f.ready();
      await f.until(async () => f.calls.some((path) => path.endsWith('/inbox/finish')), 'a reply');
      expect((await f.send({ type: 1 })).status).toBe(200);
      expect((await f.get('/readyz')).status).toBe(200);
      controller.abort();
      await running;
      expect(f.calls.some((path) => path.includes('/webhooks/'))).toBe(true);
    },
  );
});
