import { discordChannelConfigSchema } from 'librechat-data-provider';
import { GatewayDispatchEvents, ApplicationFlags } from 'discord-api-types/v10';
import type { DiscordGatewayDriverOptions } from './socket';
import { DiscordGatewayControlClient } from './ownership';
import { runDiscordSession } from './session';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const owner = { applicationId: '123', applicationRevision: 'revision', ownerId: 'a'.repeat(32) };
const policy = discordChannelConfigSchema.parse({ enabled: true, gateway: { enabled: true } });
const bot = {
  id: '456',
  bot: true,
  username: 'bot',
  discriminator: '0',
  global_name: null,
  avatar: null,
};

function fixture(renewal = true) {
  const connected = deferred<DiscordGatewayDriverOptions>();
  const controller = new AbortController();
  const calls: string[] = [];
  const transport: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    calls.push(path);
    const body = JSON.parse(String(init?.body));
    expect(body.owner).toEqual(owner);
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer service-token');
    if (path.endsWith('/bootstrap'))
      return Response.json({
        ...owner,
        ownerId: undefined,
        botUserId: bot.id,
        botToken: 'private-token',
        policy: policy.gateway,
      });
    if (path.endsWith('/load'))
      return Response.json({
        applicationId: owner.applicationId,
        applicationRevision: owner.applicationRevision,
        botUserId: bot.id,
        checkpoints: [],
      });
    if (path.endsWith('/acquire') || path.endsWith('/renew')) {
      expect(body.leaseMs).toBe(policy.gateway.ownershipLeaseMs);
      return renewal ? new Response(null, { status: 204 }) : Response.json({}, { status: 409 });
    }
    if (path.endsWith('/save')) return new Response(null, { status: 204 });
    throw new Error('Unexpected service call');
  };
  const ownership = new DiscordGatewayControlClient(
    {
      CHANNEL_SERVICE_TOKEN: 'service-token',
      LIBRECHAT_INTERNAL_URL: 'http://localhost:3080',
      API_CALL_TIMEOUT_MS: 1000,
    },
    transport,
  );
  const destroy = jest.fn(async () => {});
  const createDriver = (options: DiscordGatewayDriverOptions) => ({
    destroy,
    async connect() {
      await options.updateSessionInfo(0, {
        sessionId: 'session',
        sequence: 1,
        shardId: 0,
        shardCount: 1,
        resumeURL: 'wss://gateway.discord.gg',
      });
      options.ready({
        shardId: 0,
        data: {
          v: 10,
          user: bot,
          application: {
            id: owner.applicationId,
            flags: ApplicationFlags.GatewayMessageContentLimited,
            flags_new: '0',
          },
          session_id: 'session',
          resume_gateway_url: 'wss://gateway.discord.gg',
          guilds: [],
        },
      });
      connected.resolve(options);
    },
  });
  const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { connected, controller, calls, ownership, destroy, createDriver, log };
}

it('shares the exact owner with the SDK and leaves release to the outer application', async () => {
  const f = fixture();
  const run = runDiscordSession(
    { ...f, owner, policy, dispatch: async () => {} },
    f.controller.signal,
  );
  await f.connected.promise;
  f.controller.abort();
  await run;
  expect(f.calls.some((path) => path.endsWith('/renew'))).toBe(true);
  expect(f.calls.some((path) => path.endsWith('/acquire'))).toBe(false);
  expect(f.calls.some((path) => path.endsWith('/release'))).toBe(false);
  expect(f.destroy).toHaveBeenCalledTimes(1);
});

it('aborts intake immediately but drains the durable callback before returning', async () => {
  const f = fixture();
  const entered = deferred<AbortSignal>();
  const drained = deferred<void>();
  let done = false;
  const run = runDiscordSession(
    {
      ...f,
      owner,
      policy,
      dispatch: async (application, event, signal) => {
        expect(application.botUserId).toBe(bot.id);
        expect(event.ownerId).toBe(owner.ownerId);
        entered.resolve(signal);
        await drained.promise;
      },
    },
    f.controller.signal,
  ).finally(() => {
    done = true;
  });
  const driver = await f.connected.promise;
  driver.dispatch({
    shardId: 0,
    data: {
      op: 0,
      s: 2,
      t: GatewayDispatchEvents.GuildDelete,
      d: { id: '900', unavailable: true },
    },
  });
  const signal = await entered.promise;
  f.controller.abort();
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(signal.aborted).toBe(true);
  expect(f.destroy).toHaveBeenCalledTimes(1);
  expect(done).toBe(false);
  drained.resolve();
  await run;
  expect(done).toBe(true);
  expect(f.calls.some((path) => path.endsWith('/release'))).toBe(false);
});

it('does not bootstrap credentials for an already aborted owner', async () => {
  const f = fixture();
  f.controller.abort();
  await expect(
    runDiscordSession({ ...f, owner, policy, dispatch: async () => {} }, f.controller.signal),
  ).rejects.toThrow();
  expect(f.calls).toEqual([]);
  expect(f.destroy).not.toHaveBeenCalled();
});

it('never reacquires or starts the socket when the outer lease has already been released', async () => {
  const f = fixture(false);
  await runDiscordSession({ ...f, owner, policy, dispatch: async () => {} }, f.controller.signal);
  expect(f.calls.some((path) => path.endsWith('/renew'))).toBe(true);
  expect(f.calls.some((path) => path.endsWith('/acquire'))).toBe(false);
  expect(f.calls.some((path) => path.endsWith('/load'))).toBe(false);
  expect(f.destroy).not.toHaveBeenCalled();
});
