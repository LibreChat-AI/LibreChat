import { isValidTimestamp, getMessageTimestamp } from '../time';

describe('isValidTimestamp', () => {
  it('returns false for missing values', () => {
    expect(isValidTimestamp(undefined)).toBe(false);
    expect(isValidTimestamp(null)).toBe(false);
    expect(isValidTimestamp('')).toBe(false);
  });

  it('returns false for unparseable strings', () => {
    expect(isValidTimestamp('not-a-date')).toBe(false);
  });

  it('returns true for ISO date strings', () => {
    expect(isValidTimestamp('2026-06-12T15:42:00.000Z')).toBe(true);
  });
});

describe('getMessageTimestamp', () => {
  const NOW = new Date('2026-06-12T15:42:00.000Z').getTime();

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns null for missing or invalid values', () => {
    expect(getMessageTimestamp(undefined, 'en-US')).toBeNull();
    expect(getMessageTimestamp(null, 'en-US')).toBeNull();
    expect(getMessageTimestamp('not-a-date', 'en-US')).toBeNull();
  });

  it('formats relative and absolute time for a recent message', () => {
    const twoHoursAgo = new Date(NOW - 2 * 60 * 60 * 1000).toISOString();
    const result = getMessageTimestamp(twoHoursAgo, 'en-US');
    expect(result).not.toBeNull();
    expect(result?.relative).toBe('2 hours ago');
    expect(result?.iso).toBe(twoHoursAgo);
    expect(result?.absolute).toContain('2026');
  });

  it('flags messages under 24h as recent (prefer relative)', () => {
    const justUnderADay = new Date(NOW - 23 * 60 * 60 * 1000).toISOString();
    expect(getMessageTimestamp(justUnderADay, 'en-US')?.isRecent).toBe(true);
  });

  it('flags older messages as not recent (prefer absolute date)', () => {
    const overADay = new Date(NOW - 25 * 60 * 60 * 1000).toISOString();
    const monthAgo = new Date(NOW - 38 * 24 * 60 * 60 * 1000).toISOString();
    expect(getMessageTimestamp(overADay, 'en-US')?.isRecent).toBe(false);
    expect(getMessageTimestamp(monthAgo, 'en-US')?.isRecent).toBe(false);
  });

  it('uses "now" for the current instant', () => {
    const result = getMessageTimestamp(new Date(NOW).toISOString(), 'en-US');
    expect(result?.relative).toBe('now');
    expect(result?.isRecent).toBe(true);
  });

  it('falls back to the default locale for a malformed locale tag', () => {
    const iso = new Date(NOW - 60 * 1000).toISOString();
    expect(() => getMessageTimestamp(iso, 'not a locale!!')).not.toThrow();
    expect(getMessageTimestamp(iso, 'not a locale!!')).not.toBeNull();
  });

  /** Every message row formats its timestamp on each render; constructing the
   *  Intl formatters per call made them the costliest function of a send. */
  it('reuses its formatters across calls for the same locale and clock', () => {
    const { DateTimeFormat, RelativeTimeFormat } = Intl;
    const replaceIntl = (key: 'DateTimeFormat' | 'RelativeTimeFormat', value: unknown) =>
      Object.defineProperty(Intl, key, { value, configurable: true, writable: true });
    const constructed = { absolute: 0, relative: 0 };
    replaceIntl(
      'DateTimeFormat',
      class extends DateTimeFormat {
        constructor(...args: ConstructorParameters<typeof DateTimeFormat>) {
          super(...args);
          constructed.absolute += 1;
        }
      },
    );
    replaceIntl(
      'RelativeTimeFormat',
      class extends RelativeTimeFormat {
        constructor(...args: ConstructorParameters<typeof RelativeTimeFormat>) {
          super(...args);
          constructed.relative += 1;
        }
      },
    );
    try {
      const iso = new Date(NOW - 5 * 60 * 1000).toISOString();
      const first = getMessageTimestamp(iso, 'fr-CA', true);
      const second = getMessageTimestamp(iso, 'fr-CA', true);
      getMessageTimestamp(iso, 'fr-CA', true);

      expect(second).toEqual(first);
      expect(constructed).toEqual({ absolute: 1, relative: 1 });

      getMessageTimestamp(iso, 'fr-CA', false);
      expect(constructed).toEqual({ absolute: 2, relative: 1 });
    } finally {
      replaceIntl('DateTimeFormat', DateTimeFormat);
      replaceIntl('RelativeTimeFormat', RelativeTimeFormat);
    }
  });

  it('keeps a formatter per clock format', () => {
    const iso = new Date(2026, 5, 12, 15, 5).toISOString();

    expect(getMessageTimestamp(iso, 'en-US', true)?.absolute).toMatch(/3:05\sPM/);
    expect(getMessageTimestamp(iso, 'en-US', false)?.absolute).toMatch(/15:05/);
  });
});
