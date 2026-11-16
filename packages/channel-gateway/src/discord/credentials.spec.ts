import type { DiscordApplicationObservation } from './observe';
import { DiscordCredentialReporter } from './credentials';
import { discordCredentialObservation } from './observe';

const owner = {
  applicationId: '123456789012345678',
  applicationRevision: 'revision',
  ownerId: 'a'.repeat(32),
};
const valid: DiscordApplicationObservation = { type: 'session', event: 'ready', shardId: 0 };
const invalid: DiscordApplicationObservation = { type: 'stop', reason: 'credentials' };
const settle = async (): Promise<void> => {
  for (let index = 0; index < 10; index++) await Promise.resolve();
};

describe('credential evidence', () => {
  it.each([200, 204, 299, 401])('accepts bot REST status %s', (status) => {
    expect(discordCredentialObservation({ type: 'rest', route: 'GET /gateway/bot', status })).toBe(
      status === 401 ? 'invalid' : 'valid',
    );
  });

  it.each([undefined, 199, 302, 403, 404, 429, 500, 503, 600, 200.5, NaN])(
    'ignores ambiguous bot REST status %s',
    (status) => {
      expect(
        discordCredentialObservation({ type: 'rest', route: 'GET /gateway/bot', status }),
      ).toBeUndefined();
    },
  );

  it.each(['PATCH /webhooks/:id/:token/messages/@original', 'GET /unknown', 'GET /channels/123'])(
    'does not infer bot validity from %s',
    (route) => {
      for (const status of [200, 401])
        expect(discordCredentialObservation({ type: 'rest', route, status })).toBeUndefined();
    },
  );

  it.each<DiscordApplicationObservation>([
    { type: 'permission', outcome: 'denied' },
    { type: 'stop', reason: 'configuration' },
    { type: 'stop', reason: 'identity' },
    { type: 'session', event: 'closed_fatal', shardId: 0 },
    { type: 'session', event: 'closed_transient', shardId: 0 },
    { type: 'heartbeat', shardId: 0, latencyMs: 20 },
  ])('ignores non-credential evidence %j', (observation) => {
    expect(discordCredentialObservation(observation)).toBeUndefined();
  });

  it('recognizes authenticated sessions and an explicit credential stop', () => {
    expect(discordCredentialObservation(valid)).toBe('valid');
    expect(discordCredentialObservation({ type: 'session', event: 'resumed', shardId: 0 })).toBe(
      'valid',
    );
    expect(discordCredentialObservation(invalid)).toBe('invalid');
  });
});

describe('lease-scoped credential reporter', () => {
  function setup() {
    let now = 100;
    const write = jest.fn(async () => true);
    const reporter = new DiscordCredentialReporter({
      owner,
      write,
      intervalMs: 1000,
      now: () => now,
    });
    return { reporter, write, clock: (value: number) => (now = value) };
  }

  it('coalesces bursts, records changes immediately and refreshes only with fresh evidence', async () => {
    const { reporter, write, clock } = setup();
    for (let index = 0; index < 1000; index++) reporter.observe(valid);
    await settle();
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenLastCalledWith(owner, 'valid', 1);
    clock(1099);
    reporter.observe(valid);
    await settle();
    expect(write).toHaveBeenCalledTimes(1);
    clock(1100);
    reporter.observe(valid);
    await settle();
    expect(write).toHaveBeenCalledTimes(2);
    reporter.observe(invalid);
    await settle();
    expect(write).toHaveBeenLastCalledWith(owner, 'invalid', 3);
    clock(100000);
    await reporter.close();
    expect(write).toHaveBeenCalledTimes(3);
    reporter.observe(valid);
    await settle();
    expect(write).toHaveBeenCalledTimes(3);
  });

  it('serializes writes and flushes the latest pending state before lease release', async () => {
    const { reporter, write } = setup();
    let finish: (value: boolean) => void = () => undefined;
    write.mockImplementationOnce(() => new Promise<boolean>((resolve) => (finish = resolve)));
    reporter.observe(valid);
    await settle();
    reporter.observe(invalid);
    reporter.observe(valid);
    reporter.observe(invalid);
    let closed = false;
    const closing = reporter.close().then(() => (closed = true));
    reporter.observe(valid);
    await settle();
    expect(closed).toBe(false);
    expect(write).toHaveBeenCalledTimes(1);
    finish(true);
    await closing;
    expect(write.mock.calls).toEqual([
      [owner, 'valid', 1],
      [owner, 'invalid', 2],
    ]);
  });

  it('discards pending and future observations after loss of ownership', async () => {
    const { reporter, write } = setup();
    let finish: (value: boolean) => void = () => undefined;
    write.mockImplementationOnce(() => new Promise<boolean>((resolve) => (finish = resolve)));
    reporter.observe(valid);
    await settle();
    reporter.observe(invalid);
    finish(false);
    await settle();
    reporter.observe(invalid);
    await reporter.close();
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('bounds outage retries without treating failed persistence as invalid credentials', async () => {
    const { reporter, write, clock } = setup();
    write.mockRejectedValueOnce(new Error('private-provider-content'));
    reporter.observe(valid);
    await settle();
    reporter.observe(valid);
    await settle();
    expect(write).toHaveBeenCalledTimes(1);
    clock(1100);
    reporter.observe(valid);
    await reporter.close();
    expect(write.mock.calls).toEqual([
      [owner, 'valid', 1],
      [owner, 'valid', 2],
    ]);
  });

  it('does not retry identical evidence when the clock steps backwards', async () => {
    const { reporter, write, clock } = setup();
    reporter.observe(valid);
    await settle();
    clock(1);
    reporter.observe(valid);
    await reporter.close();
    expect(write).toHaveBeenCalledTimes(1);
  });
});
