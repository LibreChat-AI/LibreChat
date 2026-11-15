import { DiscordClient } from './client';

const input = {
  applicationId: '123456789012345678',
  botUserId: '234567890123456789',
  guildId: '345678901234567890',
  threadChannelId: '456789012345678901',
  authorId: '567890123456789012',
};
const parentChannelId = '678901234567890123';
const required = String(BigInt(1024 | 65536) | (BigInt(1) << BigInt(38)));
const options = { botToken: 'private-token', timeoutMs: 1000, maxResponseBytes: 2048 };
function fixture(type = 11) {
  const metadata = {
    id: input.threadChannelId,
    guild_id: input.guildId,
    parent_id: parentChannelId,
    type,
    flags: 0,
    thread_metadata: { archived: false, locked: false },
  };
  const permissions = { bot: required, author: required };
  let membership: (userId: string) => Response = (userId) =>
    Response.json({ id: input.threadChannelId, user_id: userId });
  let external: ((url: string) => Response) | undefined;
  const transport = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>(async (url) => {
    if (external) return external(String(url));
    const path = new URL(String(url)).pathname;
    if (path.endsWith(`/thread-members/${input.botUserId}`)) return membership(input.botUserId);
    if (path.endsWith(`/thread-members/${input.authorId}`)) return membership(input.authorId);
    if (path.endsWith(`/permissions/member/${input.botUserId}`))
      return Response.json({ permissions: permissions.bot });
    if (path.endsWith(`/permissions/member/${input.authorId}`))
      return Response.json({ permissions: permissions.author });
    return Response.json(metadata);
  });
  return {
    metadata,
    permissions,
    transport,
    client: new DiscordClient(options, transport),
    members: (value: typeof membership) => {
      membership = value;
    },
    response: (value: typeof external) => {
      external = value;
    },
  };
}
it('reads the actual thread and both effective permission projections without a privileged member list', async () => {
  const { client, transport } = fixture();
  expect(await client.inspectGuildThreadSource(input)).toEqual({
    kind: 'guild_thread',
    ...input,
    parentChannelId,
    threadType: 11,
    archived: false,
    locked: false,
    permissions: { bot: required, author: required },
    membership: { bot: false, author: false },
  });
  expect(transport).toHaveBeenCalledTimes(3);
  for (const [url, request] of transport.mock.calls) {
    expect(String(url)).toContain(`/channels/${input.threadChannelId}`);
    expect(request).toMatchObject({
      method: 'GET',
      redirect: 'error',
      headers: { Authorization: 'Bot private-token' },
    });
    expect(request?.body).toBeUndefined();
    expect(String(url)).not.toMatch(/thread-members$/);
  }
});
it('verifies each exact private thread member without requiring the privileged list endpoint', async () => {
  const f = fixture(12);
  expect(await f.client.inspectGuildThreadSource(input)).toMatchObject({
    threadType: 12,
    membership: { bot: true, author: true },
  });
  expect(f.transport).toHaveBeenCalledTimes(5);
  for (const user of [input.botUserId, input.authorId])
    expect(f.transport).toHaveBeenCalledWith(
      `https://discord.com/api/v10/channels/${input.threadChannelId}/thread-members/${user}`,
      expect.objectContaining({ method: 'GET' }),
    );
});
it.each(['bot', 'author'] as const)(
  'refuses a private thread after %s membership is removed',
  async (actor) => {
    const f = fixture(12);
    const user = actor === 'bot' ? input.botUserId : input.authorId;
    f.members((id) =>
      id === user
        ? Response.json({ message: 'private upstream message' }, { status: 404 })
        : Response.json({ id: input.threadChannelId, user_id: id }),
    );
    expect(await f.client.inspectGuildThreadSource(input)).toBeNull();
  },
);
it.each(['bot', 'author'] as const)(
  'refuses insufficient %s permissions even with guild SEND_MESSAGES',
  async (actor) => {
    const f = fixture();
    f.permissions[actor] = actor === 'bot' ? String(1024 | 2048 | 65536) : '0';
    expect(await f.client.inspectGuildThreadSource(input)).toBeNull();
  },
);
it.each([String(8), String(BigInt(required) | (BigInt(1) << BigInt(34)))])(
  'allows private moderator access through permission %s without fabricated membership',
  async (bits) => {
    const f = fixture(12);
    f.permissions.bot = bits;
    f.permissions.author = bits;
    expect(await f.client.inspectGuildThreadSource(input)).toMatchObject({
      membership: { bot: false, author: false },
    });
    expect(f.transport).toHaveBeenCalledTimes(3);
  },
);
it.each(['archived', 'locked'] as const)(
  'refuses %s threads without reopening or joining',
  async (state) => {
    const f = fixture();
    f.metadata.thread_metadata[state] = true;
    expect(await f.client.inspectGuildThreadSource(input)).toBeNull();
    expect(f.transport.mock.calls.every(([, value]) => value?.method === 'GET')).toBe(true);
  },
);
it.each([
  { type: 0 },
  { type: 1 },
  { type: 3 },
  { type: 10 },
  { id: '999999999999999999' },
  { guild_id: '999999999999999999' },
  { parent_id: input.threadChannelId },
  { flags: 1 << 17 },
])('refuses unsupported or mismatched physical metadata %j', async (metadata) => {
  const f = fixture();
  Object.assign(f.metadata, metadata);
  expect(await f.client.inspectGuildThreadSource(input)).toBeNull();
});
it('rejects a mismatched membership response instead of granting the requested actor access', async () => {
  const f = fixture(12);
  f.members(() => Response.json({ id: input.threadChannelId, user_id: '999999999999999999' }));
  await expect(f.client.inspectGuildThreadSource(input)).rejects.toMatchObject({
    outcome: 'unknown',
    message: 'Discord operation was not confirmed',
  });
});
it.each([403, 404])('treats HTTP%s source revocation as unavailable', async (status) => {
  const f = fixture();
  f.response(() => Response.json({ message: 'private provider content' }, { status }));
  expect(await f.client.inspectGuildThreadSource(input)).toBeNull();
});
it('does not consume authentication or transient failures and never replays a request automatically', async () => {
  const f = fixture();
  f.response(() => Response.json({ message: 'secret private-token' }, { status: 401 }));
  await expect(f.client.inspectGuildThreadSource(input)).rejects.toMatchObject({
    outcome: 'permanent',
    status: 401,
    message: 'Discord operation was not confirmed',
  });
  expect(f.transport).toHaveBeenCalledTimes(3);
  f.transport.mockClear();
  f.response(() => new Response('{', { status: 429, headers: { 'Retry-After': '2' } }));
  await expect(f.client.inspectGuildThreadSource(input)).rejects.toMatchObject({
    outcome: 'retryable',
    retryAfterMs: 2000,
  });
  expect(f.transport.mock.calls.length).toBeGreaterThanOrEqual(1);
  expect(f.transport.mock.calls.length).toBeLessThanOrEqual(3);
  const paths = f.transport.mock.calls.map(([url]) => String(url));
  expect(new Set(paths).size).toBe(paths.length);
});
it('uses the caller abort signal and surfaces a redacted uncertain transport failure', async () => {
  const controller = new AbortController();
  controller.abort();
  const transport = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>(
    async (_url, options) => {
      options?.signal?.throwIfAborted();
      throw new Error('private-token');
    },
  );
  await expect(
    new DiscordClient(options, transport).inspectGuildThreadSource(input, controller.signal),
  ).rejects.toMatchObject({ message: 'Discord operation was not confirmed' });
  expect(transport.mock.calls.length).toBeLessThanOrEqual(3);
});

it('accepts the actor visibility required for a signed slash command in a read-only thread', async () => {
  const f = fixture();
  f.permissions.author = '1024';
  expect(await f.client.inspectGuildThreadSource(input)).toMatchObject({
    permissions: { bot: required, author: '1024' },
  });
});
