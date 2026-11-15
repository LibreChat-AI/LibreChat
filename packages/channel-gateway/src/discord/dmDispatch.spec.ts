import { discordChannelConfigSchema } from 'librechat-data-provider';
import type { DiscordGatewayMessage } from 'librechat-data-provider';
import { DiscordGatewayControlClient } from './ownership';
import { DiscordRuntimeClient } from './discovery';
import { dispatchDiscordEvent } from './dispatch';
import { DiscordRateCoordinator } from './rates';

const owner = { applicationId: '123', applicationRevision: 'revision', ownerId: 'a'.repeat(32) };
const event: DiscordGatewayMessage = {
  ...owner,
  kind: 'message',
  shardId: 0,
  sequence: 1,
  messageId: '234',
  channelId: '345',
  authorId: '456',
  content: 'private message',
  mentionsBot: false,
};
const prepared = {
  applicationId: '123',
  externalUserId: '456',
  dmChannelId: '345',
  selectionId: 'selection',
  selectionRevision: 'generation',
  guildId: '567',
  parentChannelId: '678',
  botUserId: '789',
};
function fixture(
  options: {
    sourceStatus?: number;
    selected?: boolean;
    wrongActor?: boolean;
    enabled?: boolean;
    admissionStatus?: number;
    invalidResponse?: 'prepare' | 'message';
  } = {},
) {
  const calls: string[] = [];
  const submissions: object[] = [];
  const policy = discordChannelConfigSchema.parse({
    enabled: true,
    gateway: { enabled: true },
    dm: { enabled: options.enabled !== false },
  });
  const connection = {
    LIBRECHAT_INTERNAL_URL: 'http://localhost:3080',
    CHANNEL_SERVICE_TOKEN: 'service-token',
    API_CALL_TIMEOUT_MS: 1000,
  };
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    if (url.hostname === 'discord.com') {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bot private-token');
      if (options.sourceStatus && options.sourceStatus !== 200)
        return Response.json({}, { status: options.sourceStatus });
      if (url.pathname === '/api/v10/guilds/567/members/456')
        return Response.json({ user: { id: '456' } });
      if (url.pathname.endsWith('/permissions/member/789'))
        return Response.json({ permissions: '68608' });
      if (url.pathname.endsWith('/permissions/member/456'))
        return Response.json({ permissions: '1024' });
      expect(url.pathname).toBe('/api/v10/channels/678');
      return Response.json({ id: '678', type: 0, guild_id: '567' });
    }
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer service-token');
    expect(new Headers(init?.headers).has('x-tenant-id')).toBe(false);
    const body = JSON.parse(String(init?.body));
    expect(body.owner).toEqual(owner);
    expect(body.event).toEqual(event);
    if (options.invalidResponse && url.pathname.endsWith(`/${options.invalidResponse}`))
      return new Response('private malformed payload');
    if (url.pathname.endsWith('/prepare'))
      return Response.json(
        options.selected === false
          ? null
          : { ...prepared, ...(options.wrongActor ? { externalUserId: '999' } : {}) },
      );
    expect(url.pathname).toBe('/api/channels/discord/service/dm/message');
    submissions.push(body);
    return Response.json(
      options.admissionStatus ? { error: 'authority_changed' } : { outcome: 'admitted' },
      { status: options.admissionStatus || 200 },
    );
  };
  return {
    calls,
    submissions,
    deps: {
      owner,
      policy,
      application: {
        ...owner,
        botUserId: '789',
        botToken: 'private-token',
        policy: policy.gateway,
      },
      rates: new DiscordRateCoordinator(policy.rateLimits),
      transport,
      runtime: new DiscordRuntimeClient(connection, transport),
      gateway: new DiscordGatewayControlClient(connection, transport),
    },
  };
}
it('inspects the real selected guild source and submits the unchanged physical private message', async () => {
  const f = fixture();
  await dispatchDiscordEvent(f.deps, event, new AbortController().signal);
  expect(f.calls).toHaveLength(6);
  expect(f.calls).not.toContain('/api/v10/channels/345');
  expect(f.submissions).toEqual([
    {
      owner,
      event,
      selectionId: 'selection',
      selectionRevision: 'generation',
      source: {
        kind: 'guild_text',
        applicationId: '123',
        botUserId: '789',
        guildId: '567',
        channelId: '678',
        permissions: '68608',
        authorId: '456',
        authorMember: true,
        authorPermissions: '1024',
      },
    },
  ]);
});
it('does no Discord I/O before explicit enabled selection and refuses mismatched preparation identity', async () => {
  const disabled = fixture({ enabled: false });
  await dispatchDiscordEvent(disabled.deps, event, new AbortController().signal);
  expect(disabled.calls).toEqual([]);
  const absent = fixture({ selected: false });
  await dispatchDiscordEvent(absent.deps, event, new AbortController().signal);
  expect(absent.calls).toEqual(['/api/channels/discord/service/dm/prepare']);
  const changed = fixture({ wrongActor: true });
  await expect(
    dispatchDiscordEvent(changed.deps, event, new AbortController().signal),
  ).rejects.toThrow('identity changed');
  expect(changed.calls).toHaveLength(1);
});
it('submits definite source denial for durable consumption but preserves uncertainty on operational failure', async () => {
  const denied = fixture({ sourceStatus: 403 });
  await dispatchDiscordEvent(denied.deps, event, new AbortController().signal);
  expect(denied.submissions).toEqual([expect.objectContaining({ source: null })]);
  const unavailable = fixture({ sourceStatus: 503 });
  await expect(
    dispatchDiscordEvent(unavailable.deps, event, new AbortController().signal),
  ).rejects.toThrow();
  expect(unavailable.submissions).toEqual([]);
  const stale = fixture({ admissionStatus: 409 });
  await expect(
    dispatchDiscordEvent(stale.deps, event, new AbortController().signal),
  ).rejects.toThrow();
});
it.each(['prepare', 'message'] as const)(
  'redacts malformed private %s responses',
  async (invalidResponse) => {
    const f = fixture({ invalidResponse });
    await expect(dispatchDiscordEvent(f.deps, event, new AbortController().signal)).rejects.toThrow(
      invalidResponse === 'prepare'
        ? 'Invalid Discord DM preparation'
        : 'Invalid Discord DM admission',
    );
  },
);
