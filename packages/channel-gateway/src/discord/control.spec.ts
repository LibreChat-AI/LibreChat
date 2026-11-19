import { DiscordControlClient } from './control';

const applicationId = '123456789012345678';
const eventId = '234567890123456789';
const token = 'private-interaction-token';
const app = {
  applicationId,
  applicationRevision: 'revision',
  tenantId: '_',
  botUserId: '345678901234567890',
  publicKey: 'a'.repeat(64),
};
const submission = {
  applicationId,
  expectedApplicationRevision: 'revision',
  eventId,
  token,
  guildId: '456789012345678901',
  externalChannelId: '567890123456789012',
  externalUserId: '678901234567890123',
  action: { kind: 'link' as const },
};
const fence = { applicationId, eventId, owner: 'worker', epoch: 1 };
let client: DiscordControlClient;
let transport: jest.Mock;
let response: Response;
beforeEach(() => {
  response = Response.json(app);
  transport = jest.fn(async () => response);
  client = new DiscordControlClient(
    {
      LIBRECHAT_INTERNAL_URL: 'http://internal/prefix',
      CHANNEL_SERVICE_TOKEN: 'service-secret',
      CHANNEL_TENANT_ID: 'untrusted',
      API_CALL_TIMEOUT_MS: 1000,
    },
    transport,
  );
});
it('acknowledges only matching direct DM metadata and preserves operational failure semantics', async () => {
  const input = {
    applicationId,
    applicationRevision: 'revision',
    externalUserId: '678901234567890123',
    dmChannelId: '789012345678901234',
    confirmationEventId: eventId,
    codeHash: 'b'.repeat(64),
  };
  const value = {
    applicationId,
    externalUserId: input.externalUserId,
    dmChannelId: input.dmChannelId,
    selectionId: 'selection',
    expiresAtMs: Date.now() + 60000,
  };
  response = Response.json({ ok: true, value });
  expect(await client.select(input)).toBe('accepted');
  expect(transport.mock.calls[0][0]).toBe(
    'http://internal/prefix/api/channels/discord/service/dm/select',
  );
  expect(transport.mock.calls[0][1].headers).not.toHaveProperty('X-Tenant-Id');
  expect(JSON.parse(transport.mock.calls[0][1].body)).toEqual(input);
  response = Response.json({ ok: true, value: { ...value, dmChannelId: '999' } });
  await expect(client.select(input)).rejects.toThrow('not confirmed');
  response = new Response(null, { status: 409 });
  expect(await client.select(input)).toBe('conflict');
  response = new Response(null, { status: 429 });
  expect(await client.select(input)).toBe('capacity');
  response = new Response('private query', { status: 503 });
  await expect(client.select(input)).rejects.toThrow('HTTP 503');
});

it('uses protected prefixed discovery without a caller tenant header', async () => {
  expect(await client.security(applicationId)).toEqual(app);
  const [url, options] = transport.mock.calls[0];
  expect(url).toBe(`http://internal/prefix/api/channels/discord/service/security/${applicationId}`);
  expect(options.headers).toMatchObject({ Authorization: 'Bearer service-secret' });
  expect(options.headers).not.toHaveProperty('X-Tenant-Id');
  expect(options.redirect).toBe('error');
});
it('distinguishes missing applications from outages and mismatched results', async () => {
  response = new Response(null, { status: 404 });
  expect(await client.security(applicationId)).toBeNull();
  response = new Response(token, { status: 503 });
  await expect(client.security(applicationId)).rejects.toThrow('HTTP 503');
  response = Response.json({ ...app, applicationId: eventId });
  await expect(client.security(applicationId)).rejects.toThrow('mismatch');
});
it('accepts only matching committed admissions', async () => {
  response = Response.json(
    { ok: true, value: { eventId, state: 'queued', duplicate: false } },
    { status: 201 },
  );
  expect(await client.submit(submission)).toBe('accepted');
  response = Response.json({
    ok: true,
    value: { eventId: applicationId, state: 'queued', duplicate: false },
  });
  await expect(client.submit(submission)).rejects.toThrow('not confirmed');
  response = new Response(token, { status: 409 });
  expect(await client.submit(submission)).toBe('conflict');
  response = new Response(token, { status: 429 });
  expect(await client.submit(submission)).toBe('capacity');
});
it('validates private reply leases and handles empty queues', async () => {
  response = new Response(null, { status: 204 });
  expect(await client.claim(applicationId, 'worker')).toBeNull();
  const delivery = {
    fence,
    token,
    applicationRevision: 'revision',
    expiresAt: Date.now() + 1000,
    reply: { content: 'Accepted.' },
  };
  response = Response.json(delivery);
  expect(await client.claim(applicationId, 'worker')).toEqual(delivery);
  response = Response.json({ ...delivery, fence: { ...fence, owner: 'other' } });
  await expect(client.claim(applicationId, 'worker')).rejects.toThrow('lease mismatch');
});
it('keeps stale receipt settlement distinct from transport failure', async () => {
  response = new Response(null, { status: 204 });
  expect(await client.finish(fence, 'completed')).toBe(true);
  response = new Response(null, { status: 409 });
  expect(await client.defer(fence, Date.now() + 1000)).toBe(false);
  response = new Response(token, { status: 500 });
  await expect(client.finish(fence, 'unavailable')).rejects.toThrow('HTTP 500');
});
it('propagates deadline cancellation to the external control-plane call', async () => {
  const controller = new AbortController();
  transport.mockImplementation(async (_url, options) => {
    controller.abort();
    options.signal.throwIfAborted();
    return response;
  });
  await expect(client.security(applicationId, controller.signal)).rejects.toThrow();
});

it('resolves only the exact immutable claimed lease through the protected owner endpoint', async () => {
  const input = {
    fence,
    owner: { applicationId, applicationRevision: 'revision', ownerId: 'a'.repeat(32) },
    source: null,
  };
  const delivery = {
    fence,
    token,
    applicationRevision: 'revision',
    expiresAt: Date.now() + 60000,
    reply: { content: 'Unavailable.' },
  };
  response = Response.json(delivery);
  expect(await client.resolve(input)).toEqual(delivery);
  const [url, options] = transport.mock.calls[0];
  expect(url).toContain('/service/inbox/resolve');
  expect(JSON.parse(options.body)).toEqual(input);
  expect(options.headers).not.toHaveProperty('X-Tenant-Id');
  response = Response.json({ ...delivery, fence: { ...fence, eventId: applicationId } });
  await expect(client.resolve(input)).rejects.toThrow('resolution mismatch');
  response = new Response(null, { status: 409 });
  expect(await client.resolve(input)).toBeNull();
});
