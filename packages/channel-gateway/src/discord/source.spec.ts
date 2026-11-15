import { DiscordClient } from './client';

const input = {
  applicationId: '123456789012345678',
  botUserId: '234567890123456789',
  guildId: '345678901234567890',
  channelId: '456789012345678901',
};
const channel = { id: input.channelId, guild_id: input.guildId, type: 0, flags: 0 };
const permissions = String(1024 | 2048 | 65536);
const options = { botToken: 'private-bot-token', timeoutMs: 1000, maxResponseBytes: 2048 };
it('reads effective permissions for the requested actor without coercing lossless bitfields', async () => {
  const transport = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>(async () =>
    Response.json({ permissions: '9007199254742016' }),
  );
  const client = new DiscordClient(options, transport);
  await expect(client.getChannelMemberPermissions(input.channelId, input.botUserId)).resolves.toBe(
    '9007199254742016',
  );
  expect(transport).toHaveBeenCalledWith(
    `https://discord.com/api/v10/channels/${input.channelId}/permissions/member/${input.botUserId}`,
    expect.objectContaining({ method: 'GET', body: undefined }),
  );
});
it.each([{}, { permissions: 1024 }, { permissions: '-1' }, { permissions: 'invalid' }])(
  'refuses malformed member permissions',
  async (body) => {
    const client = new DiscordClient(options, async () => Response.json(body));
    await expect(
      client.getChannelMemberPermissions(input.channelId, input.botUserId),
    ).rejects.toMatchObject({ outcome: 'unknown' });
  },
);
function fixture(value = channel, bits = permissions) {
  const transport = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>(async (url) =>
    Response.json(
      String(url).endsWith(`/member/${input.botUserId}`) ? { permissions: bits } : value,
    ),
  );
  return { transport, client: new DiscordClient(options, transport) };
}
it('inspects actual guild/channel identity and effective bot permissions through bounded authenticated GET requests', async () => {
  const { client, transport } = fixture();
  expect(await client.inspectGuildTextSource(input)).toEqual({
    kind: 'guild_text',
    ...input,
    permissions,
  });
  expect(transport).toHaveBeenCalledWith(
    `https://discord.com/api/v10/channels/${input.channelId}`,
    expect.objectContaining({
      method: 'GET',
      redirect: 'error',
      headers: { Authorization: 'Bot private-bot-token', 'Content-Type': 'application/json' },
    }),
  );
  expect(transport).toHaveBeenCalledWith(
    `https://discord.com/api/v10/channels/${input.channelId}/permissions/member/${input.botUserId}`,
    expect.objectContaining({ method: 'GET', body: undefined }),
  );
});
it.each([
  [{ ...channel, type: 11 }, permissions],
  [{ ...channel, type: 1 }, permissions],
  [{ ...channel, guild_id: '999999999999999999' }, permissions],
  [{ ...channel, id: '999999999999999999' }, permissions],
  [{ ...channel, flags: 1 << 17 }, permissions],
  [channel, '2048'],
] as const)(
  'refuses unsupported destinations or missing current permissions',
  async (value, bits) => {
    expect(await fixture(value, bits).client.inspectGuildTextSource(input)).toBeNull();
  },
);
it.each([403, 404])(
  'treats HTTP%s as unavailable without disclosing provider details',
  async (status) => {
    const transport = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>(async () =>
      Response.json({ message: 'private-provider-body' }, { status }),
    );
    expect(await new DiscordClient(options, transport).inspectGuildTextSource(input)).toBeNull();
    expect(transport).toHaveBeenCalledTimes(2);
  },
);
it('propagates authentication failure and rate limits instead of silently consuming the message', async () => {
  const transport = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>(async () =>
    Response.json({ message: 'private-provider-body' }, { status: 401 }),
  );
  const client = new DiscordClient(options, transport);
  await expect(client.inspectGuildTextSource(input)).rejects.toMatchObject({
    outcome: 'permanent',
    status: 401,
    message: 'Discord operation was not confirmed',
  });
  transport.mockImplementation(
    async () => new Response('{', { status: 429, headers: { 'Retry-After': '60' } }),
  );
  await expect(client.inspectGuildTextSource(input)).rejects.toMatchObject({
    outcome: 'retryable',
    retryAfterMs: 60000,
  });
  expect(transport).toHaveBeenCalledTimes(4);
});

const actorInput = { ...input, authorId: '567890123456789012' };
function actorFixture({
  bits = '1024',
  member = { user: { id: actorInput.authorId } },
  status = 200,
} = {}) {
  const transport = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>(async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === `/api/v10/guilds/${input.guildId}/members/${actorInput.authorId}`)
      return Response.json(member, { status });
    if (path.endsWith(`/member/${actorInput.authorId}`))
      return Response.json({ permissions: bits });
    if (path.endsWith(`/member/${input.botUserId}`)) return Response.json({ permissions });
    return Response.json(channel);
  });
  return { client: new DiscordClient(options, transport), transport };
}
it('proves current human guild membership and effective actor visibility independently of bot access', async () => {
  const { client, transport } = actorFixture();
  expect(await client.inspectGuildTextActorSource(actorInput)).toEqual({
    kind: 'guild_text',
    ...input,
    permissions,
    authorId: actorInput.authorId,
    authorMember: true,
    authorPermissions: '1024',
  });
  expect(transport).toHaveBeenCalledTimes(4);
  expect(transport).toHaveBeenCalledWith(
    `https://discord.com/api/v10/guilds/${input.guildId}/members/${actorInput.authorId}`,
    expect.objectContaining({ method: 'GET', redirect: 'error' }),
  );
  expect(
    await actorFixture({ bits: '8' }).client.inspectGuildTextActorSource(actorInput),
  ).not.toBeNull();
});
it.each([403, 404])('refuses a departed or inaccessible guild member (HTTP%s)', async (status) => {
  expect(await actorFixture({ status }).client.inspectGuildTextActorSource(actorInput)).toBeNull();
});
it('refuses actors without View Channel and bot/system identities', async () => {
  expect(
    await actorFixture({ bits: '2048' }).client.inspectGuildTextActorSource(actorInput),
  ).toBeNull();
  for (const flags of [{ bot: true }, { system: true }]) {
    const transport: typeof fetch = async (url) => {
      const path = new URL(String(url)).pathname;
      if (path.includes('/members/'))
        return Response.json({ user: { id: actorInput.authorId, ...flags } });
      if (path.includes('/permissions/member/')) return Response.json({ permissions });
      return Response.json(channel);
    };
    expect(
      await new DiscordClient(options, transport).inspectGuildTextActorSource(actorInput),
    ).toBeNull();
  }
  const own = actorFixture();
  expect(
    await own.client.inspectGuildTextActorSource({ ...actorInput, authorId: input.botUserId }),
  ).toBeNull();
  expect(own.transport).not.toHaveBeenCalled();
});
it('does not convert malformed membership or operational failures into durable permission denials', async () => {
  await expect(
    actorFixture({ member: { user: { id: input.botUserId } } }).client.inspectGuildTextActorSource(
      actorInput,
    ),
  ).rejects.toMatchObject({ outcome: 'unknown', message: 'Discord operation was not confirmed' });
  await expect(
    actorFixture({ status: 503 }).client.inspectGuildTextActorSource(actorInput),
  ).rejects.toMatchObject({ outcome: 'unknown', message: 'Discord operation was not confirmed' });
});
