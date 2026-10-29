import { SlackClient, SlackWriteError, validSlackUploadURL } from './slack';

const config = { SLACK_API_BASE_URL: 'http://127.0.0.1:8080/api/', API_CALL_TIMEOUT_MS: 2000 };
const token = 'private-test-token';
const message = { channel: 'C123', text: 'Answer', thread_ts: '123.456' };
const success = (body: object) =>
  new Response(JSON.stringify({ ok: true, ...body }), {
    headers: { 'Content-Type': 'application/json' },
  });
const receipt = () => success({ channel: 'C123', ts: '123.789' });

describe('SlackClient', () => {
  test('posts once with safe rendering defaults and no token in its body', async () => {
    const transport = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockResolvedValue(receipt());
    const client = new SlackClient(config, undefined, transport);
    await expect(client.postMessage(token, message)).resolves.toEqual({
      channel: 'C123',
      ts: '123.789',
    });
    expect(transport).toHaveBeenCalledTimes(1);
    const [url, init] = transport.mock.calls[0];
    expect(url).toBe(`${config.SLACK_API_BASE_URL}chat.postMessage`);
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${token}`);
    expect(String(init?.body)).toContain('unfurl_links=false');
    expect(String(init?.body)).not.toContain(token);
    expect(init?.redirect).toBe('error');
  });

  test.each([
    ['network', () => Promise.reject(new Error('secret content')), 'unknown'],
    ['5xx', () => Promise.resolve(new Response('secret content', { status: 503 })), 'unknown'],
    ['invalid JSON', () => Promise.resolve(new Response('secret content')), 'unknown'],
    [
      'empty successful response',
      () => Promise.resolve(new Response(null, { status: 204 })),
      'unknown',
    ],
    [
      'internal error',
      () => Promise.resolve(success({ ok: false, error: 'internal_error' })),
      'unknown',
    ],
    [
      'rejected',
      () => Promise.resolve(success({ ok: false, error: 'channel_not_found' })),
      'permanent',
    ],
    [
      'HTTP rejection',
      () => Promise.resolve(new Response('secret content', { status: 403 })),
      'permanent',
    ],
    [
      'rate limited',
      () => Promise.resolve(new Response('', { status: 429, headers: { 'retry-after': '2' } })),
      'retryable',
    ],
    [
      'rate limited without header',
      () => Promise.resolve(new Response('', { status: 429 })),
      'retryable',
    ],
  ])('does not retry a create on %s', async (_name, response, outcome) => {
    const transport = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockImplementation(response);
    const warn = jest.fn();
    const client = new SlackClient(config, { warn, info: jest.fn(), error: jest.fn() }, transport);
    await expect(client.postMessage(token, message)).rejects.toMatchObject({ outcome });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret');
    expect(JSON.stringify(warn.mock.calls)).not.toContain(token);
  });

  test('retries only a known update and returns its exact handle', async () => {
    const transport = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockResolvedValue(success({ channel: 'C123', ts: '123.456' }));
    await expect(
      new SlackClient(config, undefined, transport).updateMessage(token, {
        ...message,
        ts: '123.456',
      }),
    ).resolves.toEqual({ channel: 'C123', ts: '123.456' });
    expect(transport).toHaveBeenCalledTimes(2);
  });

  test('does not shorten a long retry-after or sleep on the process', async () => {
    const transport = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockResolvedValue(new Response('', { status: 429, headers: { 'retry-after': '60' } }));
    await expect(
      new SlackClient(config, undefined, transport).reaction(
        token,
        'add',
        'C123',
        '123.456',
        'eyes',
      ),
    ).rejects.toMatchObject({ outcome: 'retryable', retryAfterMs: 60000 });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['network failure', () => Promise.reject(new Error('uncertain')), 'unknown'],
    [
      'internal failure',
      () => Promise.resolve(success({ ok: false, error: 'internal_error' })),
      'unknown',
    ],
    ['HTTP failure', () => Promise.resolve(new Response('', { status: 503 })), 'unknown'],
    [
      'rate limit',
      () => Promise.resolve(new Response('', { status: 429, headers: { 'retry-after': '1' } })),
      'retryable',
    ],
  ])('does not retry durable progress after %s', async (_name, response, outcome) => {
    const transport = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockImplementation(response);
    const client = new SlackClient(config, undefined, transport);
    await expect(
      client.updateMessageOnce(token, { ...message, ts: '123.456' }),
    ).rejects.toMatchObject({ outcome });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['add', 'already_reacted'],
    ['remove', 'no_reaction'],
  ] as const)('accepts the idempotent reaction %s state', async (action, error) => {
    const transport = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockResolvedValue(success({ ok: false, error }));
    await expect(
      new SlackClient(config, undefined, transport).reaction(
        token,
        action,
        'C123',
        '123.456',
        'eyes',
      ),
    ).resolves.toBeUndefined();
    expect(transport).toHaveBeenCalledTimes(1);
  });

  test('invalid/mismatched message receipts are unknown and not replayed', async () => {
    const transport = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockResolvedValue(success({ channel: 'OTHER', ts: '123.789' }));
    await expect(
      new SlackClient(config, undefined, transport).postMessage(token, message),
    ).rejects.toMatchObject({ outcome: 'unknown' });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  test.each(['invalid_blocks', 'invalid_attachments'])(
    'uses text fallback only after explicit %s rejection',
    async (error) => {
      const transport = jest
        .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
        .mockResolvedValueOnce(success({ ok: false, error }))
        .mockResolvedValueOnce(receipt());
      await expect(
        new SlackClient(config, undefined, transport).deliverPart(token, {
          ...message,
          blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'Answer' } }],
        }),
      ).resolves.toEqual({ channel: 'C123', ts: '123.789' });
      expect(transport).toHaveBeenCalledTimes(2);
      const fallback = new URLSearchParams(String(transport.mock.calls[1][1]?.body));
      expect(fallback.get('blocks')).toBe('[]');
      expect(fallback.get('text')).toBe(message.text);
    },
  );

  test.each([
    () => Promise.reject(new Error('network failure')),
    () => Promise.resolve(new Response('invalid_blocks')),
    () => Promise.resolve(success({ ok: false, error: 'internal_error' })),
    () => Promise.resolve(success({ ok: false, error: 'not_in_channel' })),
  ])('never uses rich fallback on ambiguous or unrelated failure %#', async (implementation) => {
    const transport = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockImplementation(implementation);
    await expect(
      new SlackClient(config, undefined, transport).deliverPart(token, {
        ...message,
        blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'Answer' } }],
      }),
    ).rejects.toBeInstanceOf(SlackWriteError);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  test('does not replay a text-only payload or retry uncertain fallback', async () => {
    const transport = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockResolvedValueOnce(success({ ok: false, error: 'invalid_blocks' }))
      .mockResolvedValueOnce(success({ ok: false, error: 'invalid_blocks' }))
      .mockRejectedValueOnce(new Error('network'));
    const client = new SlackClient(config, undefined, transport);
    await expect(client.deliverPart(token, message)).rejects.toMatchObject({
      code: 'invalid_blocks',
    });
    expect(transport).toHaveBeenCalledTimes(1);
    await expect(
      client.deliverPart(token, { ...message, blocks: [{ type: 'divider' }] }),
    ).rejects.toMatchObject({ outcome: 'unknown' });
    expect(transport).toHaveBeenCalledTimes(3);
  });

  test('rejects a native loader without the Stop subscription', async () => {
    const transport = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockResolvedValue(
        success({ warnings: ['missing_agent_session_stopped_event_subscription'] }),
      );
    await expect(
      new SlackClient(config, undefined, transport).setSessionStatus(token, {
        channel: 'C123',
        threadTs: '123.456',
        status: 'processing',
      }),
    ).rejects.toMatchObject({ outcome: 'permanent' });
  });

  test.each([
    ['invalid_arguments', 'invalid_arguments'],
    ['private-untrusted-error', 'platform_error'],
  ])('retains only allowlisted diagnostic metadata for %s', async (error, reason) => {
    const transport = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockResolvedValue(success({ ok: false, error, secret: 'private-provider-payload' }));
    const warn = jest.fn();
    const client = new SlackClient(config, { info: jest.fn(), warn, error: jest.fn() }, transport);
    await expect(
      client.setSessionStatus(token, {
        channel: 'C123',
        threadTs: '123.456',
        status: 'active',
        title: 'private-title',
      }),
    ).rejects.toThrow();
    expect(warn).toHaveBeenCalledWith(
      `slack_api_call_failed:agents.sessions.setStatus:200:${reason}`,
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain('private-');
    expect(JSON.stringify(warn.mock.calls)).not.toContain(token);
  });

  test('uses no public reply or external response URL for ephemeral and modal writes', async () => {
    const transport = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockImplementation(async () => success({}));
    const client = new SlackClient(config, undefined, transport);
    await client.ephemeral(token, { ...message, user: 'U123' });
    await client.openView(token, 'trigger', {
      type: 'modal',
      title: { type: 'plain_text', text: 'Review' },
      blocks: [],
    });
    await client.updateView(
      token,
      'view',
      { type: 'modal', title: { type: 'plain_text', text: 'Review' }, blocks: [] },
      'hash',
    );
    expect(transport.mock.calls.map(([url]) => url)).toEqual(
      ['chat.postEphemeral', 'views.open', 'views.update'].map(
        (method) => config.SLACK_API_BASE_URL + method,
      ),
    );
    expect(String(transport.mock.calls[0][1]?.body)).toContain('user=U123');
  });

  test('cancels before an external write when the fence is already lost', async () => {
    const transport = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>();
    await expect(
      new SlackClient(config, undefined, transport).postMessage(
        token,
        message,
        AbortSignal.abort(),
      ),
    ).rejects.toBeInstanceOf(SlackWriteError);
    expect(transport).not.toHaveBeenCalled();
  });

  test('returns an allocated ID even for an invalid capability so it can be checkpointed', async () => {
    const transport = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockResolvedValue(success({ file_id: 'F123', upload_url: 'https://evil.example/upload' }));
    const client = new SlackClient(config, undefined, transport);
    await expect(client.allocateArtifact(token, 'report.csv', 3)).resolves.toEqual({
      fileId: 'F123',
      uploadUrl: 'https://evil.example/upload',
    });
    await expect(
      client.uploadArtifact('https://evil.example/upload', Buffer.from('abc')),
    ).rejects.toMatchObject({ outcome: 'permanent' });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  test('uploads bytes without bot credentials or redirects and validates the final receipt', async () => {
    const transport = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockResolvedValueOnce(new Response('ok'))
      .mockResolvedValueOnce(success({ files: [{ id: 'F123' }] }));
    const client = new SlackClient(config, undefined, transport);
    await client.uploadArtifact('https://files.slack.com/upload/capability', Buffer.from('abc'));
    expect(new Headers(transport.mock.calls[0][1]?.headers).has('authorization')).toBe(false);
    expect(transport.mock.calls[0][1]?.redirect).toBe('error');
    await expect(
      client.completeArtifact(token, {
        channel: 'C123',
        threadTs: '123.456',
        fileId: 'F123',
        filename: 'file.txt',
      }),
    ).resolves.toBeUndefined();
  });

  test('holds uncertain binary upload and completion without implicit retries', async () => {
    const transport = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(success({ files: [{ id: 'OTHER' }] }));
    const client = new SlackClient(config, undefined, transport);
    await expect(
      client.uploadArtifact('https://files.slack.com/upload/capability', Buffer.from('abc')),
    ).rejects.toMatchObject({ outcome: 'unknown' });
    await expect(
      client.completeArtifact(token, {
        channel: 'C123',
        threadTs: '123.456',
        fileId: 'F123',
        filename: 'file.txt',
      }),
    ).rejects.toMatchObject({ outcome: 'unknown' });
    expect(transport).toHaveBeenCalledTimes(2);
  });
});

describe('validSlackUploadURL', () => {
  test.each(['https://files.slack.com/upload?q=capability', 'http://127.0.0.1:8080/upload'])(
    'allows the existing production/fixture boundary: %s',
    (url) => {
      expect(validSlackUploadURL(url, config.SLACK_API_BASE_URL)).toBe(true);
    },
  );
  test.each([
    'https://files.slack.com.evil.example/a',
    'https://files.slack.com:8443/a',
    'https://user:pass@files.slack.com/a',
    'https://files.slack.com/a#fragment',
    'http://localhost:8080/a',
    'http://127.0.0.1:9999/a',
    'https://10.0.0.1/a',
    'ftp://files.slack.com/a',
  ])('rejects %s', (url) => {
    expect(validSlackUploadURL(url, config.SLACK_API_BASE_URL)).toBe(false);
  });
});
