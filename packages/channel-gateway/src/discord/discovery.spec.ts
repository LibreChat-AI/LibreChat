import { discordChannelConfigSchema } from 'librechat-data-provider';
import { DiscordRuntimeClient } from './discovery';

const cursor = 'a'.repeat(24);
const connection = {
  LIBRECHAT_INTERNAL_URL: 'http://internal/prefix',
  CHANNEL_SERVICE_TOKEN: 'private-service-token'.repeat(2),
  CHANNEL_TENANT_ID: 'caller-tenant',
  API_CALL_TIMEOUT_MS: 1000,
};
it('uses bounded protected GET discovery without forwarding caller tenant selection', async () => {
  const transport = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>(async () =>
    Response.json({ applications: [], next: cursor }),
  );
  const client = new DiscordRuntimeClient(connection, transport);
  expect(await client.applications(cursor)).toEqual({ applications: [], next: cursor });
  expect(transport).toHaveBeenCalledWith(
    `http://internal/prefix/api/channels/discord/service/runtime/applications?cursor=${cursor}`,
    expect.objectContaining({
      method: 'GET',
      redirect: 'error',
      headers: {
        Authorization: `Bearer ${connection.CHANNEL_SERVICE_TOKEN}`,
        'Content-Type': 'application/json',
      },
    }),
  );
  await expect(client.applications('invalid')).rejects.toThrow();
  expect(transport).toHaveBeenCalledTimes(1);
});
it('accepts disabled policy for orderly shutdown and rejects credentials in discovery responses', async () => {
  const policy = discordChannelConfigSchema.parse({});
  const transport = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>(async () =>
    Response.json({ discord: policy }),
  );
  const client = new DiscordRuntimeClient(connection, transport);
  expect((await client.bootstrap()).discord.enabled).toBe(false);
  transport.mockImplementation(async () =>
    Response.json({
      applications: [
        {
          applicationId: '123456789012345678',
          applicationRevision: 'revision',
          tenantId: '_',
          botToken: 'private-token',
        },
      ],
    }),
  );
  await expect(client.applications()).rejects.toThrow();
});
it('bounds successful payload reads and keeps unexpected server messages out of errors', async () => {
  const transport = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>(async () =>
    Response.json({ error: 'private-token' }, { status: 503 }),
  );
  const client = new DiscordRuntimeClient(connection, transport);
  await expect(client.channels()).rejects.toThrow('HTTP 503');
  transport.mockImplementation(async () => new Response('x'.repeat(128 * 1024 + 1)));
  await expect(client.channels()).rejects.toThrow('Remote response exceeds size limit');
  expect(transport).toHaveBeenCalledTimes(2);
});
