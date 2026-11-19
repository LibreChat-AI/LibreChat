import { discordChannelConfigSchema } from 'librechat-data-provider';
import { ApplicationFlags, GatewayDispatchEvents } from 'discord-api-types/v10';
import type { DiscordGatewayDriverOptions } from './socket';
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

it.each(['visible', 'denied', 'outage'] as const)(
  'preflights signed text prompts through the owned rate-coordinated actor inspector (%s)',
  async (state) => {
    const visible = state === 'visible';
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
            return Response.json({ permissions: '68608' });
          if (path.endsWith('/permissions/member/600'))
            return outage
              ? Response.json({ message: 'Private actor REST diagnostic' }, { status: 503 })
              : Response.json({ permissions: visible ? '1024' : '0' });
          if (path.endsWith('/guilds/900/members/600'))
            return Response.json({ user: { id: '600' } });
          expect(path).toBe('/api/v10/channels/800');
          return Response.json({ id: '800', guild_id: '900', type: 0 });
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
        expect(observed).toHaveLength(4);
        expect(body.owner).toEqual({ applicationId, applicationRevision, ownerId });
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
  },
);
