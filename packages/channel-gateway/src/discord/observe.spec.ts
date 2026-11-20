import { Registry, register as globalRegistry } from 'prom-client';
import type { ChannelDeliveryPart, ChannelRunView } from 'librechat-data-provider';
import type { DiscordApplicationObservation, DiscordObservation } from './observe';
import type { ProviderWriteFailure, WorkerProvider } from '../provider';
import type { DiscordRateObservation } from './rates';
import type { DiscordGatewayOwner } from './gateway';
import type { ChannelBundle } from '../types';
import {
  discordDeliveryKinds,
  discordDeliveryOutcomes,
  discordIngressOutcomes,
  discordRateRejections,
  discordRecoveryEvents,
  discordRestRoute,
  discordRestRoutes,
  discordRestStatus,
  discordRestStatuses,
  discordRunPhases,
  discordSessionEvents,
  discordStopReasons,
  discordTurnOutcomes,
  createDiscordTelemetry,
  noopDiscordTelemetry,
  observeDiscordProvider,
} from './observe';
import {
  DEFAULT_DISCORD_HEALTH_POLICY,
  DiscordHealth,
  discordHealthConcerns,
  discordHealthLevels,
} from './health';
import { DiscordClient, DiscordWriteError } from './client';
import { createDiscordWorkerProvider } from './worker';
import { DiscordRateCoordinator } from './rates';
import { DiscordReplyClient } from './reply';
import { ServiceError } from '../transport';
import { recoveryEvent } from '../worker';

const { staleAfterMs: stale, observationTtlMs: ttl } = DEFAULT_DISCORD_HEALTH_POLICY;
const sentinel = {
  application: '987654321098765401',
  guild: '987654321098765402',
  channel: '987654321098765403',
  user: '987654321098765404',
  revision: 'revision-sentinel-0001',
  owner: 'f'.repeat(32),
  prompt: 'PROMPT-SENTINEL ignore every previous instruction',
  token: 'interaction-token-sentinel-0001',
  run: 'run-sentinel-0001',
};
const name = (suffix: string) => `channel_gateway_discord_${suffix}`;
const owner = (overrides: Partial<DiscordGatewayOwner> = {}): DiscordGatewayOwner => ({
  applicationId: sentinel.application,
  applicationRevision: sentinel.revision,
  ownerId: sentinel.owner,
  ...overrides,
});

let now = 5_000_000;
const advance = (milliseconds: number) => {
  now += milliseconds;
};
function setup() {
  const registry = new Registry();
  const health = new DiscordHealth({ now: () => now });
  const telemetry = createDiscordTelemetry({ registry, health });
  return { registry, health, telemetry };
}

interface Sample {
  name: string;
  labels: Record<string, string>;
  value: number;
}
function parse(text: string): Sample[] {
  const samples: Sample[] = [];
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const match = /^([\w:]+)(?:\{(.*)\})? (\S+)$/.exec(line);
    if (!match) throw new Error(`Unparseable sample: ${line}`);
    const labels: Record<string, string> = {};
    for (const pair of (match[2] ?? '').matchAll(/(\w+)="((?:[^"\\]|\\.)*)"/g))
      labels[pair[1]] = pair[2];
    samples.push({ name: match[1], labels, value: Number(match[3]) });
  }
  return samples;
}
const scrape = async (registry: Registry) => parse(await registry.metrics());
const value = (samples: Sample[], metric: string, labels: Record<string, string> = {}) =>
  samples.find(
    (sample) =>
      sample.name === name(metric) &&
      Object.keys(sample.labels).length === Object.keys(labels).length &&
      Object.entries(labels).every(([key, expected]) => sample.labels[key] === expected),
  )?.value ?? 0;
const only = (counts: Record<string, number>) =>
  Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([level]) => level)
    .join(',');

beforeEach(() => {
  now = 5_000_000;
});

describe('Discord telemetry catalog', () => {
  test('registers exactly the catalog on the caller registry and none on the global one', async () => {
    const { registry } = setup();
    const names = (await registry.getMetricsAsJSON()).map((metric) => metric.name).sort();
    expect(names).toEqual(
      [
        'ingress_total',
        'ack_seconds',
        'rest_total',
        'rest_queue_rejected_total',
        'delivery_total',
        'run_total',
        'turn_total',
        'recovery_total',
        'gateway_session_total',
        'gateway_stop_total',
        'heartbeat_seconds',
        'health',
        'applications_owned',
        'applications_quarantined',
      ]
        .map(name)
        .sort(),
    );
    expect(
      globalRegistry.getMetricsAsArray().filter((metric) => metric.name.startsWith(name(''))),
    ).toEqual([]);
  });

  test('registries are independent, and one registry cannot be wired twice', async () => {
    const first = setup();
    const second = setup();
    first.telemetry.observe({ type: 'ingress', outcome: 'accepted' });
    expect(value(await scrape(first.registry), 'ingress_total', { outcome: 'accepted' })).toBe(1);
    expect(value(await scrape(second.registry), 'ingress_total', { outcome: 'accepted' })).toBe(0);
    expect(() =>
      createDiscordTelemetry({ registry: first.registry, health: first.health }),
    ).toThrow();
  });

  test('the no-op telemetry accepts every observation and hands out a no-op scope', () => {
    noopDiscordTelemetry.observe({ type: 'ingress', outcome: 'accepted' });
    const scope = noopDiscordTelemetry.application(owner(), { shards: 1 });
    scope.observe({ type: 'stop', reason: 'shutdown' });
    expect(() => scope.release()).not.toThrow();
  });
});

describe('Discord closed labels', () => {
  const allowed: Record<string, Record<string, readonly string[]>> = {
    ingress_total: { outcome: [...discordIngressOutcomes, 'other'] },
    rest_total: { route: discordRestRoutes, status: discordRestStatuses },
    rest_queue_rejected_total: { reason: [...discordRateRejections, 'other'] },
    delivery_total: {
      kind: [...discordDeliveryKinds, 'other'],
      outcome: [...discordDeliveryOutcomes, 'other'],
    },
    run_total: { phase: [...discordRunPhases, 'other'] },
    turn_total: { outcome: [...discordTurnOutcomes, 'other'] },
    recovery_total: { event: discordRecoveryEvents },
    gateway_session_total: { event: [...discordSessionEvents, 'other'] },
    gateway_stop_total: { reason: [...discordStopReasons, 'other'] },
    health: { concern: discordHealthConcerns, level: discordHealthLevels },
  };
  const hostile = `${sentinel.guild}/${sentinel.prompt}`;

  test('maps a runtime value outside every vocabulary to other', async () => {
    const { registry, telemetry } = setup();
    const scope = telemetry.application(owner(), { shards: 1 });
    const unknown = hostile as never;
    telemetry.observe({ type: 'ingress', outcome: unknown });
    telemetry.observe({ type: 'turn', outcome: unknown });
    telemetry.observe({ type: 'recovery', event: hostile });
    telemetry.observe({ type: 'delivery', kind: unknown, outcome: unknown });
    telemetry.observe({ type: 'run', phase: unknown });
    scope.observe({ type: 'rest', route: hostile, status: 200 });
    scope.observe({ type: 'rest', route: 'POST /channels/:id/messages', status: 299.5 });
    scope.observe({ type: 'rejected', reason: unknown });
    scope.observe({ type: 'session', event: unknown, shardId: 0 });
    scope.observe({ type: 'stop', reason: unknown });
    const samples = await scrape(registry);
    expect(value(samples, 'ingress_total', { outcome: 'other' })).toBe(1);
    expect(value(samples, 'turn_total', { outcome: 'other' })).toBe(1);
    expect(value(samples, 'recovery_total', { event: 'other' })).toBe(1);
    expect(value(samples, 'delivery_total', { kind: 'other', outcome: 'other' })).toBe(1);
    expect(value(samples, 'run_total', { phase: 'other' })).toBe(1);
    expect(value(samples, 'rest_total', { route: 'other', status: '2xx' })).toBe(1);
    expect(value(samples, 'rest_total', { route: 'message_create', status: 'other' })).toBe(1);
    expect(value(samples, 'rest_queue_rejected_total', { reason: 'other' })).toBe(1);
    expect(value(samples, 'gateway_session_total', { event: 'other' })).toBe(1);
    expect(value(samples, 'gateway_stop_total', { reason: 'other' })).toBe(1);
  });

  test('every exposed label value is in its closed vocabulary and the series budget holds', async () => {
    const { registry, telemetry } = setup();
    const scope = telemetry.application(owner(), { shards: 1 });
    for (const outcome of discordIngressOutcomes) telemetry.observe({ type: 'ingress', outcome });
    for (const outcome of discordTurnOutcomes) telemetry.observe({ type: 'turn', outcome });
    for (const event of discordRecoveryEvents) telemetry.observe({ type: 'recovery', event });
    for (const kind of discordDeliveryKinds)
      for (const outcome of discordDeliveryOutcomes)
        telemetry.observe({ type: 'delivery', kind, outcome });
    for (const phase of discordRunPhases) telemetry.observe({ type: 'run', phase });
    for (const route of discordRestRoutes)
      for (const status of [200, 401, 403, 404, 429, 418, 503, undefined, 302])
        scope.observe({ type: 'rest', route: templateFor(route), status });
    for (const reason of discordRateRejections) scope.observe({ type: 'rejected', reason });
    for (const event of discordSessionEvents)
      scope.observe(
        event === 'error' ? { type: 'session', event } : { type: 'session', event, shardId: 0 },
      );
    for (const reason of discordStopReasons) scope.observe({ type: 'stop', reason });
    scope.observe({ type: 'heartbeat', shardId: 0, latencyMs: 120 });
    telemetry.observe({ type: 'ack', durationMs: 40 });
    // Unknown values add only the `other` series each vocabulary already accounts for.
    telemetry.observe({ type: 'ingress', outcome: hostile as never });
    telemetry.observe({ type: 'delivery', kind: hostile as never, outcome: hostile as never });
    scope.observe({ type: 'stop', reason: hostile as never });
    const samples = await scrape(registry);
    for (const sample of samples) {
      const bare = sample.name.slice(name('').length).replace(/_(?:bucket|sum|count)$/, '');
      const rules = allowed[bare];
      if (!rules) continue;
      for (const [label, labelValue] of Object.entries(sample.labels))
        if (label !== 'le') expect(rules[label]).toContain(labelValue);
    }
    expect(samples.length).toBeLessThanOrEqual(250);
  });

  test('no identifier, token, prompt or raw route reaches an exposition or a health snapshot', async () => {
    const { registry, health, telemetry } = setup();
    const scope = telemetry.application(owner(), { shards: 2 });
    const leaks = [...Object.values(sentinel), hostile];
    telemetry.observe({ type: 'recovery', event: sentinel.prompt });
    telemetry.observe({ type: 'ingress', outcome: sentinel.guild as never });
    telemetry.observe({
      type: 'delivery',
      kind: sentinel.channel as never,
      outcome: sentinel.run as never,
    });
    scope.observe({
      type: 'rest',
      route: `PATCH /webhooks/${sentinel.application}/${sentinel.token}/messages/@original`,
      status: 401,
    });
    scope.observe({
      type: 'rest',
      route: `POST /channels/${sentinel.channel}/messages`,
      status: 403,
    });
    scope.observe({ type: 'session', event: 'ready', shardId: 0 });
    scope.observe({ type: 'stop', reason: sentinel.user as never });
    const exposition = await registry.metrics();
    const snapshot = JSON.stringify(health.snapshot());
    for (const leak of leaks) {
      expect(exposition).not.toContain(leak);
      expect(snapshot).not.toContain(leak);
    }
  });
});

/** The exact template each caller builds, taken from `DiscordClient`, `DiscordReplyClient` and the SDK REST. */
function templateFor(route: (typeof discordRestRoutes)[number]): string {
  return {
    message_create: 'POST /channels/:id/messages',
    message_edit: 'PATCH /channels/:id/messages/:id',
    message_delete: 'DELETE /channels/:id/messages/:id',
    channel_read: 'GET /channels/:id',
    permissions_read: 'GET /channels/:id/permissions/member/:id',
    thread_read: 'GET /channels/:id/thread-members/:id',
    member_read: 'GET /guilds/:id/members/:id',
    guild_read: 'GET /guilds/:id',
    gateway_bot: 'GET /gateway/bot',
    interaction_reply: 'PATCH /webhooks/:id/:token/messages/@original',
    other: 'GET /unknown',
  }[route];
}

describe('Discord REST interpretation', () => {
  test.each([
    [undefined, 'network'],
    [200, '2xx'],
    [204, '2xx'],
    [299, '2xx'],
    [100, 'other'],
    [302, 'other'],
    [400, '4xx'],
    [401, '401'],
    [403, '403'],
    [404, '404'],
    [418, '4xx'],
    [429, '429'],
    [500, '5xx'],
    [503, '5xx'],
    [599, '5xx'],
    [600, 'other'],
    [200.5, 'other'],
    [Number.NaN, 'other'],
  ])('classifies status %p as %s', (status, expected) => {
    expect(discordRestStatus(status)).toBe(expected);
  });

  test('maps every template a real caller builds, and nothing else, to a route group', async () => {
    const routes: string[] = [];
    const rates = new DiscordRateCoordinator(undefined, (observation) => {
      if (observation.type === 'rest') routes.push(observation.route);
    });
    const channel = '123456789012345678';
    const guild = '223456789012345678';
    const user = '323456789012345678';
    const thread = '423456789012345678';
    const parent = '523456789012345678';
    const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname.replace(/^\/api\/v10/, '');
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      let body: object = {};
      const target = /^\/channels\/(\d+)\/(?:permissions\/member|thread-members)\/(\d+)$/.exec(
        path,
      );
      if (path.includes('/thread-members/') && target) body = { id: target[1], user_id: target[2] };
      else if (path.includes('/permissions/member/')) body = { permissions: '3072' };
      else if (path === `/channels/${thread}`)
        body = {
          id: thread,
          guild_id: guild,
          parent_id: parent,
          type: 12,
          thread_metadata: { archived: false, locked: false },
        };
      else if (/^\/guilds\/\d+\/members\/\d+$/.test(path)) body = { user: { id: user } };
      else if (/^\/guilds\/\d+$/.test(path)) body = { id: guild };
      else if (path.endsWith('/messages') || /\/messages\/\d+$/.test(path))
        body = { id: '623456789012345678', channel_id: channel };
      return Response.json(body);
    }) as typeof fetch;
    const client = new DiscordClient(
      { botToken: 'bot-token-sentinel', timeoutMs: 1000, maxResponseBytes: 65_536 },
      transport,
      rates,
    );
    const quiet = <T>(work: Promise<T>) => work.catch(() => undefined);
    await quiet(client.isGuildMember(guild));
    await quiet(client.getChannelMemberPermissions(channel, user));
    await quiet(
      client.inspectGuildTextActorSource({
        applicationId: sentinel.application,
        botUserId: '723456789012345678',
        guildId: guild,
        channelId: channel,
        authorId: user,
      }),
    );
    await quiet(
      client.inspectGuildThreadSource({
        applicationId: sentinel.application,
        botUserId: '723456789012345678',
        guildId: guild,
        threadChannelId: thread,
        authorId: user,
      }),
    );
    await quiet(client.createMessage(channel, { content: 'hello' }, 'operation-1'));
    await quiet(client.editMessage(channel, '623456789012345678', { content: 'hello' }));
    await quiet(client.deleteMessage(channel, '623456789012345678'));
    await quiet(
      new DiscordReplyClient({ timeoutMs: 1000, maxResponseBytes: 65_536 }, transport, rates).write(
        sentinel.application,
        sentinel.token,
        { content: 'reply' },
      ),
    );
    const groups = new Set(routes.map(discordRestRoute));
    for (const route of discordRestRoutes)
      if (route !== 'other' && route !== 'gateway_bot') expect(groups).toContain(route);
    expect(groups).not.toContain('other');
    expect(routes.join('\n')).not.toMatch(/\d{10,}/);
    expect(routes.join('\n')).not.toContain(sentinel.token);
    // The SDK REST wrapper in socket.ts acquires its permit with this literal template.
    expect(discordRestRoute('GET /gateway/bot')).toBe('gateway_bot');
  });

  const botRoutes = discordRestRoutes.filter(
    (route) => route !== 'other' && route !== 'interaction_reply',
  );
  const credentialsOf = (health: DiscordHealth) => only(health.snapshot().credentials);
  const permissionsOf = (health: DiscordHealth) => only(health.snapshot().permissions);

  test.each(botRoutes)('a 2xx on %s proves the bot token and a 401 rejects it', (route) => {
    const accepted = setup();
    accepted.telemetry
      .application(owner(), { shards: 0 })
      .observe({ type: 'rest', route: templateFor(route), status: 200 });
    expect(credentialsOf(accepted.health)).toBe('healthy');
    const rejected = setup();
    rejected.telemetry
      .application(owner(), { shards: 0 })
      .observe({ type: 'rest', route: templateFor(route), status: 401 });
    expect(credentialsOf(rejected.health)).toBe('failing');
  });

  test.each(['interaction_reply', 'other'] as const)(
    'a 401 or 2xx on %s says nothing about the bot token',
    (route) => {
      const { health, telemetry } = setup();
      const scope = telemetry.application(owner(), { shards: 0 });
      scope.observe({ type: 'rest', route: templateFor(route), status: 401 });
      scope.observe({ type: 'rest', route: templateFor(route), status: 200 });
      expect(credentialsOf(health)).toBe('unknown');
      expect(permissionsOf(health)).toBe('unknown');
    },
  );

  test.each([500, 502, 503, 429, undefined, 400, 403, 404])(
    'status %p on a bot route is neither a healthy nor a failing credential',
    (status) => {
      const { health, telemetry } = setup();
      const scope = telemetry.application(owner(), { shards: 0 });
      scope.observe({ type: 'rest', route: templateFor('channel_read'), status });
      expect(credentialsOf(health)).toBe('unknown');
    },
  );

  test('a 5xx or 429 neither heals a rejected token nor fails an accepted one', () => {
    const { health, telemetry } = setup();
    const scope = telemetry.application(owner(), { shards: 0 });
    scope.observe({ type: 'rest', route: templateFor('guild_read'), status: 200 });
    scope.observe({ type: 'rest', route: templateFor('guild_read'), status: 503 });
    scope.observe({ type: 'rest', route: templateFor('guild_read'), status: 429 });
    expect(credentialsOf(health)).toBe('healthy');
    scope.observe({ type: 'rest', route: templateFor('guild_read'), status: 401 });
    scope.observe({ type: 'rest', route: templateFor('guild_read'), status: 500 });
    expect(credentialsOf(health)).toBe('failing');
  });

  test('only a 403 on a bot message write is a bot permission denial', () => {
    const { health, telemetry } = setup();
    const scope = telemetry.application(owner(), { shards: 0 });
    for (const route of ['message_edit', 'message_create'] as const)
      scope.observe({ type: 'rest', route: templateFor(route), status: 404 });
    for (const route of ['member_read', 'permissions_read', 'thread_read', 'channel_read'] as const)
      scope.observe({ type: 'rest', route: templateFor(route), status: 403 });
    scope.observe({ type: 'rest', route: templateFor('message_delete'), status: 403 });
    scope.observe({ type: 'rest', route: templateFor('message_create'), status: 503 });
    expect(permissionsOf(health)).toBe('unknown');
    scope.observe({ type: 'rest', route: templateFor('message_create'), status: 200 });
    expect(permissionsOf(health)).toBe('healthy');
    scope.observe({ type: 'rest', route: templateFor('message_edit'), status: 403 });
    expect(permissionsOf(health)).toBe('degraded');
    scope.observe({ type: 'rest', route: templateFor('message_create'), status: 403 });
    scope.observe({ type: 'rest', route: templateFor('message_create'), status: 403 });
    expect(permissionsOf(health)).toBe('failing');
    scope.observe({ type: 'permission', outcome: 'ok' });
    expect(permissionsOf(health)).toBe('degraded');
    scope.observe({ type: 'permission', outcome: 'unexpected' as never });
    expect(permissionsOf(health)).toBe('degraded');
    for (let index = 0; index < 3; index++)
      scope.observe({ type: 'permission', outcome: 'denied' });
    expect(permissionsOf(health)).toBe('failing');
  });

  test('counts each request once by closed route group and status class', async () => {
    const { registry, telemetry } = setup();
    const scope = telemetry.application(owner(), { shards: 0 });
    scope.observe({ type: 'rest', route: templateFor('message_create'), status: 200 });
    scope.observe({ type: 'rest', route: templateFor('message_create'), status: 200 });
    scope.observe({ type: 'rest', route: templateFor('message_create'), status: undefined });
    scope.observe({ type: 'rejected', reason: 'queue_full' });
    scope.observe({ type: 'rejected', reason: 'capacity' });
    scope.observe({ type: 'rejected', reason: 'queue_timeout' });
    const samples = await scrape(registry);
    expect(value(samples, 'rest_total', { route: 'message_create', status: '2xx' })).toBe(2);
    expect(value(samples, 'rest_total', { route: 'message_create', status: 'network' })).toBe(1);
    for (const reason of discordRateRejections)
      expect(value(samples, 'rest_queue_rejected_total', { reason })).toBe(1);
  });

  test('real clients through the real coordinator update health from what Discord answered', async () => {
    const { health, telemetry } = setup();
    const scope = telemetry.application(owner(), { shards: 0 });
    const rates = new DiscordRateCoordinator(undefined, (observation: DiscordRateObservation) =>
      scope.observe(observation),
    );
    let status = 200;
    const transport = (async () =>
      Response.json(
        { id: '623456789012345678', channel_id: '123456789012345678' },
        { status },
      )) as typeof fetch;
    const client = new DiscordClient(
      { botToken: 'bot-token-sentinel', timeoutMs: 1000, maxResponseBytes: 65_536 },
      transport,
      rates,
    );
    const reply = new DiscordReplyClient(
      { timeoutMs: 1000, maxResponseBytes: 65_536 },
      transport,
      rates,
    );
    const send = () =>
      client
        .createMessage('123456789012345678', { content: 'hello' }, 'operation-1')
        .catch(() => undefined);
    const answer = () =>
      reply.write(sentinel.application, sentinel.token, { content: 'late' }).catch(() => undefined);
    status = 401;
    await answer();
    status = 200;
    await answer();
    expect(credentialsOf(health)).toBe('unknown');
    status = 401;
    await send();
    expect(credentialsOf(health)).toBe('failing');
    status = 200;
    await send();
    expect(credentialsOf(health)).toBe('healthy');
    status = 403;
    for (let index = 0; index < 3; index++) await send();
    expect(permissionsOf(health)).toBe('failing');
    expect(credentialsOf(health)).toBe('healthy');
  });
});

describe('Discord Gateway observations', () => {
  const nativeOf = (health: DiscordHealth) => only(health.snapshot().native);

  test('READY and RESUMED prove the credential and the shard, a transient close degrades', async () => {
    const { registry, health, telemetry } = setup();
    const scope = telemetry.application(owner(), { shards: 1 });
    expect(nativeOf(health)).toBe('unknown');
    scope.observe({ type: 'session', event: 'ready', shardId: 0 });
    expect(nativeOf(health)).toBe('healthy');
    expect(only(health.snapshot().credentials)).toBe('healthy');
    scope.observe({ type: 'session', event: 'closed_transient', shardId: 0 });
    expect(nativeOf(health)).toBe('degraded');
    scope.observe({ type: 'session', event: 'resumed', shardId: 0 });
    expect(nativeOf(health)).toBe('healthy');
    scope.observe({ type: 'session', event: 'gap', shardId: 0 });
    expect(nativeOf(health)).toBe('degraded');
    scope.observe({ type: 'session', event: 'error' });
    const samples = await scrape(registry);
    for (const event of ['ready', 'resumed', 'closed_transient', 'gap', 'error'])
      expect(value(samples, 'gateway_session_total', { event })).toBe(1);
  });

  test('an SDK error carries no shard and leaves health alone, a fatal close fails the shard', () => {
    const { health, telemetry } = setup();
    const scope = telemetry.application(owner(), { shards: 1 });
    scope.observe({ type: 'session', event: 'ready', shardId: 0 });
    scope.observe({ type: 'session', event: 'error' });
    expect(nativeOf(health)).toBe('healthy');
    scope.observe({ type: 'session', event: 'closed_fatal', shardId: 0 });
    expect(nativeOf(health)).toBe('failing');
  });

  test('a credential stop fails the credential and the Gateway, any other held stop only the Gateway', () => {
    const credential = setup();
    credential.telemetry
      .application(owner(), { shards: 1 })
      .observe({ type: 'stop', reason: 'credentials' });
    expect(only(credential.health.snapshot().credentials)).toBe('failing');
    expect(nativeOf(credential.health)).toBe('failing');
    for (const reason of ['configuration', 'identity', 'startup'] as const) {
      const other = setup();
      other.telemetry.application(owner(), { shards: 1 }).observe({ type: 'stop', reason });
      expect(only(other.health.snapshot().credentials)).toBe('unknown');
      expect(nativeOf(other.health)).toBe('failing');
    }
  });

  test.each(['shutdown', 'lost'] as const)(
    'a %s stop ends the owner, is counted and marks no failure',
    async (reason) => {
      const { registry, health, telemetry } = setup();
      const scope = telemetry.application(owner(), { shards: 1 });
      scope.observe({ type: 'session', event: 'ready', shardId: 0 });
      scope.observe({ type: 'stop', reason });
      expect(nativeOf(health)).toBe('healthy');
      expect(value(await scrape(registry), 'gateway_stop_total', { reason })).toBe(1);
    },
  );

  test.each(['checkpoint', 'failed', 'backpressure', 'dispatch'] as const)(
    'a %s stop leaves every shard down until the next session is READY, without a fatal failure',
    async (reason) => {
      const { registry, health, telemetry } = setup();
      const scope = telemetry.application(owner(), { shards: 2 });
      scope.observe({ type: 'session', event: 'ready', shardId: 0 });
      scope.observe({ type: 'session', event: 'ready', shardId: 1 });
      expect(nativeOf(health)).toBe('healthy');
      scope.observe({ type: 'stop', reason });
      expect(nativeOf(health)).toBe('degraded');
      expect(only(health.snapshot().credentials)).toBe('healthy');
      scope.observe({ type: 'session', event: 'ready', shardId: 0 });
      expect(nativeOf(health)).toBe('degraded');
      scope.observe({ type: 'session', event: 'ready', shardId: 1 });
      expect(nativeOf(health)).toBe('healthy');
      expect(value(await scrape(registry), 'gateway_stop_total', { reason })).toBe(1);
    },
  );

  test.each(['credentials', 'configuration', 'identity', 'startup'] as const)(
    'the next READY recovers the Gateway after a %s stop of an application that stays owned',
    (reason) => {
      const { health, telemetry } = setup();
      const scope = telemetry.application(owner(), { shards: 1 });
      scope.observe({ type: 'session', event: 'ready', shardId: 0 });
      scope.observe({ type: 'stop', reason });
      expect(nativeOf(health)).toBe('failing');
      expect(health.snapshot().applications).toBe(1);
      scope.observe({ type: 'heartbeat', shardId: 0, latencyMs: 20 });
      expect(nativeOf(health)).toBe('failing');
      scope.observe({ type: 'session', event: 'ready', shardId: 0 });
      expect(nativeOf(health)).toBe('healthy');
      expect(only(health.snapshot().credentials)).toBe('healthy');
    },
  );

  test('a startup stop is counted under its own reason and leaves the credential and permissions alone', async () => {
    const { registry, health, telemetry } = setup();
    const scope = telemetry.application(owner(), { shards: 1 });
    scope.observe({ type: 'stop', reason: 'startup' });
    const samples = await scrape(registry);
    expect(value(samples, 'gateway_stop_total', { reason: 'startup' })).toBe(1);
    expect(samples.some((sample) => sample.labels.reason === 'other')).toBe(false);
    expect(nativeOf(health)).toBe('failing');
    expect(only(health.snapshot().credentials)).toBe('unknown');
    expect(only(health.snapshot().permissions)).toBe('unknown');
  });

  test('heartbeats are observed in seconds and keep the shard live', async () => {
    const { registry, health, telemetry } = setup();
    const scope = telemetry.application(owner(), { shards: 1 });
    scope.observe({ type: 'session', event: 'ready', shardId: 0 });
    advance(stale);
    scope.observe({ type: 'heartbeat', shardId: 0, latencyMs: 100 });
    advance(stale);
    expect(nativeOf(health)).toBe('healthy');
    advance(1);
    expect(nativeOf(health)).toBe('degraded');
    scope.observe({ type: 'heartbeat', shardId: 0, latencyMs: Number.NaN });
    scope.observe({ type: 'heartbeat', shardId: 0, latencyMs: -5 });
    expect(nativeOf(health)).toBe('healthy');
    const samples = await scrape(registry);
    expect(value(samples, 'heartbeat_seconds_count')).toBe(1);
    expect(value(samples, 'heartbeat_seconds_sum')).toBeCloseTo(0.1);
    expect(value(samples, 'heartbeat_seconds_bucket', { le: '0.1' })).toBe(1);
    expect(value(samples, 'heartbeat_seconds_bucket', { le: '0.05' })).toBe(0);
  });
});

describe('Discord process observations', () => {
  test('counts ingress, turns, recoveries, deliveries and runs by closed outcome', async () => {
    const { registry, telemetry } = setup();
    for (const outcome of discordIngressOutcomes) telemetry.observe({ type: 'ingress', outcome });
    telemetry.observe({ type: 'turn', outcome: 'idle' });
    telemetry.observe({ type: 'turn', outcome: 'worked' });
    telemetry.observe({ type: 'turn', outcome: 'worked' });
    telemetry.observe({ type: 'recovery', event: 'discord_write_deferred' });
    telemetry.observe({ type: 'delivery', kind: 'answer', outcome: 'confirmed' });
    telemetry.observe({ type: 'run', phase: 'cancelled' });
    const samples = await scrape(registry);
    for (const outcome of discordIngressOutcomes)
      expect(value(samples, 'ingress_total', { outcome })).toBe(1);
    expect(value(samples, 'turn_total', { outcome: 'worked' })).toBe(2);
    expect(value(samples, 'recovery_total', { event: 'discord_write_deferred' })).toBe(1);
    expect(value(samples, 'delivery_total', { kind: 'answer', outcome: 'confirmed' })).toBe(1);
    expect(value(samples, 'run_total', { phase: 'cancelled' })).toBe(1);
  });

  test('observes acknowledgement time in seconds and ignores impossible durations', async () => {
    const { registry, telemetry } = setup();
    telemetry.observe({ type: 'ack', durationMs: 1500 });
    for (const durationMs of [Number.NaN, -1, Number.POSITIVE_INFINITY])
      telemetry.observe({ type: 'ack', durationMs });
    const samples = await scrape(registry);
    expect(value(samples, 'ack_seconds_count')).toBe(1);
    expect(value(samples, 'ack_seconds_sum')).toBeCloseTo(1.5);
    expect(value(samples, 'ack_seconds_bucket', { le: '1.5' })).toBe(1);
    expect(value(samples, 'ack_seconds_bucket', { le: '1' })).toBe(0);
  });

  test('discovery and task results feed workers health without a metric of their own', async () => {
    const { registry, health, telemetry } = setup();
    expect(health.snapshot().workers).toBe('unknown');
    telemetry.observe({ type: 'discovery', source: 'applications', ok: true });
    telemetry.observe({ type: 'discovery', source: 'channels', ok: true });
    expect(health.snapshot().workers).toBe('healthy');
    telemetry.observe({ type: 'task', ok: false });
    expect(health.snapshot().workers).toBe('degraded');
    telemetry.observe({ type: 'discovery', source: 'nonsense' as never, ok: true });
    expect(health.snapshot().workers).toBe('degraded');
    const names = (await registry.getMetricsAsJSON()).map((metric) => metric.name);
    expect(names.filter((metric) => /discovery|task/.test(metric))).toEqual([]);
  });

  test('closes every recovery event the real classifiers can produce', () => {
    const provider = createDiscordWorkerProvider({
      rates: new DiscordRateCoordinator(),
      createClient: () => {
        throw new Error('not used');
      },
    });
    const classify = provider.recoveryEvent.bind(provider);
    const errors: unknown[] = [
      new ServiceError(500),
      new ServiceError(502),
      new ServiceError(503),
      new ServiceError(504),
      new ServiceError(401),
      new ServiceError(403),
      new ServiceError(404),
      new ServiceError(409),
      new ServiceError(429),
      new ServiceError(400, 'transactions_unavailable'),
      new DOMException('late', 'TimeoutError'),
      new DiscordWriteError('permanent'),
      new DiscordWriteError('retryable'),
      new DiscordWriteError('unknown'),
      new Error('unclassified'),
    ];
    const produced = new Set(errors.map((error) => recoveryEvent(error, classify)));
    for (const event of produced) expect(discordRecoveryEvents).toContain(event);
    expect(produced).not.toContain('other');
  });
});

describe('Discord application scope', () => {
  test('creates health state on entry and removes it exactly once on release', async () => {
    const { registry, health, telemetry } = setup();
    const scope = telemetry.application(owner(), { shards: 1 });
    scope.observe({ type: 'session', event: 'ready', shardId: 0 });
    expect(health.snapshot().applications).toBe(1);
    expect(value(await scrape(registry), 'applications_owned')).toBe(1);
    scope.release();
    scope.release();
    expect(health.snapshot().applications).toBe(0);
    const samples = await scrape(registry);
    expect(value(samples, 'applications_owned')).toBe(0);
    expect(value(samples, 'health', { concern: 'native', level: 'healthy' })).toBe(0);
  });

  test('a late observation after release still counts but cannot recreate the state', async () => {
    const { registry, health, telemetry } = setup();
    const scope = telemetry.application(owner(), { shards: 1 });
    scope.release();
    scope.observe({ type: 'session', event: 'ready', shardId: 0 });
    scope.observe({ type: 'rest', route: templateFor('message_create'), status: 401 });
    expect(health.snapshot()).toMatchObject({
      applications: 0,
      credentials: { failing: 0, healthy: 0, unknown: 0 },
    });
    expect(value(await scrape(registry), 'gateway_session_total', { event: 'ready' })).toBe(1);
  });

  test('a replacement revision starts unknown and the previous scope cannot remove it', () => {
    const { health, telemetry } = setup();
    const previous = telemetry.application(owner({ ownerId: 'a'.repeat(32) }), { shards: 1 });
    previous.observe({ type: 'stop', reason: 'credentials' });
    const replacement = telemetry.application(
      owner({ applicationRevision: 'revision-b', ownerId: 'b'.repeat(32) }),
      { shards: 1 },
    );
    expect(only(health.snapshot().credentials)).toBe('unknown');
    previous.observe({ type: 'stop', reason: 'credentials' });
    previous.release();
    expect(health.snapshot()).toMatchObject({ applications: 1, credentials: { unknown: 1 } });
    replacement.observe({ type: 'session', event: 'ready', shardId: 0 });
    expect(only(health.snapshot().credentials)).toBe('healthy');
  });

  test('an invalid owner never throws and the application still counts metrics', async () => {
    const { registry, health, telemetry } = setup();
    const scope = telemetry.application(owner({ applicationId: '' }), { shards: 1 });
    scope.observe({ type: 'session', event: 'ready', shardId: 0 });
    expect(() => scope.release()).not.toThrow();
    expect(health.snapshot().applications).toBe(0);
    expect(value(await scrape(registry), 'gateway_session_total', { event: 'ready' })).toBe(1);
  });
});

describe('Discord aggregate health gauges', () => {
  test('exposes every concern and level, with workers as one process entity', async () => {
    const { registry, health, telemetry } = setup();
    telemetry.observe({ type: 'discovery', source: 'applications', ok: true });
    telemetry.observe({ type: 'discovery', source: 'channels', ok: true });
    const first = telemetry.application(owner(), { shards: 1 });
    first.observe({ type: 'session', event: 'ready', shardId: 0 });
    const second = telemetry.application(owner({ applicationId: '987654321098765499' }), {
      shards: 0,
    });
    second.observe({ type: 'rest', route: templateFor('message_create'), status: 401 });
    const gauge = (await scrape(registry)).filter((sample) => sample.name === name('health'));
    expect(gauge).toHaveLength(20);
    const level = (concern: string, at: string) =>
      gauge.find((sample) => sample.labels.concern === concern && sample.labels.level === at)
        ?.value;
    expect(level('workers', 'healthy')).toBe(1);
    expect(level('workers', 'failing')).toBe(0);
    expect(level('credentials', 'healthy')).toBe(1);
    expect(level('credentials', 'failing')).toBe(1);
    expect(level('native', 'healthy')).toBe(1);
    expect(level('native', 'disabled')).toBe(1);
    expect(level('permissions', 'unknown')).toBe(2);
    advance(ttl + 1);
    const decayed = (await scrape(registry)).filter((sample) => sample.name === name('health'));
    expect(
      decayed.find(
        (sample) => sample.labels.concern === 'credentials' && sample.labels.level === 'unknown',
      )?.value,
    ).toBe(2);
    expect(health.snapshot().credentials.healthy).toBe(0);
  });

  test('reports quarantined applications from the supplier at scrape time', async () => {
    let held = { credentials: 1, configuration: 0, identity: 1 };
    const registry = new Registry();
    const health = new DiscordHealth({ now: () => now, quarantine: () => held });
    createDiscordTelemetry({ registry, health });
    let samples = await scrape(registry);
    expect(value(samples, 'applications_quarantined')).toBe(2);
    expect(value(samples, 'health', { concern: 'native', level: 'failing' })).toBe(2);
    expect(value(samples, 'health', { concern: 'credentials', level: 'failing' })).toBe(1);
    held = { credentials: 0, configuration: 0, identity: 0 };
    samples = await scrape(registry);
    expect(value(samples, 'applications_quarantined')).toBe(0);
    expect(value(samples, 'health', { concern: 'native', level: 'failing' })).toBe(0);
  });
});

describe('Discord observer failure isolation', () => {
  const everyObservation = (): [DiscordObservation[], DiscordApplicationObservation[]] => [
    [
      { type: 'ingress', outcome: undefined as never },
      { type: 'ack', durationMs: undefined as never },
      { type: 'discovery', source: null as never, ok: true },
      { type: 'task', ok: 1 as never },
      { type: 'turn', outcome: {} as never },
      { type: 'recovery', event: 42 as never },
      { type: 'delivery', kind: null as never, outcome: [] as never },
      { type: 'run', phase: Symbol('phase') as never },
      { type: 'unknown' } as never,
    ],
    [
      { type: 'rest', route: null as never, status: 'x' as never },
      { type: 'rejected', reason: {} as never },
      { type: 'permission', outcome: 7 as never },
      { type: 'session', event: 'ready', shardId: 'zero' as never },
      { type: 'heartbeat', shardId: {} as never, latencyMs: 'slow' as never },
      { type: 'stop', reason: null as never },
      { type: 'unknown' } as never,
    ],
  ];

  test('hostile observations never throw and never create an unbounded series', async () => {
    const { registry, telemetry } = setup();
    const scope = telemetry.application(owner(), { shards: 1 });
    const [processWide, application] = everyObservation();
    for (const observation of processWide)
      expect(() => telemetry.observe(observation)).not.toThrow();
    for (const observation of application) expect(() => scope.observe(observation)).not.toThrow();
    expect((await scrape(registry)).length).toBeLessThanOrEqual(250);
  });

  test('a broken health registry cannot break an observation, a release or a scrape', async () => {
    class Broken extends DiscordHealth {
      override entry(): never {
        throw new Error('entry unavailable');
      }
      override remove(): never {
        throw new Error('remove unavailable');
      }
      override discovery(): never {
        throw new Error('discovery unavailable');
      }
      override task(): never {
        throw new Error('task unavailable');
      }
      override snapshot(): never {
        throw new Error('snapshot unavailable');
      }
    }
    const registry = new Registry();
    const telemetry = createDiscordTelemetry({ registry, health: new Broken() });
    const scope = telemetry.application(owner(), { shards: 1 });
    expect(() => {
      telemetry.observe({ type: 'discovery', source: 'channels', ok: true });
      telemetry.observe({ type: 'task', ok: false });
      scope.observe({ type: 'session', event: 'ready', shardId: 0 });
      scope.release();
    }).not.toThrow();
    const samples = await scrape(registry);
    expect(value(samples, 'gateway_session_total', { event: 'ready' })).toBe(1);
    expect(samples.filter((sample) => sample.name === name('health'))).toEqual([]);
  });

  test('a throwing observer is swallowed by the provider decorator', async () => {
    const provider = observeDiscordProvider(fakeProvider(), () => {
      throw new Error('sink unavailable');
    });
    await expect(provider.writeProgress(runView('queued'), bundle, signal)).resolves.toEqual({
      externalMessageKey: 'written',
    });
  });
});

const signal = new AbortController().signal;
const bundle = {} as ChannelBundle;
const runView = (state: string) => ({ state }) as unknown as ChannelRunView;
const partOf = (traceUrl?: string) => ({ traceUrl }) as unknown as ChannelDeliveryPart;
function fakeProvider(overrides: Partial<WorkerProvider> = {}): WorkerProvider {
  return {
    progressRenderer: 'test-v1',
    maxProgressLength: 100,
    validateAddress: jest.fn(),
    assertBinding: jest.fn(),
    progressText: jest.fn(() => 'text'),
    makePlan: jest.fn(),
    supportsRenderer: jest.fn(() => true),
    preparePart: jest.fn(() => async () => ({ externalMessageKey: 'part' })),
    writeProgress: jest.fn(async () => ({ externalMessageKey: 'written' })),
    deleteProgress: jest.fn(async () => undefined),
    deliverArtifact: jest.fn(),
    classifyError: jest.fn((): ProviderWriteFailure => ({ outcome: 'unknown' })),
    recoveryEvent: jest.fn(),
    ...overrides,
  };
}

describe('Discord provider decorator', () => {
  const observed = () => {
    const events: DiscordObservation[] = [];
    return { events, observer: (observation: DiscordObservation) => events.push(observation) };
  };

  test('reports confirmed deliveries by kind and returns the provider result untouched', async () => {
    const { events, observer } = observed();
    const provider = observeDiscordProvider(fakeProvider(), observer);
    await expect(provider.writeProgress(runView('executing'), bundle, signal)).resolves.toEqual({
      externalMessageKey: 'written',
    });
    await provider.deleteProgress(runView('executing'), bundle, signal);
    const answer = provider.preparePart(partOf(), 'v1', bundle);
    await expect(answer(runView('executing'), signal)).resolves.toEqual({
      externalMessageKey: 'part',
    });
    await provider.preparePart(
      partOf('https://example.test/session'),
      'v1',
      bundle,
    )(runView('executing'), signal);
    expect(events).toEqual([
      { type: 'delivery', kind: 'progress', outcome: 'confirmed' },
      { type: 'delivery', kind: 'cleanup', outcome: 'confirmed' },
      { type: 'delivery', kind: 'answer', outcome: 'confirmed' },
      { type: 'delivery', kind: 'trace', outcome: 'confirmed' },
    ]);
  });

  test.each([
    [{ outcome: 'permanent' }, 'permanent'],
    [{ outcome: 'retryable', retryAfterMs: 5 }, 'retryable'],
    [{ outcome: 'unknown' }, 'uncertain'],
  ] as [ProviderWriteFailure, string][])(
    'classifies a failed write with the provider (%j) as %s and rethrows the same error',
    async (failure, expected) => {
      const { events, observer } = observed();
      const error = new Error('write failed');
      const classifyError = jest.fn(() => failure);
      const provider = observeDiscordProvider(
        fakeProvider({
          classifyError,
          writeProgress: jest.fn(async () => {
            throw error;
          }),
        }),
        observer,
      );
      await expect(provider.writeProgress(runView('executing'), bundle, signal)).rejects.toBe(
        error,
      );
      expect(classifyError).toHaveBeenCalledWith(error);
      expect(events).toEqual([{ type: 'delivery', kind: 'progress', outcome: expected }]);
    },
  );

  test('a classifier that throws is an uncertain outcome and the original error still surfaces', async () => {
    const { events, observer } = observed();
    const error = new Error('write failed');
    const provider = observeDiscordProvider(
      fakeProvider({
        classifyError: jest.fn(() => {
          throw new Error('classifier failed');
        }),
        deleteProgress: jest.fn(async () => {
          throw error;
        }),
      }),
      observer,
    );
    await expect(provider.deleteProgress(runView('executing'), bundle, signal)).rejects.toBe(error);
    expect(events).toEqual([{ type: 'delivery', kind: 'cleanup', outcome: 'uncertain' }]);
  });

  test('a synchronous preparation failure is not a delivery attempt', () => {
    const { events, observer } = observed();
    const error = new Error('unsupported part');
    const provider = observeDiscordProvider(
      fakeProvider({
        preparePart: jest.fn(() => {
          throw error;
        }),
      }),
      observer,
    );
    expect(() => provider.preparePart(partOf(), 'v1', bundle)).toThrow(error);
    expect(events).toEqual([]);
  });

  test('counts a start only for a queued run, and a terminal phase from the committed state', async () => {
    const { events, observer } = observed();
    const lifecycle = jest.fn(async () => undefined);
    const provider = observeDiscordProvider(fakeProvider({ lifecycle }), observer);
    await provider.lifecycle?.(runView('queued'), bundle, 'started', signal);
    await provider.lifecycle?.(runView('executing'), bundle, 'started', signal);
    await provider.lifecycle?.(runView('delivered'), bundle, 'completed', signal);
    await provider.lifecycle?.(runView('failed'), bundle, 'failed', signal);
    await provider.lifecycle?.(runView('cancelled'), bundle, 'failed', signal);
    expect(events.map((event) => (event.type === 'run' ? event.phase : event.type))).toEqual([
      'started',
      'delivered',
      'failed',
      'cancelled',
    ]);
    expect(lifecycle).toHaveBeenCalledTimes(5);
  });

  test('records the run phase before the original lifecycle and still propagates its failure', async () => {
    const { events, observer } = observed();
    const error = new Error('lifecycle failed');
    const provider = observeDiscordProvider(
      fakeProvider({
        lifecycle: jest.fn(async () => {
          throw error;
        }),
      }),
      observer,
    );
    await expect(
      provider.lifecycle?.(runView('delivered'), bundle, 'completed', signal),
    ).rejects.toBe(error);
    expect(events).toEqual([{ type: 'run', phase: 'delivered' }]);
  });

  test('keeps every other provider member, including an absent optional one', () => {
    const base = fakeProvider();
    const wrapped = observeDiscordProvider(base, () => undefined);
    expect(wrapped.progressRenderer).toBe(base.progressRenderer);
    expect(wrapped.maxProgressLength).toBe(base.maxProgressLength);
    expect(wrapped.classifyError).toBe(base.classifyError);
    expect(wrapped.makePlan).toBe(base.makePlan);
    expect(wrapped.effectContext).toBeUndefined();
    const withContext = fakeProvider({ effectContext: jest.fn() });
    expect(observeDiscordProvider(withContext, () => undefined).effectContext).toBe(
      withContext.effectContext,
    );
  });
});
