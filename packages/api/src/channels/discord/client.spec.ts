import type { DiscordProviderClient, ExchangeDiscordGuild } from './client';
import { createDiscordProviderClient } from './client';

const applicationId = '123456789012345678';
const botUserId = '123456789012345679';
const guildId = '123456789012345680';
const publicKey = 'a'.repeat(64);
const botToken = 'private-bot-token';
const clientSecret = 'private-client-secret';
const accessToken = 'private-oauth-user-token';
const expected = { applicationId, botUserId, publicKey, name: 'Bot' };
const configuration = {
  redirectUri: 'https://chat.example/api/channels/discord/oauth/callback',
  requestTimeoutMs: 1000,
  maxResponseBytes: 8192,
  botPermissions: '274877975552',
};
let payloads: Record<string, unknown>;
let overrides: Map<string, () => Response | Promise<Response>>;
let fetchProvider: jest.Mock<Promise<Response>, [string, RequestInit]>;
let client: DiscordProviderClient;
const exchange = (): ExchangeDiscordGuild => ({
  application: expected,
  botToken,
  clientSecret,
  code: 'one-time-code',
  issuer: 'https://discord.com',
});
const appPayload = () => ({
  id: applicationId,
  name: 'Bot',
  bot: { id: botUserId, bot: true },
  verify_key: publicKey,
  bot_require_code_grant: true,
});
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const makeClient = (config = configuration) =>
  createDiscordProviderClient({ config, fetch: fetchProvider });

beforeEach(() => {
  payloads = {
    '/applications/@me': appPayload(),
    '/users/@me': { id: botUserId, bot: true },
    '/oauth2/token': {
      access_token: accessToken,
      token_type: 'Bearer',
      scope: 'guilds',
      guild: { id: guildId, name: 'Grant guild' },
      refresh_token: 'private-unused-refresh-token',
      expires_in: 604800,
    },
    '/oauth2/@me': {
      application: { id: applicationId },
      scopes: ['guilds'],
    },
    '/users/@me/guilds?limit=200': [{ id: guildId, owner: false, permissions: '32' }],
    [`/guilds/${guildId}`]: { id: guildId, name: 'Verified guild' },
  };
  overrides = new Map();
  fetchProvider = jest.fn<Promise<Response>, [string, RequestInit]>(async (url: string) => {
    const parsed = new URL(url);
    const path = parsed.pathname.replace('/api/v10', '') + parsed.search;
    const override = overrides.get(path);
    if (override) return override();
    if (!(path in payloads)) throw new Error(`Unexpected path ${path}`);
    return json(payloads[path]);
  });
  client = makeClient();
});

it('verifies authoritative application, bot and public key without returning credentials', async () => {
  expect(await client.verifyApplication({ applicationId, botToken })).toEqual({
    ok: true,
    value: expected,
  });
  expect(fetchProvider).toHaveBeenCalledWith(
    'https://discord.com/api/v10/applications/@me',
    expect.objectContaining({
      headers: { Authorization: `Bot ${botToken}` },
      redirect: 'error',
      signal: expect.any(AbortSignal),
    }),
  );
  expect(fetchProvider).toHaveBeenCalledWith(
    'https://discord.com/api/v10/users/@me',
    expect.objectContaining({ headers: { Authorization: `Bot ${botToken}` } }),
  );
});

it('verifies bot identity when the optional application bot expansion is absent', async () => {
  payloads['/applications/@me'] = { ...appPayload(), bot: undefined };
  expect(await client.verifyApplication({ applicationId, botToken })).toEqual({
    ok: true,
    value: expected,
  });
  expect(await client.exchangeGuild(exchange())).toEqual({
    ok: true,
    value: { application: expected, guildId, guildName: 'Verified guild' },
  });
  expect(
    await client.verifyApplication({ applicationId, botToken, expectedBotUserId: '999' }),
  ).toEqual({ ok: false, error: { code: 'application_changed' } });
});

it('rejects an application bot expansion that differs from the authenticated bot', async () => {
  payloads['/applications/@me'] = { ...appPayload(), bot: { id: '999', bot: true } };
  expect(await client.verifyApplication({ applicationId, botToken })).toEqual({
    ok: false,
    error: { code: 'application_changed' },
  });
});

it.each([{ id: botUserId, bot: false }, { id: botUserId }, { id: 123, bot: true }])(
  'rejects an unverified authenticated bot identity %p',
  async (bot) => {
    payloads['/users/@me'] = bot;
    expect(await client.verifyApplication({ applicationId, botToken })).toEqual({
      ok: false,
      error: { code: 'malformed_response' },
    });
  },
);

it.each(['application', 'bot', 'key'])('rejects a mismatched %s identity', async (kind) => {
  const input = {
    applicationId,
    botToken,
    expectedBotUserId: botUserId,
    expectedPublicKey: publicKey,
  };
  if (kind === 'application') input.applicationId = '999';
  if (kind === 'bot') input.expectedBotUserId = '999';
  if (kind === 'key') input.expectedPublicKey = 'b'.repeat(64);
  expect(await client.verifyApplication(input)).toEqual({
    ok: false,
    error: { code: 'application_changed' },
  });
});

it('requires the code grant installation setting', async () => {
  payloads['/applications/@me'] = { ...appPayload(), bot_require_code_grant: false };
  expect(await client.verifyApplication({ applicationId, botToken })).toEqual({
    ok: false,
    error: { code: 'unsupported_installation' },
  });
  expect(await client.exchangeGuild(exchange())).toEqual({
    ok: false,
    error: { code: 'unsupported_installation' },
  });
  expect(fetchProvider.mock.calls.every(([url]) => !url.endsWith('/oauth2/token'))).toBe(true);
});

it.each([
  { ...appPayload(), bot: { id: botUserId, bot: false } },
  { ...appPayload(), verify_key: 'invalid' },
  { ...appPayload(), id: 123 },
])('rejects malformed bot application metadata', async (payload) => {
  payloads['/applications/@me'] = payload;
  expect(await client.verifyApplication({ applicationId, botToken })).toEqual({
    ok: false,
    error: { code: 'malformed_response' },
  });
});

it('constructs a guild-only authorization URL with minimal user scope and bound reconnect selection', () => {
  const result = client.authorizationURL({ applicationId, state: 's'.repeat(43), guildId });
  if (!result.ok) throw new Error(result.error.code);
  const url = new URL(result.value);
  expect(url.origin + url.pathname).toBe('https://discord.com/oauth2/authorize');
  expect(Object.fromEntries(url.searchParams)).toEqual({
    client_id: applicationId,
    response_type: 'code',
    redirect_uri: configuration.redirectUri,
    scope: 'bot applications.commands guilds',
    state: 's'.repeat(43),
    integration_type: '0',
    permissions: configuration.botPermissions,
    guild_id: guildId,
    disable_guild_select: 'true',
  });
  expect(result.value).not.toContain(clientSecret);
  expect(result.value).not.toContain(botToken);
});

it('ignores a forged callback guild hint and returns only verified metadata', async () => {
  const result = await client.exchangeGuild(
    Object.assign(exchange(), { callbackGuildId: '999', permissions: '8' }),
  );
  expect(result).toEqual({
    ok: true,
    value: { application: expected, guildId, guildName: 'Verified guild' },
  });
  expect(JSON.stringify(result)).not.toMatch(/private-|refresh_token|access_token/);
  expect(fetchProvider.mock.calls.map(([url]) => url)).not.toContain(
    'https://discord.com/api/v10/guilds/999',
  );
  const request = fetchProvider.mock.calls.find(([url]) => url.endsWith('/oauth2/token'))![1];
  expect(request.method).toBe('POST');
  expect(request.headers).toEqual({ 'Content-Type': 'application/x-www-form-urlencoded' });
  expect(Object.fromEntries(new URLSearchParams(String(request.body)))).toEqual({
    grant_type: 'authorization_code',
    code: 'one-time-code',
    client_id: applicationId,
    client_secret: clientSecret,
    redirect_uri: configuration.redirectUri,
  });
  expect(fetchProvider.mock.calls.every(([, init]) => init.redirect === 'error')).toBe(true);
});

it.each([
  ['guilds', ['guilds']],
  ['guilds', ['bot', 'applications.commands', 'guilds']],
  ['bot applications.commands guilds', ['guilds']],
  ['bot guilds', ['applications.commands', 'guilds']],
])(
  'accepts user scopes %s independently of installation scopes',
  async (scope, authorizationScopes) => {
    payloads['/oauth2/token'] = {
      access_token: accessToken,
      token_type: 'Bearer',
      scope,
      guild: { id: guildId, name: 'Grant guild' },
    };
    payloads['/oauth2/@me'] = { application: { id: applicationId }, scopes: authorizationScopes };
    expect(await client.exchangeGuild(exchange())).toEqual({
      ok: true,
      value: { application: expected, guildId, guildName: 'Verified guild' },
    });
    expect(fetchProvider).toHaveBeenCalledWith(
      `https://discord.com/api/v10/guilds/${guildId}`,
      expect.objectContaining({ headers: { Authorization: `Bot ${botToken}` } }),
    );
  },
);

it.each(['https://attacker.example', '', 'https://discord.com/'])(
  'rejects issuer %s before network work',
  async (issuer) => {
    expect(await client.exchangeGuild({ ...exchange(), issuer })).toEqual({
      ok: false,
      error: { code: 'invalid_grant' },
    });
    expect(fetchProvider).not.toHaveBeenCalled();
  },
);

it('rejects a grant for another trusted reconnect guild', async () => {
  expect(await client.exchangeGuild({ ...exchange(), expectedGuildId: '999' })).toEqual({
    ok: false,
    error: { code: 'guild_changed' },
  });
});

it.each([
  { access_token: accessToken, token_type: 'Bearer', scope: 'guilds' },
  {
    access_token: accessToken,
    token_type: 'Bot',
    scope: 'bot applications.commands guilds',
    guild: { id: guildId, name: 'Guild' },
  },
  {
    access_token: accessToken,
    token_type: 'Bearer',
    scope: 'bot applications.commands',
    guild: { id: guildId, name: 'Guild' },
  },
])('rejects unsupported or incomplete grant responses', async (grant) => {
  payloads['/oauth2/token'] = grant;
  const result = await client.exchangeGuild(exchange());
  expect(result.ok).toBe(false);
  expect(JSON.stringify(result)).not.toContain(accessToken);
});

it.each([
  { application: { id: '999' }, scopes: ['bot', 'applications.commands', 'guilds'] },
  { application: { id: applicationId }, scopes: ['bot'] },
])(
  'binds the returned OAuth token to the expected application and scopes',
  async (authorization) => {
    payloads['/oauth2/@me'] = authorization;
    expect(await client.exchangeGuild(exchange())).toEqual({
      ok: false,
      error: { code: 'invalid_grant' },
    });
  },
);

it.each(['8', '32', '40'])(
  'accepts effective administrative guild permissions %s',
  async (permission) => {
    payloads['/users/@me/guilds?limit=200'] = [
      { id: guildId, owner: false, permissions: permission },
    ];
    expect((await client.exchangeGuild(exchange())).ok).toBe(true);
  },
);

it('accepts guild ownership without additional permission bits', async () => {
  payloads['/users/@me/guilds?limit=200'] = [{ id: guildId, owner: true, permissions: '0' }];
  expect((await client.exchangeGuild(exchange())).ok).toBe(true);
});

it.each([
  { guilds: [] },
  { guilds: [{ id: '999', owner: true, permissions: '8' }] },
  { guilds: [{ id: guildId, owner: false, permissions: '1024' }] },
])(
  'rejects an installer without effective management rights in the granted guild',
  async ({ guilds }) => {
    payloads['/users/@me/guilds?limit=200'] = guilds;
    expect(await client.exchangeGuild(exchange())).toEqual({
      ok: false,
      error: { code: 'missing_permissions' },
    });
    expect(fetchProvider.mock.calls.some(([url]) => url.includes(`/guilds/${guildId}`))).toBe(
      false,
    );
  },
);

it('requires bot access to the exact guild', async () => {
  payloads[`/guilds/${guildId}`] = { id: '999', name: 'Foreign' };
  expect(await client.exchangeGuild(exchange())).toEqual({
    ok: false,
    error: { code: 'guild_changed' },
  });
  overrides.set(`/guilds/${guildId}`, () => json({ message: 'private provider diagnostic' }, 403));
  expect(await client.exchangeGuild(exchange())).toEqual({
    ok: false,
    error: { code: 'provider_refused' },
  });
});

it.each([
  [400, 'provider_refused'],
  [401, 'provider_refused'],
  [429, 'rate_limited'],
  [503, 'provider_unavailable'],
])('maps HTTP %s to a safe code', async (status, code) => {
  overrides.set('/applications/@me', () =>
    json({ message: `private diagnostic ${botToken}` }, Number(status)),
  );
  expect(await client.verifyApplication({ applicationId, botToken })).toEqual({
    ok: false,
    error: { code },
  });
});

it('refuses redirects and suppresses sensitive fetch exceptions', async () => {
  overrides.set(
    '/applications/@me',
    () => new Response(null, { status: 302, headers: { location: 'https://attacker.example' } }),
  );
  expect(await client.verifyApplication({ applicationId, botToken })).toEqual({
    ok: false,
    error: { code: 'provider_refused' },
  });
  fetchProvider.mockRejectedValueOnce(new Error(`fetch refused redirect ${botToken}`));
  expect(await client.verifyApplication({ applicationId, botToken })).toEqual({
    ok: false,
    error: { code: 'provider_unavailable' },
  });
});

it('rejects malformed JSON and an empty response', async () => {
  overrides.set('/applications/@me', () => new Response(`private ${botToken}`));
  expect(await client.verifyApplication({ applicationId, botToken })).toEqual({
    ok: false,
    error: { code: 'malformed_response' },
  });
  overrides.set('/applications/@me', () => new Response(null));
  expect(await client.verifyApplication({ applicationId, botToken })).toEqual({
    ok: false,
    error: { code: 'malformed_response' },
  });
});

it('bounds streamed response bytes and cancels the reader', async () => {
  const cancel = jest.fn();
  overrides.set(
    '/applications/@me',
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(9000));
          },
          cancel,
        }),
      ),
  );
  expect(await client.verifyApplication({ applicationId, botToken })).toEqual({
    ok: false,
    error: { code: 'response_too_large' },
  });
  expect(cancel).toHaveBeenCalled();
});

it('rejects excessive declared content length before parsing the body', async () => {
  overrides.set(
    '/applications/@me',
    () => new Response('{}', { headers: { 'content-length': '999999' } }),
  );
  expect(await client.verifyApplication({ applicationId, botToken })).toEqual({
    ok: false,
    error: { code: 'response_too_large' },
  });
});

it('bounds a stalled fetch even when the injected transport ignores abort', async () => {
  fetchProvider.mockImplementationOnce(() => new Promise(() => {}));
  client = makeClient({ ...configuration, requestTimeoutMs: 10 });
  expect(await client.verifyApplication({ applicationId, botToken })).toEqual({
    ok: false,
    error: { code: 'timeout' },
  });
  expect(fetchProvider.mock.calls[0][1].signal?.aborted).toBe(true);
});

it('bounds body reads and cancels stalled streams', async () => {
  const cancel = jest.fn();
  overrides.set('/applications/@me', () => new Response(new ReadableStream({ cancel })));
  client = makeClient({ ...configuration, requestTimeoutMs: 10 });
  expect(await client.verifyApplication({ applicationId, botToken })).toEqual({
    ok: false,
    error: { code: 'timeout' },
  });
  expect(cancel).toHaveBeenCalled();
});

it('rejects unsafe configuration and invalid input without calling Discord', async () => {
  expect(() => makeClient({ ...configuration, redirectUri: 'http://attacker.example' })).toThrow(
    TypeError,
  );
  expect(() =>
    makeClient({ ...configuration, redirectUri: 'https://user:secret@chat.example/callback' }),
  ).toThrow(TypeError);
  expect(() => makeClient({ ...configuration, requestTimeoutMs: 0 })).toThrow(TypeError);
  expect(() => makeClient({ ...configuration, maxResponseBytes: 0 })).toThrow(TypeError);
  expect(() => makeClient({ ...configuration, botPermissions: '-1' })).toThrow(TypeError);
  expect(await client.verifyApplication({ applicationId: '0', botToken })).toEqual({
    ok: false,
    error: { code: 'invalid_input' },
  });
  expect(await client.verifyApplication({ applicationId, botToken: 'token\r\ninjected' })).toEqual({
    ok: false,
    error: { code: 'invalid_input' },
  });
  expect(client.authorizationURL({ applicationId, state: 'bad-state' })).toEqual({
    ok: false,
    error: { code: 'invalid_input' },
  });
  expect(fetchProvider).not.toHaveBeenCalled();
});

it('rejects a refused one-time code without continuing installation or exposing diagnostics', async () => {
  overrides.set('/oauth2/token', () =>
    json({ error: 'invalid_grant', error_description: `private ${clientSecret}` }, 400),
  );
  expect(await client.exchangeGuild(exchange())).toEqual({
    ok: false,
    error: { code: 'provider_refused' },
  });
  expect(fetchProvider.mock.calls.map(([url]) => url)).toEqual([
    'https://discord.com/api/v10/applications/@me',
    'https://discord.com/api/v10/users/@me',
    'https://discord.com/api/v10/oauth2/token',
  ]);
});

it('cancels responses that arrive after an uncooperative transport times out', async () => {
  let deliver: (response: Response) => void = () => {};
  fetchProvider.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        deliver = resolve;
      }),
  );
  client = makeClient({ ...configuration, requestTimeoutMs: 10 });
  expect(await client.verifyApplication({ applicationId, botToken })).toEqual({
    ok: false,
    error: { code: 'timeout' },
  });
  const cancel = jest.fn();
  deliver(new Response(new ReadableStream({ cancel })));
  await Promise.resolve();
  expect(cancel).toHaveBeenCalled();
});
