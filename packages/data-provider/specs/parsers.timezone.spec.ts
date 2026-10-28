import { replaceSpecialVars } from '../src/parsers';

/**
 * Exercises real `dayjs` timezone conversion (no module mock) so the assertions
 * hold regardless of the machine's local timezone — the anchor instant and the
 * requested zone are both fixed.
 */
describe('replaceSpecialVars timezone handling', () => {
  const anchor = '2024-01-15T18:30:00.000Z';

  test('resolves {{current_datetime}} in the supplied timezone', () => {
    const result = replaceSpecialVars({
      text: '{{current_datetime}}',
      now: anchor,
      timezone: 'America/New_York',
    });
    expect(result).toBe('2024-01-15 13:30:00 -05:00 (Monday)');
  });

  test('resolves {{current_date}} across a day boundary into the local zone', () => {
    const result = replaceSpecialVars({
      text: '{{current_date}}',
      now: '2024-01-15T02:30:00.000Z',
      timezone: 'America/New_York',
    });
    expect(result).toBe('2024-01-14 (Sunday)');
  });

  test('shifts the local day forward for zones ahead of UTC', () => {
    const result = replaceSpecialVars({
      text: '{{current_date}} | {{current_datetime}}',
      now: anchor,
      timezone: 'Asia/Tokyo',
    });
    expect(result).toBe('2024-01-16 (Tuesday) | 2024-01-16 03:30:00 +09:00 (Tuesday)');
  });

  test('keeps {{iso_datetime}} in UTC regardless of timezone', () => {
    const result = replaceSpecialVars({
      text: '{{iso_datetime}}',
      now: anchor,
      timezone: 'Asia/Tokyo',
    });
    expect(result).toBe('2024-01-15T18:30:00.000Z');
  });

  test('falls back to the un-zoned anchor when the timezone is invalid', () => {
    const withInvalid = replaceSpecialVars({
      text: '{{current_datetime}}',
      now: anchor,
      timezone: 'Not/AZone',
    });
    const withNone = replaceSpecialVars({ text: '{{current_datetime}}', now: anchor });
    expect(withInvalid).toBe(withNone);
  });

  test('ignores an empty timezone string', () => {
    const withEmpty = replaceSpecialVars({
      text: '{{current_datetime}}',
      now: anchor,
      timezone: '',
    });
    const withNone = replaceSpecialVars({ text: '{{current_datetime}}', now: anchor });
    expect(withEmpty).toBe(withNone);
  });
});
