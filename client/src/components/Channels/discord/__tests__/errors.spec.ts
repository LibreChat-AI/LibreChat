import { discordErrorLabel, isUnreachable } from '../errors';

const failure = (code?: string, status?: number) => Object.assign(new Error('x'), { code, status });

describe('discordErrorLabel', () => {
  test.each([
    ['a network failure', failure('unavailable'), 'read'],
    ['a network failure on a write', failure('unavailable'), 'write'],
    ['a bad gateway', failure('unavailable', 502), 'read'],
    ['an unavailable service', failure('unavailable', 503), 'read'],
    ['a gateway timeout', failure('unavailable', 504), 'write'],
  ] as const)('says LibreChat is unreachable for %s', (_name, error, context) => {
    expect(isUnreachable(error)).toBe(true);
    expect(discordErrorLabel(error, context)).toBe('com_ui_discord_unreachable');
  });

  test.each([
    ['provider_unavailable', 'com_ui_discord_provider_unavailable'],
    ['timeout', 'com_ui_discord_timeout'],
  ])('keeps Discord %s apart from an unreachable server', (code, key) => {
    expect(isUnreachable(failure(code))).toBe(false);
    expect(discordErrorLabel(failure(code), 'read')).toBe(key);
    expect(discordErrorLabel(failure(code, 503), 'write')).toBe(key);
  });

  test('words an unknown failed read as a load failure', () => {
    expect(discordErrorLabel(failure('unavailable', 500), 'read')).toBe(
      'com_ui_discord_load_failed',
    );
    expect(discordErrorLabel(new Error('boom'), 'read')).toBe('com_ui_discord_load_failed');
    expect(
      discordErrorLabel(failure('unavailable', 500), 'read', {
        read: 'com_ui_discord_dm_load_failed',
      }),
    ).toBe('com_ui_discord_dm_load_failed');
  });

  test('words an unknown write outcome as not confirmed', () => {
    expect(discordErrorLabel(failure('unavailable', 500), 'write')).toBe('com_ui_discord_error');
    expect(discordErrorLabel(failure('binding_uncertain'), 'write')).toBe('com_ui_discord_error');
    expect(discordErrorLabel(new Error('boom'), 'write')).toBe('com_ui_discord_error');
  });

  test.each([
    [failure('forbidden', 403), 'com_ui_discord_admin'],
    [failure('x', 404), 'com_ui_discord_disabled'],
    [failure('rate_limited'), 'com_ui_discord_rate_limited'],
    [failure('provider_refused'), 'com_ui_discord_refused'],
    [failure('unsupported_installation'), 'com_ui_discord_code_grant'],
    [failure('application_changed'), 'com_ui_discord_changed'],
    [failure('capacity'), 'com_ui_discord_dm_capacity'],
    [failure('invalid_code'), 'com_ui_discord_dm_invalid_code'],
  ])('keeps a specific message for a known cause', (error, key) => {
    expect(discordErrorLabel(error, 'read')).toBe(key);
    expect(discordErrorLabel(error, 'write')).toBe(key);
  });

  test('lets a surface reword a known cause', () => {
    expect(
      discordErrorLabel(failure('forbidden', 403), 'write', {
        known: { '403': 'com_ui_discord_binding_forbidden' },
      }),
    ).toBe('com_ui_discord_binding_forbidden');
  });
});
