import { getRunStepDurationLabels, getElapsedDurationLabels } from '../runStepDuration';

describe('getRunStepDurationLabels', () => {
  describe('under ten seconds', () => {
    it('keeps one decimal, where the tenth still distinguishes two durations', () => {
      expect(getRunStepDurationLabels(1400, 'en')).toMatchObject({
        key: 'com_ui_duration_seconds',
        values: { 0: '1.4' },
      });
    });

    it('drops a trailing zero rather than rendering "1.0s"', () => {
      expect(getRunStepDurationLabels(1000, 'en').values).toEqual({ 0: '1' });
    });

    /** The decimal separator belongs to the locale, not to the code — a raw
     *  JS number interpolated into the label hardcodes the en-US point into
     *  every language (Codex-era self-audit finding on #14892). */
    it('formats the decimal for the active locale', () => {
      expect(getRunStepDurationLabels(1400, 'de').values).toEqual({ 0: '1,4' });
    });

    it('falls back to the plain number on a malformed language tag', () => {
      expect(getRunStepDurationLabels(1400, 'not a tag').values).toEqual({ 0: '1.4' });
    });

    it('announces the singular form only for exactly one second', () => {
      expect(getRunStepDurationLabels(1000).announcedKey).toBe(
        'com_ui_duration_announced_seconds_one',
      );
      expect(getRunStepDurationLabels(1400).announcedKey).toBe('com_ui_duration_announced_seconds');
    });
  });

  describe('ten seconds to a minute', () => {
    it('rounds to whole seconds, where the tenth is only jitter', () => {
      expect(getRunStepDurationLabels(12_400, 'en')).toMatchObject({
        key: 'com_ui_duration_seconds',
        values: { 0: '12' },
      });
      expect(getRunStepDurationLabels(12_600, 'en').values).toEqual({ 0: '13' });
    });
  });

  describe('a minute and over', () => {
    it('splits into minutes and seconds', () => {
      expect(getRunStepDurationLabels(65_000, 'en')).toMatchObject({
        key: 'com_ui_duration_minutes',
        values: { 0: '1', 1: '5' },
      });
      expect(getRunStepDurationLabels(723_000, 'en').values).toEqual({ 0: '12', 1: '3' });
    });

    it('renders an exact minute without a stray remainder', () => {
      expect(getRunStepDurationLabels(60_000, 'en').values).toEqual({ 0: '1', 1: '0' });
    });

    /** Branching on the raw seconds would render the nonsensical `60s`. */
    it('promotes a value that rounds up to a full minute', () => {
      expect(getRunStepDurationLabels(59_600, 'en')).toMatchObject({
        key: 'com_ui_duration_minutes',
        values: { 0: '1', 1: '0' },
      });
    });

    it('announces whole minutes, leaving the precise value on the button', () => {
      expect(getRunStepDurationLabels(65_000, 'en')).toMatchObject({
        announcedKey: 'com_ui_duration_announced_minutes_one',
        announcedValues: { count: '1' },
      });
      expect(getRunStepDurationLabels(150_000, 'en')).toMatchObject({
        announcedKey: 'com_ui_duration_announced_minutes',
        announcedValues: { count: '3' },
      });
    });

    /** Locales with localized digits must not silently revert to ASCII in
     *  the minute branch while the seconds branch respects them (Codex
     *  round 3 on #14892). */
    it('uses localized digits in the minute branch', () => {
      expect(getRunStepDurationLabels(65_000, 'ar-EG').values).toEqual({ 0: '١', 1: '٥' });
    });
  });
});

describe('getElapsedDurationLabels', () => {
  it('keeps the run-step visible form and rephrases the spoken form as elapsed', () => {
    expect(getElapsedDurationLabels(5_000, 'en')).toEqual({
      key: 'com_ui_duration_seconds',
      values: { 0: '5' },
      announcedKey: 'com_ui_elapsed_announced_seconds',
      announcedValues: { count: '5' },
    });
  });

  it('announces the singular form only for exactly one unit', () => {
    expect(getElapsedDurationLabels(1_000).announcedKey).toBe(
      'com_ui_elapsed_announced_seconds_one',
    );
    expect(getElapsedDurationLabels(60_000).announcedKey).toBe(
      'com_ui_elapsed_announced_minutes_one',
    );
  });

  it('rounds the spoken form to whole minutes past a minute', () => {
    expect(getElapsedDurationLabels(90_000, 'en')).toMatchObject({
      key: 'com_ui_duration_minutes',
      values: { 0: '1', 1: '30' },
      announcedKey: 'com_ui_elapsed_announced_minutes',
      announcedValues: { count: '2' },
    });
  });

  it('formats every interpolated number for the active locale', () => {
    expect(getElapsedDurationLabels(65_000, 'ar-EG')).toMatchObject({
      values: { 0: '١', 1: '٥' },
      announcedValues: { count: '١' },
    });
  });
});
