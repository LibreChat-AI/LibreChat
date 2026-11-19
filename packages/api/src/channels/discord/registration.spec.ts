import { discordCommandManifest } from './registration';
import { createDiscordProviderClient } from './client';

const applicationId = '123456789012345678';
const botUserId = '123456789012345679';
const commandId = '234567890123456789';
const providerVersion = '345678901234567890';
const botToken = 'private-bot-token';
const publicKey = 'a'.repeat(64);
const application = { applicationId, botUserId, publicKey, name: 'Bot' };
const path = `/applications/${applicationId}/commands`;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const appPayload = () => ({
  id: applicationId,
  verify_key: publicKey,
  name: 'Bot',
  bot: { id: botUserId },
  bot_require_code_grant: true,
});
const commandPayload = () => ({
  ...discordCommandManifest,
  id: commandId,
  version: providerVersion,
  application_id: applicationId,
});
let fetchProvider: jest.Mock<Promise<Response>, [string, RequestInit]>;
let payloads: Record<string, unknown>;
let override: (() => Response | Promise<Response>) | undefined;
let client: ReturnType<typeof createDiscordProviderClient>;
const register = () => client.registerCommands({ application, botToken });
beforeEach(() => {
  override = undefined;
  payloads = {
    '/applications/@me': appPayload(),
    '/users/@me': { id: botUserId, bot: true },
    [path]: commandPayload(),
  };
  fetchProvider = jest.fn<Promise<Response>, [string, RequestInit]>(async (url) => {
    const route = new URL(url).pathname.replace('/api/v10', '');
    if (route === path && override) return override();
    if (!(route in payloads)) throw new Error('unexpected provider route');
    return json(payloads[route]);
  });
  client = createDiscordProviderClient({
    fetch: fetchProvider,
    config: {
      redirectUri: 'https://chat.example/api/channels/discord/oauth/callback',
      requestTimeoutMs: 100,
      maxResponseBytes: 8192,
      botPermissions: '274877975552',
    },
  });
});

it('upserts only the versioned guild-only LibreChat command and preserves unrelated commands', async () => {
  const commands = new Map<string, object>([
    ['1:other', { id: 'other-command', name: 'other' }],
    ['2:librechat', { id: 'user-command', name: 'librechat', type: 2 }],
    ['1:librechat', { id: commandId, name: 'librechat', description: 'Old version' }],
  ]);
  fetchProvider.mockImplementation(async (url, init) => {
    const route = new URL(url).pathname.replace('/api/v10', '');
    if (route !== path) return json(payloads[route]);
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      Authorization: `Bot ${botToken}`,
      'Content-Type': 'application/json',
    });
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({
      type: 1,
      name: 'librechat',
      integration_types: [0],
      contexts: [0],
      default_member_permissions: null,
    });
    expect(body).not.toHaveProperty('version');
    expect(body.options.map((option: { name: string }) => option.name)).toEqual([
      'ask',
      'link',
      'status',
      'cancel',
    ]);
    expect(body.options[0].options).toEqual([
      expect.objectContaining({
        type: 3,
        name: 'prompt',
        required: true,
        min_length: 1,
        max_length: 6000,
      }),
    ]);
    commands.set(`${body.type}:${body.name}`, body);
    return json(
      { ...body, id: commandId, application_id: applicationId, version: providerVersion },
      201,
    );
  });
  const expected = {
    ok: true,
    value: { applicationId, commandId, providerVersion, manifestVersion: '1' },
  };
  expect(await register()).toEqual(expected);
  expect(await register()).toEqual(expected);
  expect(commands.get('1:other')).toEqual({ id: 'other-command', name: 'other' });
  expect(commands.get('2:librechat')).toEqual({ id: 'user-command', name: 'librechat', type: 2 });
  expect(commands.size).toBe(3);
  expect(fetchProvider.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(2);
  expect(
    fetchProvider.mock.calls.every(
      ([, init]) => !['PUT', 'PATCH', 'DELETE'].includes(init.method ?? 'GET'),
    ),
  ).toBe(true);
  expect(JSON.stringify(expected)).not.toContain(botToken);
});

it.each([
  { id: '999' },
  { bot: { id: '999' } },
  { verify_key: 'b'.repeat(64) },
  { bot_require_code_grant: false },
])('rejects changed application authority before registration: %j', async (change) => {
  payloads['/applications/@me'] = { ...appPayload(), ...change };
  expect(await register()).toMatchObject({ ok: false });
  expect(fetchProvider.mock.calls.some(([url]) => url.endsWith(path))).toBe(false);
});

it('rejects a different authoritative bot before registering', async () => {
  payloads['/users/@me'] = { id: '999', bot: true };
  expect(await register()).toMatchObject({ ok: false, error: { code: 'application_changed' } });
  expect(fetchProvider.mock.calls.some(([url]) => url.endsWith(path))).toBe(false);
});

it.each([
  { application_id: '999' },
  { id: 123 },
  { version: '0' },
  { version: 123 },
  { type: 2 },
  { name: 'other' },
  { contexts: [0, 1] },
  { integration_types: [0, 1] },
  { guild_id: '999' },
  { options: [] },
  { default_member_permissions: '8' },
])('rejects an unconfirmed registration shape: %j', async (change) => {
  payloads[path] = { ...commandPayload(), ...change };
  expect(await register()).toMatchObject({ ok: false });
});

it.each([429, 500, 403])('sanitizes registration refusal %s', async (status) => {
  const codes: Record<number, string> = {
    429: 'rate_limited',
    500: 'provider_unavailable',
    403: 'provider_refused',
  };
  override = () => json({ message: `private ${botToken}`, token: botToken }, status);
  const result = await register();
  expect(result).toMatchObject({
    ok: false,
    error: {
      code: codes[status],
    },
  });
  expect(JSON.stringify(result)).not.toContain(botToken);
});

it('bounds malformed and oversized registration responses', async () => {
  override = () => new Response('not-json');
  expect(await register()).toMatchObject({ ok: false, error: { code: 'malformed_response' } });
  override = () => new Response('x'.repeat(9000));
  expect(await register()).toMatchObject({ ok: false, error: { code: 'response_too_large' } });
});

it('refuses registration redirects and bounds unresponsive provider I/O', async () => {
  override = () =>
    new Response(null, { status: 302, headers: { location: 'https://attacker.example' } });
  expect(await register()).toMatchObject({ ok: false, error: { code: 'provider_refused' } });
  override = () => new Promise(() => {});
  expect(await register()).toMatchObject({ ok: false, error: { code: 'timeout' } });
  const call = [...fetchProvider.mock.calls].reverse().find(([url]) => url.endsWith(path));
  expect(call?.[1].redirect).toBe('error');
  expect(call?.[1].signal?.aborted).toBe(true);
});
