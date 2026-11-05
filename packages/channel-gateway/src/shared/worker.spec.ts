import {
  channelConfigSchema,
  channelGatewayWirePolicySchema,
  sharedSlackGatewayPolicySchema,
} from 'librechat-data-provider';
import { runSharedWorkers } from './worker';
import { WorkspaceClient } from './client';
import { loadBootstrap } from '../config';
import { ChannelWorker } from '../worker';

afterEach(() => jest.restoreAllMocks());

it('accepts dotted tenant discovery rows and enforces the canonical tenant boundary', async () => {
  const bootstrap = loadBootstrap({
    CHANNEL_SERVICE_TOKEN: 'test-service-token-at-least-32-characters',
  });
  if (bootstrap.mode !== 'shared') throw new Error('Expected shared config');
  const transport = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>(
    async () =>
      new Response(JSON.stringify([{ tenantId: 'org.with.periods', channelId: 'binding' }])),
  );
  const client = new WorkspaceClient(bootstrap.config, transport);
  expect(await client.discover(1)).toEqual([
    { tenantId: 'org.with.periods', channelId: 'binding' },
  ]);
  for (const tenantId of ['org/scope', 'x'.repeat(129), '__SYSTEM__']) {
    transport.mockResolvedValueOnce(
      new Response(JSON.stringify([{ tenantId, channelId: 'binding' }])),
    );
    await expect(client.discover(1)).rejects.toThrow();
  }
});

it('bounds simultaneous durable turns while allowing several turns for the same binding', async () => {
  const bootstrap = loadBootstrap({
    CHANNEL_SERVICE_TOKEN: 'test-service-token-at-least-32-characters',
  });
  if (bootstrap.mode !== 'shared') throw new Error('Expected shared config');
  const client = new WorkspaceClient(bootstrap.config);
  jest.spyOn(client, 'bootstrap').mockResolvedValue({
    gateway: channelGatewayWirePolicySchema.parse({
      ...channelConfigSchema.parse({ transport: 'webhook' }),
      version: 1,
    }),
    workers: sharedSlackGatewayPolicySchema.parse({
      workerConcurrency: 2,
      discoveryBatchSize: 5,
    }),
  });
  const rows = Array.from({ length: 5 }, () => ({ tenantId: 'org-a', channelId: 'binding-a' }));
  const discover = jest.spyOn(client, 'discover').mockResolvedValue(rows);
  const controller = new AbortController();
  let active = 0,
    maximum = 0,
    completed = 0;
  const tick = jest.spyOn(ChannelWorker.prototype, 'tick').mockImplementation(async () => {
    active++;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setImmediate(resolve));
    active--;
    completed++;
    if (completed === rows.length) controller.abort();
    return true;
  });
  await runSharedWorkers(
    bootstrap.config,
    client,
    { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    controller.signal,
  );
  expect(maximum).toBe(2);
  expect(tick).toHaveBeenCalledTimes(5);
  expect(discover).toHaveBeenCalledTimes(1);
  expect(active).toBe(0);
});

it('requires explicit server worker limits instead of silently defaulting an incomplete wire policy', async () => {
  const bootstrap = loadBootstrap({
    CHANNEL_SERVICE_TOKEN: 'test-service-token-at-least-32-characters',
  });
  if (bootstrap.mode !== 'shared') throw new Error('Expected shared config');
  const transport = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>(
    async () =>
      new Response(
        JSON.stringify({
          gateway: channelGatewayWirePolicySchema.parse({
            ...channelConfigSchema.parse({ transport: 'webhook' }),
            version: 1,
          }),
          workers: {},
        }),
      ),
  );
  await expect(new WorkspaceClient(bootstrap.config, transport).bootstrap()).rejects.toThrow();
  expect(() =>
    loadBootstrap({ CHANNEL_SERVICE_TOKEN: 'token', CHANNEL_TENANT_ID: 'org-a' }),
  ).toThrow('CHANNEL_ID');
  expect(
    loadBootstrap({
      CHANNEL_SERVICE_TOKEN: 'token',
      CHANNEL_TENANT_ID: 'org-a',
      CHANNEL_ID: 'binding-a',
    }).mode,
  ).toBe('single');
});
