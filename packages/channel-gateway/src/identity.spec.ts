import { DEFAULT_CHANNEL_GATEWAY_POLICY } from 'librechat-data-provider';
import type { ChannelLinkView } from 'librechat-data-provider';
import type { ChannelBundle } from './types';
import { IdentityFlow, safeIdentityTicket, safePrivateURL, validActorView } from './identity';
import { ChannelClient } from './client';
import { loadConfig } from './config';
import { SlackClient } from './slack';

const config = loadConfig({
  CHANNEL_SERVICE_TOKEN: 'test-service',
  CHANNEL_TENANT_ID: 'tenant',
  CHANNEL_ID: 'binding',
});
const bundle: ChannelBundle = {
  gateway: { version: 1, ...DEFAULT_CHANNEL_GATEWAY_POLICY },
  channel: {
    channelId: 'binding',
    tenantId: 'tenant',
    agentId: 'agent',
    createdBy: 'owner',
    type: 'slack',
    status: 'active',
    credentialMode: 'per_user',
    revision: 'r1',
    slack: { teamId: 'T1', appId: 'A1', botUserId: 'B1' },
  },
  agent: { id: 'agent' },
  credentials: { botToken: 'test-bot' },
};
const view = (): ChannelLinkView => ({
  identity: {
    tenantId: 'tenant',
    channelId: 'binding',
    channelRevision: 'r1',
    teamId: 'T1',
    externalUserId: 'U1',
    agentId: 'agent',
  },
  linkId: 'link',
  revision: 'l1',
  state: 'accepted',
  expiresAtMs: Date.now() + 60000,
  accountLabel: 'Personal account',
});
const json = (body: object) =>
  new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
function setup() {
  const backend = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>();
  const slack = jest
    .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
    .mockImplementation(async () => json({ ok: true }));
  return {
    backend,
    slack,
    flow: new IdentityFlow(
      new ChannelClient(config, backend),
      new SlackClient(config, undefined, slack),
    ),
  };
}
function posted(transport: ReturnType<typeof setup>['slack']) {
  return new URLSearchParams(String(transport.mock.calls[0][1]?.body));
}

describe('private identity linking', () => {
  test('concurrent accepted reads produce one confirmation and one private stale acknowledgement', async () => {
    const { backend, slack, flow } = setup();
    let reads = 0;
    let confirms = 0;
    let release: () => void = () => {};
    const bothRead = new Promise<void>((resolve) => {
      release = resolve;
    });
    backend.mockImplementation(async (url) => {
      if (String(url).endsWith('/confirm')) {
        confirms++;
        return json(
          confirms === 1
            ? { ok: true, value: { ...view(), state: 'active' } }
            : { ok: false, error: { code: 'changed' } },
        );
      }
      reads++;
      if (reads === 2) release();
      await bothRead;
      return json({ ok: true, value: view() });
    });
    const reference = JSON.stringify({ linkId: 'link', revision: 'l1' });
    await Promise.all([
      flow.confirm('C1', 'U1', reference, bundle),
      flow.confirm('C1', 'U1', reference, bundle),
    ]);
    const texts = slack.mock.calls.map(
      ([, init]) => new URLSearchParams(String(init?.body)).get('text')!,
    );
    expect(texts.filter((text) => text.includes('link is confirmed'))).toHaveLength(1);
    expect(texts.filter((text) => text.includes('stale'))).toHaveLength(1);
    expect(backend.mock.calls.every(([url]) => String(url).includes('/identity/U1'))).toBe(true);
    expect(
      slack.mock.calls.every(
        ([url, init]) =>
          String(url).includes('chat.postEphemeral') &&
          new URLSearchParams(String(init?.body)).get('user') === 'U1',
      ),
    ).toBe(true);
  });

  test.each([
    'invalid_ticket',
    'expired',
    'changed',
    'forbidden',
    'already_linked',
    'confirmation_required',
    'revoked',
    'unavailable',
  ])(
    'preserves domain failure %s across lookup, ticket and confirmation without claiming success',
    async (code) => {
      for (const phase of ['lookup', 'ticket', 'confirm']) {
        const { backend, slack, flow } = setup();
        if (phase !== 'lookup')
          backend.mockResolvedValueOnce(
            json({ ok: true, value: phase === 'ticket' ? null : view() }),
          );
        backend.mockResolvedValueOnce(json({ ok: false, error: { code } }));
        if (phase === 'confirm')
          await flow.confirm(
            'C1',
            'U1',
            JSON.stringify({ linkId: 'link', revision: 'l1' }),
            bundle,
          );
        else await flow.prompt('C1', 'U1', bundle);
        expect(posted(slack).get('text')).toContain('stale or unavailable');
        expect(posted(slack).get('text')).not.toContain('link is confirmed');
        expect(slack).toHaveBeenCalledTimes(1);
      }
    },
  );

  test.each([400, 403, 404, 409, 410])(
    'expected HTTP %i is private unavailability, not a failed interaction',
    async (status) => {
      const { backend, slack, flow } = setup();
      backend.mockResolvedValueOnce(new Response('{}', { status }));
      await flow.prompt('C1', 'U1', bundle);
      expect(posted(slack).get('text')).toContain('stale or unavailable');
    },
  );

  test('a confirmation HTTP conflict is acknowledged, while service outages still propagate', async () => {
    const { backend, slack, flow } = setup();
    backend
      .mockResolvedValueOnce(json({ ok: true, value: view() }))
      .mockResolvedValueOnce(new Response('{}', { status: 409 }));
    await flow.confirm('C1', 'U1', JSON.stringify({ linkId: 'link', revision: 'l1' }), bundle);
    expect(posted(slack).get('text')).toContain('stale or unavailable');
    backend.mockResolvedValueOnce(new Response('{}', { status: 503 }));
    await expect(flow.prompt('C1', 'U1', bundle)).rejects.toThrow();
    expect(slack).toHaveBeenCalledTimes(1);
  });

  test('accepted account requires explicit actor-private Slack confirmation', async () => {
    const { backend, slack, flow } = setup();
    backend.mockResolvedValueOnce(json({ ok: true, value: view() }));
    await flow.prompt('C1', 'U1', bundle);
    const payload = posted(slack);
    expect(String(slack.mock.calls[0][0])).toContain('chat.postEphemeral');
    expect(payload.get('user')).toBe('U1');
    expect(payload.get('blocks')).toContain('channel_link_confirm');
    expect(payload.get('blocks')).not.toContain('test-service');
    expect(backend).toHaveBeenCalledTimes(1);
  });

  test('a browser ticket is private and the original command is not replayed', async () => {
    const { backend, slack, flow } = setup();
    const ticket = {
      url: `https://chat.example/channels/link#${'a'.repeat(43)}`,
      expiresAtMs: Date.now() + 60000,
    };
    backend
      .mockResolvedValueOnce(json({ ok: true, value: null }))
      .mockResolvedValueOnce(json({ ok: true, value: ticket }));
    await flow.prompt('C1', 'U1', bundle);
    expect(posted(slack).get('text')).toContain('will not run automatically');
    expect(backend.mock.calls.map(([url]) => String(url))).toEqual([
      `${config.LIBRECHAT_INTERNAL_URL}/api/channels/service/binding/identity/U1`,
      `${config.LIBRECHAT_INTERNAL_URL}/api/channels/service/binding/identity/U1/ticket`,
    ]);
  });

  test.each([
    'externalUserId',
    'channelRevision',
    'teamId',
    'agentId',
    'tenantId',
    'channelId',
  ] as const)('rejects mismatched %s', async (field) => {
    const { backend, slack, flow } = setup();
    const other = view();
    other.identity[field] = 'other';
    backend.mockResolvedValueOnce(json({ ok: true, value: other }));
    await expect(flow.prompt('C1', 'U1', bundle)).rejects.toThrow();
    expect(slack).not.toHaveBeenCalled();
  });

  test.each(['email@example.com', 'label\nunsafe', 'label\u202eunsafe', ''])(
    'does not disclose unsafe account label %p',
    async (label) => {
      const { backend, slack, flow } = setup();
      const linked = view();
      linked.accountLabel = label;
      backend.mockResolvedValueOnce(json({ ok: true, value: linked }));
      await expect(flow.prompt('C1', 'U1', bundle)).rejects.toThrow();
      expect(slack).not.toHaveBeenCalled();
    },
  );

  test('stale link confirmation does not mutate identity', async () => {
    const { backend, slack, flow } = setup();
    backend.mockResolvedValueOnce(json({ ok: true, value: view() }));
    await flow.confirm('C1', 'U1', JSON.stringify({ linkId: 'link', revision: 'old' }), bundle);
    expect(backend).toHaveBeenCalledTimes(1);
    expect(posted(slack).get('text')).toContain('stale');
  });

  test('confirmation is verified active and never admits the earlier command', async () => {
    const { backend, slack, flow } = setup();
    backend
      .mockResolvedValueOnce(json({ ok: true, value: view() }))
      .mockResolvedValueOnce(json({ ok: true, value: { ...view(), state: 'active' } }));
    await flow.confirm('C1', 'U1', JSON.stringify({ linkId: 'link', revision: 'l1' }), bundle);
    expect(String(backend.mock.calls[1][0])).toContain('/identity/U1/confirm');
    expect(posted(slack).get('text')).toContain('earlier request was not run');
    expect(backend).toHaveBeenCalledTimes(2);
  });

  test('unconfirmed mutation does not claim success', async () => {
    const { backend, slack, flow } = setup();
    backend.mockImplementation(async () => json({ ok: true, value: view() }));
    await expect(
      flow.confirm('C1', 'U1', JSON.stringify({ linkId: 'link', revision: 'l1' }), bundle),
    ).rejects.toThrow('not committed');
    expect(slack).not.toHaveBeenCalled();
  });

  test('expired identity cannot be confirmed', () => {
    const expired = view();
    expired.expiresAtMs = Date.now() - 1;
    expect(validActorView(expired, 'tenant', 'U1', bundle)).toBe(false);
  });
  test.each([
    'https://example.com/x#token',
    'https://user:pass@example.com/x',
    'javascript:alert(1)',
    'http://example.com/x',
    'https://example.com/x|bad',
  ])('rejects unsafe private URL %s', (url) => expect(safePrivateURL(url)).toBe(false));
  test('allows loopback browser fixture without permitting arbitrary HTTP', () =>
    expect(safePrivateURL('http://127.0.0.1:3088/channels/link')).toBe(true));
  test('rejects ticket query and expiry', () => {
    expect(
      safeIdentityTicket({
        url: `https://chat.example/channels/link?ticket=leak#${'a'.repeat(43)}`,
        expiresAtMs: Date.now() + 1000,
      }),
    ).toBe(false);
    expect(
      safeIdentityTicket({
        url: `https://chat.example/channels/link#${'a'.repeat(43)}`,
        expiresAtMs: Date.now() - 1,
      }),
    ).toBe(false);
  });
});

test('an unavailable prior identity issues a fresh private ticket without replaying the original request', async () => {
  const { backend, slack, flow } = setup();
  backend
    .mockResolvedValueOnce(json({ ok: true, value: { ...view(), state: 'unavailable' } }))
    .mockResolvedValueOnce(
      json({
        ok: true,
        value: {
          url: `https://chat.example/channels/link#${'b'.repeat(43)}`,
          expiresAtMs: Date.now() + 60000,
        },
      }),
    );
  await flow.prompt('C1', 'U1', bundle);
  expect(backend.mock.calls.map(([url]) => String(url).split('/').at(-1))).toEqual([
    'U1',
    'ticket',
  ]);
  expect(posted(slack).get('text')).toContain('will not run automatically');
  expect(posted(slack).get('user')).toBe('U1');
});
