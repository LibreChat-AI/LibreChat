import { DiscordClient, DiscordWriteError, discordNonce } from './client';

const options = { botToken: 'secret-token', timeoutMs: 1000, maxResponseBytes: 2048 };
function fixture(response: () => Promise<Response>) {
  const transport = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>(response);
  return { transport, client: new DiscordClient(options, transport) };
}
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
