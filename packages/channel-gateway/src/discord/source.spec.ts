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
