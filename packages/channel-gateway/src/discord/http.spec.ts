import { once } from 'node:events';
import { createServer } from 'node:http';
import { generateKeyPairSync, createHash, sign } from 'node:crypto';
import type { DiscordApplicationSecurity, DiscordInboxSubmission } from 'librechat-data-provider';
import type { DiscordDmConsume, DiscordDmInboxSubmission } from 'librechat-data-provider';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { DiscordWebhookDependencies } from './http';
import type { DiscordObservation } from './observe';
import { createDiscordWebhook } from './http';

const keys = generateKeyPairSync('ed25519');
const publicKey = keys.publicKey
  .export({ type: 'spki', format: 'der' })
  .subarray(-32)
  .toString('hex');
const applicationId = '123456789012345678';
const guildId = '234567890123456789';
const event = {
  type: 2,
  id: '567890123456789012',
  application_id: applicationId,
  token: 'private-token',
  version: 1,
  guild_id: guildId,
  context: 0,
  authorizing_integration_owners: { '0': guildId },
  channel_id: '345678901234567890',
  member: { user: { id: '456789012345678901' } },
  data: {
    id: '678901234567890123',
    name: 'librechat',
    type: 1,
    options: [{ name: 'ask', type: 1, options: [{ name: 'prompt', type: 3, value: ' Hello ' }] }],
  },
};
let server: Server;
let base: string;
let now: number;
let received: DiscordInboxSubmission[];
let lookups: number;
let security: DiscordWebhookDependencies['security'];
let submit: DiscordWebhookDependencies['submit'];
let deps: DiscordWebhookDependencies;
const app: DiscordApplicationSecurity = {
  tenantId: 'tenant',
  applicationId,
  applicationRevision: 'revision',
  publicKey,
  botUserId: '789012345678901234',
};
async function start(overrides: Partial<DiscordWebhookDependencies> = {}) {
  const webhook = createDiscordWebhook({ ...deps, ...overrides });
  server = createServer((req, res) => {
    void webhook.http(req, res);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function send(
  payload: object | string = event,
  changes: {
    path?: string;
    signature?: string;
    timestamp?: string;
    contentType?: string;
    body?: string;
  } = {},
) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const timestamp = changes.timestamp ?? String(Math.floor(now / 1000));
  const signature =
    changes.signature ??
    sign(
      null,
      Buffer.concat([Buffer.from(timestamp), Buffer.from(text)]),
      keys.privateKey,
    ).toString('hex');
  return fetch(base + (changes.path ?? `/discord/${applicationId}/interactions`), {
    method: 'POST',
    headers: {
      'content-type': changes.contentType ?? 'application/json',
      'x-signature-timestamp': timestamp,
      'x-signature-ed25519': signature,
    },
    body: changes.body ?? text,
  });
}
beforeEach(() => {
  now = Date.now();
  received = [];
  lookups = 0;
  security = async () => app;
  submit = async (input) => {
    received.push(input);
    return 'accepted';
  };
  deps = {
    policy: { maxBodyBytes: 4096, signatureToleranceSeconds: 300, interactionTimeoutMs: 2000 },
    capacity: 2,
    ready: () => true,
    security: async (id, signal) => {
      lookups++;
      return security(id, signal);
    },
    submit: (input, signal) => submit(input, signal),
    now: () => now,
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
  };
});
afterEach(async () => {
  if (!server) return;
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});
const dmCode = 'a'.repeat(43);
const dmEvent = () => ({
  ...event,
  guild_id: undefined,
  member: undefined,
  context: 1,
  user: { id: event.member.user.id },
  authorizing_integration_owners: { '0': '0' },
  channel: { id: event.channel_id, type: 1 },
  data: {
    ...event.data,
    options: [{ name: 'select', type: 1, options: [{ name: 'code', type: 3, value: dmCode }] }],
  },
});
it('hashes only a verified BOT_DM selection and acknowledges durable metadata without using the inbox', async () => {
  const selected: DiscordDmConsume[] = [];
  await start({
    select: async (input) => {
      selected.push(input);
      return 'accepted';
    },
  });
  expect((await send(dmEvent(), { signature: '0'.repeat(128) })).status).toBe(401);
  expect(selected).toEqual([]);
  const response = await send(dmEvent());
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    type: 4,
    data: { flags: 64, allowed_mentions: { parse: [] } },
  });
  expect(selected).toEqual([
    {
      applicationId,
      applicationRevision: 'revision',
      externalUserId: event.member.user.id,
      dmChannelId: event.channel_id,
      confirmationEventId: event.id,
      codeHash: createHash('sha256').update(dmCode).digest('hex'),
    },
  ]);
  expect(JSON.stringify(selected)).not.toContain(dmCode);
  expect(received).toEqual([]);
});
it.each([
  { context: 2 },
  { guild_id: guildId },
  { member: event.member },
  { user: { id: event.member.user.id, bot: true } },
  { authorizing_integration_owners: { '0': guildId } },
  { authorizing_integration_owners: { '0': '0', '1': event.member.user.id } },
  { channel: { id: event.channel_id, type: 3 } },
  { channel: { id: '999', type: 1 } },
  { user: { id: '0' } },
])('rejects unsupported or mixed DM context %j before metadata writes', async (change) => {
  const select = jest.fn(async () => 'accepted' as const);
  await start({ select });
  expect((await send({ ...dmEvent(), ...change })).status).toBe(400);
  expect(select).not.toHaveBeenCalled();
  expect(received).toEqual([]);
});
it('accepts Discord omission of the optional partial channel object without inferring a guild', async () => {
  const select = jest.fn(async () => 'accepted' as const);
  await start({ select });
  expect((await send({ ...dmEvent(), channel: undefined })).status).toBe(200);
  expect(select).toHaveBeenCalledWith(
    expect.objectContaining({
      dmChannelId: event.channel_id,
      externalUserId: event.member.user.id,
    }),
    expect.any(AbortSignal),
  );
  expect(received).toEqual([]);
});
it.each(['ask', 'link', 'status', 'cancel'])(
  'keeps DM %s execution disabled after public manifest expansion',
  async (name) => {
    const select = jest.fn(async () => 'accepted' as const);
    await start({ select });
    expect(
      (await send({ ...dmEvent(), data: { ...event.data, options: [{ name, type: 1 }] } })).status,
    ).toBe(400);
    expect(select).not.toHaveBeenCalled();
    expect(received).toEqual([]);
  },
);
it('does not acknowledge an operational selection failure and gives safe expired-code feedback', async () => {
  let unavailable = true;
  await start({
    select: async () => {
      if (unavailable) throw new Error('private database/code data');
      return 'conflict';
    },
  });
  expect((await send(dmEvent())).status).toBe(503);
  unavailable = false;
  const response = await send(dmEvent());
  expect(await response.json()).toMatchObject({
    type: 4,
    data: { content: 'That selection code is unavailable. Generate a new code in LibreChat.' },
  });
});

it('verifies raw signatures before PING acknowledgement or command admission', async () => {
  await start();
  expect((await send({ type: 1 }, { signature: '0'.repeat(128) })).status).toBe(401);
  expect(await (await send({ type: 1 })).json()).toEqual({ type: 1 });
  expect(await (await send()).json()).toEqual({ type: 5, data: { flags: 64 } });
  expect(received).toEqual([
    {
      applicationId,
      expectedApplicationRevision: 'revision',
      guildId,
      externalChannelId: event.channel_id,
      externalUserId: event.member.user.id,
      eventId: event.id,
      token: event.token,
      action: { kind: 'ask', prompt: 'Hello' },
    },
  ]);
});

it('rejects byte changes, old signatures, wrong application keys and invalid JSON', async () => {
  await start();
  expect((await send(event, { body: JSON.stringify(event) + ' ' })).status).toBe(401);
  expect((await send(event, { timestamp: String(Math.floor(now / 1000) - 301) })).status).toBe(401);
  security = async () => ({ ...app, publicKey: 'a'.repeat(64) });
  expect((await send()).status).toBe(401);
  security = async () => app;
  expect((await send('{invalid')).status).toBe(400);
  expect((await send(event, { contentType: 'text/plain' })).status).toBe(400);
  expect(received).toHaveLength(0);
});

it.each([
  { application_id: '987654321098765432' },
  { context: 1 },
  { context: undefined },
  { guild_id: undefined },
  { authorizing_integration_owners: { '0': '987654321098765432' } },
  { member: { user: { id: '456789012345678901', bot: true } } },
  { user: { id: '456789012345678901' } },
])('rejects unsupported actor or installation context %p', async (patch) => {
  await start();
  expect((await send({ ...event, ...patch })).status).toBe(400);
  expect(received).toHaveLength(0);
});

it.each(['link', 'status', 'cancel'])('accepts the namespaced %s command', async (name) => {
  await start();
  expect(
    (await send({ ...event, data: { ...event.data, options: [{ name, type: 1 }] } })).status,
  ).toBe(200);
  expect(received[0].action).toEqual({ kind: name });
});

it('rejects unknown command shapes and never accepts arbitrary component references', async () => {
  await start();
  for (const data of [
    { ...event.data, name: 'other' },
    { ...event.data, options: [] },
    { ...event.data, options: [{ name: 'unknown', type: 1 }] },
    { ...event.data, options: [{ name: 'status', type: 1, value: 'bad' }] },
    {
      ...event.data,
      options: [{ name: 'link', type: 1, options: [{ name: 'extra', type: 3, value: 'x' }] }],
    },
    {
      ...event.data,
      options: [{ name: 'ask', type: 1, options: [{ name: 'prompt', type: 3, value: ' ' }] }],
    },
  ])
    expect((await send({ ...event, data })).status).toBe(400);
  expect(
    (await send({ ...event, type: 3, data: { custom_id: 'arbitrary', component_type: 2 } })).status,
  ).toBe(400);
  expect(received).toHaveLength(0);
});

it('acknowledges only after durable submission, including duplicate requests', async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  submit = async (input) => {
    received.push(input);
    started();
    await held;
    return 'accepted';
  };
  await start();
  let responded = false;
  const pending = send().then((response) => {
    responded = true;
    return response;
  });
  await entered;
  expect(responded).toBe(false);
  release();
  expect((await pending).status).toBe(200);
  expect((await send()).status).toBe(200);
  expect(received[0]).toEqual(received[1]);
});

it.each(['conflict', 'capacity'] as const)(
  'does not acknowledge a %s rejection',
  async (result) => {
    submit = async () => result;
    await start();
    const response = await send();
    expect(response.status).toBe(result === 'capacity' ? 429 : 409);
    expect(await response.json()).toEqual({ error: 'interaction_not_accepted' });
  },
);

it('enforces the acknowledgement deadline even when the control plane ignores abort', async () => {
  let release!: () => void;
  security = () =>
    new Promise((resolve) => {
      release = () => resolve(app);
    });
  await start({ capacity: 1, policy: { ...deps.policy, interactionTimeoutMs: 100 } });
  const response = await send();
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: 'delivery_not_accepted' });
  // The unresolved request retains its capacity slot, bounding abandoned upstream work.
  const second = await send();
  expect(second.status).toBe(503);
  expect(await second.json()).toEqual({ error: 'capacity_exhausted' });
  release();
  expect(received).toHaveLength(0);
});

it('rejects oversized bodies before any control-plane lookup', async () => {
  await start();
  const response = await send({ value: 'x'.repeat(5000) });
  expect(response.status).toBe(413);
  expect(lookups).toBe(0);
});

it('uses a fresh verification key on every request and exposes bounded health endpoints', async () => {
  await start({ ready: () => false });
  expect((await fetch(base + '/livez')).status).toBe(200);
  expect((await fetch(base + '/readyz')).status).toBe(503);
  expect((await send({ type: 1 })).status).toBe(200);
  security = async () => null;
  expect((await send({ type: 1 })).status).toBe(401);
  expect(lookups).toBe(2);
  expect((await send(event, { path: '/discord/invalid/interactions' })).status).toBe(404);
});

it('normalizes versioned controls while preserving the source message for run actions', async () => {
  await start();
  const runId = '12345678-1234-4123-8123-123456789012';
  const messageId = '890123456789012345';
  const click = {
    ...event,
    type: 3,
    message: { id: messageId },
    data: { custom_id: `lc1:x:${runId}`, component_type: 2 },
  };
  expect((await send(click)).status).toBe(200);
  expect(received[0].action).toEqual({ kind: 'cancel', reference: runId, messageId });
  expect((await send({ ...click, message: undefined })).status).toBe(400);
  expect((await send({ ...click, data: { ...click.data, component_type: 3 } })).status).toBe(400);
  expect(
    (
      await send({
        ...click,
        data: { custom_id: `lc1:c:${'a'.repeat(43)}${'b'.repeat(43)}`, component_type: 2 },
      })
    ).status,
  ).toBe(200);
  expect(received[1].action).toEqual({
    kind: 'confirm',
    reference: 'a'.repeat(43) + 'b'.repeat(43),
  });
});

it.each(['ask', 'status', 'cancel'] as const)(
  'accepts a signed private %s only through the staged DM capability',
  async (kind) => {
    const submitDm = jest.fn(async () => 'accepted' as const);
    await start({ submitDm });
    const payload = {
      ...dmEvent(),
      data: {
        ...event.data,
        options: [
          {
            name: kind,
            type: 1,
            ...(kind === 'ask'
              ? { options: [{ name: 'prompt', type: 3, value: ' private ' }] }
              : {}),
          },
        ],
      },
    };
    expect((await send(payload)).status).toBe(200);
    expect(submitDm).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: 'dm',
        externalChannelId: event.channel_id,
        externalUserId: event.member.user.id,
        action: kind === 'ask' ? { kind, prompt: 'private' } : { kind },
      }),
      expect.any(AbortSignal),
    );
    expect(submitDm).not.toHaveBeenCalledWith(
      expect.objectContaining({ guildId: expect.anything() }),
      expect.anything(),
    );
    expect(received).toEqual([]);
  },
);
it('keeps private asks unavailable without staged composition and rejects DM link controls', async () => {
  await start();
  expect((await send({ ...dmEvent(), data: event.data })).status).toBe(400);
  expect(
    (await send({ ...dmEvent(), data: { ...event.data, options: [{ name: 'link', type: 1 }] } }))
      .status,
  ).toBe(400);
});

describe('Discord ingress observation', () => {
  let observed: DiscordObservation[];
  const outcomes = () =>
    observed.flatMap((item) => (item.type === 'ingress' ? [item.outcome] : []));
  const acks = () => observed.flatMap((item) => (item.type === 'ack' ? [item.durationMs] : []));
  const watch = (overrides: Partial<DiscordWebhookDependencies> = {}) =>
    start({ observe: (observation) => observed.push(observation), ...overrides });
  beforeEach(() => {
    observed = [];
  });

  it('names the outcome of every guild branch and times each matched response once', async () => {
    await watch();
    const guild = (changes: object) => ({ ...event, ...changes });
    const requests: [string, () => Promise<Response>, number][] = [
      ['accepted', () => send(), 200],
      ['ping', () => send({ type: 1 }), 200],
      ['bad_signature', () => send(event, { signature: '0'.repeat(128) }), 401],
      ['bad_payload', () => send('not json'), 400],
      ['bad_payload', () => send(event, { contentType: 'text/plain' }), 400],
      ['bad_context', () => send({ type: 1, application_id: '999999999999999999' }), 400],
      ['bad_context', () => send(guild({ member: undefined })), 400],
      ['unsupported', () => send(guild({ data: { ...event.data, name: 'other' } })), 400],
    ];
    for (const [, request, status] of requests) expect((await request()).status).toBe(status);
    submit = async () => 'conflict';
    expect((await send()).status).toBe(409);
    submit = async () => 'capacity';
    expect((await send()).status).toBe(429);
    expect(outcomes()).toEqual([...requests.map(([outcome]) => outcome), 'conflict', 'capacity']);
    expect(acks()).toHaveLength(outcomes().length);
    for (const duration of acks()) {
      expect(Number.isFinite(duration)).toBe(true);
      expect(duration).toBeGreaterThanOrEqual(0);
      expect(duration).toBeLessThan(2000);
    }
  });

  it('counts a route miss without an acknowledgement time', async () => {
    await watch();
    expect((await send(event, { path: '/discord/invalid/interactions' })).status).toBe(404);
    expect((await fetch(`${base}/discord/${applicationId}/interactions`)).status).toBe(404);
    expect(outcomes()).toEqual(['not_found', 'not_found']);
    expect(acks()).toEqual([]);
    expect((await fetch(`${base}/livez`)).status).toBe(200);
    expect((await fetch(`${base}/readyz`)).status).toBe(200);
    expect(outcomes()).toHaveLength(2);
  });

  it('separates every private selection and private ask result', async () => {
    let result: 'accepted' | 'conflict' | 'capacity' = 'accepted';
    await watch({ select: async () => result, submitDm: async () => result });
    const ask = { ...dmEvent(), data: event.data };
    const statuses = { accepted: 200, conflict: 409, capacity: 429 };
    for (result of ['accepted', 'conflict', 'capacity'] as const) {
      expect((await send(dmEvent())).status).toBe(200);
      expect((await send(ask)).status).toBe(statuses[result]);
    }
    expect((await send({ ...dmEvent(), guild_id: guildId })).status).toBe(400);
    expect((await send({ ...dmEvent(), data: { ...event.data, options: [] } })).status).toBe(400);
    expect(outcomes()).toEqual([
      'accepted',
      'accepted',
      'conflict',
      'conflict',
      'capacity',
      'capacity',
      'bad_context',
      'unsupported',
    ]);
  });

  it('reports the transport outcomes once, including a response sent after the deadline', async () => {
    let release!: () => void;
    let failed!: () => void;
    const finished = new Promise<void>((resolve) => {
      failed = resolve;
    });
    security = () =>
      new Promise((resolve) => {
        release = () => resolve(app);
      });
    await watch({
      capacity: 1,
      policy: { ...deps.policy, interactionTimeoutMs: 100 },
      log: { ...deps.log, warn: () => failed() },
    });
    expect((await send()).status).toBe(503);
    expect((await send()).status).toBe(503);
    expect(outcomes()).toEqual(['deadline', 'at_capacity']);
    expect(acks()[0]).toBeGreaterThanOrEqual(80);
    expect(acks()[1]).toBeLessThan(80);
    release();
    await finished;
    expect(outcomes()).toEqual(['deadline', 'at_capacity']);
    expect(acks()).toHaveLength(2);
  });

  it('names oversize and unavailable control planes', async () => {
    await watch();
    expect((await send({ value: 'x'.repeat(5000) })).status).toBe(413);
    security = async () => {
      throw new Error('private upstream failure');
    };
    expect((await send()).status).toBe(503);
    expect(outcomes()).toEqual(['too_large', 'unavailable']);
    expect(acks()).toHaveLength(2);
  });

  it('never lets a throwing observer change a response or the capacity it holds', async () => {
    await watch({
      capacity: 1,
      observe: () => {
        throw new Error('sink unavailable');
      },
    });
    for (let index = 0; index < 3; index++) {
      const response = await send();
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ type: 5, data: { flags: 64 } });
    }
    expect((await send({ type: 1 }, { signature: '0'.repeat(128) })).status).toBe(401);
    expect(received).toHaveLength(3);
  });

  it('carries no identifier, token or payload text', async () => {
    await watch();
    await send();
    await send(event, { signature: '0'.repeat(128) });
    await send(event, { path: '/discord/invalid/interactions' });
    const text = JSON.stringify(observed);
    for (const secret of [
      event.token,
      applicationId,
      guildId,
      event.id,
      event.channel_id,
      event.member.user.id,
      'Hello',
    ])
      expect(text).not.toContain(secret);
    for (const item of observed) {
      expect(Object.keys(item).sort()).toEqual(
        item.type === 'ack' ? ['durationMs', 'type'] : ['outcome', 'type'],
      );
    }
  });
});

it.each(['guild', 'dm'] as const)(
  'acknowledges native review and decisions privately in %s and persists only bounded control identifiers',
  async (source) => {
    const submitDm = jest.fn(async (input: DiscordDmInboxSubmission) => {
      expect(input.scope).toBe('dm');
      return 'accepted' as const;
    });
    await start({ submitDm });
    const runId = '12345678-1234-4123-8123-123456789012';
    const messageId = '890123456789012345';
    const payload = {
      ...(source === 'dm' ? dmEvent() : event),
      type: 3,
      message: { id: messageId, flags: 64 },
      data: { custom_id: `lc1:r:${runId}`, component_type: 2 },
    };
    const entry = await send(payload);
    expect(entry.status).toBe(200);
    expect(await entry.json()).toEqual({ type: 5, data: { flags: 64 } });
    const decision = await send({
      ...payload,
      data: { custom_id: `lc1:v:${event.id}:1`, component_type: 2 },
    });
    expect(decision.status).toBe(200);
    expect(await decision.json()).toEqual({ type: 6 });
    const publicDecision = await send({
      ...payload,
      message: { id: messageId, flags: 0 },
      data: { custom_id: `lc1:v:${event.id}:1`, component_type: 2 },
    });
    expect(await publicDecision.json()).toEqual({ type: 5, data: { flags: 64 } });
    const actions = source === 'dm' ? submitDm.mock.calls.map((call) => call[0]) : received;
    expect(actions).toEqual([
      expect.objectContaining({ action: { kind: 'review', reference: runId, messageId } }),
      expect.objectContaining({ action: { kind: 'decide', reference: event.id, choice: 1 } }),
      expect.objectContaining({ action: { kind: 'decide', reference: event.id, choice: 1 } }),
    ]);
  },
);
