import { DEFAULT_DISCORD_RATE_POLICY, DiscordRateCoordinator } from './rates';
import { DiscordClient, DiscordWriteError, discordNonce } from './client';

const options = { botToken: 'secret-token', timeoutMs: 1000, maxResponseBytes: 2048 };
function fixture(response: () => Promise<Response>) {
  const transport = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>(response);
  return { transport, client: new DiscordClient(options, transport) };
}
describe('current bot guild membership', () => {
  test('requires the exact guild identity from an authenticated current lookup', async () => {
    const f = fixture(async () => Response.json({ id: '123' }));
    expect(await f.client.isGuildMember('123')).toBe(true);
    expect(f.transport.mock.calls[0]).toEqual([
      'https://discord.com/api/v10/guilds/123',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ Authorization: 'Bot secret-token' }),
        redirect: 'error',
      }),
    ]);
  });
  test.each([403, 404])('treats only definite HTTP %s as absent membership', async (status) => {
    expect(
      await fixture(async () => Response.json({}, { status })).client.isGuildMember('123'),
    ).toBe(false);
  });
  test.each([401, 429, 500, 503])(
    'propagates HTTP %s without inventing removal',
    async (status) => {
      const f = fixture(async () => Response.json({}, { status }));
      await expect(f.client.isGuildMember('123')).rejects.toMatchObject(
        status === 429 ? { outcome: 'retryable', retryAfterMs: 1000 } : { status },
      );
      expect(f.transport).toHaveBeenCalledTimes(1);
    },
  );
  test.each([{}, { id: '456' }])(
    'rejects partial or different guild success data',
    async (body) => {
      await expect(
        fixture(async () => Response.json(body)).client.isGuildMember('123'),
      ).rejects.toThrow();
    },
  );
});
describe('Discord REST writes', () => {
  test('uses stable bounded nonces, suppresses all mentions on create and edit', async () => {
    const f = fixture(async () => Response.json({ id: '456', channel_id: '123' }));
    expect(
      await f.client.createMessage('123', { content: 'hello @everyone' }, 'run:part:1'),
    ).toEqual({ channelId: '123', messageId: '456', externalMessageKey: '123:456' });
    await f.client.editMessage('123', '456', { content: 'edited' });
    const create = JSON.parse(String(f.transport.mock.calls[0][1]?.body));
    const edit = JSON.parse(String(f.transport.mock.calls[1][1]?.body));
    expect(create).toMatchObject({
      allowed_mentions: { parse: [], replied_user: false },
      nonce: discordNonce('run:part:1'),
      enforce_nonce: true,
    });
    expect(edit.allowed_mentions).toEqual(create.allowed_mentions);
    expect(create.nonce).toHaveLength(25);
    expect(discordNonce('run:part:1')).not.toBe(discordNonce('run:part:2'));
    expect(f.transport.mock.calls[0][1]).toMatchObject({
      redirect: 'error',
      headers: { Authorization: 'Bot secret-token' },
    });
  });
  test.each([400, 401, 403, 404])(
    'classifies HTTP %s as permanent with redacted errors',
    async (status) => {
      const f = fixture(async () =>
        Response.json({ message: 'secret submitted content' }, { status }),
      );
      await expect(
        f.client.createMessage('123', { content: 'hello' }, 'operation'),
      ).rejects.toMatchObject({ outcome: 'permanent' });
      await expect(
        f.client.createMessage('123', { content: 'hello' }, 'operation'),
      ).rejects.toThrow('Discord operation was not confirmed');
    },
  );
  test('returns rate-limit delay without replaying a write', async () => {
    const f = fixture(async () => Response.json({ retry_after: 2.5 }, { status: 429 }));
    await expect(
      f.client.createMessage('123', { content: 'hello' }, 'operation'),
    ).rejects.toMatchObject({ outcome: 'retryable', retryAfterMs: 2500 });
    expect(f.transport).toHaveBeenCalledTimes(1);
  });
  test.each(['malformed', 'oversized', 'interrupted', 'locked'])(
    'retains Retry-After with a %s rate-limit body',
    async (kind) => {
      const f = fixture(async () => {
        const headers = { 'retry-after': '65' };
        if (kind === 'malformed') return new Response('{', { status: 429, headers });
        if (kind === 'oversized') return new Response('x'.repeat(2049), { status: 429, headers });
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            if (kind === 'interrupted') controller.error(new Error('private transport detail'));
          },
        });
        const response = new Response(stream, { status: 429, headers });
        if (kind === 'locked') response.body?.getReader();
        return response;
      });
      await expect(
        f.client.createMessage('123', { content: 'hello' }, 'operation'),
      ).rejects.toMatchObject({ outcome: 'retryable', retryAfterMs: 65_000 });
      expect(f.transport).toHaveBeenCalledTimes(1);
    },
  );
  test.each([undefined, 'invalid', '0', '-1', 'Infinity'])(
    'uses a positive fallback for an unreadable 429 with header %s',
    async (header) => {
      const f = fixture(
        async () =>
          new Response('{', {
            status: 429,
            headers: header === undefined ? {} : { 'retry-after': header },
          }),
      );
      await expect(
        f.client.createMessage('123', { content: 'hello' }, 'operation'),
      ).rejects.toMatchObject({ outcome: 'retryable', retryAfterMs: 1000 });
    },
  );
  test('honors the header when the decoded body delay is invalid or shorter', async () => {
    for (const retry_after of [0, -1, 'invalid', 1]) {
      const f = fixture(async () =>
        Response.json({ retry_after }, { status: 429, headers: { 'retry-after': '65' } }),
      );
      await expect(
        f.client.createMessage('123', { content: 'hello' }, 'operation'),
      ).rejects.toMatchObject({ outcome: 'retryable', retryAfterMs: 65_000 });
    }
  });
  test.each([500, 502, 503])('holds uncertain HTTP %s writes', async (status) => {
    const f = fixture(async () => new Response('untrusted diagnostics', { status }));
    await expect(
      f.client.createMessage('123', { content: 'hello' }, 'operation'),
    ).rejects.toMatchObject({ outcome: 'unknown' });
    expect(f.transport).toHaveBeenCalledTimes(1);
  });
  test('does not replay a timed-out request', async () => {
    const f = fixture(async () => {
      throw new DOMException('secret-token', 'TimeoutError');
    });
    await expect(f.client.createMessage('123', { content: 'hello' }, 'operation')).rejects.toEqual(
      new DiscordWriteError('unknown'),
    );
    expect(f.transport).toHaveBeenCalledTimes(1);
  });
  test('rejects oversized or mismatched success bodies as uncertain', async () => {
    const oversized = fixture(async () => new Response('x'.repeat(2049)));
    await expect(
      oversized.client.createMessage('123', { content: 'hello' }, 'operation'),
    ).rejects.toMatchObject({ outcome: 'unknown' });
    const wrongChannel = fixture(async () => Response.json({ id: '456', channel_id: '789' }));
    await expect(
      wrongChannel.client.createMessage('123', { content: 'hello' }, 'operation'),
    ).rejects.toMatchObject({ outcome: 'unknown' });
  });
  test('rejects invalid addresses and messages before network access', async () => {
    const f = fixture(async () => Response.json({}));
    await expect(
      f.client.createMessage('../webhooks', { content: 'hello' }, 'operation'),
    ).rejects.toThrow('Invalid Discord address');
    await expect(
      f.client.createMessage('123', { content: 'x'.repeat(2001) }, 'operation'),
    ).rejects.toThrow('Invalid Discord message');
    expect(f.transport).not.toHaveBeenCalled();
    expect(
      () => new DiscordClient({ ...options, apiBase: 'https://user:secret@discord.com/api' }),
    ).toThrow();
  });
});

describe('shared Discord client rate admission', () => {
  beforeEach(() => jest.useFakeTimers({ now: 1_700_000_000_000 }));
  afterEach(() => jest.useRealTimers());
  test('separate clients share the bot global budget', async () => {
    const rates = new DiscordRateCoordinator({
      ...DEFAULT_DISCORD_RATE_POLICY,
      globalRequestsPerSecond: 1,
    });
    const transport = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>(async (url) => {
      const channel_id = new URL(String(url)).pathname.split('/')[4];
      return Response.json({ id: '456', channel_id });
    });
    const first = new DiscordClient(options, transport, rates);
    const second = new DiscordClient(options, transport, rates);
    await first.createMessage('123', { content: 'one' }, 'one');
    const waiting = second.createMessage('789', { content: 'two' }, 'two');
    await jest.advanceTimersByTimeAsync(999);
    expect(transport).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    await expect(waiting).resolves.toMatchObject({ channelId: '789' });
    expect(transport).toHaveBeenCalledTimes(2);
  });
  test('bucket admission spans clients and message IDs while other channels remain available', async () => {
    const rates = new DiscordRateCoordinator();
    let calls = 0;
    const transport = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>(async (url) => {
      const channel_id = new URL(String(url)).pathname.split('/')[4];
      return Response.json(
        { id: '456', channel_id },
        {
          headers: {
            'x-ratelimit-bucket': 'messages',
            'x-ratelimit-remaining': ++calls === 2 ? '0' : '2',
            'x-ratelimit-reset-after': '2',
          },
        },
      );
    });
    const first = new DiscordClient(options, transport, rates);
    const second = new DiscordClient(options, transport, rates);
    await first.createMessage('123', { content: 'one' }, 'one');
    await second.editMessage('123', '456', { content: 'two' });
    const waiting = first.editMessage('123', '789', { content: 'three' });
    await second.createMessage('987', { content: 'independent' }, 'independent');
    await jest.advanceTimersByTimeAsync(1999);
    expect(transport).toHaveBeenCalledTimes(3);
    await jest.advanceTimersByTimeAsync(1);
    await waiting;
    expect(transport).toHaveBeenCalledTimes(4);
  });
  test('a malformed global 429 pauses other clients without replaying the rejected write', async () => {
    const rates = new DiscordRateCoordinator();
    const transport = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockResolvedValueOnce(
        new Response('{', {
          status: 429,
          headers: { 'retry-after': '2', 'x-ratelimit-scope': 'global' },
        }),
      )
      .mockResolvedValueOnce(Response.json({ id: '456', channel_id: '789' }));
    const first = new DiscordClient(options, transport, rates);
    const second = new DiscordClient(options, transport, rates);
    await expect(first.createMessage('123', { content: 'one' }, 'one')).rejects.toMatchObject({
      outcome: 'retryable',
      retryAfterMs: 2000,
    });
    const waiting = second.createMessage('789', { content: 'two' }, 'two');
    await jest.advanceTimersByTimeAsync(1999);
    expect(transport).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    await waiting;
    expect(transport).toHaveBeenCalledTimes(2);
  });
  test('aborted and timed-out queued requests never reach the network', async () => {
    const rates = new DiscordRateCoordinator({
      ...DEFAULT_DISCORD_RATE_POLICY,
      globalRequestsPerSecond: 1,
      maxQueueWaitMs: 100,
    });
    const transport = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>(async () =>
      Response.json({ id: '456', channel_id: '123' }),
    );
    const client = new DiscordClient(options, transport, rates);
    await client.createMessage('123', { content: 'one' }, 'one');
    const controller = new AbortController();
    const aborted = client
      .createMessage('123', { content: 'two' }, 'two', controller.signal)
      .catch((error: unknown) => error);
    controller.abort();
    await expect(aborted).resolves.toMatchObject({ outcome: 'retryable' });
    const expired = client
      .createMessage('123', { content: 'three' }, 'three')
      .catch((error: unknown) => error);
    await jest.advanceTimersByTimeAsync(100);
    await expect(expired).resolves.toMatchObject({ outcome: 'retryable' });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  test('an uncertain write is never replayed by the coordinator', async () => {
    const rates = new DiscordRateCoordinator();
    const transport = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>(async () => {
      throw new DOMException('connection lost', 'TimeoutError');
    });
    const client = new DiscordClient(options, transport, rates);
    await expect(client.createMessage('123', { content: 'one' }, 'one')).rejects.toMatchObject({
      outcome: 'unknown',
    });
    await jest.advanceTimersByTimeAsync(5000);
    expect(transport).toHaveBeenCalledTimes(1);
  });
});
