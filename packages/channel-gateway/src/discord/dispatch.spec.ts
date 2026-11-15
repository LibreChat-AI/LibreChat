import { discordChannelConfigSchema } from 'librechat-data-provider';
import type { DiscordGatewayMessage } from 'librechat-data-provider';
import { DiscordGatewayControlClient } from './ownership';
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

function fixture(status = 200, sourceStatus = 200, threadType?: 11 | 12) {
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
        return Response.json({
          permissions: threadType
            ? String(BigInt(1024 | 65536) | (BigInt(1) << BigInt(38)))
            : '68608',
        });
      if (url.pathname.endsWith('/permissions/member/600'))
        return Response.json({ permissions: '1024' });
      if (url.pathname === '/api/v10/guilds/900/members/600')
        return Response.json({ user: { id: '600' } });
      if (url.pathname.includes('/thread-members/'))
        return Response.json({ id: '800', user_id: url.pathname.split('/').at(-1) });
      if (threadType)
        return Response.json({
          id: '800',
          guild_id: '900',
          parent_id: '801',
          type: threadType,
          thread_metadata: { archived: false, locked: false },
        });
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
      gateway: new DiscordGatewayControlClient(
        {
          LIBRECHAT_INTERNAL_URL: 'http://localhost:3080',
          CHANNEL_SERVICE_TOKEN: 'service-token',
          API_CALL_TIMEOUT_MS: 1000,
        },
        transport,
      ),
      transport,
      rates: new DiscordRateCoordinator(policy.rateLimits),
    },
  };
}

it('inspects the actual destination and waits for private durable admission', async () => {
  const f = fixture();
  await dispatchDiscordEvent(f.deps, event, f.controller.signal);
  expect(f.calls).toHaveLength(5);
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
        authorId: '600',
        authorMember: true,
        authorPermissions: '1024',
      },
    },
  ]);
});

it.each([11, 12] as const)(
  'inspects actual type %s thread metadata and membership before submitting its physical destination',
  async (threadType) => {
    const f = fixture(200, 200, threadType);
    await dispatchDiscordEvent(f.deps, { ...event, channelType: threadType }, f.controller.signal);
    expect(f.submitted).toEqual([
      {
        owner,
        event: { ...event, channelType: threadType },
        source: expect.objectContaining({
          kind: 'guild_thread',
          parentChannelId: '801',
          threadChannelId: '800',
          authorId: '600',
          threadType,
        }),
      },
    ]);
    expect(f.calls.filter((path) => path === '/api/v10/channels/800')).toHaveLength(2);
    expect(f.calls.filter((path) => path.includes('/thread-members/'))).toHaveLength(
      threadType === 12 ? 2 : 0,
    );
  },
);

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
describe('guild lifecycle dispatch', () => {
  const target = {
    guildId: '900',
    installationId: 'installation',
    installationRevision: 'guild-revision',
  };
  function guildFixture(membership = 404, prepared = true, commit = 204) {
    const calls: string[] = [];
    const bodies: object[] = [];
    const transport: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      calls.push(url.pathname);
      if (url.hostname === 'discord.com') {
        expect(url.pathname).toBe('/api/v10/guilds/900');
        expect(new Headers(init?.headers).get('authorization')).toBe('Bot private-token');
        return Response.json(membership === 200 ? { id: '900' } : {}, { status: membership });
      }
      expect(new Headers(init?.headers).has('x-tenant-id')).toBe(false);
      bodies.push(JSON.parse(String(init?.body)));
      if (url.pathname.endsWith('/prepareGuildRemoval'))
        return Response.json({ target: prepared ? target : null });
      expect(url.pathname.endsWith('/removeGuild')).toBe(true);
      return new Response(null, { status: commit });
    };
    const f = fixture();
    const connection = {
      LIBRECHAT_INTERNAL_URL: 'http://localhost:3080',
      CHANNEL_SERVICE_TOKEN: 'service-token',
      API_CALL_TIMEOUT_MS: 1000,
    };
    return {
      ...f,
      calls,
      bodies,
      deps: {
        ...f.deps,
        transport,
        gateway: new DiscordGatewayControlClient(connection, transport),
      },
    };
  }
  const guildEvent = {
    ...owner,
    shardId: 0,
    sequence: 3,
    kind: 'guild' as const,
    guildId: '900',
    state: 'removed' as const,
  };
  it.each(['available', 'unavailable'] as const)(
    'ignores %s without disconnecting or reactivating',
    async (state) => {
      const f = guildFixture();
      await dispatchDiscordEvent(f.deps, { ...guildEvent, state }, f.controller.signal);
      expect(f.calls).toEqual([]);
    },
  );
  it.each([403, 404])(
    'prepares before fresh inspection and commits the exact tuple after HTTP %s',
    async (status) => {
      const f = guildFixture(status);
      await dispatchDiscordEvent(f.deps, guildEvent, f.controller.signal);
      expect(f.calls).toEqual([
        '/api/channels/discord/service/gateway/prepareGuildRemoval',
        '/api/v10/guilds/900',
        '/api/channels/discord/service/gateway/removeGuild',
      ]);
      expect(f.bodies).toEqual([
        { owner, guildId: '900' },
        { owner, target },
      ]);
    },
  );
  it('ignores a stale replay when the bot is currently a member', async () => {
    const f = guildFixture(200);
    await dispatchDiscordEvent(f.deps, guildEvent, f.controller.signal);
    expect(f.bodies).toEqual([{ owner, guildId: '900' }]);
  });
  it('ignores an already disconnected or absent installation without provider I/O', async () => {
    const f = guildFixture(404, false);
    await dispatchDiscordEvent(f.deps, guildEvent, f.controller.signal);
    expect(f.calls).toHaveLength(1);
  });
  it.each([401, 429, 503])(
    'does not commit or checkpoint when fresh inspection returns %s',
    async (status) => {
      const f = guildFixture(status);
      await expect(dispatchDiscordEvent(f.deps, guildEvent, f.controller.signal)).rejects.toThrow();
      expect(f.bodies).toHaveLength(1);
    },
  );
  it.each([409, 503])('propagates a fenced or unavailable commit HTTP %s', async (status) => {
    const f = guildFixture(404, true, status);
    await expect(
      dispatchDiscordEvent(f.deps, guildEvent, f.controller.signal),
    ).rejects.toMatchObject({ status });
  });
});
