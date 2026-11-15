import { GatewayDispatchEvents, ApplicationFlags } from 'discord-api-types/v10';
import type { SessionInfo } from '@discordjs/ws';
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
import type { Logger } from '../types';
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
  policy: { shardCount?: number; maxQueuedEvents?: number } = {},
  ownerId?: string,
) {
  const hooks: {
    dispatch?: (event: DiscordGatewayEvent, signal: AbortSignal) => Promise<void>;
    connect?: () => Promise<void>;
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
      async dispatch(event, signal) {
        if (hooks.dispatch) await hooks.dispatch(event, signal);
        seen.push(event);
      },
      createDriver(options) {
        drivers.push(options);
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
