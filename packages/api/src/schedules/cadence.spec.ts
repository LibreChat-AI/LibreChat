import { SCHEDULE_CRON_MAX_LENGTH, nextRunInstants } from 'librechat-data-provider';
import type { TScheduleCadence, TStructuredCadence } from 'librechat-data-provider';
import {
  cadenceToCron,
  computeNextRunAt,
  isValidTimezone,
  scheduleJitterMs,
  cadenceIntervalMinutes,
  isValidCronExpression,
  SCHEDULE_JITTER_WINDOW_MS,
} from './cadence';

const NEW_YORK = 'America/New_York';
/** The only zone that shifts two hours, which is where the allowance comes from. */
const TROLL = 'Antarctica/Troll';

function cadence(overrides: Partial<TStructuredCadence>): TScheduleCadence {
  return { frequency: 'daily', hour: 0, minute: 0, ...overrides };
}

function cronCadence(expression: string): TScheduleCadence {
  return { frequency: 'cron', expression };
}

function wallClock(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '';
  return `${get('weekday')} ${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

function nextRun(params: {
  cadence: TScheduleCadence;
  timezone: string;
  after: Date;
  scheduleId?: string;
}): Date {
  const result = computeNextRunAt({
    cadence: params.cadence,
    timezone: params.timezone,
    scheduleId: params.scheduleId ?? 'sched-test',
    after: params.after,
    disableJitter: true,
  });
  if (result == null) {
    throw new Error('expected computeNextRunAt to return a Date');
  }
  return result;
}

describe('cadenceToCron', () => {
  it('maps hourly to a minute-only pattern', () => {
    expect(cadenceToCron(cadence({ frequency: 'hourly', minute: 15 }))).toBe('15 * * * *');
  });

  it('maps daily to minute + hour', () => {
    expect(cadenceToCron(cadence({ frequency: 'daily', hour: 8, minute: 0 }))).toBe('0 8 * * *');
  });

  it('maps weekdays to Monday through Friday', () => {
    expect(cadenceToCron(cadence({ frequency: 'weekdays', hour: 9, minute: 30 }))).toBe(
      '30 9 * * 1-5',
    );
  });

  it('maps weekly multi-day with days sorted ascending', () => {
    expect(
      cadenceToCron(cadence({ frequency: 'weekly', hour: 7, minute: 45, daysOfWeek: [5, 1, 3] })),
    ).toBe('45 7 * * 1,3,5');
  });

  it('defaults weekly to Monday when daysOfWeek is missing or empty', () => {
    expect(cadenceToCron(cadence({ frequency: 'weekly', hour: 7, minute: 45 }))).toBe('45 7 * * 1');
    expect(
      cadenceToCron(cadence({ frequency: 'weekly', hour: 7, minute: 45, daysOfWeek: [] })),
    ).toBe('45 7 * * 1');
  });
});

describe('computeNextRunAt', () => {
  const daily8amNewYork = {
    cadence: cadence({ frequency: 'daily', hour: 8, minute: 0 }),
    timezone: NEW_YORK,
  };

  it('fires later the same day when the occurrence is still ahead', () => {
    const next = nextRun({ ...daily8amNewYork, after: new Date('2026-07-15T09:00:00Z') });
    expect(wallClock(next, NEW_YORK)).toBe('Wed 2026-07-15 08:00');
    expect(next.toISOString()).toBe('2026-07-15T12:00:00.000Z');
  });

  it('rolls to the next day once the occurrence has passed', () => {
    const next = nextRun({ ...daily8amNewYork, after: new Date('2026-07-15T13:00:00Z') });
    expect(wallClock(next, NEW_YORK)).toBe('Thu 2026-07-16 08:00');
    expect(next.toISOString()).toBe('2026-07-16T12:00:00.000Z');
  });

  it('returns null for a malformed stored timezone instead of throwing', () => {
    // A bad schedule reaching the engine must not throw out of a tick — null is
    // the "uncomputable" signal the engine disables (invalid_schedule) on.
    expect(() =>
      computeNextRunAt({
        cadence: cadence({ frequency: 'daily', hour: 8, minute: 0 }),
        timezone: 'Not/AZone',
        scheduleId: 'sched_bad_tz',
      }),
    ).not.toThrow();
    expect(
      computeNextRunAt({
        cadence: cadence({ frequency: 'daily', hour: 8, minute: 0 }),
        timezone: 'Not/AZone',
        scheduleId: 'sched_bad_tz',
      }),
    ).toBeNull();
  });

  it('skips an occurrence exactly at `after` (strictly-after semantics)', () => {
    const next = nextRun({ ...daily8amNewYork, after: new Date('2026-07-15T12:00:00Z') });
    expect(wallClock(next, NEW_YORK)).toBe('Thu 2026-07-16 08:00');
  });

  describe('DST spring-forward (US 2026-03-08)', () => {
    const daily230amNewYork = {
      cadence: cadence({ frequency: 'daily', hour: 2, minute: 30 }),
      timezone: NEW_YORK,
    };

    it('fires the gap occurrence shifted to 03:30 EDT rather than dropping March 8', () => {
      const next = nextRun({ ...daily230amNewYork, after: new Date('2026-03-07T17:00:00Z') });
      expect(next.toISOString()).toBe('2026-03-08T07:30:00.000Z');
      expect(wallClock(next, NEW_YORK)).toBe('Sun 2026-03-08 03:30');
    });

    it('resumes at 02:30 EDT on March 9 after the gap occurrence', () => {
      const march8 = nextRun({ ...daily230amNewYork, after: new Date('2026-03-07T17:00:00Z') });
      const next = nextRun({ ...daily230amNewYork, after: march8 });
      expect(next.toISOString()).toBe('2026-03-09T06:30:00.000Z');
      expect(wallClock(next, NEW_YORK)).toBe('Mon 2026-03-09 02:30');
    });
  });

  describe('DST fall-back (US 2026-11-01)', () => {
    it('fires the repeated 01:30 exactly once, at the first (EDT) occurrence', () => {
      const daily130amNewYork = {
        cadence: cadence({ frequency: 'daily', hour: 1, minute: 30 }),
        timezone: NEW_YORK,
      };
      const runs: Date[] = [];
      let after = new Date('2026-10-31T16:00:00Z');
      for (let i = 0; i < 3; i++) {
        const next = nextRun({ ...daily130amNewYork, after });
        runs.push(next);
        after = next;
      }
      expect(runs.map((run) => run.toISOString())).toEqual([
        '2026-11-01T05:30:00.000Z',
        '2026-11-02T06:30:00.000Z',
        '2026-11-03T06:30:00.000Z',
      ]);
      expect(runs.map((run) => wallClock(run, NEW_YORK))).toEqual([
        'Sun 2026-11-01 01:30',
        'Mon 2026-11-02 01:30',
        'Tue 2026-11-03 01:30',
      ]);
    });
  });

  it('weekdays cadence skips weekends', () => {
    const weekdays9amNewYork = {
      cadence: cadence({ frequency: 'weekdays', hour: 9, minute: 0 }),
      timezone: NEW_YORK,
    };
    const fromFriday = nextRun({ ...weekdays9amNewYork, after: new Date('2026-07-17T15:00:00Z') });
    expect(wallClock(fromFriday, NEW_YORK)).toBe('Mon 2026-07-20 09:00');
    const fromSaturday = nextRun({
      ...weekdays9amNewYork,
      after: new Date('2026-07-18T12:00:00Z'),
    });
    expect(wallClock(fromSaturday, NEW_YORK)).toBe('Mon 2026-07-20 09:00');
  });

  it('hourly cadence fires at the next :MM', () => {
    const hourly45 = { cadence: cadence({ frequency: 'hourly', minute: 45 }), timezone: 'UTC' };
    expect(nextRun({ ...hourly45, after: new Date('2026-07-15T10:30:00Z') }).toISOString()).toBe(
      '2026-07-15T10:45:00.000Z',
    );
    expect(nextRun({ ...hourly45, after: new Date('2026-07-15T10:50:00Z') }).toISOString()).toBe(
      '2026-07-15T11:45:00.000Z',
    );
    expect(nextRun({ ...hourly45, after: new Date('2026-07-15T10:45:00Z') }).toISOString()).toBe(
      '2026-07-15T11:45:00.000Z',
    );
  });

  it('weekly multi-day cadence fires only on the configured days', () => {
    const weekly = {
      cadence: cadence({ frequency: 'weekly', hour: 10, minute: 0, daysOfWeek: [3, 6] }),
      timezone: 'UTC',
    };
    const first = nextRun({ ...weekly, after: new Date('2026-07-16T00:00:00Z') });
    const second = nextRun({ ...weekly, after: first });
    const third = nextRun({ ...weekly, after: second });
    expect([first, second, third].map((run) => run.toISOString())).toEqual([
      '2026-07-18T10:00:00.000Z',
      '2026-07-22T10:00:00.000Z',
      '2026-07-25T10:00:00.000Z',
    ]);
    expect([first, second, third].map((run) => wallClock(run, 'UTC').slice(0, 3))).toEqual([
      'Sat',
      'Wed',
      'Sat',
    ]);
  });
});

describe('jitter', () => {
  it('is deterministic for the same schedule id', () => {
    expect(scheduleJitterMs('sched-abc')).toBe(scheduleJitterMs('sched-abc'));
  });

  it('stays within the jitter window', () => {
    for (let i = 0; i < 100; i++) {
      const value = scheduleJitterMs(`schedule-${i}`);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(SCHEDULE_JITTER_WINDOW_MS);
    }
  });

  it('respects a custom window', () => {
    for (let i = 0; i < 20; i++) {
      const value = scheduleJitterMs(`schedule-${i}`, 1000);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1000);
    }
  });

  it('spreads different ids across the window', () => {
    const values = new Set(Array.from({ length: 50 }, (_, i) => scheduleJitterMs(`schedule-${i}`)));
    expect(values.size).toBeGreaterThan(40);
  });

  it('computeNextRunAt offsets the cron instant by the schedule jitter', () => {
    const params = {
      cadence: cadence({ frequency: 'daily', hour: 8, minute: 0 }),
      timezone: NEW_YORK,
      scheduleId: 'sched-jitter',
      after: new Date('2026-07-15T09:00:00Z'),
    };
    const jittered = computeNextRunAt(params);
    const bare = computeNextRunAt({ ...params, disableJitter: true });
    expect(jittered).not.toBeNull();
    expect(bare).not.toBeNull();
    expect((jittered?.getTime() ?? 0) - (bare?.getTime() ?? 0)).toBe(
      scheduleJitterMs('sched-jitter'),
    );
  });

  it('does not skip a still-future occurrence inside the jitter window', () => {
    const scheduleId = 'sched-window';
    const jitter = scheduleJitterMs(scheduleId);
    expect(jitter).toBeGreaterThan(1000); // ensure the window is meaningful
    const cadenceHourly = cadence({ frequency: 'hourly', hour: 0, minute: 0 });
    const cronInstant = new Date('2026-07-15T12:00:00Z'); // an hourly :00 boundary (UTC)
    // `after` is just past the unjittered instant but before the jittered one:
    // the jittered occurrence (cronInstant + jitter) is still in the future.
    const after = new Date(cronInstant.getTime() + 1000);
    const next = computeNextRunAt({ cadence: cadenceHourly, timezone: 'UTC', scheduleId, after });
    // Must return THIS hour's jittered instant, not next hour's.
    expect(next?.getTime()).toBe(cronInstant.getTime() + jitter);
  });
});

describe('isValidTimezone', () => {
  it('accepts IANA zone names', () => {
    expect(isValidTimezone('America/New_York')).toBe(true);
    expect(isValidTimezone('Europe/Stockholm')).toBe(true);
    expect(isValidTimezone('UTC')).toBe(true);
  });

  it('rejects invalid zones', () => {
    expect(isValidTimezone('Not/AZone')).toBe(false);
    expect(isValidTimezone('EST5EDT-Bogus')).toBe(false);
    expect(isValidTimezone('')).toBe(false);
  });
});

describe('cadenceIntervalMinutes', () => {
  it('returns the minimum minutes between occurrences per frequency', () => {
    expect(cadenceIntervalMinutes(cadence({ frequency: 'hourly' }))).toBe(60);
    // Day-and-longer gaps report the DST-compressed minimum (largest real-world
    // transition is 2h — Antarctica/Troll): a floor set at the nominal value would
    // admit a schedule that genuinely violates it once a year.
    expect(cadenceIntervalMinutes(cadence({ frequency: 'daily' }))).toBe(24 * 60 - 120);
    expect(cadenceIntervalMinutes(cadence({ frequency: 'weekdays' }))).toBe(24 * 60 - 120);
  });

  it('uses the shortest gap between weekly days, incl. the week wrap-around', () => {
    // single day → full week
    expect(cadenceIntervalMinutes(cadence({ frequency: 'weekly' }))).toBe(7 * 24 * 60 - 120);
    expect(cadenceIntervalMinutes(cadence({ frequency: 'weekly', daysOfWeek: [3] }))).toBe(
      7 * 24 * 60 - 120,
    );
    // adjacent days fire 24h apart — the floor must reflect that, not the average
    expect(cadenceIntervalMinutes(cadence({ frequency: 'weekly', daysOfWeek: [1, 2] }))).toBe(
      24 * 60 - 120,
    );
    // evenly spaced Mon/Wed/Fri → 2-day min gap
    expect(cadenceIntervalMinutes(cadence({ frequency: 'weekly', daysOfWeek: [1, 3, 5] }))).toBe(
      2 * 24 * 60 - 120,
    );
    // duplicates are one selection, not a zero-day gap: [1, 1] fires once a week,
    // and reading it as 0 minutes rejected the schedule against every valid floor
    expect(cadenceIntervalMinutes(cadence({ frequency: 'weekly', daysOfWeek: [1, 1] }))).toBe(
      7 * 24 * 60 - 120,
    );
    // wrap-around: Sun + Sat are 1 day apart across the week boundary
    expect(cadenceIntervalMinutes(cadence({ frequency: 'weekly', daysOfWeek: [0, 6] }))).toBe(
      24 * 60 - 120,
    );
  });
});

describe('cron cadence', () => {
  it('compiles to the expression verbatim', () => {
    expect(cadenceToCron(cronCadence('0 9,17 * * 1-5'))).toBe('0 9,17 * * 1-5');
  });

  it('computes the next run from a cron expression', () => {
    const next = computeNextRunAt({
      cadence: cronCadence('0 9 * * *'),
      timezone: NEW_YORK,
      scheduleId: 'cron-next',
      after: new Date('2026-03-01T00:00:00Z'),
      disableJitter: true,
    });
    expect(next).not.toBeNull();
    expect(wallClock(next as Date, NEW_YORK)).toBe('Sun 2026-03-01 09:00');
  });

  it('reports the tightest gap so a dense expression fails the floor', () => {
    expect(cadenceIntervalMinutes(cronCadence('* * * * *'))).toBe(1);
    expect(cadenceIntervalMinutes(cronCadence('*/30 * * * *'))).toBe(30);
  });

  it('matches the structured values for the equivalent expressions', () => {
    // an expression a user could type instead of picking the preset must not be
    // rejected by a floor the preset passes
    expect(cadenceIntervalMinutes(cronCadence('0 * * * *'))).toBe(
      cadenceIntervalMinutes(cadence({ frequency: 'hourly' })),
    );
    expect(cadenceIntervalMinutes(cronCadence('0 9 * * *'))).toBe(
      cadenceIntervalMinutes(cadence({ frequency: 'daily', hour: 9 })),
    );
    expect(cadenceIntervalMinutes(cronCadence('0 9 * * 1-5'))).toBe(
      cadenceIntervalMinutes(cadence({ frequency: 'weekdays', hour: 9 })),
    );
  });

  it('fails closed on an expression the engine cannot fire', () => {
    // 0 means "violates every floor", so an unfireable expression cannot be saved
    expect(cadenceIntervalMinutes(cronCadence('not a cron'))).toBe(0);
    // syntactically valid, but February never has a 30th
    expect(cadenceIntervalMinutes(cronCadence('0 9 30 2 *'))).toBe(0);
  });

  it('measures the gap spring-forward compresses rather than the nominal one', () => {
    // Midnight to noon is 11 real hours on the day America/New_York springs forward.
    // Probed without the zone it reads as 12, and a floor set between the two would
    // admit a schedule that genuinely breaks it once a year.
    expect(cadenceIntervalMinutes(cronCadence('0 0,12 * * *'), NEW_YORK)).toBe(11 * 60);
    expect(cadenceIntervalMinutes(cronCadence('0 0,12 * * *'), 'UTC')).toBe(12 * 60);
    // 01:00 and 03:00 are an hour apart on that day, not two.
    expect(cadenceIntervalMinutes(cronCadence('0 1,3 * * *'), NEW_YORK)).toBe(60);
  });

  it('keeps an hourly expression at 60 minutes in a DST zone', () => {
    // croner repeats (Troll even reverses) the folded instant at spring-forward.
    // Counted as a gap it reads as 0 or less and rejects every hourly cron there.
    for (const zone of [NEW_YORK, 'UTC', 'Europe/Berlin', 'Australia/Sydney', TROLL]) {
      expect(cadenceIntervalMinutes(cronCadence('0 * * * *'), zone)).toBe(60);
    }
  });

  it('previews a spring-forward fold as one occurrence, not two', () => {
    // croner folds the skipped 2:00 onto 3:00 on the day America/New_York springs
    // forward, emitting the same instant twice. That is one firing (the engine's
    // unique-occurrence index counts it that way), and a preview keyed by instant
    // would render duplicate rows.
    jest.useFakeTimers().setSystemTime(new Date('2027-03-13T12:00:00Z'));
    try {
      const runs = nextRunInstants(cronCadence('0 2,3 * * *'), NEW_YORK, 6);
      const instants = runs.map((run) => run.getTime());
      expect(new Set(instants).size).toBe(instants.length);
    } finally {
      jest.useRealTimers();
    }
  });

  it('measures a transition that lands on the preceding UTC date', () => {
    // Australia/Sydney turns over at 16:00 UTC the day BEFORE the local date it
    // belongs to, so a scan rounded forward to the anchor's own UTC day excluded it
    // and the gap it compressed went unmeasured. 2027-10-03 is that day locally.
    jest.useFakeTimers().setSystemTime(new Date('2027-10-01T00:00:00Z'));
    try {
      const straddling = cronCadence('0 0,12 * * *');
      expect(cadenceIntervalMinutes(straddling, 'Australia/Sydney')).toBe(11 * 60);
      expect(cadenceIntervalMinutes(straddling, 'UTC')).toBe(12 * 60);
    } finally {
      jest.useRealTimers();
    }
  });

  it('refuses the seconds and year forms croner would otherwise accept', () => {
    // Five fields only. A seconds field promises a precision the engine does not keep
    // (a thirty-second tick plus up to two minutes of jitter), and a pinned year makes
    // a cadence that runs out, which every "no next occurrence" reader treats as a
    // cadence it cannot read.
    expect(isValidCronExpression('0 9 * * 1-5')).toBe(true);
    expect(isValidCronExpression('0 0 9 * * 1-5')).toBe(false);
    expect(isValidCronExpression('0 0 9 * * 1-5 2027')).toBe(false);
    // croner's shorthand aliases are the same promise in fewer characters.
    expect(isValidCronExpression('@daily')).toBe(false);
  });

  it('accepts an expression only when it can actually match', () => {
    expect(isValidCronExpression('0 0 29 2 *')).toBe(true);
    // syntactically valid, but February never has a 30th: nothing would ever fire
    expect(isValidCronExpression('0 9 30 2 *')).toBe(false);
    expect(isValidCronExpression('not a cron')).toBe(false);
    // croner accepts an unusable timezone and only throws when it computes with it
    expect(isValidCronExpression('0 9 * * *', 'Not/AZone')).toBe(false);
  });

  it('refuses an expression longer than the schema stores', () => {
    // A parseable expression over the cap is not "valid but large": the payload
    // schema refuses it, so accepting it here left the dialog offering a Create the
    // API answers 400 to, surfaced as a bare "something went wrong".
    const minutes = Array.from({ length: 60 }, (_, minute) => minute).join(',');
    const hours = Array.from({ length: 24 }, (_, hour) => hour).join(',');
    const days = Array.from({ length: 31 }, (_, day) => day + 1).join(',');
    const padded = `${minutes} ${hours} ${days} * *`;
    expect(padded.length).toBeGreaterThan(SCHEDULE_CRON_MAX_LENGTH);
    expect(isValidCronExpression(padded)).toBe(false);
    // the same shape inside the cap still parses
    expect(`${minutes} * * * *`.length).toBeLessThanOrEqual(SCHEDULE_CRON_MAX_LENGTH);
    expect(isValidCronExpression(`${minutes} * * * *`)).toBe(true);
  });

  it('validates expressions with the parser the engine fires from', () => {
    expect(isValidCronExpression('0 9,17 * * *')).toBe(true);
    expect(isValidCronExpression('0 0 1 * *')).toBe(true);
    expect(isValidCronExpression('nonsense')).toBe(false);
    expect(isValidCronExpression('99 * * * *')).toBe(false);
  });
});
