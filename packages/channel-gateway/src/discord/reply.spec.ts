import type { DiscordInboxDelivery } from 'librechat-data-provider';
import { DiscordReplyClient, deliverDiscordReply } from './reply';
import { DiscordControlClient } from './control';
import { DiscordRateCoordinator } from './rates';
import { DiscordWriteError } from './client';

const applicationId = '123456789012345678';
const eventId = '234567890123456789';
const token = 'private/token';
let now: number;
let job: DiscordInboxDelivery;
let transport: jest.Mock;
let discord: () => Promise<Response>;
let settlement: () => Promise<Response>;
let controller: AbortController;
let control: DiscordControlClient;
let reply: DiscordReplyClient;
let finished: boolean;
const turn = () =>
  deliverDiscordReply(
    { applicationId, owner: 'worker', control, reply, retryDelayMs: 1000, now: () => now },
    controller.signal,
  );
const calls = (path: string) => transport.mock.calls.filter(([url]) => String(url).includes(path));
beforeEach(() => {
  now = Date.now();
  finished = false;
  controller = new AbortController();
  job = {
    fence: { applicationId, eventId, owner: 'worker', epoch: 1 },
    token,
    applicationRevision: 'revision',
    expiresAt: now + 60000,
    reply: { content: 'Private reply' },
  };
  discord = async () => Response.json({ id: '345678901234567890' });
  settlement = async () => {
    finished = true;
    return new Response(null, { status: 204 });
  };
  transport = jest.fn(async (url) => {
    if (String(url).startsWith('https://discord.com')) return discord();
    if (String(url).endsWith('/claim'))
      return finished ? new Response(null, { status: 204 }) : Response.json(job);
    if (String(url).endsWith('/finish')) return settlement();
    if (String(url).endsWith('/defer')) return new Response(null, { status: 204 });
    throw new Error('Unexpected endpoint');
  });
  control = new DiscordControlClient(
    {
      LIBRECHAT_INTERNAL_URL: 'http://internal',
      CHANNEL_SERVICE_TOKEN: 'service-token',
      API_CALL_TIMEOUT_MS: 1000,
    },
    transport,
  );
  reply = new DiscordReplyClient({ timeoutMs: 1000, maxResponseBytes: 4096 }, transport);
});

it('edits only the known original and suppresses mentions without sending bot authorization', async () => {
  job.reply = {
    content: '@everyone accepted',
    actions: [
      { label: 'Confirm', reference: 'opaque-control', style: 'primary' },
      { label: 'Open', url: 'https://chat.example/channels/link#private' },
    ],
  };
  expect(await turn()).toBe(true);
  const [url, options] = calls('/webhooks/')[0];
  expect(url).toBe(
    `https://discord.com/api/v10/webhooks/${applicationId}/private%2Ftoken/messages/@original`,
  );
  expect(options.method).toBe('PATCH');
  expect(options.redirect).toBe('error');
  expect(options.headers).not.toHaveProperty('Authorization');
  expect(JSON.parse(options.body)).toEqual({
    content: '@everyone accepted',
    allowed_mentions: { parse: [], replied_user: false },
    components: [
      {
        type: 1,
        components: [
          { type: 2, style: 1, label: 'Confirm', custom_id: 'opaque-control' },
          { type: 2, style: 5, label: 'Open', url: 'https://chat.example/channels/link#private' },
        ],
      },
    ],
  });
  expect(JSON.parse(calls('/finish')[0][1].body)).toMatchObject({
    fence: job.fence,
    result: 'completed',
  });
  expect(await turn()).toBe(false);
});

it('repeats the identical PATCH after an uncertain result without exposing token-bearing errors', async () => {
  discord = async () => {
    throw new Error(`Failed to request ${token}`);
  };
  expect(await turn()).toBe(true);
  expect(calls('/finish')).toHaveLength(0);
  const retryAt = JSON.parse(calls('/defer')[0][1].body).retryAt;
  expect(retryAt).toBeGreaterThanOrEqual(now + 500);
  expect(retryAt).toBeLessThanOrEqual(now + 1000);
  const first = calls('/webhooks/')[0];
  now += 1000;
  discord = async () => Response.json({ id: '345678901234567890' });
  expect(await turn()).toBe(true);
  const second = calls('/webhooks/')[1];
  expect(second[0]).toBe(first[0]);
  expect(second[1].body).toBe(first[1].body);
});

it('leaves a prepared reply recoverable when receipt settlement is unavailable', async () => {
  settlement = async () => new Response('private diagnostic', { status: 503 });
  await expect(turn()).rejects.toThrow('HTTP 503');
  expect(calls('/webhooks/')).toHaveLength(1);
  settlement = async () => new Response(null, { status: 204 });
  expect(await turn()).toBe(true);
  expect(calls('/webhooks/')).toHaveLength(2);
  expect(calls('/webhooks/')[0][1].body).toBe(calls('/webhooks/')[1][1].body);
});

it.each([400, 401, 403, 404])(
  'finishes permanent HTTP %s failures without retrying',
  async (status) => {
    discord = async () => new Response('private diagnostic', { status });
    expect(await turn()).toBe(true);
    expect(calls('/defer')).toHaveLength(0);
    expect(JSON.parse(calls('/finish')[0][1].body).result).toBe('unavailable');
  },
);

it('preserves Discord Retry-After and keeps token values out of rate metadata', async () => {
  const rates = new DiscordRateCoordinator();
  const acquire = jest.spyOn(rates, 'acquire');
  reply = new DiscordReplyClient({ timeoutMs: 1000, maxResponseBytes: 4096 }, transport, rates);
  discord = async () => Response.json({ retry_after: 3 }, { status: 429 });
  expect(await turn()).toBe(true);
  expect(JSON.parse(calls('/defer')[0][1].body).retryAt).toBe(now + 3000);
  expect(JSON.stringify(acquire.mock.calls)).not.toContain(token);
});

it('retires expired credentials without issuing a provider request', async () => {
  job.expiresAt = now;
  expect(await turn()).toBe(true);
  expect(calls('/webhooks/')).toHaveLength(0);
  expect(JSON.parse(calls('/finish')[0][1].body).result).toBe('expired');
});

it('does not settle or retry a delivery after runtime ownership cancellation', async () => {
  discord = async () => {
    controller.abort();
    throw new Error(token);
  };
  await expect(turn()).rejects.toThrow();
  expect(calls('/finish')).toHaveLength(0);
  expect(calls('/defer')).toHaveLength(0);
});

it('sanitizes provider failures and rejects unsafe reply links before sending', async () => {
  discord = async () => {
    throw new Error(token);
  };
  await expect(reply.write(applicationId, token, job.reply)).rejects.toThrow(
    'Discord operation was not confirmed',
  );
  transport.mockClear();
  await expect(
    reply.write(applicationId, token, {
      content: 'Open',
      actions: [{ label: 'Unsafe', url: 'javascript:alert(1)' }],
    }),
  ).rejects.toThrow();
  expect(transport).not.toHaveBeenCalled();
});

it('bounds exponential retry backoff by the interaction token lifetime', async () => {
  job.fence.epoch = 20;
  discord = async () => new Response(null, { status: 503 });
  expect(await turn()).toBe(true);
  expect(JSON.parse(calls('/defer')[0][1].body).retryAt).toBe(job.expiresAt);
});

it.each(['oversized', 'interrupted'])(
  'preserves Retry-After when a 429 body is %s',
  async (body) => {
    discord = async () =>
      new Response(
        body === 'oversized'
          ? 'x'.repeat(5000)
          : new ReadableStream({
              start(stream) {
                stream.error(new Error(token));
              },
            }),
        { status: 429, headers: { 'Retry-After': '7' } },
      );
    await expect(reply.write(applicationId, token, job.reply)).rejects.toMatchObject({
      outcome: 'retryable',
      retryAfterMs: 7000,
    });
  },
);

it('cannot deliver an unresolved source claim before the owned inspection adapter is enabled', async () => {
  const inspection = {
    fence: job.fence,
    applicationRevision: job.applicationRevision,
    expiresAt: job.expiresAt,
    inspection: {
      guildId: '345678901234567890',
      externalChannelId: '456789012345678901',
      externalUserId: '567890123456789012',
    },
  };
  transport.mockImplementation(async (url) => {
    if (String(url).endsWith('/claim')) return Response.json(inspection);
    if (String(url).endsWith('/finish')) return new Response(null, { status: 204 });
    throw new Error('Unexpected external effect');
  });
  expect(await turn()).toBe(true);
  expect(calls('/webhooks/')).toHaveLength(0);
  expect(JSON.parse(calls('/finish')[0][1].body)).toEqual({
    fence: job.fence,
    result: 'unavailable',
  });
});

it('inspects once before delivering the exact prepared reply without replacing the physical lease', async () => {
  const inspection = {
    fence: job.fence,
    applicationRevision: job.applicationRevision,
    expiresAt: job.expiresAt,
    inspection: {
      guildId: '345678901234567890',
      externalChannelId: '456789012345678901',
      externalUserId: '567890123456789012',
    },
  };
  transport.mockImplementation(async (url) => {
    if (String(url).endsWith('/claim')) return Response.json(inspection);
    if (String(url).endsWith('/resolve')) return Response.json(job);
    if (String(url).endsWith('/finish')) return new Response(null, { status: 204 });
    if (String(url).startsWith('https://discord.com')) return discord();
    throw new Error('Unexpected endpoint');
  });
  const inspect = jest.fn(async (value: typeof inspection, signal: AbortSignal) =>
    control.resolve(
      {
        fence: value.fence,
        owner: {
          applicationId,
          applicationRevision: job.applicationRevision,
          ownerId: 'a'.repeat(32),
        },
        source: null,
      },
      signal,
    ),
  );
  expect(
    await deliverDiscordReply(
      {
        applicationId,
        owner: 'worker',
        control,
        reply,
        retryDelayMs: 1000,
        now: () => now,
        inspect,
      },
      controller.signal,
    ),
  ).toBe(true);
  expect(inspect).toHaveBeenCalledTimes(1);
  expect(calls('/webhooks/')).toHaveLength(1);
  expect(calls('/resolve')).toHaveLength(1);
});
it('defers failed source reads as reads without marking a bot write uncertain', async () => {
  const inspection = {
    fence: job.fence,
    applicationRevision: job.applicationRevision,
    expiresAt: job.expiresAt,
    inspection: {
      guildId: '345678901234567890',
      externalChannelId: '456789012345678901',
      externalUserId: '567890123456789012',
    },
  };
  transport.mockImplementation(async (url) =>
    String(url).endsWith('/claim')
      ? Response.json(inspection)
      : new Response(null, { status: 204 }),
  );
  const inspect = jest.fn(async () => {
    throw new DiscordWriteError('retryable', 2000);
  });
  expect(
    await deliverDiscordReply(
      {
        applicationId,
        owner: 'worker',
        control,
        reply,
        retryDelayMs: 1000,
        now: () => now,
        inspect,
      },
      controller.signal,
    ),
  ).toBe(true);
  expect(calls('/webhooks/')).toHaveLength(0);
  expect(calls('/defer')).toHaveLength(1);
  expect(JSON.parse(calls('/defer')[0][1].body).retryAt).toBe(now + 2000);
});
it('rejects an inspection callback that returns another physical event or deadline', async () => {
  const inspection = {
    fence: job.fence,
    applicationRevision: job.applicationRevision,
    expiresAt: job.expiresAt,
    inspection: {
      guildId: '345678901234567890',
      externalChannelId: '456789012345678901',
      externalUserId: '567890123456789012',
    },
  };
  transport.mockImplementation(async () => Response.json(inspection));
  const inspect = async () => ({ ...job, expiresAt: job.expiresAt + 1 });
  await expect(
    deliverDiscordReply(
      {
        applicationId,
        owner: 'worker',
        control,
        reply,
        retryDelayMs: 1000,
        now: () => now,
        inspect,
      },
      controller.signal,
    ),
  ).rejects.toThrow('lease changed');
  expect(calls('/webhooks/')).toHaveLength(0);
});
