import { getTwoFactorError } from '../errors';

const limited = (retryAfter?: string | number) => ({
  isAxiosError: true,
  response: {
    status: 429,
    data: { code: 'TWO_FACTOR_RATE_LIMITED' },
    headers: { 'retry-after': retryAfter },
  },
});

describe('2FA error guidance', () => {
  it('uses the retry interval without labeling a throttled code as invalid', () => {
    expect(getTwoFactorError(limited('42'), 'com_ui_2fa_invalid')).toEqual({
      key: 'com_ui_2fa_rate_limited_retry',
      seconds: 42,
    });
  });

  it.each([undefined, '', 'bad', '-1', '0', 'Infinity', '9999999999'])(
    'falls back safely for %s',
    (header) => {
      expect(getTwoFactorError(limited(header), 'com_ui_2fa_invalid')).toEqual({
        key: 'com_ui_2fa_rate_limited',
      });
    },
  );

  it('handles an older server without the new error code', () => {
    const error = limited(5);
    error.response.data = { code: '' };
    expect(getTwoFactorError(error, 'com_ui_2fa_invalid').seconds).toBe(5);
  });

  it('preserves invalid-factor and network error fallbacks without exposing server details', () => {
    expect(
      getTwoFactorError(
        { isAxiosError: true, response: { status: 400, data: { message: 'secret' } } },
        'com_ui_2fa_invalid',
      ),
    ).toEqual({ key: 'com_ui_2fa_invalid' });
    expect(getTwoFactorError(new Error('secret'), 'com_ui_backup_codes_regenerate_error')).toEqual({
      key: 'com_ui_backup_codes_regenerate_error',
    });
  });
});
