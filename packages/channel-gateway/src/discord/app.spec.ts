import { once } from 'node:events';
import { createServer } from 'node:http';
import { generateKeyPairSync, sign } from 'node:crypto';
import { discordChannelConfigSchema } from 'librechat-data-provider';
import { ApplicationFlags, GatewayDispatchEvents } from 'discord-api-types/v10';
import type { AddressInfo } from 'node:net';
import type { DiscordGatewayDriverOptions } from './socket';
import { DiscordIdentifyRefusal } from './recovery';
import { DiscordGatewayApp } from './app';
import { loadBootstrap } from '../config';

const applicationId = '123456789012345678';
const eventId = '234567890123456789';
const applicationRevision = 'revision';
const config = loadBootstrap({
  CHANNEL_PROVIDER: 'discord',
  CHANNEL_SERVICE_TOKEN: 'private-service-token',
  LIBRECHAT_INTERNAL_URL: 'http://localhost:3080',
}).config;
const policy = discordChannelConfigSchema.parse({
  enabled: true,
  gateway: { pollIntervalMs: 100, ownershipLeaseMs: 5000, maxApplications: 1 },
});
const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
let controller: AbortController;
beforeEach(() => {
  controller = new AbortController();
});
afterEach(() => controller.abort());

it('claims durable private replies only while owning the application and drains before release', async () => {
  let complete!: () => void;
  const finished = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const calls: string[] = [];
  let held = false;
  let delivered = false;
  let claimed = false;
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const path = url.pathname;
    calls.push(path);
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
    if (url.hostname === 'discord.com') {
      expect(held).toBe(true);
      expect(path).toBe(`/api/v10/webhooks/${applicationId}/interaction-token/messages/@original`);
      expect(init?.method).toBe('PATCH');
      expect(new Headers(init?.headers).has('authorization')).toBe(false);
      expect(body).toMatchObject({ content: 'Private reply', allowed_mentions: { parse: [] } });
      delivered = true;
      return Response.json({ id: eventId });
    }
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer private-service-token');
    expect(new Headers(init?.headers).has('x-tenant-id')).toBe(false);
    if (path.endsWith('/runtime/applications'))
      return Response.json({
        applications: [{ applicationId, applicationRevision, tenantId: 'canonical' }],
      });
    if (path.endsWith('/runtime/channels')) return Response.json({ channels: [] });
    if (path.endsWith('/gateway/acquire')) {
      expect(body.leaseMs).toBe(5000);
      held = true;
      return new Response(null, { status: 204 });
    }
    if (path.endsWith('/gateway/renew')) return new Response(null, { status: 204 });
    if (path.endsWith('/gateway/release')) {
      held = false;
      return new Response(null, { status: 204 });
    }
    if (path.endsWith('/inbox/claim')) {
      expect(held).toBe(true);
      if (claimed) return new Response(null, { status: 204 });
      claimed = true;
      return Response.json({
        fence: { applicationId, eventId, owner: body.owner, epoch: 1 },
        applicationRevision,
        token: 'interaction-token',
        expiresAt: Date.now() + 10000,
        reply: { content: 'Private reply' },
      });
    }
    if (path.endsWith('/inbox/finish')) {
      expect(delivered).toBe(true);
      complete();
      return new Response(null, { status: 204 });
    }
    throw new Error('Unexpected service request');
  };
  const app = new DiscordGatewayApp(config, policy, log, transport);
  app.ready = true;
  const running = app.run(controller.signal);
  try {
    await finished;
  } finally {
    controller.abort();
    await running;
  }
  expect(calls.filter((path) => path.includes('/webhooks/'))).toHaveLength(1);
  expect(calls.at(-1)).toBe('/api/channels/discord/service/gateway/release');
  expect(held).toBe(false);
  expect(app.ready).toBe(false);
});

it('does not claim work or send provider requests when another process owns the application', async () => {
  let scans = 0;
  const calls: string[] = [];
  const transport: typeof fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push(url.pathname);
    if (url.pathname.endsWith('/runtime/applications')) {
      if (++scans === 3) controller.abort();
      return Response.json({
        applications: [{ applicationId, applicationRevision, tenantId: '_' }],
      });
    }
    if (url.pathname.endsWith('/runtime/channels')) return Response.json({ channels: [] });
    if (url.pathname.endsWith('/gateway/acquire')) return new Response('{}', { status: 409 });
    throw new Error('Unexpected service request');
  };
  await new DiscordGatewayApp(config, policy, log, transport).run(controller.signal);
  expect(calls.some((path) => path.includes('/inbox/') || path.includes('/webhooks/'))).toBe(false);
  expect(calls.filter((path) => path.endsWith('/gateway/acquire')).length).toBeGreaterThan(0);
});

it('runs enabled Gateway messages through the same application owner and protected admission client', async () => {
  const enabledPolicy = { ...policy, gateway: { ...policy.gateway, enabled: true } };
  let admitted!: () => void;
  const finished = new Promise<void>((resolve) => {
    admitted = resolve;
  });
  let claimedOwner: object | undefined;
  let released = false;
  const bot = {
    id: '456',
    bot: true,
    username: 'bot',
    discriminator: '0',
    global_name: null,
    avatar: null,
  };
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
    if (url.hostname === 'discord.com') {
      if (url.pathname.endsWith('/permissions/member/456'))
        return Response.json({ permissions: '68608' });
      if (url.pathname.endsWith('/permissions/member/600'))
        return Response.json({ permissions: '1024' });
      if (url.pathname === '/api/v10/guilds/900/members/600')
        return Response.json({ user: { id: '600' } });
      expect(url.pathname).toBe('/api/v10/channels/800');
      return Response.json({ id: '800', guild_id: '900', type: 0 });
    }
    const path = url.pathname;
    if (path.endsWith('/runtime/applications'))
      return Response.json({
        applications: [{ applicationId, applicationRevision, tenantId: '_' }],
      });
    if (path.endsWith('/runtime/channels')) return Response.json({ channels: [] });
    if (path.endsWith('/gateway/acquire')) {
      expect(claimedOwner).toBeUndefined();
      claimedOwner = body.owner;
      return new Response(null, { status: 204 });
    }
    if (path.includes('/gateway/')) {
      expect(body.owner).toEqual(claimedOwner);
      if (path.endsWith('/bootstrap'))
        return Response.json({
          applicationId,
          applicationRevision,
          botUserId: bot.id,
          botToken: 'private-token',
          policy: enabledPolicy.gateway,
        });
      if (path.endsWith('/load'))
        return Response.json({
          applicationId,
          applicationRevision,
          botUserId: bot.id,
          checkpoints: [],
        });
      if (path.endsWith('/release')) released = true;
      return new Response(null, { status: 204 });
    }
    if (path.endsWith('/inbox/claim')) return new Response(null, { status: 204 });
    expect(path).toBe('/api/channels/discord/service/messages');
    expect(body.owner).toEqual(claimedOwner);
    expect(body.event).toMatchObject({
      applicationId,
      applicationRevision,
      messageId: '700',
      content: '<@456> hello',
    });
    expect(body.source).toMatchObject({ kind: 'guild_text', guildId: '900', channelId: '800' });
    admitted();
    return Response.json({ outcome: 'admitted' });
  };
  const destroy = jest.fn(async () => {});
  const createDriver = (options: DiscordGatewayDriverOptions) => ({
    destroy,
    async connect() {
      await options.updateSessionInfo(0, {
        sessionId: 'session',
        sequence: 1,
        shardId: 0,
        shardCount: 1,
        resumeURL: 'wss://gateway.discord.gg',
      });
      options.ready({
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
      options.dispatch({
        shardId: 0,
        data: {
          op: 0,
          s: 2,
          t: GatewayDispatchEvents.MessageCreate,
          d: {
            id: '700',
            channel_id: '800',
            guild_id: '900',
            author: { ...bot, id: '600', bot: false },
            content: '<@456> hello',
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
    },
  });
  const app = new DiscordGatewayApp(config, enabledPolicy, log, transport, createDriver);
  const running = app.run(controller.signal);
  try {
    await finished;
  } finally {
    controller.abort();
    await running;
  }
  expect(released).toBe(true);
  expect(destroy).toHaveBeenCalledTimes(1);
});

it.each(['visible', 'denied', 'outage', 'thread'] as const)(
  'preflights signed text prompts through the owned rate-coordinated actor inspector (%s)',
  async (state) => {
    const thread = state === 'thread';
    const visible = state === 'visible' || thread;
    const outage = state === 'outage';
    let complete!: () => void;
    const finished = new Promise<void>((resolve) => {
      complete = resolve;
    });
    let held = false;
    let claimed = false;
    let ownerId = '';
    let resolutions = 0;
    let writes = 0;
    let deferrals = 0;
    const expiresAt = Date.now() + 10000;
    const observed: string[] = [];
    const transport: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      const path = url.pathname;
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
      if (url.hostname === 'discord.com') {
        expect(held).toBe(true);
        if (init?.method === 'GET') {
          expect(new Headers(init.headers).get('authorization')).toBe(
            'Bot private-inspection-token',
          );
          observed.push(path);
          if (path.endsWith('/permissions/member/456'))
            return Response.json({
              permissions: thread
                ? String(BigInt(1024 | 65536) | (BigInt(1) << BigInt(38)))
                : '68608',
            });
          if (path.endsWith('/permissions/member/600'))
            return outage
              ? Response.json({ message: 'Private actor REST diagnostic' }, { status: 503 })
              : Response.json({ permissions: visible ? '1024' : '0' });
          if (path.endsWith('/guilds/900/members/600'))
            return Response.json({ user: { id: '600' } });
          expect(path).toBe('/api/v10/channels/800');
          return thread
            ? Response.json({
                id: '800',
                guild_id: '900',
                parent_id: '700',
                type: 11,
                thread_metadata: { archived: false, locked: false },
              })
            : Response.json({ id: '800', guild_id: '900', type: 0 });
        }
        expect(path).toBe(
          `/api/v10/webhooks/${applicationId}/interaction-token/messages/@original`,
        );
        writes++;
        expect(outage).toBe(false);
        expect(body.content).toBe(visible ? 'Authorized.' : 'Unavailable.');
        return Response.json({ id: eventId });
      }
      if (path.endsWith('/runtime/applications'))
        return Response.json({
          applications: [{ applicationId, applicationRevision, tenantId: 'canonical' }],
        });
      if (path.endsWith('/runtime/channels')) return Response.json({ channels: [] });
      if (path.endsWith('/gateway/acquire')) {
        held = true;
        ownerId = body.owner.ownerId;
        return new Response(null, { status: 204 });
      }
      if (path.endsWith('/gateway/renew')) return new Response(null, { status: 204 });
      if (path.endsWith('/gateway/release')) {
        held = false;
        return new Response(null, { status: 204 });
      }
      if (path.endsWith('/gateway/bootstrap')) {
        expect(body.owner).toEqual({ applicationId, applicationRevision, ownerId });
        return Response.json({
          applicationId,
          applicationRevision,
          botUserId: '456',
          botToken: 'private-inspection-token',
          policy: policy.gateway,
        });
      }
      if (path.endsWith('/inbox/claim')) {
        if (claimed) return new Response(null, { status: 204 });
        claimed = true;
        return Response.json({
          fence: { applicationId, eventId, owner: ownerId, epoch: 1 },
          applicationRevision,
          expiresAt,
          inspection: { guildId: '900', externalChannelId: '800', externalUserId: '600' },
        });
      }
      if (path.endsWith('/inbox/resolve')) {
        resolutions++;
        expect(outage).toBe(false);
        expect(observed).toHaveLength(state === 'visible' ? 4 : 7);
        expect(body.owner).toEqual({ applicationId, applicationRevision, ownerId });
        if (thread)
          expect(body.source).toMatchObject({
            kind: 'guild_thread',
            threadChannelId: '800',
            parentChannelId: '700',
            authorId: '600',
          });
        else
          expect(body.source).toEqual(
            visible
              ? {
                  kind: 'guild_text',
                  applicationId,
                  botUserId: '456',
                  guildId: '900',
                  channelId: '800',
                  permissions: '68608',
                  authorId: '600',
                  authorMember: true,
                  authorPermissions: '1024',
                }
              : null,
          );
        return Response.json({
          fence: body.fence,
          applicationRevision,
          expiresAt,
          token: 'interaction-token',
          reply: { content: visible ? 'Authorized.' : 'Unavailable.' },
        });
      }
      if (path.endsWith('/inbox/defer')) {
        expect(outage).toBe(true);
        expect(body.fence).toEqual({ applicationId, eventId, owner: ownerId, epoch: 1 });
        expect(body.retryAt).toBeGreaterThan(Date.now());
        expect(body.retryAt).toBeLessThanOrEqual(expiresAt);
        deferrals++;
        complete();
        return new Response(null, { status: 204 });
      }
      if (path.endsWith('/inbox/finish')) {
        expect(outage).toBe(false);
        complete();
        return new Response(null, { status: 204 });
      }
      throw new Error('Unexpected request');
    };
    const running = new DiscordGatewayApp(config, policy, log, transport).run(controller.signal);
    try {
      await finished;
    } finally {
      controller.abort();
      await running;
    }
    expect(held).toBe(false);
    expect(resolutions).toBe(outage ? 0 : 1);
    expect(writes).toBe(outage ? 0 : 1);
    expect(deferrals).toBe(outage ? 1 : 0);
    if (outage) expect(observed).toHaveLength(4);
  },
);

it('routes verified DM commands through the production app while Gateway message ingestion is off', async () => {
  const keys = generateKeyPairSync('ed25519');
  const publicKey = keys.publicKey
    .export({ type: 'spki', format: 'der' })
    .subarray(-32)
    .toString('hex');
  const dmPolicy = {
    ...policy,
    dm: { ...policy.dm, enabled: true },
    gateway: { ...policy.gateway, enabled: false },
  };
  let ready!: () => void;
  const healthy = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const submissions: object[] = [];
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    expect(url.origin).toBe('http://localhost:3080');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer private-service-token');
    expect(new Headers(init?.headers).has('x-tenant-id')).toBe(false);
    if (url.pathname.endsWith('/runtime/applications')) return Response.json({ applications: [] });
    if (url.pathname.endsWith('/runtime/channels')) return Response.json({ channels: [] });
    if (url.pathname.endsWith(`/security/${applicationId}`))
      return Response.json({
        applicationId,
        applicationRevision,
        publicKey,
        tenantId: '_',
        botUserId: '789012345678901234',
      });
    expect(url.pathname).toBe('/api/channels/discord/service/inbox/dm');
    const body = JSON.parse(String(init?.body));
    submissions.push(body);
    return Response.json(
      { ok: true, value: { eventId: body.eventId, state: 'queued', duplicate: false } },
      { status: 201 },
    );
  };
  const app = new DiscordGatewayApp(
    config,
    dmPolicy,
    {
      ...log,
      info: (message) => {
        if (message === 'discord_gateway_ready') ready();
      },
    },
    transport,
  );
  app.ready = true;
  const running = app.run(controller.signal);
  const server = createServer((req, res) => {
    void app.http(req, res);
  });
  try {
    await healthy;
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const body = JSON.stringify({
      type: 2,
      id: eventId,
      application_id: applicationId,
      token: 'signed-dm-token',
      version: 1,
      context: 1,
      user: { id: '456789012345678901' },
      authorizing_integration_owners: { '0': '0' },
      channel_id: '345678901234567890',
      channel: { id: '345678901234567890', type: 1 },
      data: {
        id: '678901234567890123',
        name: 'librechat',
        type: 1,
        options: [
          {
            name: 'ask',
            type: 1,
            options: [{ name: 'prompt', type: 3, value: 'Private question' }],
          },
        ],
      },
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/discord/${applicationId}/interactions`;
    const send = (signature: string) =>
      fetch(url, {
        method: 'POST',
        body,
        headers: {
          'content-type': 'application/json',
          'x-signature-timestamp': timestamp,
          'x-signature-ed25519': signature,
        },
      });
    expect((await send('0'.repeat(128))).status).toBe(401);
    expect(submissions).toEqual([]);
    const response = await send(
      sign(null, Buffer.from(timestamp + body), keys.privateKey).toString('hex'),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ type: 5, data: { flags: 64 } });
    expect(submissions).toHaveLength(1);
    expect(submissions[0]).toMatchObject({
      scope: 'dm',
      applicationId,
      eventId,
      externalChannelId: '345678901234567890',
      externalUserId: '456789012345678901',
      action: { kind: 'ask', prompt: 'Private question' },
    });
    expect(submissions[0]).not.toHaveProperty('guildId');
  } finally {
    controller.abort();
    await running;
    server.closeAllConnections();
    if (server.listening)
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
  }
});

describe('a Gateway session that fails while its application stays owned', () => {
  const recovery = {
    fatalRetryMinMs: 1000,
    fatalRetryMaxMs: 2000,
    retryMaxMs: 1000,
    resetAfterMs: 1000,
  };
  const heldPolicy = discordChannelConfigSchema.parse({
    enabled: true,
    gateway: {
      enabled: true,
      pollIntervalMs: 100,
      ownershipLeaseMs: 5000,
      maxApplications: 1,
      recovery,
    },
  });
  // One startup attempt may take 3 x 1000 + 1000 ms: the REST read, the socket, HELLO and READY.
  const startupPolicy = discordChannelConfigSchema.parse({
    enabled: true,
    gateway: {
      enabled: true,
      pollIntervalMs: 100,
      ownershipLeaseMs: 5000,
      maxApplications: 1,
      handshakeTimeoutMs: 1000,
      readyTimeoutMs: 1000,
      recovery,
    },
  });
  jest.setTimeout(20_000);

  function harness(
    options: {
      silent?: boolean;
      /** How every attempt fails. A throw rejects the connect, as a refused budget or a failed read does. */
      connect?: (driver: DiscordGatewayDriverOptions) => void;
    } = {},
  ) {
    const policy = options.silent ? startupPolicy : heldPolicy;
    const startedAt = Date.now();
    const marks: { path: string; at: number; revision?: string }[] = [];
    const warns: string[] = [];
    let revision = 'revision-a';
    let queued = false;
    const after = (path: string) => marks.filter((mark) => mark.path.endsWith(path));
    const transport: typeof fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
      marks.push({
        path: url.pathname,
        at: Date.now() - startedAt,
        revision: body.owner?.applicationRevision,
      });
      const path = url.pathname;
      if (url.hostname === 'discord.com') return Response.json({ id: eventId });
      if (path.endsWith('/runtime/applications'))
        return Response.json({
          applications: [{ applicationId, applicationRevision: revision, tenantId: 'canonical' }],
        });
      if (path.endsWith('/runtime/channels')) return Response.json({ channels: [] });
      if (path.endsWith('/gateway/bootstrap'))
        return Response.json({
          applicationId,
          applicationRevision: body.owner.applicationRevision,
          botUserId: '456',
          botToken: 'private-token',
          policy: policy.gateway,
        });
      if (path.endsWith('/gateway/load'))
        return Response.json({
          applicationId,
          applicationRevision: body.owner.applicationRevision,
          botUserId: '456',
          checkpoints: [],
        });
      if (/\/gateway\/(acquire|renew|release|save)$/.test(path))
        return new Response(null, { status: 204 });
      if (path.endsWith('/inbox/claim')) {
        if (!queued) return new Response(null, { status: 204 });
        queued = false;
        return Response.json({
          fence: { applicationId, eventId, owner: body.owner, epoch: 1 },
          applicationRevision: revision,
          token: 'interaction-token',
          expiresAt: Date.now() + 10_000,
          reply: { content: 'Private reply' },
        });
      }
      if (path.endsWith('/inbox/finish')) return new Response(null, { status: 204 });
      throw new Error('Unexpected service request ' + path);
    };
    // Every attempt is closed by Discord with 4014 (a disallowed intent), a fatal Gateway stop, or
    // fails as `connect` says, or, when silent, never answers at all.
    const createDriver = (driver: DiscordGatewayDriverOptions) => ({
      async connect() {
        if (options.connect) options.connect(driver);
        else if (!options.silent) driver.closed(4014, 0);
        await new Promise<void>(() => undefined);
      },
      destroy: async () => undefined,
    });
    const app = new DiscordGatewayApp(
      config,
      policy,
      {
        info: () => undefined,
        warn: (event: string) => void warns.push(event),
        error: () => undefined,
      },
      transport,
      createDriver,
    );
    const sessions = () => after('/gateway/bootstrap');
    const waitForSessions = async (count: number) => {
      while (sessions().length < count) await new Promise((resolve) => setTimeout(resolve, 20));
    };
    return {
      app,
      marks,
      warns,
      after,
      sessions,
      waitForSessions,
      queueReply: () => {
        queued = true;
      },
      rotate: () => {
        revision = 'revision-b';
      },
    };
  }

  it('keeps the lease and answers inbox work while a fatal stop holds the next session', async () => {
    const h = harness();
    const running = h.app.run(controller.signal);
    await h.waitForSessions(1);
    h.queueReply();
    await h.waitForSessions(3);
    const [first, second, third] = h.sessions();
    controller.abort();
    await running;
    // The fatal ladder applies to the session alone: 1 s, then 2 s, never an immediate retry.
    expect(second.at - first.at).toBeGreaterThanOrEqual(900);
    expect(second.at - first.at).toBeLessThan(1600);
    expect(third.at - second.at).toBeGreaterThanOrEqual(1900);
    expect(third.at - second.at).toBeLessThan(2700);
    const between = (mark: { at: number }) => mark.at > first.at && mark.at < second.at;
    expect(h.after('/inbox/claim').filter(between).length).toBeGreaterThanOrEqual(7);
    const replies = h.marks.filter((mark) => mark.path.includes('/webhooks/'));
    expect(replies).toHaveLength(1);
    expect(between(replies[0])).toBe(true);
    expect(h.after('/inbox/finish').filter(between)).toHaveLength(1);
    // One lease for the whole time, released once at shutdown.
    expect(h.after('/gateway/acquire')).toHaveLength(1);
    expect(h.after('/gateway/release')).toHaveLength(1);
    expect(h.marks.at(-1)?.path.endsWith('/gateway/release')).toBe(true);
    expect(h.warns.filter((event) => event === 'discord_application_quarantined')).toHaveLength(3);
    expect(h.warns).not.toContain('discord_application_runtime_unavailable');
  });

  it('starts a new owner at once for a new revision and gives it a fresh ladder', async () => {
    const h = harness();
    const running = h.app.run(controller.signal);
    await h.waitForSessions(1);
    await new Promise((resolve) => setTimeout(resolve, 250));
    h.rotate();
    await h.waitForSessions(3);
    const [first, second, third] = h.sessions();
    controller.abort();
    await running;
    expect([first.revision, second.revision, third.revision]).toEqual([
      'revision-a',
      'revision-b',
      'revision-b',
    ]);
    // The previous revision's hold (1 s) is bypassed, and the new owner starts at the minimum.
    expect(second.at - first.at).toBeLessThan(900);
    expect(third.at - second.at).toBeGreaterThanOrEqual(900);
    expect(third.at - second.at).toBeLessThan(1600);
    expect(h.after('/gateway/acquire').map((mark) => mark.revision)).toEqual([
      'revision-a',
      'revision-b',
    ]);
    expect(h.after('/gateway/release').length).toBeGreaterThanOrEqual(2);
  });

  it('stops a Gateway that never answers at its startup deadline, keeping the lease and the REST workers', async () => {
    const h = harness({ silent: true });
    const running = h.app.run(controller.signal);
    await h.waitForSessions(1);
    const waitingSince = Date.now();
    h.queueReply();
    while (!h.warns.includes('discord_gateway_start_timeout')) {
      if (Date.now() - waitingSince > 10_000) throw new Error('The startup never timed out');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const waited = Date.now() - waitingSince;
    const [first] = h.sessions();
    // The session gave up at 3 x 1000 + 1000 ms, and nothing else about the application stopped.
    expect(waited).toBeGreaterThanOrEqual(3800);
    expect(waited).toBeLessThan(6000);
    const during = (mark: { at: number }) => mark.at > first.at && mark.at < first.at + waited;
    expect(h.after('/inbox/claim').filter(during).length).toBeGreaterThanOrEqual(25);
    expect(h.after('/inbox/finish').filter(during)).toHaveLength(1);
    expect(h.after('/gateway/acquire')).toHaveLength(1);
    expect(h.after('/gateway/release')).toHaveLength(0);
    // A session that could not start holds the next one on the fatal ladder (1 s here), not the short
    // poll based delay (about 100 ms) of an ordinary failure, so a Gateway that never answers cannot
    // spend an IDENTIFY every minute.
    await h.waitForSessions(2);
    const [, second] = h.sessions();
    expect(second.at - first.at - waited).toBeGreaterThanOrEqual(900);
    expect(h.warns).toContain('discord_application_quarantined');
    expect(h.warns).not.toContain('discord_application_runtime_unavailable');
    const abortedAt = Date.now();
    controller.abort();
    await running;
    expect(Date.now() - abortedAt).toBeLessThan(1500);
    expect(h.after('/gateway/acquire')).toHaveLength(1);
    expect(h.after('/gateway/release')).toHaveLength(1);
  });

  it('holds a refused startup on the fatal ladder, doubling to its cap, while the REST workers keep working', async () => {
    const h = harness({
      connect: () => {
        throw new DiscordIdentifyRefusal('exhausted');
      },
    });
    const running = h.app.run(controller.signal);
    await h.waitForSessions(1);
    h.queueReply();
    await h.waitForSessions(3);
    const [first, second, third] = h.sessions();
    controller.abort();
    await running;
    // 1 s, then 2 s (the cap here): a spent budget is never retried at the short ordinary delay.
    expect(second.at - first.at).toBeGreaterThanOrEqual(900);
    expect(second.at - first.at).toBeLessThan(1600);
    expect(third.at - second.at).toBeGreaterThanOrEqual(1900);
    expect(third.at - second.at).toBeLessThan(2700);
    const between = (mark: { at: number }) => mark.at > first.at && mark.at < second.at;
    expect(h.after('/inbox/claim').filter(between).length).toBeGreaterThanOrEqual(7);
    expect(h.after('/inbox/finish').filter(between)).toHaveLength(1);
    expect(h.after('/gateway/acquire')).toHaveLength(1);
    expect(h.after('/gateway/release')).toHaveLength(1);
    const logged = (event: string) => h.warns.filter((warn) => warn === event).length;
    expect(logged('discord_gateway_identify_refused:exhausted')).toBeGreaterThanOrEqual(2);
    expect(logged('discord_application_quarantined')).toBeGreaterThanOrEqual(2);
    expect(h.warns).not.toContain('discord_application_runtime_unavailable');
  });

  it('keeps a failure that is not a refused startup on the short transient ladder', async () => {
    const h = harness({
      connect: () => {
        throw new Error('private transport detail');
      },
    });
    const running = h.app.run(controller.signal);
    await h.waitForSessions(4);
    const [first, , , fourth] = h.sessions();
    controller.abort();
    await running;
    // Poll based delays with jitter: at most 100, 200 and 400 ms. On the fatal ladder these gaps are 5 s.
    expect(fourth.at - first.at).toBeLessThan(1200);
    expect(h.warns).toContain('discord_application_runtime_unavailable');
    expect(h.warns).not.toContain('discord_application_quarantined');
    expect(h.warns.filter((warn) => warn.startsWith('discord_gateway_identify_refused'))).toEqual(
      [],
    );
    expect(JSON.stringify(h.warns)).not.toMatch(/private/);
  });

  it('stops promptly during a hold and releases the lease exactly once', async () => {
    const h = harness();
    const running = h.app.run(controller.signal);
    await h.waitForSessions(1);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const abortedAt = Date.now();
    controller.abort();
    await running;
    expect(Date.now() - abortedAt).toBeLessThan(500);
    expect(h.sessions()).toHaveLength(1);
    expect(h.after('/gateway/acquire')).toHaveLength(1);
    expect(h.after('/gateway/release')).toHaveLength(1);
    expect(h.app.ready).toBe(false);
  });
});
