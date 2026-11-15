import { discordChannelConfigSchema } from 'librechat-data-provider';
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
