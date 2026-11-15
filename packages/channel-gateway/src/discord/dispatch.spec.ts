import { discordChannelConfigSchema } from 'librechat-data-provider';
import type { DiscordGatewayMessage } from 'librechat-data-provider';
import { DiscordRuntimeClient } from './discovery';
import { dispatchDiscordEvent } from './dispatch';
import { DiscordRateCoordinator } from './rates';

const owner = { applicationId: '123', applicationRevision: 'revision', ownerId: 'a'.repeat(32) };
const policy = discordChannelConfigSchema.parse({ enabled: true, gateway: { enabled: true } });
const application = {
  ...owner,
  botUserId: '456',
  botToken: 'private-token',
  policy: policy.gateway,
};
const event: DiscordGatewayMessage = {
  ...owner,
  kind: 'message',
  shardId: 0,
  sequence: 2,
  messageId: '700',
  channelId: '800',
  guildId: '900',
  authorId: '600',
  content: '<@456> hello',
  mentionsBot: true,
};

function fixture(status = 200, sourceStatus = 200) {
  const calls: string[] = [];
  const controller = new AbortController();
  const submitted: object[] = [];
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    if (url.hostname === 'discord.com') {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bot private-token');
      if (sourceStatus !== 200) return Response.json({}, { status: sourceStatus });
      if (url.pathname.endsWith('/permissions/member/456'))
        return Response.json({ permissions: '68608' });
      expect(url.pathname).toBe('/api/v10/channels/800');
      return Response.json({ id: '800', guild_id: '900', type: 0 });
    }
    expect(url.pathname).toBe('/api/channels/discord/service/messages');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer service-token');
    expect(new Headers(init?.headers).has('x-tenant-id')).toBe(false);
    const body = JSON.parse(String(init?.body));
    submitted.push(body);
    expect(body.owner).toEqual(owner);
    expect(body.event).toEqual(expect.objectContaining({ messageId: event.messageId }));
    return Response.json(status === 200 ? { outcome: 'admitted' } : { error: 'unavailable' }, {
      status,
    });
  };
  const runtime = new DiscordRuntimeClient(
    {
      LIBRECHAT_INTERNAL_URL: 'http://localhost:3080',
      CHANNEL_SERVICE_TOKEN: 'service-token',
      API_CALL_TIMEOUT_MS: 1000,
    },
    transport,
  );
  return {
    calls,
    submitted,
    controller,
    deps: {
      owner,
      application,
      policy,
      runtime,
      transport,
      rates: new DiscordRateCoordinator(policy.rateLimits),
    },
  };
}

it('inspects the actual destination and waits for private durable admission', async () => {
  const f = fixture();
  await dispatchDiscordEvent(f.deps, event, f.controller.signal);
  expect(f.calls).toHaveLength(3);
  expect(f.submitted).toEqual([
    {
      owner,
      event,
      source: {
        kind: 'guild_text',
        applicationId: '123',
        botUserId: '456',
        guildId: '900',
        channelId: '800',
        permissions: '68608',
      },
    },
  ]);
});

it.each([
  { content: 'ordinary message', mentionsBot: false },
  { content: 'implicit reply mention', mentionsBot: true },
  { content: '<@456> spoofed mention', mentionsBot: false },
])('does not inspect or persist ineligible messages: %s', async (change) => {
  const f = fixture();
  await dispatchDiscordEvent(f.deps, { ...event, ...change }, f.controller.signal);
  expect(f.calls).toEqual([]);
});

it.each([409, 503])(
  'propagates admission HTTP %s so the SDK cannot checkpoint the event',
  async (status) => {
    const f = fixture(status);
    await expect(dispatchDiscordEvent(f.deps, event, f.controller.signal)).rejects.toMatchObject({
      status,
    });
  },
);

it('records unavailable source permission as a durable ignored candidate', async () => {
  const f = fixture(200, 403);
  await dispatchDiscordEvent(f.deps, event, f.controller.signal);
  expect(f.submitted).toEqual([{ owner, event, source: null }]);
});

it('does not consume an event during a provider outage', async () => {
  const f = fixture(200, 503);
  await expect(dispatchDiscordEvent(f.deps, event, f.controller.signal)).rejects.toThrow();
  expect(f.submitted).toEqual([]);
});

it('rejects a mismatched owner before using credentials', async () => {
  const f = fixture();
  await expect(
    dispatchDiscordEvent(f.deps, { ...event, ownerId: 'b'.repeat(32) }, f.controller.signal),
  ).rejects.toThrow('ownership changed');
  expect(f.calls).toEqual([]);
});
