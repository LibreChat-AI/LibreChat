import type { TScheduleCadence } from 'librechat-data-provider';
import { describeCadence, formatRunInstant, buildTimezoneOptions } from '../cadence';

const localize = (key: string, vars?: Record<string, unknown>) =>
  vars ? `${key} ${JSON.stringify(vars)}` : key;

describe('describeCadence', () => {
  it('shows a cron cadence as the expression the user typed', () => {
    // Deliberately not translated into prose: a five-field expression can say things
    // no sentence template covers, and a wrong summary of a cadence the user wrote
    // themselves is worse than the expression they already understand.
    const cadence: TScheduleCadence = { frequency: 'cron', expression: '0 9,17 * * 1-5' };
    expect(describeCadence(cadence, localize, 'en-US')).toBe(
      'com_ui_schedule_runs_cron {"expression":"0 9,17 * * 1-5"}',
    );
  });

  it('still describes the structured cadences in prose', () => {
    expect(
      describeCadence({ frequency: 'daily', hour: 9, minute: 0 }, localize, 'en-US'),
    ).toContain('com_ui_schedule_runs_daily');
    expect(
      describeCadence({ frequency: 'hourly', hour: 0, minute: 5 }, localize, 'en-US'),
    ).toContain('"minute":"05"');
  });
});

describe('formatRunInstant', () => {
  it('renders a previewed occurrence in the schedule timezone, not the browser one', () => {
    const instant = new Date('2026-01-15T21:05:00Z');
    expect(formatRunInstant(instant, 'UTC', 'en-US')).toMatch(/9:05\s*PM/i);
    // Five hours behind UTC in January, so the same instant is a different clock time.
    expect(formatRunInstant(instant, 'America/New_York', 'en-US')).toMatch(/4:05\s*PM/i);
  });
});

describe('buildTimezoneOptions', () => {
  it('pins the local zone and UTC first, then browsable zones with no duplicates', () => {
    const zones = buildTimezoneOptions('America/New_York');
    expect(zones[0]).toBe('America/New_York');
    expect(zones[1]).toBe('UTC');
    expect(new Set(zones).size).toBe(zones.length);
  });

  it('includes modern IANA names the enumeration omits, wherever the engine accepts them', () => {
    // `supportedValuesOf` reports CLDR's legacy canonical forms (Asia/Calcutta,
    // Europe/Kiev); the names people search for must still find an option.
    const zones = new Set(buildTimezoneOptions('America/New_York'));
    for (const zone of ['Asia/Kolkata', 'Europe/Kyiv', 'America/Argentina/Buenos_Aires']) {
      let accepted = true;
      try {
        new Intl.DateTimeFormat(undefined, { timeZone: zone });
      } catch {
        accepted = false;
      }
      if (accepted) {
        expect(zones).toContain(zone);
      }
    }
  });
});

describe('clock format and week start', () => {
  const weekly = (daysOfWeek: number[]): TScheduleCadence => ({
    frequency: 'weekly',
    hour: 21,
    minute: 5,
    daysOfWeek,
  });

  it('forces 24-hour notation regardless of locale when the clock is 24-hour', () => {
    expect(
      describeCadence({ frequency: 'daily', hour: 21, minute: 5 }, localize, 'en-US', false),
    ).toContain('"time":"21:05"');
  });

  it('forces a meridiem regardless of locale when the clock is 12-hour', () => {
    expect(
      describeCadence({ frequency: 'daily', hour: 21, minute: 5 }, localize, 'de-DE', true),
    ).toMatch(/9:05\s*PM/i);
  });

  it('falls back to the locale default when no preference is given', () => {
    expect(
      describeCadence({ frequency: 'daily', hour: 21, minute: 5 }, localize, 'de-DE'),
    ).toContain('"time":"21:05"');
  });

  it('reads a wrap-around day selection in the user own week order', () => {
    // Sat(6) + Sun(0) + Mon(1) is a wrap-around selection: ascending-by-index reads
    // "Sun, Mon, Sat", but in a Monday-first week the calendar order is Mon, Sat, Sun.
    expect(describeCadence(weekly([6, 0, 1]), localize, 'en-US', undefined, 0)).toContain(
      '"days":"Sunday, Monday, Saturday"',
    );
    expect(describeCadence(weekly([6, 0, 1]), localize, 'en-US', undefined, 1)).toContain(
      '"days":"Monday, Saturday, Sunday"',
    );
  });

  it('formats a previewed occurrence in the preferred clock format', () => {
    const instant = new Date('2026-01-15T21:05:00Z');
    expect(formatRunInstant(instant, 'UTC', 'en-US', false)).toContain('21:05');
    expect(formatRunInstant(instant, 'UTC', 'en-US', false)).not.toMatch(/PM/i);
  });
});
