import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { GatewayDispatchEvents, ApplicationFlags } from 'discord-api-types/v10';
import type { SessionInfo } from '@discordjs/ws';
import type { AddressInfo } from 'node:net';
import type {
  DiscordGatewayOwner,
  DiscordGatewayCheckpointBatch,
  DiscordGatewayEvent,
  DiscordGatewayOwnership,
  DiscordGatewayCheckpoints,
} from './gateway';
import type {
  DiscordGatewayDriverOptions,
  DiscordGatewayDispatch,
  DiscordGatewayReady,
} from './socket';
import type { DiscordApplicationObservation } from './observe';
import type { Logger } from '../types';
import { DiscordGatewayFailure, DiscordIdentifyRefusal } from './recovery';
import { createDiscordGatewayDriver } from './socket';
import { OwnedDiscordGateway } from './gateway';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const user = (id: string, bot = false) => ({
  id,
  bot,
  username: 'user',
  discriminator: '0',
  global_name: null,
  avatar: null,
});
const session = (
  applicationId = '123',
  shardId = 0,
  shardCount = 1,
  sequence = 1,
): SessionInfo => ({
  sessionId: `session-${applicationId}-${shardId}`,
  sequence,
  shardId,
  shardCount,
  resumeURL: 'wss://gateway.discord.gg',
});
const ready = (applicationId = '123', botUserId = '456', shardId = 0): DiscordGatewayReady => ({
  shardId,
  data: {
    v: 10,
    user: user(botUserId, true),
    application: {
      id: applicationId,
      flags: ApplicationFlags.GatewayMessageContentLimited,
      flags_new: '0',
    },
    session_id: session(applicationId, shardId).sessionId,
    resume_gateway_url: 'wss://gateway.discord.gg',
    guilds: [],
  },
});
type MessageData = Extract<DiscordGatewayDispatch['data'], { t: 'MESSAGE_CREATE' }>['d'];
const message = (sequence = 2, override: Partial<MessageData> = {}): DiscordGatewayDispatch => ({
  shardId: 0,
  data: {
    op: 0,
    s: sequence,
    t: GatewayDispatchEvents.MessageCreate,
    d: {
      id: '700',
      channel_id: '800',
      guild_id: '900',
      author: user('600'),
      content: '<@456> hello',
      timestamp: '2026-01-01T00:00:00.000Z',
      edited_timestamp: null,
      tts: false,
      mention_everyone: false,
      mentions: [user('456', true)],
      mention_roles: [],
      attachments: [],
      embeds: [],
      pinned: false,
      type: 0,
      ...override,
    },
  },
});
function shared() {
  const locks = new Map<string, { ownerId: string; expiresAt: number }>();
  const batches = new Map<string, DiscordGatewayCheckpointBatch>();
  const hooks: { renew?: () => Promise<boolean>; save?: () => Promise<void> } = {};
  const valid = (owner: DiscordGatewayOwner) =>
    locks.get(owner.applicationId)?.ownerId === owner.ownerId &&
    (locks.get(owner.applicationId)?.expiresAt ?? 0) > Date.now();
  const ownership: DiscordGatewayOwnership = {
    async acquire(owner, leaseMs) {
      if ((locks.get(owner.applicationId)?.expiresAt ?? 0) > Date.now()) return false;
      locks.set(owner.applicationId, { ownerId: owner.ownerId, expiresAt: Date.now() + leaseMs });
      return true;
    },
    async renew(owner, leaseMs) {
      if (hooks.renew) return hooks.renew();
      if (!valid(owner)) return false;
      locks.set(owner.applicationId, { ownerId: owner.ownerId, expiresAt: Date.now() + leaseMs });
      return true;
    },
    async release(owner) {
      if (locks.get(owner.applicationId)?.ownerId === owner.ownerId)
        locks.delete(owner.applicationId);
    },
  };
  const checkpoints: DiscordGatewayCheckpoints = {
    async load(owner) {
      return structuredClone(batches.get(owner.applicationId) ?? null);
    },
    async save(owner, batch) {
      if (hooks.save) await hooks.save();
      if (!valid(owner)) return false;
      const current = batches.get(owner.applicationId);
      const records = new Map((current?.checkpoints ?? []).map((entry) => [entry.shardId, entry]));
      for (const entry of batch.checkpoints) {
        if (entry.session) records.set(entry.shardId, entry);
        else records.delete(entry.shardId);
      }
      batches.set(
        owner.applicationId,
        structuredClone({ ...batch, checkpoints: [...records.values()] }),
      );
      return true;
    },
  };
  return { locks, batches, hooks, ownership, checkpoints };
}
function fixture(
  store = shared(),
  applicationId = '123',
  botUserId = '456',
  policy: {
    shardCount?: number;
    maxQueuedEvents?: number;
    handshakeTimeoutMs?: number;
    readyTimeoutMs?: number;
  } = {},
  ownerId?: string,
  observe?: (observation: DiscordApplicationObservation) => void,
) {
  const hooks: {
    dispatch?: (event: DiscordGatewayEvent, signal: AbortSignal) => Promise<void>;
    connect?: () => Promise<void>;
    /** A Gateway that never answers: connecting never settles and no shard ever gets READY. */
    silent?: boolean;
    ready?: DiscordGatewayReady;
    replay?: DiscordGatewayDispatch;
  } = {};
  const seen: DiscordGatewayEvent[] = [];
  const log: Logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const drivers: DiscordGatewayDriverOptions[] = [];
  const destroy = jest.fn(async () => {});
  const controller = new AbortController();
  const gateway = new OwnedDiscordGateway(
    { applicationId, applicationRevision: 'revision-1', botUserId, botToken: 'private-bot-token' },
    {
      ownerId,
      ownership: store.ownership,
      checkpoints: store.checkpoints,
      log,
      observe,
      async dispatch(event, signal) {
        if (hooks.dispatch) await hooks.dispatch(event, signal);
        seen.push(event);
      },
      createDriver(options) {
        drivers.push(options);
        if (hooks.silent) return { destroy, connect: () => new Promise<void>(() => undefined) };
        return {
          destroy,
          async connect() {
            for (let shardId = 0; shardId < options.policy.shardCount; shardId++) {
              if (options.retrieveSessionInfo(shardId)) {
                if (hooks.replay) {
                  const info = options.retrieveSessionInfo(shardId);
                  if (info)
                    await options.updateSessionInfo(shardId, {
                      ...info,
                      sequence: hooks.replay.data.s,
                    });
                  options.dispatch(hooks.replay);
                }
                options.resumed(shardId);
              } else {
                await options.updateSessionInfo(
                  shardId,
                  session(applicationId, shardId, options.policy.shardCount),
                );
                options.ready(hooks.ready ?? ready(applicationId, botUserId, shardId));
              }
            }
            if (hooks.connect) await hooks.connect();
          },
        };
      },
    },
    { enabled: true, gateway: { enabled: true, ...policy } },
  );
  const start = () => gateway.start(controller.signal);
  const send = async (event: DiscordGatewayDispatch) => {
    const options = drivers[0];
    const info = options.retrieveSessionInfo(event.shardId);
    if (info) await options.updateSessionInfo(event.shardId, { ...info, sequence: event.data.s });
    options.dispatch(event);
    await jest.advanceTimersByTimeAsync(0);
  };
  return { gateway, start, send, store, hooks, seen, log, drivers, destroy, controller };
}
describe('owned Discord Gateway sessions', () => {
  beforeEach(() => jest.useFakeTimers({ now: 1_700_000_000_000 }));
  afterEach(() => jest.useRealTimers());
  test('retains credential failures from SDK discovery and measures only verified session lifetime', async () => {
    const rejected = fixture();
    rejected.hooks.connect = async () => {
      throw new DiscordGatewayFailure('credentials');
    };
    await expect(rejected.start()).rejects.toMatchObject({
      reason: 'credentials',
      fatal: true,
      healthyForMs: 0,
    });
    expect(rejected.destroy).toHaveBeenCalledTimes(1);
    const running = fixture();
    await expect(running.start()).resolves.toBe(true);
    jest.setSystemTime(Date.now() + 2000);
    running.drivers[0].closed(4014, 0);
    await running.gateway.closed;
    expect(running.gateway.failure).toMatchObject({
      reason: 'configuration',
      fatal: true,
      healthyForMs: 2000,
    });
  });

  test('requires both enablement flags without claiming ownership', async () => {
    const store = shared();
    const gateway = new OwnedDiscordGateway(
      { applicationId: '123', applicationRevision: 'v1', botUserId: '456', botToken: 'secret' },
      { ...store, dispatch: async () => {}, log: { info() {}, warn() {}, error() {} } },
      { gateway: { enabled: true } },
    );
    expect(await gateway.start(new AbortController().signal)).toBe(false);
    expect(store.locks.size).toBe(0);
  });
  test('one application owner covers all shards and another replica cannot open a session', async () => {
    const store = shared();
    const first = fixture(store, '123', '456', { shardCount: 2 });
    const second = fixture(store);
    expect(await first.start()).toBe(true);
    expect(await second.start()).toBe(false);
    expect(first.drivers).toHaveLength(1);
    expect(first.drivers[0].retrieveSessionInfo(0)?.shardId).toBe(0);
    expect(first.drivers[0].retrieveSessionInfo(1)?.shardId).toBe(1);
    expect(second.drivers).toHaveLength(0);
    await first.gateway.stop();
  });
  test('uses the supplied application owner for acquisition, dispatch and checkpoints', async () => {
    const ownerId = 'a'.repeat(32);
    const f = fixture(shared(), '123', '456', {}, ownerId);
    expect(await f.start()).toBe(true);
    expect(f.store.locks.get('123')?.ownerId).toBe(ownerId);
    await f.send(message());
    expect(f.seen[0]?.ownerId).toBe(ownerId);
    await f.gateway.stop();
    expect(f.store.locks.size).toBe(0);
  });
  test('rejects malformed supplied application owners before acquiring a lease', () => {
    const store = shared();
    expect(() => fixture(store, '123', '456', {}, 'not-an-owner')).toThrow();
    expect(store.locks.size).toBe(0);
  });
  test('two bots using shard zero keep separate hot and durable session state', async () => {
    const store = shared();
    const first = fixture(store);
    const second = fixture(store, '124', '457');
    await first.start();
    await second.start();
    await first.send(message(8));
    await jest.advanceTimersByTimeAsync(1000);
    expect(store.batches.get('123')?.checkpoints[0].session?.sequence).toBe(8);
    expect(store.batches.get('124')?.checkpoints[0].session?.sequence).toBe(1);
    expect(first.drivers[0].retrieveSessionInfo(0)?.sessionId).not.toBe(
      second.drivers[0].retrieveSessionInfo(0)?.sessionId,
    );
    await first.gateway.stop();
    await second.gateway.stop();
  });
  test.each(['application', 'bot'])('rejects mismatched READY %s identity', async (kind) => {
    const f = fixture();
    f.hooks.ready = ready(kind === 'application' ? '999' : '123', kind === 'bot' ? '999' : '456');
    await expect(f.start()).rejects.toThrow('Discord Gateway connection unavailable');
    expect(f.destroy).toHaveBeenCalledTimes(1);
    expect(f.store.locks.size).toBe(0);
    expect(f.seen).toHaveLength(0);
  });
  test('resumes a trusted checkpoint and forwards replay dispatch before RESUMED', async () => {
    const f = fixture();
    f.store.batches.set('123', {
      applicationId: '123',
      applicationRevision: 'revision-1',
      botUserId: '456',
      checkpoints: [{ shardId: 0, session: session('123', 0, 1, 40) }],
    });
    f.hooks.replay = message(41);
    expect(await f.start()).toBe(true);
    await jest.advanceTimersByTimeAsync(0);
    expect(f.seen).toMatchObject([{ kind: 'message', messageId: '700', sequence: 41 }]);
    await jest.advanceTimersByTimeAsync(1000);
    expect(f.store.batches.get('123')?.checkpoints[0].session?.sequence).toBe(41);
    await f.gateway.stop();
  });
  test('checkpoints never advance beyond an unfinished durable callback', async () => {
    const f = fixture();
    await f.start();
    const gate = deferred<void>();
    f.hooks.dispatch = async () => gate.promise;
    await f.send(message(2));
    await f.send({
      shardId: 0,
      data: {
        op: 0,
        s: 3,
        t: GatewayDispatchEvents.GuildDelete,
        d: { id: '900', unavailable: true },
      },
    });
    expect(f.drivers[0].retrieveSessionInfo(0)?.sequence).toBe(3);
    await jest.advanceTimersByTimeAsync(1000);
    expect(f.store.batches.get('123')?.checkpoints[0].session?.sequence).toBe(1);
    gate.resolve();
    await jest.advanceTimersByTimeAsync(1000);
    expect(f.store.batches.get('123')?.checkpoints[0].session?.sequence).toBe(3);
    await f.gateway.stop();
  });
  test('a READY checkpoint barrier precedes delivery to the durable consumer', async () => {
    const f = fixture();
    const gate = deferred<void>();
    f.store.hooks.save = () => gate.promise;
    const started = f.start();
    await jest.advanceTimersByTimeAsync(0);
    await f.send(message(2));
    expect(f.seen).toHaveLength(0);
    gate.resolve();
    expect(await started).toBe(true);
    await jest.advanceTimersByTimeAsync(0);
    expect(f.seen[0]?.kind).toBe('message');
    await f.gateway.stop();
  });
  test('shutdown retains the resume checkpoint and repeated message IDs reach durable deduplication', async () => {
    const store = shared();
    const first = fixture(store);
    await first.start();
    await first.send(message(2));
    await jest.advanceTimersByTimeAsync(1000);
    await first.gateway.stop();
    const second = fixture(store);
    await second.start();
    await second.send(message(3));
    expect(first.seen[0]).toMatchObject({ messageId: '700' });
    expect(second.seen[0]).toMatchObject({ messageId: '700' });
    expect(second.drivers[0].retrieveSessionInfo(0)?.sessionId).toBe(session().sessionId);
    await second.gateway.stop();
  });
  test.each(['identity', 'url', 'shard'])(
    'rejects foreign or malformed %s checkpoints before connecting',
    async (kind) => {
      const f = fixture();
      const info = session();
      if (kind === 'url') info.resumeURL = 'wss://private.evil.com';
      if (kind === 'shard') info.shardCount = 2;
      f.store.batches.set('123', {
        applicationId: kind === 'identity' ? '124' : '123',
        applicationRevision: 'revision-1',
        botUserId: '456',
        checkpoints: [{ shardId: 0, session: info }],
      });
      await expect(f.start()).rejects.toThrow('Discord Gateway connection unavailable');
      expect(f.drivers).toHaveLength(0);
      expect(f.store.locks.size).toBe(0);
    },
  );
  test('renewal loss aborts in-flight consumption and stops all later intake', async () => {
    const f = fixture();
    await f.start();
    const gate = deferred<void>();
    let consumerSignal: AbortSignal | undefined;
    f.hooks.dispatch = async (_event, signal) => {
      consumerSignal = signal;
      await gate.promise;
    };
    await f.send(message(2));
    f.store.hooks.renew = async () => false;
    await jest.advanceTimersByTimeAsync(10_000);
    await f.gateway.closed;
    expect(consumerSignal?.aborted).toBe(true);
    expect(f.destroy).toHaveBeenCalledTimes(1);
    f.drivers[0].dispatch(message(3));
    gate.resolve();
    await jest.advanceTimersByTimeAsync(0);
    expect(f.store.batches.get('123')?.checkpoints[0].session?.sequence).toBe(1);
    expect(jest.getTimerCount()).toBe(0);
  });
  test('the hard ownership deadline closes the socket even if renewal hangs', async () => {
    const f = fixture();
    const gate = deferred<boolean>();
    f.store.hooks.renew = () => gate.promise;
    await f.start();
    await jest.advanceTimersByTimeAsync(30_000);
    await f.gateway.closed;
    expect(f.destroy).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
    gate.resolve(true);
    await jest.advanceTimersByTimeAsync(0);
    expect(jest.getTimerCount()).toBe(0);
  });
  test('shutdown interrupts connection startup and releases only after socket destruction', async () => {
    const f = fixture();
    const gate = deferred<void>();
    f.hooks.connect = () => gate.promise;
    const started = f.start();
    await jest.advanceTimersByTimeAsync(0);
    f.destroy.mockImplementationOnce(async () => {
      expect(f.store.locks.size).toBe(1);
    });
    f.controller.abort();
    expect(await started).toBe(false);
    await f.gateway.stop();
    expect(f.destroy).toHaveBeenCalledTimes(1);
    expect(f.store.locks.size).toBe(0);
    gate.resolve();
  });
  test('shutdown during an ownership claim returns promptly and releases a late acquisition', async () => {
    const f = fixture();
    const gate = deferred<boolean>();
    const acquire = f.store.ownership.acquire;
    f.store.ownership.acquire = async (owner, leaseMs) => {
      await gate.promise;
      return acquire(owner, leaseMs);
    };
    const started = f.start();
    f.controller.abort();
    expect(await started).toBe(false);
    gate.resolve(true);
    await jest.advanceTimersByTimeAsync(0);
    expect(f.drivers).toHaveLength(0);
    expect(f.store.locks.size).toBe(0);
  });
  test('idle sessions avoid repeated checkpoint writes', async () => {
    const f = fixture();
    let saves = 0;
    f.store.hooks.save = async () => {
      saves++;
    };
    await f.start();
    await jest.advanceTimersByTimeAsync(1000);
    const initial = saves;
    await jest.advanceTimersByTimeAsync(5000);
    expect(saves).toBe(initial);
    await f.send(message(2));
    await jest.advanceTimersByTimeAsync(1000);
    expect(saves).toBe(initial + 1);
    await f.gateway.stop();
  });
  test('suppresses bot, self, webhook, system and oversized messages while accepting DMs and thread destinations', async () => {
    const f = fixture();
    await f.start();
    const ignored: Partial<MessageData>[] = [
      { author: user('601', true) },
      { author: user('456') },
      { webhook_id: '999' },
      { type: 20 },
      { author: { ...user('602'), system: true } },
      { content: 'x'.repeat(6001) },
    ];
    for (const [index, override] of ignored.entries()) await f.send(message(index + 2, override));
    expect(f.seen).toHaveLength(0);
    await f.send(message(8, { guild_id: undefined, channel_id: '801', channel_type: 1 }));
    await f.send(message(9, { channel_id: '802', channel_type: 11 }));
    expect(f.seen).toMatchObject([
      { kind: 'message', guildId: undefined, channelId: '801', mentionsBot: true },
      { kind: 'message', channelId: '802', channelType: 11 },
    ]);
    await f.gateway.stop();
  });
  test('temporary guild unavailability never becomes a removal', async () => {
    const f = fixture();
    await f.start();
    await f.send({
      shardId: 0,
      data: {
        op: 0,
        s: 2,
        t: GatewayDispatchEvents.GuildDelete,
        d: { id: '900', unavailable: true },
      },
    });
    await f.send({
      shardId: 0,
      data: { op: 0, s: 3, t: GatewayDispatchEvents.GuildDelete, d: { id: '900' } },
    });
    expect(f.seen).toMatchObject([
      { kind: 'guild', state: 'unavailable' },
      { kind: 'guild', state: 'removed' },
    ]);
    expect(f.destroy).not.toHaveBeenCalled();
    await f.gateway.stop();
  });
  test('consumer failures stop and retain the previous prefix without logging content or credentials', async () => {
    const f = fixture();
    await f.start();
    f.hooks.dispatch = async () => {
      throw new Error('private-bot-token secret prompt');
    };
    await f.send(message(2));
    await f.gateway.closed;
    expect(f.store.batches.get('123')?.checkpoints[0].session?.sequence).toBe(1);
    const diagnostics = [
      jest.mocked(f.log.info).mock.calls,
      jest.mocked(f.log.warn).mock.calls,
      jest.mocked(f.log.error).mock.calls,
    ]
      .flat(2)
      .join(' ');
    expect(diagnostics).toContain('discord_gateway_stopped:dispatch');
    expect(diagnostics).not.toMatch(/private-bot-token|secret prompt/);
    expect(f.destroy).toHaveBeenCalledTimes(1);
  });
  test('a rejected checkpoint fence stops without releasing the replacement owner', async () => {
    const f = fixture();
    f.store.hooks.save = async () => {
      f.store.locks.set('123', { ownerId: 'replacement', expiresAt: Date.now() + 30000 });
    };
    await expect(f.start()).rejects.toThrow('Discord Gateway connection unavailable');
    expect(f.destroy).toHaveBeenCalledTimes(1);
    expect(f.store.locks.get('123')?.ownerId).toBe('replacement');
    expect(f.store.batches.size).toBe(0);
    expect(f.seen).toHaveLength(0);
  });
  test('bounded backpressure stops instead of silently discarding uncheckpointed events', async () => {
    const f = fixture(shared(), '123', '456', { maxQueuedEvents: 1 });
    const gate = deferred<void>();
    f.hooks.dispatch = () => gate.promise;
    await f.start();
    await f.send(message(2));
    await f.send(message(3));
    await f.send(message(4));
    await f.gateway.closed;
    expect(f.destroy).toHaveBeenCalledTimes(1);
    expect(f.store.batches.get('123')?.checkpoints[0].session?.sequence).toBe(1);
    gate.resolve();
  });
});

describe('owned Discord Gateway observation', () => {
  beforeEach(() => jest.useFakeTimers({ now: 1_700_000_000_000 }));
  afterEach(() => jest.useRealTimers());
  const watch = (
    policy: { shardCount?: number; maxQueuedEvents?: number } = {},
    store = shared(),
    observed: DiscordApplicationObservation[] = [],
  ) => ({
    ...fixture(store, '123', '456', policy, undefined, (observation) => observed.push(observation)),
    observed,
  });
  const up = (shardId: number) => ({ type: 'session', event: 'ready', shardId });

  test('reports READY, heartbeats, transient closes, RESUMED, errors and the stop', async () => {
    const f = watch({ shardCount: 2 });
    await expect(f.start()).resolves.toBe(true);
    expect(f.observed).toEqual([up(0), up(1)]);
    f.drivers[0].heartbeat?.(1, 42);
    f.drivers[0].closed(1006, 0);
    f.drivers[0].resumed(0);
    f.drivers[0].error();
    expect(f.observed.slice(2)).toEqual([
      { type: 'heartbeat', shardId: 1, latencyMs: 42 },
      { type: 'session', event: 'closed_transient', shardId: 0 },
      { type: 'session', event: 'resumed', shardId: 0 },
      { type: 'session', event: 'error' },
    ]);
    await f.gateway.stop();
    await f.gateway.stop();
    expect(f.observed.slice(6)).toEqual([{ type: 'stop', reason: 'shutdown' }]);
  });

  test('reports a gap once, at the READY that follows a live session becoming non-resumable', async () => {
    const f = watch();
    await f.start();
    expect(f.observed).toEqual([up(0)]);
    f.observed.length = 0;
    const [driver] = f.drivers;
    await driver.updateSessionInfo(0, null);
    expect(f.observed).toEqual([]);
    await driver.updateSessionInfo(0, session('123', 0, 1, 5));
    driver.ready(ready());
    expect(f.observed).toEqual([up(0), { type: 'session', event: 'gap', shardId: 0 }]);
    f.observed.length = 0;
    driver.ready(ready());
    expect(f.observed).toEqual([up(0)]);
    await f.gateway.stop();
  });

  test('a clean shutdown, a fatal close and a first identify never report a gap', async () => {
    const stopped = watch();
    await stopped.start();
    await stopped.gateway.stop();
    await stopped.drivers[0].updateSessionInfo(0, null);
    stopped.drivers[0].ready(ready());
    const fatal = watch();
    await fatal.start();
    fatal.drivers[0].closed(4004, 0);
    await fatal.drivers[0].updateSessionInfo(0, null);
    fatal.drivers[0].ready(ready());
    await fatal.gateway.closed;
    for (const { observed } of [stopped, fatal])
      expect(observed.filter((item) => item.type === 'session' && item.event === 'gap')).toEqual(
        [],
      );
  });

  test('names a fatal close, then the stop that follows it, and ignores what comes after', async () => {
    const credentials = watch();
    await credentials.start();
    credentials.observed.length = 0;
    credentials.drivers[0].closed(4004, 0);
    credentials.drivers[0].closed(4014, 0);
    credentials.drivers[0].heartbeat?.(0, 10);
    credentials.drivers[0].error();
    await credentials.gateway.closed;
    expect(credentials.observed).toEqual([
      { type: 'session', event: 'closed_fatal', shardId: 0 },
      { type: 'stop', reason: 'credentials' },
    ]);
    const configuration = watch();
    await configuration.start();
    configuration.observed.length = 0;
    configuration.drivers[0].closed(4014, 0);
    await configuration.gateway.closed;
    expect(configuration.observed).toEqual([
      { type: 'session', event: 'closed_fatal', shardId: 0 },
      { type: 'stop', reason: 'configuration' },
    ]);
  });

  test.each([
    [
      'credentials',
      async (f: ReturnType<typeof watch>) => {
        f.hooks.connect = async () => {
          throw new DiscordGatewayFailure('credentials');
        };
        await expect(f.start()).rejects.toMatchObject({ reason: 'credentials' });
      },
    ],
    [
      'identity',
      async (f: ReturnType<typeof watch>) => {
        f.hooks.ready = ready('123', '999');
        await expect(f.start()).rejects.toThrow('Discord Gateway connection unavailable');
      },
    ],
    [
      'lost',
      async (f: ReturnType<typeof watch>) => {
        await f.start();
        f.store.hooks.renew = async () => false;
        await jest.advanceTimersByTimeAsync(10_000);
        await f.gateway.closed;
      },
    ],
    [
      'checkpoint',
      async (f: ReturnType<typeof watch>) => {
        f.store.hooks.save = async () => {
          f.store.locks.set('123', { ownerId: 'replacement', expiresAt: Date.now() + 30000 });
        };
        await expect(f.start()).rejects.toThrow('Discord Gateway connection unavailable');
      },
    ],
    [
      'dispatch',
      async (f: ReturnType<typeof watch>) => {
        await f.start();
        f.hooks.dispatch = async () => {
          throw new Error('private failure');
        };
        await f.send(message(2));
        await f.gateway.closed;
      },
    ],
  ] as const)('reports one %s stop with no other detail', async (reason, cause) => {
    const f = watch();
    await cause(f);
    expect(f.observed.filter((item) => item.type === 'stop')).toEqual([{ type: 'stop', reason }]);
    expect(JSON.stringify(f.observed)).not.toMatch(/private|session-|456|revision/);
  });

  test('backpressure is named as its own stop', async () => {
    const f = watch({ maxQueuedEvents: 1 });
    const gate = deferred<void>();
    f.hooks.dispatch = () => gate.promise;
    await f.start();
    await f.send(message(2));
    await f.send(message(3));
    await f.send(message(4));
    await f.gateway.closed;
    expect(f.observed.filter((item) => item.type === 'stop')).toEqual([
      { type: 'stop', reason: 'backpressure' },
    ]);
    gate.resolve();
  });

  test('a throwing observer changes neither session, delivery nor the failure it reports', async () => {
    const observer = jest.fn(() => {
      throw new Error('sink unavailable');
    });
    const f = fixture(shared(), '123', '456', {}, undefined, observer);
    await expect(f.start()).resolves.toBe(true);
    await f.send(message(2));
    expect(f.seen).toHaveLength(1);
    f.drivers[0].heartbeat?.(0, 5);
    f.drivers[0].closed(4014, 0);
    await f.gateway.closed;
    expect(f.gateway.failure).toMatchObject({ reason: 'configuration', fatal: true });
    expect(observer).toHaveBeenCalled();
    expect(f.destroy).toHaveBeenCalledTimes(1);
  });
});

describe('owned Discord Gateway IDENTIFY refusal', () => {
  beforeEach(() => jest.useFakeTimers({ now: 1_700_000_000_000 }));
  afterEach(() => jest.useRealTimers());

  test.each([
    ['a spent budget', new DiscordIdentifyRefusal('exhausted'), 'failed', 'exhausted'],
    ['an unreadable budget', new DiscordIdentifyRefusal('invalid'), 'failed', 'invalid'],
    ['an unanswered IDENTIFY', new DiscordIdentifyRefusal('retry'), 'failed', 'retry'],
    ['a rejected token', new DiscordGatewayFailure('credentials'), 'credentials', 'unconfirmed'],
    ['a failed read', new Error('private transport detail'), 'failed', 'unconfirmed'],
  ] as const)(
    'stops the session once for %s, naming only a closed reason',
    async (_name, error, stop, reason) => {
      const observed: DiscordApplicationObservation[] = [];
      const f = fixture(shared(), '123', '456', {}, undefined, (item) => observed.push(item));
      await f.start();
      f.drivers[0].identifyRefused?.(error);
      f.drivers[0].identifyRefused?.(error);
      await f.gateway.closed;
      expect(f.log.warn).toHaveBeenCalledWith(`discord_gateway_identify_refused:${reason}`);
      expect(
        jest
          .mocked(f.log.warn)
          .mock.calls.filter(([event]) =>
            String(event).startsWith('discord_gateway_identify_refused'),
          ),
      ).toHaveLength(1);
      expect(observed.filter((item) => item.type === 'stop')).toEqual([
        { type: 'stop', reason: stop },
      ]);
      expect(f.gateway.failure).toMatchObject({ reason: stop });
      expect(JSON.stringify(jest.mocked(f.log.warn).mock.calls)).not.toMatch(/private|token/);
    },
  );
});

describe('owned Discord Gateway startup bound', () => {
  beforeEach(() => jest.useFakeTimers({ now: 1_700_000_000_000 }));
  afterEach(() => jest.useRealTimers());
  const stages = { handshakeTimeoutMs: 1000, readyTimeoutMs: 2000 };

  test('stops a startup that never reaches READY after the time its own stage timeouts allow', async () => {
    const f = fixture(shared(), '123', '456', stages);
    f.hooks.silent = true;
    const started = f.start();
    const outcome = jest.fn();
    void started.catch(outcome);
    // The REST read, the socket and HELLO may each take the handshake timeout, and READY its own.
    await jest.advanceTimersByTimeAsync(4999);
    expect(outcome).not.toHaveBeenCalled();
    expect(f.log.warn).not.toHaveBeenCalledWith('discord_gateway_start_timeout');
    await jest.advanceTimersByTimeAsync(1);
    await expect(started).rejects.toMatchObject({ reason: 'failed', fatal: false });
    expect(f.log.warn).toHaveBeenCalledWith('discord_gateway_start_timeout');
    expect(f.destroy).toHaveBeenCalledTimes(1);
    expect(f.store.locks.size).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('gives every further shard Discord spacing for its IDENTIFY on top', async () => {
    const f = fixture(shared(), '123', '456', { ...stages, shardCount: 3 });
    f.hooks.silent = true;
    const started = f.start();
    const outcome = jest.fn();
    void started.catch(outcome);
    await jest.advanceTimersByTimeAsync(5000 + 2 * 6500 - 1);
    expect(outcome).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    await expect(started).rejects.toMatchObject({ reason: 'failed' });
    expect(jest.getTimerCount()).toBe(0);
  });

  test('a startup that reaches READY keeps no deadline behind', async () => {
    const f = fixture(shared(), '123', '456', stages);
    await expect(f.start()).resolves.toBe(true);
    await jest.advanceTimersByTimeAsync(9000);
    expect(f.log.warn).not.toHaveBeenCalledWith('discord_gateway_start_timeout');
    expect(f.destroy).not.toHaveBeenCalled();
    await f.gateway.stop();
    expect(jest.getTimerCount()).toBe(0);
  });

  test('shutdown during the wait ends it without a timeout and without a failure', async () => {
    const f = fixture(shared(), '123', '456', stages);
    f.hooks.silent = true;
    const started = f.start();
    await jest.advanceTimersByTimeAsync(1000);
    f.controller.abort();
    await expect(started).resolves.toBe(false);
    expect(f.gateway.failure).toBeUndefined();
    expect(f.log.warn).not.toHaveBeenCalledWith('discord_gateway_start_timeout');
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('owned Discord Gateway against a real Gateway socket', () => {
  test('a Gateway that never answers an IDENTIFY stops the session after exactly one IDENTIFY', async () => {
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;
    const seen = { connections: 0, identifies: 0 };
    server.on('connection', (socket) => {
      seen.connections++;
      socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 45_000 } }));
      socket.on('message', (raw) => {
        if (JSON.parse(String(raw)).op !== 2) return;
        seen.identifies++;
        socket.close(4000);
      });
    });
    const transport: typeof fetch = async () =>
      Response.json({
        url: `ws://127.0.0.1:${port}`,
        shards: 1,
        session_start_limit: {
          total: 1000,
          remaining: 999,
          reset_after: 86_400_000,
          max_concurrency: 1,
        },
      });
    const log: Logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    const store = shared();
    const gateway = new OwnedDiscordGateway(
      {
        applicationId: '123',
        applicationRevision: 'revision-1',
        botUserId: '456',
        botToken: 'private-bot-token',
      },
      {
        ...store,
        log,
        dispatch: async () => undefined,
        createDriver: (options) => createDiscordGatewayDriver(options, transport),
      },
      { enabled: true, gateway: { enabled: true, handshakeTimeoutMs: 1000, readyTimeoutMs: 5000 } },
    );
    await expect(gateway.start(new AbortController().signal)).rejects.toMatchObject({
      reason: 'failed',
    });
    expect(seen.identifies).toBe(1);
    expect(log.warn).toHaveBeenCalledWith('discord_gateway_identify_refused:retry');
    expect(log.warn).not.toHaveBeenCalledWith('discord_gateway_start_timeout');
    expect(store.locks.size).toBe(0);
    for (const client of server.clients) client.terminate();
    await new Promise((resolve) => server.close(resolve));
  });

  test('a Gateway that never says HELLO is stopped at the deadline instead of being retried forever', async () => {
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;
    const seen = { connections: 0, identifies: 0 };
    server.on('connection', (socket) => {
      seen.connections++;
      socket.on('message', (raw) => {
        if (JSON.parse(String(raw)).op === 2) seen.identifies++;
      });
    });
    const transport: typeof fetch = async () =>
      Response.json({
        url: `ws://127.0.0.1:${port}`,
        shards: 1,
        session_start_limit: {
          total: 1000,
          remaining: 999,
          reset_after: 86_400_000,
          max_concurrency: 1,
        },
      });
    const store = shared();
    const log: Logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    const gateway = new OwnedDiscordGateway(
      {
        applicationId: '123',
        applicationRevision: 'revision-1',
        botUserId: '456',
        botToken: 'private-bot-token',
      },
      {
        ...store,
        log,
        dispatch: async () => undefined,
        createDriver: (options) => createDiscordGatewayDriver(options, transport),
      },
      { enabled: true, gateway: { enabled: true, handshakeTimeoutMs: 1000, readyTimeoutMs: 1000 } },
    );
    const startedAt = Date.now();
    await expect(gateway.start(new AbortController().signal)).rejects.toMatchObject({
      reason: 'failed',
    });
    const elapsed = Date.now() - startedAt;
    // 3 x 1000 + 1000 ms. Without the deadline the SDK would reconnect every 1.5 s for as long as it ran.
    expect(elapsed).toBeGreaterThanOrEqual(3900);
    expect(elapsed).toBeLessThan(7000);
    expect(seen.connections).toBeGreaterThanOrEqual(2);
    expect(seen.identifies).toBe(0);
    expect(log.warn).toHaveBeenCalledWith('discord_gateway_start_timeout');
    expect(store.locks.size).toBe(0);
    for (const client of server.clients) client.terminate();
    await new Promise((resolve) => server.close(resolve));
  });
});
