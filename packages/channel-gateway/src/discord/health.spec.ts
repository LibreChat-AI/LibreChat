import { discordChannelConfigSchema } from 'librechat-data-provider';
import type { DiscordQuarantineSummary } from './health';
import type { DiscordGatewayOwner } from './gateway';
import { DEFAULT_DISCORD_HEALTH_POLICY, DiscordHealth, discordHealthLevels } from './health';

const { staleAfterMs: stale, observationTtlMs: ttl } = DEFAULT_DISCORD_HEALTH_POLICY;
const owner = (
  applicationId = '111111111111111111',
  applicationRevision = 'revision-a',
  ownerId = 'a'.repeat(32),
): DiscordGatewayOwner => ({ applicationId, applicationRevision, ownerId });

let now = 1_000_000;
const advance = (milliseconds: number) => {
  now += milliseconds;
};
const create = (quarantine?: () => DiscordQuarantineSummary) =>
  new DiscordHealth({ now: () => now, quarantine });

describe('Discord health policy', () => {
  beforeEach(() => {
    now = 1_000_000;
  });

  test('defaults to the documented windows, taken from the config schema', () => {
    expect(DEFAULT_DISCORD_HEALTH_POLICY).toEqual({
      staleAfterMs: 120_000,
      observationTtlMs: 3_600_000,
      observationRetryMs: 30_000,
      permissionWindow: 3,
      taskWindow: 8,
    });
    expect(DEFAULT_DISCORD_HEALTH_POLICY).toEqual(discordChannelConfigSchema.parse({}).health);
  });

  test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid policy values %p',
    (value) => {
      expect(() => new DiscordHealth({ staleAfterMs: value })).toThrow(TypeError);
      expect(() => new DiscordHealth({ observationTtlMs: value })).toThrow(TypeError);
      expect(() => new DiscordHealth({ observationRetryMs: value })).toThrow(TypeError);
      expect(() => new DiscordHealth({ permissionWindow: value })).toThrow(TypeError);
      expect(() => new DiscordHealth({ taskWindow: value })).toThrow(TypeError);
    },
  );

  test('uses the injected windows instead of the defaults', () => {
    const health = new DiscordHealth({
      now: () => now,
      staleAfterMs: 1000,
      observationTtlMs: 5000,
    });
    const entry = health.entry(owner(), { shards: 0 });
    entry.credential('ok');
    advance(5000);
    expect(health.snapshot().credentials.healthy).toBe(1);
    advance(1);
    expect(health.snapshot().credentials).toMatchObject({ healthy: 0, unknown: 1 });
  });
});

describe('Discord workers health', () => {
  beforeEach(() => {
    now = 1_000_000;
  });

  test('is unknown before any discovery, and until both sources have succeeded', () => {
    const health = create();
    expect(health.snapshot().workers).toBe('unknown');
    health.discovery('applications', true);
    expect(health.snapshot().workers).toBe('unknown');
    health.discovery('channels', true);
    expect(health.snapshot().workers).toBe('healthy');
  });

  test('a failure degrades, then fails once no success has been seen for the stale window', () => {
    const health = create();
    health.discovery('applications', true);
    health.discovery('channels', true);
    advance(1000);
    health.discovery('channels', false);
    expect(health.snapshot().workers).toBe('degraded');
    advance(stale - 1001);
    expect(health.snapshot().workers).toBe('degraded');
    advance(1);
    expect(health.snapshot().workers).toBe('failing');
    health.discovery('channels', true);
    expect(health.snapshot().workers).toBe('healthy');
  });

  test('a source that never succeeded degrades first and fails after the stale window', () => {
    const health = create();
    health.discovery('applications', true);
    health.discovery('channels', false);
    expect(health.snapshot().workers).toBe('degraded');
    advance(stale);
    health.discovery('applications', true);
    expect(health.snapshot().workers).toBe('failing');
  });

  test('silence decays at read time without any failure being reported', () => {
    const health = create();
    health.discovery('applications', true);
    health.discovery('channels', true);
    advance(stale);
    expect(health.snapshot().workers).toBe('healthy');
    advance(1);
    expect(health.snapshot().workers).toBe('failing');
  });

  test('a recent window made only of failed tasks degrades healthy discovery', () => {
    const health = create();
    health.discovery('applications', true);
    health.discovery('channels', true);
    health.task(false);
    health.task(false);
    expect(health.snapshot().workers).toBe('degraded');
    health.task(true);
    expect(health.snapshot().workers).toBe('healthy');
  });

  test('old task failures stop counting, and tasks never change a worse discovery verdict', () => {
    const health = create();
    health.discovery('applications', true);
    health.discovery('channels', true);
    health.task(false);
    advance(stale);
    health.discovery('applications', true);
    health.discovery('channels', true);
    expect(health.snapshot().workers).toBe('degraded');
    advance(1);
    health.discovery('applications', true);
    health.discovery('channels', true);
    expect(health.snapshot().workers).toBe('healthy');
    health.discovery('channels', false);
    health.task(true);
    expect(health.snapshot().workers).toBe('degraded');
    const unseen = create();
    unseen.task(false);
    expect(unseen.snapshot().workers).toBe('unknown');
  });

  test('keeps only a bounded window of task outcomes', () => {
    const health = create();
    health.discovery('applications', true);
    health.discovery('channels', true);
    health.task(true);
    for (let index = 0; index < 8; index++) health.task(false);
    expect(health.snapshot().workers).toBe('degraded');
  });

  test('a configured task window decides how many recent outcomes count', () => {
    const health = new DiscordHealth({ now: () => now, taskWindow: 2 });
    health.discovery('applications', true);
    health.discovery('channels', true);
    health.task(true);
    health.task(false);
    expect(health.snapshot().workers).toBe('healthy');
    health.task(false);
    expect(health.snapshot().workers).toBe('degraded');
    health.task(true);
    expect(health.snapshot().workers).toBe('healthy');
    const wide = new DiscordHealth({ now: () => now, taskWindow: 20 });
    wide.discovery('applications', true);
    wide.discovery('channels', true);
    wide.task(true);
    for (let index = 0; index < 19; index++) wide.task(false);
    expect(wide.snapshot().workers).toBe('healthy');
    wide.task(false);
    expect(wide.snapshot().workers).toBe('degraded');
  });
});

describe('Discord credentials health', () => {
  beforeEach(() => {
    now = 1_000_000;
  });

  test('starts unknown, becomes healthy on a positive observation and decays to unknown', () => {
    const health = create();
    const entry = health.entry(owner(), { shards: 0 });
    expect(health.snapshot().credentials).toMatchObject({ unknown: 1, healthy: 0 });
    entry.credential('ok');
    expect(health.snapshot().credentials).toMatchObject({ unknown: 0, healthy: 1 });
    advance(ttl);
    expect(health.snapshot().credentials.healthy).toBe(1);
    advance(1);
    expect(health.snapshot().credentials).toMatchObject({ unknown: 1, healthy: 0 });
  });

  test('a rejection fails until a later positive observation, and the latest one wins', () => {
    const health = create();
    const entry = health.entry(owner(), { shards: 0 });
    entry.credential('ok');
    advance(10);
    entry.credential('rejected');
    expect(health.snapshot().credentials.failing).toBe(1);
    advance(10);
    entry.credential('ok');
    expect(health.snapshot().credentials).toMatchObject({ failing: 0, healthy: 1 });
    entry.credential('rejected');
    expect(health.snapshot().credentials.failing).toBe(1);
  });

  test('a rejection is also an observation and decays to unknown', () => {
    const health = create();
    health.entry(owner(), { shards: 0 }).credential('rejected');
    advance(ttl + 1);
    expect(health.snapshot().credentials).toMatchObject({ failing: 0, unknown: 1 });
  });
});

describe('Discord permissions health', () => {
  beforeEach(() => {
    now = 1_000_000;
  });
  const level = (health: DiscordHealth) =>
    Object.entries(health.snapshot().permissions).find(([, count]) => count === 1)?.[0];

  test('is unknown without outcomes and healthy while the last three are fine', () => {
    const health = create();
    const entry = health.entry(owner(), { shards: 0 });
    expect(level(health)).toBe('unknown');
    entry.permission('ok');
    expect(level(health)).toBe('healthy');
  });

  test('any denial in the last three degrades, and three denials in a row fail', () => {
    const health = create();
    const entry = health.entry(owner(), { shards: 0 });
    entry.permission('denied');
    expect(level(health)).toBe('degraded');
    entry.permission('denied');
    expect(level(health)).toBe('degraded');
    entry.permission('denied');
    expect(level(health)).toBe('failing');
    entry.permission('ok');
    expect(level(health)).toBe('degraded');
    entry.permission('ok');
    expect(level(health)).toBe('degraded');
    entry.permission('ok');
    expect(level(health)).toBe('healthy');
  });

  test('a configured permission window decides how many denials in a row fail', () => {
    const health = new DiscordHealth({ now: () => now, permissionWindow: 2 });
    const entry = health.entry(owner(), { shards: 0 });
    entry.permission('denied');
    expect(level(health)).toBe('degraded');
    entry.permission('denied');
    expect(level(health)).toBe('failing');
    entry.permission('ok');
    entry.permission('ok');
    expect(level(health)).toBe('healthy');
    const wide = new DiscordHealth({ now: () => now, permissionWindow: 5 });
    const tracked = wide.entry(owner('222222222222222222'), { shards: 0 });
    for (let index = 0; index < 4; index++) tracked.permission('denied');
    expect(level(wide)).toBe('degraded');
    tracked.permission('denied');
    expect(level(wide)).toBe('failing');
  });

  test('each outcome expires on its own after the observation window', () => {
    const health = create();
    const entry = health.entry(owner(), { shards: 0 });
    entry.permission('denied');
    advance(ttl);
    entry.permission('ok');
    advance(1);
    expect(level(health)).toBe('healthy');
    advance(ttl);
    expect(level(health)).toBe('unknown');
  });
});

describe('Discord native Gateway health', () => {
  beforeEach(() => {
    now = 1_000_000;
  });
  const level = (health: DiscordHealth) =>
    Object.entries(health.snapshot().native).find(([, count]) => count === 1)?.[0];

  test('is disabled when the Gateway is off, whatever signals arrive', () => {
    const health = create();
    const entry = health.entry(owner(), { shards: 0 });
    entry.native('up', 0);
    entry.fatal();
    expect(level(health)).toBe('disabled');
  });

  test('is unknown before the first READY and healthy once up', () => {
    const health = create();
    const entry = health.entry(owner(), { shards: 1 });
    expect(level(health)).toBe('unknown');
    entry.native('up', 0);
    expect(level(health)).toBe('healthy');
  });

  test('missing acknowledgements degrade after the stale window and an ack recovers', () => {
    const health = create();
    const entry = health.entry(owner(), { shards: 1 });
    entry.native('up', 0);
    advance(stale);
    expect(level(health)).toBe('healthy');
    advance(1);
    expect(level(health)).toBe('degraded');
    entry.native('ack', 0);
    expect(level(health)).toBe('healthy');
  });

  test('a non-fatal close degrades until the shard is up again, even before the first READY', () => {
    const health = create();
    const entry = health.entry(owner(), { shards: 1 });
    entry.native('closed', 0);
    expect(level(health)).toBe('degraded');
    entry.native('up', 0);
    expect(level(health)).toBe('healthy');
    entry.native('closed', 0);
    entry.native('ack', 0);
    expect(level(health)).toBe('degraded');
  });

  test('a gap degrades only inside the stale window', () => {
    const health = create();
    const entry = health.entry(owner(), { shards: 1 });
    entry.native('up', 0);
    entry.native('gap', 0);
    expect(level(health)).toBe('degraded');
    advance(stale);
    entry.native('ack', 0);
    expect(level(health)).toBe('degraded');
    advance(1);
    entry.native('ack', 0);
    expect(level(health)).toBe('healthy');
  });

  test('a fatal stop fails until the next READY or RESUMED, and an acknowledgement does not recover it', () => {
    const health = create();
    const entry = health.entry(owner(), { shards: 1 });
    entry.native('up', 0);
    entry.fatal();
    entry.native('ack', 0);
    expect(level(health)).toBe('failing');
    entry.native('closed', 0);
    expect(level(health)).toBe('failing');
    entry.native('up', 0);
    expect(level(health)).toBe('healthy');
  });

  test('a fatal stop closes every shard, so one READY cannot make the application healthy', () => {
    const health = create();
    const entry = health.entry(owner(), { shards: 2 });
    entry.native('up', 0);
    entry.native('up', 1);
    expect(level(health)).toBe('healthy');
    entry.fatal();
    expect(level(health)).toBe('failing');
    // A late acknowledgement from the session that ended cannot recover a closed shard.
    entry.native('ack', 1);
    // The replacement session reaches READY on shard 0 only: shard 1 keeps nothing of the old one.
    entry.native('up', 0);
    expect(level(health)).toBe('degraded');
    entry.native('ack', 1);
    advance(stale + 1);
    entry.native('ack', 0);
    expect(level(health)).toBe('degraded');
    entry.native('up', 1);
    expect(level(health)).toBe('healthy');
  });

  test('after a fatal stop every shard still needs its own READY, even one that never connected', () => {
    const health = create();
    const entry = health.entry(owner(), { shards: 2 });
    entry.native('up', 0);
    entry.fatal();
    entry.native('up', 0);
    expect(level(health)).toBe('unknown');
    entry.native('up', 1);
    expect(level(health)).toBe('healthy');
  });

  test('a fatal stop changes only the native level, never the credential or permission levels', () => {
    const health = create();
    const entry = health.entry(owner(), { shards: 2 });
    entry.credential('rejected');
    entry.permission('denied');
    entry.native('up', 0);
    entry.native('up', 1);
    const before = health.snapshot();
    expect(before.credentials.failing).toBe(1);
    expect(before.permissions.degraded).toBe(1);
    entry.fatal();
    const after = health.snapshot();
    expect(after.credentials).toEqual(before.credentials);
    expect(after.permissions).toEqual(before.permissions);
    expect(after.native).toMatchObject({ failing: 1, healthy: 0, degraded: 0 });
    entry.native('up', 0);
    expect(health.snapshot().credentials).toEqual(before.credentials);
    expect(health.snapshot().permissions).toEqual(before.permissions);
  });

  test('an ordinary close degrades only until that shard is up again, and an ack does not recover it', () => {
    const health = create();
    const entry = health.entry(owner(), { shards: 2 });
    entry.native('up', 0);
    entry.native('up', 1);
    entry.native('closed', 1);
    expect(level(health)).toBe('degraded');
    entry.native('ack', 1);
    expect(level(health)).toBe('degraded');
    entry.native('up', 1);
    expect(level(health)).toBe('healthy');
  });

  test('the weakest shard decides, and an unreported shard keeps the application unknown', () => {
    const health = create();
    const entry = health.entry(owner(), { shards: 2 });
    entry.native('up', 0);
    expect(level(health)).toBe('unknown');
    entry.native('up', 1);
    expect(level(health)).toBe('healthy');
    advance(stale + 1);
    entry.native('ack', 0);
    expect(level(health)).toBe('degraded');
    entry.native('ack', 1);
    expect(level(health)).toBe('healthy');
  });

  test.each([-1, 1.5, Number.NaN, 2, 1_000_000])(
    'ignores shard id %p outside the shard count',
    (id) => {
      const health = create();
      const entry = health.entry(owner(), { shards: 2 });
      entry.native('up', id);
      entry.native('closed', id);
      expect(level(health)).toBe('unknown');
    },
  );
});

describe('Discord health ownership lifecycle', () => {
  beforeEach(() => {
    now = 1_000_000;
  });

  test('removal drops the application and turns its handle inert', () => {
    const health = create();
    const subject = owner();
    const entry = health.entry(subject, { shards: 1 });
    entry.credential('ok');
    expect(health.snapshot().applications).toBe(1);
    health.remove(subject);
    expect(health.snapshot()).toMatchObject({ applications: 0, credentials: { healthy: 0 } });
    entry.credential('rejected');
    entry.native('up', 0);
    entry.fatal();
    expect(health.snapshot()).toMatchObject({
      applications: 0,
      credentials: { failing: 0 },
      native: { failing: 0 },
    });
  });

  test('a new revision starts at unknown and inherits nothing from the previous owner', () => {
    const health = create();
    const first = health.entry(owner(undefined, 'revision-a', 'a'.repeat(32)), { shards: 1 });
    first.credential('rejected');
    first.native('up', 0);
    first.fatal();
    const second = health.entry(owner(undefined, 'revision-b', 'b'.repeat(32)), { shards: 1 });
    expect(health.snapshot()).toMatchObject({
      applications: 1,
      credentials: { unknown: 1, failing: 0 },
      native: { unknown: 1, failing: 0 },
    });
    first.credential('rejected');
    expect(health.snapshot().credentials.failing).toBe(0);
    second.credential('ok');
    expect(health.snapshot().credentials.healthy).toBe(1);
  });

  test('a late removal by a previous owner leaves the replacement alone', () => {
    const health = create();
    const previous = owner(undefined, 'revision-a', 'a'.repeat(32));
    const replacement = owner(undefined, 'revision-b', 'b'.repeat(32));
    health.entry(previous, { shards: 0 });
    health.entry(replacement, { shards: 0 }).credential('ok');
    health.remove(previous);
    expect(health.snapshot()).toMatchObject({ applications: 1, credentials: { healthy: 1 } });
    health.remove(replacement);
    expect(health.snapshot().applications).toBe(0);
  });

  test('entering the same owner twice shares one record, and removing an unknown owner is a no-op', () => {
    const health = create();
    const subject = owner();
    const first = health.entry(subject, { shards: 0 });
    const second = health.entry(subject, { shards: 0 });
    first.credential('rejected');
    second.credential('ok');
    expect(health.snapshot()).toMatchObject({ applications: 1, credentials: { healthy: 1 } });
    expect(() => health.remove(owner('222222222222222222'))).not.toThrow();
    expect(health.snapshot().applications).toBe(1);
  });

  test.each([
    ['empty application', owner('', 'revision-a', 'a'.repeat(32)), 1],
    ['empty revision', owner(undefined, '', 'a'.repeat(32)), 1],
    ['empty owner', owner(undefined, 'revision-a', ''), 1],
    ['negative shards', owner(), -1],
    ['fractional shards', owner(), 1.5],
  ])('rejects %s', (_name, subject, shards) => {
    expect(() => create().entry(subject, { shards })).toThrow(TypeError);
  });
});

describe('Discord health snapshot', () => {
  beforeEach(() => {
    now = 1_000_000;
  });

  test('counts applications per concern and level, and contains no identifiers', () => {
    const health = create();
    const sentinels = [
      '777777777777777701',
      '777777777777777702',
      'revision-sentinel',
      'c'.repeat(32),
    ];
    const good = health.entry(owner(sentinels[0], sentinels[2], sentinels[3]), { shards: 1 });
    good.credential('ok');
    good.permission('ok');
    good.native('up', 0);
    const bad = health.entry(owner(sentinels[1], sentinels[2], 'd'.repeat(32)), { shards: 0 });
    bad.credential('rejected');
    bad.permission('denied');
    const snapshot = health.snapshot();
    expect(snapshot).toMatchObject({
      applications: 2,
      quarantined: 0,
      credentials: { healthy: 1, failing: 1 },
      permissions: { healthy: 1, degraded: 1 },
      native: { healthy: 1, disabled: 1 },
    });
    expect(Object.keys(snapshot).sort()).toEqual([
      'applications',
      'credentials',
      'native',
      'permissions',
      'quarantined',
      'workers',
    ]);
    const serialized = JSON.stringify(snapshot);
    for (const sentinel of [...sentinels, 'd'.repeat(32)])
      expect(serialized).not.toContain(sentinel);
    for (const concern of ['credentials', 'permissions', 'native'] as const)
      expect(Object.keys(snapshot[concern])).toEqual([...discordHealthLevels]);
  });

  test('returns a fresh object, so a caller cannot change later reads', () => {
    const health = create();
    health.entry(owner(), { shards: 0 });
    const first = health.snapshot();
    first.credentials.healthy = 99;
    first.applications = 99;
    expect(health.snapshot()).toMatchObject({ applications: 1, credentials: { healthy: 0 } });
  });

  test('adds quarantined applications to the concerns they fail without owning them', () => {
    let held: DiscordQuarantineSummary = { credentials: 2, configuration: 1, identity: 1 };
    const health = create(() => held);
    health.entry(owner(), { shards: 1 }).native('up', 0);
    const snapshot = health.snapshot();
    expect(snapshot).toMatchObject({
      applications: 1,
      quarantined: 4,
      credentials: { failing: 2, unknown: 3 },
      permissions: { unknown: 5 },
      native: { failing: 4, healthy: 1 },
    });
    for (const concern of ['credentials', 'permissions', 'native'] as const) {
      const total = Object.values(snapshot[concern]).reduce((sum, count) => sum + count, 0);
      expect(total).toBe(snapshot.applications + snapshot.quarantined);
    }
    held = { credentials: 0, configuration: 0, identity: 0 };
    expect(health.snapshot().quarantined).toBe(0);
  });

  test.each([
    ['negative', { credentials: -1, configuration: 0, identity: 0 }],
    ['fractional', { credentials: 1.5, configuration: 0, identity: 0 }],
    ['not a number', { credentials: Number.NaN, configuration: 0, identity: 0 }],
    ['infinite', { credentials: Number.POSITIVE_INFINITY, configuration: 0, identity: 0 }],
    ['text', { credentials: '3', configuration: 0, identity: 0 }],
  ])('ignores a %s quarantine count', (_name, supplied) => {
    const health = create(() => supplied as unknown as DiscordQuarantineSummary);
    expect(health.snapshot().quarantined).toBe(0);
  });

  test('a throwing quarantine supplier cannot break a read', () => {
    const health = create(() => {
      throw new Error('quarantine unavailable');
    });
    health.entry(owner(), { shards: 0 });
    expect(health.snapshot()).toMatchObject({ applications: 1, quarantined: 0 });
  });
});
