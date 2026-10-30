import { createHash } from 'node:crypto';
import {
  CHANNEL_RUN_MAX_JSON_BYTES,
  DEFAULT_CHANNEL_GATEWAY_POLICY,
  CHANNEL_DELIVERY_TEXT_MAX_CHARS,
  CHANNEL_DELIVERY_PARTS_HARD_MAX,
  CHANNEL_DELIVERY_PRESENTATION_MAX_BYTES,
} from 'librechat-data-provider';
import type { ChannelArtifact, ChannelRunFence, ChannelRunView } from 'librechat-data-provider';
import type { ChannelBundle, ResponseGrant } from './types';
import { ChannelClient, ServiceError, boundedBody } from './client';
import { loadConfig } from './config';

const config = loadConfig({
  CHANNEL_SERVICE_TOKEN: 'private-service-token',
  CHANNEL_TENANT_ID: 'tenant-1',
  CHANNEL_ID: 'channel-1',
  LIBRECHAT_INTERNAL_URL: 'http://127.0.0.1:3080/',
});
const json = (value: object | null, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const fence: ChannelRunFence = { runId: 'run-1', owner: 'worker-1', epoch: 1 };
const grant: ResponseGrant = {
  apiKey: 'sk-bound-private-test',
  requestKey: 'channel:run-1',
  request: { model: 'agent-1', input: 'private-user-prompt', background: true, store: true },
};
const response = {
  id: 'resp_123',
  object: 'response',
  model: 'agent-1',
  background: true,
  store: true,
  status: 'in_progress',
};
const bundle: ChannelBundle = {
  channel: {
    channelId: 'channel-1',
    tenantId: 'tenant-1',
    agentId: 'agent-1',
    createdBy: 'user-1',
    type: 'slack',
    status: 'active',
    credentialMode: 'per_user',
    revision: 'revision-1',
    slack: { teamId: 'T1', appId: 'A1', botUserId: 'U1' },
  },
  agent: { id: 'agent-1' },
  credentials: { botToken: 'private-slack-token' },
  gateway: { version: 1, ...DEFAULT_CHANNEL_GATEWAY_POLICY },
};
const run: ChannelRunView = {
  runId: 'run-1',
  channelId: 'channel-1',
  revision: 'revision-1',
  state: 'executing',
  sequence: 1,
  cancellationRequested: false,
  receipts: [],
  admission: {
    eventId: 'event-1',
    externalChannelId: 'C1',
    externalMessageKey: 'C1:123.456',
    externalThreadKey: 'C1:123.456',
    actor: { teamId: 'T1', appId: 'A1', externalUserId: 'U1' },
    input: 'private-user-prompt',
  },
};

describe('ChannelClient service boundary', () => {
  test.each([
    undefined,
    { ...bundle.gateway, version: 2 },
    { version: 1 },
    { ...bundle.gateway, nativeSessions: 'true' },
    { ...bundle.gateway, signatureToleranceSeconds: 301 },
  ])('rejects missing or unsupported authoritative gateway policy %#', async (gateway) => {
    const transport = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockImplementation(async () => json({ ...bundle, gateway }));
    await expect(new ChannelClient(config, transport).channel()).rejects.toThrow(
      'Unsupported channel gateway policy',
    );
  });
  test.each([0, 101, 1.5, '1', null])(
    'rejects malformed delivery budget %p',
    async (maxDeliveryParts) => {
      const transport = jest
        .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
        .mockResolvedValue(json({ ...bundle, delivery: { maxDeliveryParts } }));
      await expect(new ChannelClient(config, transport).channel()).rejects.toThrow(
        'Invalid channel delivery policy',
      );
    },
  );
  test('reads the server-selected reduced delivery budget', async () => {
    const transport = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockResolvedValue(json({ ...bundle, delivery: { maxDeliveryParts: 1 } }));
    expect((await new ChannelClient(config, transport).channel()).delivery).toEqual({
      maxDeliveryParts: 1,
    });
  });
  test('preserves identity domain results and null absence without converting conflicts to exceptions', async () => {
    const transport = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockResolvedValueOnce(json({ ok: false, error: { code: 'changed' } }))
      .mockResolvedValueOnce(json({ ok: true, value: null }));
    const client = new ChannelClient(config, transport);
    await expect(client.identity('U1', '/confirm', {})).resolves.toEqual({
      ok: false,
      error: { code: 'changed' },
    });
    await expect(client.identity('U1')).resolves.toEqual({ ok: true, value: null });
  });
  test('returns a valid worker-bound claim', async () => {
    const lease = { run, fence, leaseExpiresAt: Date.now() + 60_000 };
    const transport = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockImplementation(async () => json(lease));
    await expect(new ChannelClient(config, transport).claim(fence.owner)).resolves.toEqual(lease);
  });

  test.each([
    { fence: { ...fence, runId: 'other-run' } },
    { fence: { ...fence, owner: 'other-worker' } },
    { fence: { ...fence, epoch: 0 } },
    { fence: { ...fence, epoch: 1.5 } },
    { run: { ...run, channelId: 'other-channel' } },
    { run: { ...run, revision: '' } },
    { run: { ...run, admission: { ...run.admission, externalThreadKey: 'foreign:123' } } },
    { run: { ...run, admission: null } },
    { leaseExpiresAt: 0 },
    { leaseExpiresAt: 'future' },
  ])('rejects an inconsistent claimed lease %#', async (change) => {
    const transport = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockImplementation(async () =>
        json({ run, fence, leaseExpiresAt: Date.now() + 60_000, ...change }),
      );
    await expect(new ChannelClient(config, transport).claim(fence.owner)).rejects.toThrow();
  });

  test.each([
    { fence: { ...fence, runId: 'other-run' } },
    { fence: { ...fence, owner: 'other-worker' } },
    { fence: { ...fence, epoch: 2 } },
    { leaseExpiresAt: 0 },
  ])('rejects a renewal that changes the fence %#', async (change) => {
    const transport = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockImplementation(async () =>
        json({ fence, leaseExpiresAt: Date.now() + 60_000, ...change }),
      );
    await expect(new ChannelClient(config, transport).renew(fence)).rejects.toThrow();
  });

  test('rejects settlement for another run before exposing it to the worker', async () => {
    const transport = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockImplementation(async () => json({ settled: { ...run, runId: 'other-run' } }));
    await expect(new ChannelClient(config, transport).prepare(fence)).rejects.toThrow();
  });

  test.each([
    { settled: { ...run, channelId: 'other-channel' } },
    { settled: null },
    { settled: run, apiKey: grant.apiKey },
    { ...grant, request: { ...grant.request, store: false } },
    { ...grant, request: undefined },
  ])('fails closed on ambiguous or malformed successful preparation %#', async (value) => {
    const transport = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockImplementation(async () => json(value));
    await expect(new ChannelClient(config, transport).prepare(fence)).rejects.toThrow();
    expect(transport).toHaveBeenCalledTimes(1);
  });

  test('reads a valid maximal-part plan above the old service cap through claim and mutation', async () => {
    const largeRun: ChannelRunView = {
      ...run,
      plan: {
        revision: 'revision-1',
        rendererVersion: 'test',
        parts: Array.from({ length: CHANNEL_DELIVERY_PARTS_HARD_MAX }, (_, i) => ({
          operationId: `part-${i}`,
          kind: 'message',
          required: true,
          text: '\u0000'.repeat(CHANNEL_DELIVERY_TEXT_MAX_CHARS),
          presentation: {
            format: 'slack-blocks-v1',
            payload: JSON.stringify({
              text: 'x'.repeat(CHANNEL_DELIVERY_PRESENTATION_MAX_BYTES - 1000),
            }),
          },
        })),
      },
    };
    expect(Buffer.byteLength(JSON.stringify(largeRun))).toBeGreaterThan(2 * 1024 * 1024);
    const transport = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockImplementationOnce(async () =>
        json({ run: largeRun, fence, leaseExpiresAt: Date.now() + 60_000 }),
      )
      .mockImplementationOnce(async () => json(largeRun));
    const client = new ChannelClient(config, transport);
    await expect(client.claim(fence.owner)).resolves.toMatchObject({ fence, run: largeRun });
    await expect(client.mutate(fence, 'advance')).resolves.toEqual(largeRun);
  });

  test('uses service credentials only for the authorized channel/tenant and prohibits redirects', async () => {
    const transport = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockResolvedValue(json(bundle));
    await expect(new ChannelClient(config, transport).channel()).resolves.toEqual({
      ...bundle,
      delivery: { maxDeliveryParts: 100 },
    });
    const [url, init] = transport.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:3080/api/channels/service/slack/tenant-1/channel-1');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer private-service-token');
    expect(new Headers(init?.headers).get('X-Tenant-Id')).toBe('tenant-1');
    expect(init?.redirect).toBe('error');
    expect(init?.method).toBe('GET');
  });

  test('omits tenant header for the single-tenant placeholder', async () => {
    const transport = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockResolvedValue(json({}));
    await new ChannelClient({ ...config, CHANNEL_TENANT_ID: '_' }, transport).request('/test');
    expect(new Headers(transport.mock.calls[0][1]?.headers).has('X-Tenant-Id')).toBe(false);
  });

  test.each([
    { channel: { ...bundle.channel, channelId: 'foreign' } },
    { channel: { ...bundle.channel, tenantId: 'foreign' } },
    { channel: { ...bundle.channel, status: 'disabled' } },
    { channel: { ...bundle.channel, revision: '' } },
    { channel: { ...bundle.channel, slack: { ...bundle.channel.slack, appId: '' } } },
    { credentials: { botToken: '' } },
    { agent: { id: 'foreign' } },
  ])('rejects changed/inactive channel binding %#', async (change) => {
    const transport = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockResolvedValue(json({ ...bundle, ...change }));
    await expect(new ChannelClient(config, transport).channel()).rejects.toThrow(
      'Invalid active channel binding',
    );
  });

  test('204 claim/yield is absence, not a JSON or operational failure', async () => {
    const transport = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockImplementation(async () => new Response(null, { status: 204 }));
    const client = new ChannelClient(config, transport);
    await expect(client.claim('worker-1')).resolves.toBeNull();
    await expect(client.yield(fence)).resolves.toBeNull();
    expect(transport.mock.calls.map(([url]) => url)).toEqual([
      'http://127.0.0.1:3080/api/channels/service/channel-1/runs/claim',
      'http://127.0.0.1:3080/api/channels/service/channel-1/runs/run-1/yield',
    ]);
  });

  test('fenced mutation sends its fence and rejects a foreign run', async () => {
    const transport = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockResolvedValueOnce(json(run))
      .mockResolvedValueOnce(json({ ...run, runId: 'foreign' }));
    const client = new ChannelClient(config, transport);
    await expect(client.mutate(fence, 'advance')).resolves.toEqual(run);
    expect(JSON.parse(String(transport.mock.calls[0][1]?.body))).toEqual({ fence });
    await expect(client.mutate(fence, 'advance')).rejects.toThrow('Channel run identity changed');
  });

  test.each([400, 401, 403, 409, 500])(
    'does not expose untrusted HTTP %s response data',
    async (status) => {
      const transport = jest
        .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
        .mockResolvedValue(
          json({ error: 'private-upstream-message', token: 'private-upstream-token' }, status),
        );
      try {
        await new ChannelClient(config, transport).claim('worker-1');
        throw new Error('unexpected success');
      } catch (error) {
        expect(error).toBeInstanceOf(ServiceError);
        expect(String(error)).toBe(`Error: Channel service returned HTTP ${status}`);
        expect(error).toHaveProperty('code', '');
      }
    },
  );

  test('allows only the explicit actor-link-required error code on 403', async () => {
    const transport = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockResolvedValue(json({ error: 'channel_link_required', secret: 'private-value' }, 403));
    await expect(new ChannelClient(config, transport).claim('worker-1')).rejects.toMatchObject({
      status: 403,
      code: 'channel_link_required',
    });
  });

  test('malformed and oversized bodies fail safely', async () => {
    const chunk = Buffer.alloc(64 * 1024, 'x');
    let remaining = CHANNEL_RUN_MAX_JSON_BYTES + 1;
    const oversized = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (remaining === 0) return controller.close();
        const size = Math.min(remaining, chunk.length);
        controller.enqueue(chunk.subarray(0, size));
        remaining -= size;
      },
    });
    const transport = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockResolvedValueOnce(new Response('private-malformed-value'))
      .mockResolvedValueOnce(new Response(oversized));
    const client = new ChannelClient(config, transport);
    await expect(client.claim('worker-1')).rejects.toThrow('Invalid channel service response');
    await expect(client.claim('worker-1')).rejects.toThrow('Remote response exceeds size limit');
  });
});

describe('bound Responses lifecycle', () => {
  test('reads valid persisted Response content beyond the previous service cap', async () => {
    const large = { ...response, output: '\u0000'.repeat(400_000) };
    expect(Buffer.byteLength(JSON.stringify(large))).toBeGreaterThan(2 * 1024 * 1024);
    const transport = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockImplementation(async () => json(large));
    await expect(new ChannelClient(config, transport).response(grant, 'create')).resolves.toEqual(
      large,
    );
  });
  test('uses only the run-bound key, stable creation idempotency and exact returned identity', async () => {
    const transport = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockImplementation(async () => json(response));
    const client = new ChannelClient(config, transport);
    await client.response(grant, 'create');
    await client.response({ ...grant, responseId: response.id }, 'read');
    await client.response({ ...grant, responseId: response.id }, 'cancel');
    const [create, read, cancel] = transport.mock.calls;
    expect(create[0]).toBe('http://127.0.0.1:3080/api/agents/v1/responses');
    expect(JSON.parse(String(create[1]?.body))).toEqual({ ...grant.request, stream: false });
    expect(new Headers(create[1]?.headers).get('Idempotency-Key')).toBe('channel:run-1');
    expect(read[0]).toBe(create[0] + '/resp_123');
    expect(read[1]?.method).toBe('GET');
    expect(new Headers(read[1]?.headers).has('Idempotency-Key')).toBe(false);
    expect(cancel[0]).toBe(create[0] + '/resp_123/cancel');
    expect(cancel[1]?.body).toBe('{}');
    for (const [, init] of transport.mock.calls) {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer sk-bound-private-test');
      expect(new Headers(init?.headers).get('X-Tenant-Id')).toBe('tenant-1');
    }
  });

  test.each([
    { apiKey: 'shared-api-key' },
    { requestKey: '' },
    { requestKey: 'unsafe\nkey' },
    { requestKey: 'x'.repeat(257) },
  ])('rejects invalid run credential before HTTP %#', async (change) => {
    const transport = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>();
    await expect(
      new ChannelClient(config, transport).response({ ...grant, ...change }, 'create'),
    ).rejects.toThrow('Invalid run-bound response credential');
    expect(transport).not.toHaveBeenCalled();
  });

  test.each([undefined, 'foreign', 'resp_../x', 'resp_x?secret', 'resp_x\n'])(
    'rejects read/cancel identity %s before HTTP',
    async (responseId) => {
      const transport = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>();
      const client = new ChannelClient(config, transport);
      await expect(client.response({ ...grant, responseId }, 'read')).rejects.toThrow(
        'Invalid Response identity',
      );
      await expect(client.response({ ...grant, responseId }, 'cancel')).rejects.toThrow(
        'Invalid Response identity',
      );
      expect(transport).not.toHaveBeenCalled();
    },
  );

  test.each([
    { id: 'resp_foreign' },
    { id: 'not-response' },
    { model: 'foreign' },
    { object: 'other' },
    { store: false },
    { background: false },
    { store: 'false' },
    { background: 'false' },
    { status: 'unexpected' },
  ])('rejects changed Responses identity/state %#', async (change) => {
    const transport = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockResolvedValue(json({ ...response, ...change }));
    await expect(
      new ChannelClient(config, transport).response({ ...grant, responseId: response.id }, 'read'),
    ).rejects.toThrow('Responses identity or state changed');
  });

  test('never silently retries an uncertain creation', async () => {
    const transport = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockRejectedValue(new Error('network'));
    await expect(new ChannelClient(config, transport).response(grant, 'create')).rejects.toThrow();
    expect(transport).toHaveBeenCalledTimes(1);
  });
});

describe('authorized artifact content', () => {
  const content = Buffer.from('fixture content');
  const artifact: ChannelArtifact = {
    artifactId: 'artifact-1',
    filename: 'résumé.csv',
    mediaType: 'text/csv',
    bytes: content.length,
    sha256: createHash('sha256').update(content).digest('hex'),
  };
  const headers = () => ({
    'Content-Type': 'application/octet-stream',
    'X-Artifact-Filename': encodeURIComponent(artifact.filename),
    'X-Artifact-SHA256': artifact.sha256,
    'X-Artifact-Media-Type': artifact.mediaType,
  });

  test('fetches only fenced server content and verifies exact metadata, length and hash', async () => {
    const transport = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockResolvedValue(new Response(content, { headers: headers() }));
    await expect(new ChannelClient(config, transport).artifact(fence, artifact)).resolves.toEqual(
      content,
    );
    const [url, init] = transport.mock.calls[0];
    expect(url).toBe(
      'http://127.0.0.1:3080/api/channels/service/channel-1/runs/run-1/artifacts/artifact-1',
    );
    expect(init?.body).toBe(JSON.stringify({ fence }));
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer private-service-token');
  });

  test.each([
    { artifactId: '' },
    { artifactId: 'x'.repeat(513) },
    { filename: '' },
    { filename: '../private' },
    { filename: 'unsafe\\file' },
    { filename: 'file\nname' },
    { filename: 'file\u200bname' },
    { filename: 'é'.repeat(361) },
    { bytes: -1 },
    { bytes: 0.5 },
    { bytes: 50 * 1024 * 1024 + 1 },
    { sha256: 'bad' },
    { sha256: 'A'.repeat(64) },
  ])('rejects invalid descriptors before HTTP %#', async (change) => {
    const transport = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>();
    await expect(
      new ChannelClient(config, transport).artifact(fence, { ...artifact, ...change }),
    ).rejects.toThrow('Invalid artifact descriptor');
    expect(transport).not.toHaveBeenCalled();
  });

  test.each(['X-Artifact-Filename', 'X-Artifact-SHA256', 'X-Artifact-Media-Type', 'Content-Type'])(
    'rejects mismatched %s',
    async (name) => {
      const transport = jest
        .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
        .mockResolvedValue(
          new Response(content, { headers: { ...headers(), [name]: 'private-mismatch' } }),
        );
      await expect(new ChannelClient(config, transport).artifact(fence, artifact)).rejects.toThrow(
        'Artifact metadata changed',
      );
    },
  );

  test.each([
    Buffer.from('short'),
    Buffer.from('x'.repeat(content.length)),
    Buffer.concat([content, Buffer.from('extra')]),
  ])('rejects changed content %#', async (body) => {
    const transport = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockResolvedValue(new Response(body, { headers: headers() }));
    await expect(new ChannelClient(config, transport).artifact(fence, artifact)).rejects.toThrow();
  });

  test('rejects malformed filename encoding and does not expose server errors', async () => {
    const transport = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockResolvedValueOnce(
        new Response(content, { headers: { ...headers(), 'X-Artifact-Filename': '%zz' } }),
      )
      .mockResolvedValueOnce(new Response('private-secret', { status: 403 }));
    const client = new ChannelClient(config, transport);
    await expect(client.artifact(fence, artifact)).rejects.toThrow('Artifact metadata changed');
    await expect(client.artifact(fence, artifact)).rejects.toThrow(
      'Channel service returned HTTP 403',
    );
  });

  test('bounded reader cancels the stream after exceeding its cap', async () => {
    const cancel = jest.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from('too large'));
      },
      cancel,
    });
    await expect(boundedBody(new Response(body), 2)).rejects.toThrow(
      'Remote response exceeds size limit',
    );
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});

test('renewal returns only the renewed fence and deadline, without inventing a run snapshot', async () => {
  const renewed = { fence, leaseExpiresAt: Date.now() + 60_000 };
  const transport = jest
    .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
    .mockResolvedValue(json(renewed));
  const value = await new ChannelClient(config, transport).renew(fence);
  expect(value).toEqual(renewed);
  expect(value).not.toHaveProperty('run');
});

test('preparation distinguishes canonical settlement from execution credentials', async () => {
  const settled = {
    ...run,
    state: 'delivering' as const,
    cancellationRequested: true,
    snapshot: { status: 'cancelled' as const, text: '', elapsedMs: 0 },
  };
  const transport = jest
    .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
    .mockResolvedValueOnce(json({ settled }))
    .mockResolvedValueOnce(json(grant));
  const client = new ChannelClient(config, transport);
  const first = await client.prepare(fence);
  if (!first.settled) throw new Error('Expected canonical unstarted cancellation');
  expect(first.settled).toEqual(settled);
  expect(first).not.toHaveProperty('apiKey');
  const next = await client.prepare(fence);
  if (next.settled) throw new Error('Expected credential-bearing preparation');
  expect(next.apiKey).toBe(grant.apiKey);
  expect(transport).toHaveBeenCalledTimes(2);
});

test('Stop and cancel retain the complete external-channel scope at the service boundary', async () => {
  const transport = jest
    .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
    .mockImplementation(async () => json({ cancellationRequested: true }));
  const client = new ChannelClient(config, transport);
  const actor = run.admission.actor;
  await client.stop(actor, 'C1:123.456', 1234, 'C1');
  await client.cancel(run.runId, actor, run.revision, 'C1');
  expect(transport.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
    { actor, externalThreadKey: 'C1:123.456', externalChannelId: 'C1', eventAt: 1234 },
    { actor, revision: run.revision, externalChannelId: 'C1' },
  ]);
});

test('exposes only the approved trace-unavailable code for a409; other diagnostics stay private', async () => {
  const transport = jest
    .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
    .mockResolvedValueOnce(json({ error: 'trace_unavailable', secret: 'private' }, 409))
    .mockResolvedValueOnce(json({ error: 'private-database-error', secret: 'private' }, 409));
  const client = new ChannelClient(config, transport);
  await expect(client.claim('worker')).rejects.toMatchObject({
    status: 409,
    code: 'trace_unavailable',
  });
  await expect(client.claim('worker')).rejects.toMatchObject({ status: 409, code: '' });
});
