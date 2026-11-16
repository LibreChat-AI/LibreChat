import { discordChannelConfigSchema } from 'librechat-data-provider';
import { DiscordGatewayFailure, discordRetryDelay } from './recovery';

const gateway = (recovery = {}, pollIntervalMs = 1000) =>
  discordChannelConfigSchema.parse({ gateway: { pollIntervalMs, recovery } }).gateway;
const fresh = () => ({ fatalFailures: 0, transientFailures: 0 });

describe('Discord retry ladder', () => {
  test('a fatal delay starts at the minimum, doubles exactly and stops at the cap', () => {
    const policy = gateway({ fatalRetryMinMs: 30_000, fatalRetryMaxMs: 100_000 });
    const state = fresh();
    const waits = Array.from(
      { length: 5 },
      () =>
        discordRetryDelay(state, new DiscordGatewayFailure('configuration'), policy, () => 0)
          .waitMs,
    );
    expect(waits).toEqual([30_000, 60_000, 100_000, 100_000, 100_000]);
    expect(state).toEqual({ fatalFailures: 5, transientFailures: 0 });
  });

  test.each([
    ['credentials', true],
    ['configuration', true],
    ['identity', true],
    ['startup', true],
    ['checkpoint', false],
    ['failed', false],
    ['backpressure', false],
    ['dispatch', false],
  ] as const)('a %s failure is fatal: %s', (reason, fatal) => {
    expect(new DiscordGatewayFailure(reason).fatal).toBe(fatal);
  });

  test('a session that cannot start keeps the fatal ladder however long it goes on', () => {
    // The delay comes from policy alone: a startup failure carries none, and Discord's own reset time
    // is never read, so a spent budget costs one retry per rung and a Gateway that is down never faster.
    const policy = gateway({ fatalRetryMinMs: 30_000, fatalRetryMaxMs: 900_000 }, 1000);
    const state = fresh();
    const waits = Array.from(
      { length: 9 },
      () => discordRetryDelay(state, new DiscordGatewayFailure('startup'), policy, () => 0).waitMs,
    );
    expect(waits).toEqual([
      30_000, 60_000, 120_000, 240_000, 480_000, 900_000, 900_000, 900_000, 900_000,
    ]);
    expect(state).toEqual({ fatalFailures: 9, transientFailures: 0 });
  });

  test('a verified session starts both ladders again, so a transient failure after startup failures is short', () => {
    const policy = gateway({ resetAfterMs: 120_000, fatalRetryMinMs: 30_000 }, 1000);
    const state = { fatalFailures: 6, transientFailures: 0 };
    const dropped = new DiscordGatewayFailure('failed', 120_000);
    expect(discordRetryDelay(state, dropped, policy, () => 1)).toEqual({
      fatal: false,
      waitMs: 1000,
    });
    expect(state).toEqual({ fatalFailures: 0, transientFailures: 1 });
    // A session that did not last the reset window does not erase the startup failures counted so far.
    const early = new DiscordGatewayFailure('startup', 119_999);
    expect(discordRetryDelay(state, early, policy)).toEqual({ fatal: true, waitMs: 30_000 });
    expect(discordRetryDelay(state, early, policy)).toEqual({ fatal: true, waitMs: 60_000 });
    expect(state).toEqual({ fatalFailures: 2, transientFailures: 1 });
  });

  test('a transient delay starts at the poll interval and takes equal jitter below the cap', () => {
    const policy = gateway({ retryMaxMs: 8000 }, 1000);
    const state = fresh();
    const low = discordRetryDelay(state, new DiscordGatewayFailure('failed'), policy, () => 0);
    const high = discordRetryDelay(state, new DiscordGatewayFailure('failed'), policy, () => 1);
    expect(low).toEqual({ fatal: false, waitMs: 500 });
    expect(high).toEqual({ fatal: false, waitMs: 2000 });
    const capped = fresh();
    for (let index = 0; index < 10; index++)
      discordRetryDelay(capped, new Error('x'), policy, () => 1);
    expect(discordRetryDelay(capped, new Error('x'), policy, () => 1).waitMs).toBe(8000);
    expect(discordRetryDelay(capped, new Error('x'), policy, () => 0).waitMs).toBe(4000);
  });

  test('a delay is never below one millisecond, and an unusable random source waits in full', () => {
    const policy = gateway({}, 100);
    expect(discordRetryDelay(fresh(), new Error('x'), policy, () => 0).waitMs).toBe(50);
    expect(discordRetryDelay(fresh(), new Error('x'), policy, () => Number.NaN).waitMs).toBe(100);
    expect(discordRetryDelay(fresh(), new Error('x'), policy, () => -5).waitMs).toBe(50);
    expect(discordRetryDelay(fresh(), new Error('x'), policy, () => 9).waitMs).toBe(100);
  });

  test('fatal and transient failures keep separate counters', () => {
    const policy = gateway({ fatalRetryMinMs: 4000 }, 1000);
    const state = fresh();
    expect(discordRetryDelay(state, new DiscordGatewayFailure('credentials'), policy).waitMs).toBe(
      4000,
    );
    expect(discordRetryDelay(state, new Error('x'), policy, () => 1).waitMs).toBe(1000);
    expect(discordRetryDelay(state, new DiscordGatewayFailure('credentials'), policy).waitMs).toBe(
      8000,
    );
    expect(state).toEqual({ fatalFailures: 2, transientFailures: 1 });
  });

  test('only a failure after a verified session of the reset window starts the ladder again', () => {
    const policy = gateway({ resetAfterMs: 120_000, fatalRetryMinMs: 5000 });
    const state = { fatalFailures: 3, transientFailures: 3 };
    discordRetryDelay(state, new DiscordGatewayFailure('configuration', 119_999), policy);
    expect(state).toEqual({ fatalFailures: 4, transientFailures: 3 });
    const wait = discordRetryDelay(
      state,
      new DiscordGatewayFailure('configuration', 120_000),
      policy,
    );
    expect(wait).toEqual({ fatal: true, waitMs: 5000 });
    expect(state).toEqual({ fatalFailures: 1, transientFailures: 0 });
    discordRetryDelay(
      state,
      new Error('a long lived session that is not a Gateway failure'),
      policy,
    );
    expect(state).toEqual({ fatalFailures: 1, transientFailures: 1 });
  });

  test('counters stop growing at 31, so the exponent cannot overflow', () => {
    const policy = gateway({ fatalRetryMaxMs: 86_400_000 });
    const state = { fatalFailures: 31, transientFailures: 31 };
    expect(discordRetryDelay(state, new DiscordGatewayFailure('identity'), policy).waitMs).toBe(
      86_400_000,
    );
    expect(discordRetryDelay(state, new Error('x'), policy, () => 1).waitMs).toBe(60_000);
    expect(state).toEqual({ fatalFailures: 31, transientFailures: 31 });
  });
});
