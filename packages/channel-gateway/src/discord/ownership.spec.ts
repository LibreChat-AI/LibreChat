import { discordChannelConfigSchema } from 'librechat-data-provider';
import { DiscordGatewayControlClient } from './ownership';

const owner = {
  applicationId: '123456789012345678',
  applicationRevision: 'revision',
  ownerId: 'a'.repeat(32),
};
const bootstrap = {
  ...owner,
  botUserId: '234567890123456789',
  botToken: 'private-bot',
  policy: discordChannelConfigSchema.parse({ enabled: true, gateway: { enabled: true } }).gateway,
};
const connection = {
  LIBRECHAT_INTERNAL_URL: 'http://internal/prefix',
  CHANNEL_SERVICE_TOKEN: 'private-service-token'.repeat(2),
  CHANNEL_TENANT_ID: 'untrusted',
  API_CALL_TIMEOUT_MS: 1000,
};
it('uses protected POST requests without forwarding caller-selected tenant authority', async () => {
  const transport = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>(
    async () => new Response(null, { status: 204 }),
  );
  const client = new DiscordGatewayControlClient(connection, transport);
  expect(await client.acquire(owner, 30000)).toBe(true);
  expect(transport).toHaveBeenCalledWith(
    'http://internal/prefix/api/channels/discord/service/gateway/acquire',
    expect.objectContaining({
      method: 'POST',
      redirect: 'error',
      body: JSON.stringify({ owner, leaseMs: 30000 }),
    }),
  );
  const headers = transport.mock.calls[0][1]?.headers;
  expect(headers).toEqual({
    Authorization: `Bearer ${connection.CHANNEL_SERVICE_TOKEN}`,
    'Content-Type': 'application/json',
  });
});
it('rejects mismatched bootstrap identity and permits only validated private capabilities', async () => {
  const { ownerId: _ownerId, ...valid } = bootstrap;
  void _ownerId;
  const transport = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>(async () =>
    Response.json(valid),
  );
  const client = new DiscordGatewayControlClient(connection, transport);
  expect(await client.bootstrap(owner)).toEqual(valid);
  transport.mockImplementation(async () =>
    Response.json({ ...valid, applicationRevision: 'other' }),
  );
  await expect(client.bootstrap(owner)).rejects.toThrow('bootstrap mismatch');
});
it('propagates outages safely and distinguishes a lost lease without replaying writes', async () => {
  const transport = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>(async () =>
    Response.json({ error: 'private-database-content' }, { status: 503 }),
  );
  const client = new DiscordGatewayControlClient(connection, transport);
  await expect(client.renew(owner, 30000)).rejects.toThrow('HTTP 503');
  expect(transport).toHaveBeenCalledTimes(1);
  transport.mockImplementation(async () =>
    Response.json({ error: 'unavailable' }, { status: 409 }),
  );
  expect(await client.renew(owner, 30000)).toBe(false);
  expect(await client.load(owner)).toBeNull();
});
it('reports credential observations using only the current owner, closed state and sequence', async () => {
  const transport = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>(
    async () => new Response(null, { status: 204 }),
  );
  const client = new DiscordGatewayControlClient(connection, transport);
  expect(await client.observeCredentials(owner, 'invalid', 1)).toBe(true);
  expect(transport).toHaveBeenCalledWith(
    'http://internal/prefix/api/channels/discord/service/gateway/observeCredentials',
    expect.objectContaining({
      method: 'POST',
      redirect: 'error',
      body: JSON.stringify({ owner, state: 'invalid', sequence: 1 }),
      headers: {
        Authorization: `Bearer ${connection.CHANNEL_SERVICE_TOKEN}`,
        'Content-Type': 'application/json',
      },
    }),
  );
  expect(await client.observeCredentials(owner, 'valid', 2)).toBe(true);
  transport.mockImplementation(async () => Response.json({ error: 'stale' }, { status: 409 }));
  expect(await client.observeCredentials(owner, 'invalid', 3)).toBe(false);
  transport.mockImplementation(async () =>
    Response.json({ error: 'private-database-content' }, { status: 503 }),
  );
  await expect(client.observeCredentials(owner, 'invalid', 4)).rejects.toThrow('HTTP 503');
  expect(transport).toHaveBeenCalledTimes(4);
});
it('does not transmit an invalid credential observation owner', async () => {
  const transport = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>();
  const client = new DiscordGatewayControlClient(connection, transport);
  await expect(
    client.observeCredentials({ ...owner, ownerId: '' }, 'invalid', 1),
  ).rejects.toThrow();
  expect(transport).not.toHaveBeenCalled();
});
it('does not transmit a credential observation without a safe positive integer sequence', async () => {
  const transport = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>(
    async () => new Response(null, { status: 204 }),
  );
  const client = new DiscordGatewayControlClient(connection, transport);
  const observe = client.observeCredentials.bind(client) as (
    ...input: unknown[]
  ) => Promise<boolean>;
  for (const sequence of [0, -1, 1.5, NaN, Infinity, 2 ** 53, '1', null, undefined, {}])
    await expect(observe(owner, 'invalid', sequence)).rejects.toThrow();
  await expect(observe(owner, 'invalid')).rejects.toThrow();
  expect(transport).not.toHaveBeenCalled();
  expect(await observe(owner, 'invalid', Number.MAX_SAFE_INTEGER)).toBe(true);
  expect(transport).toHaveBeenCalledTimes(1);
});
