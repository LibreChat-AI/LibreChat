import { AUTH_SESSION_CHECK_UNAVAILABLE } from 'librechat-data-provider';
import { ProviderSessionUnavailableError, isProviderSessionUnavailableError } from './errors';

describe('ProviderSessionUnavailableError', () => {
  it('carries the AUTH_SESSION_CHECK_UNAVAILABLE code and a 503 status hint', () => {
    const error = new ProviderSessionUnavailableError();
    expect(error.code).toBe(AUTH_SESSION_CHECK_UNAVAILABLE);
    expect(error.status).toBe(503);
  });

  it('is recognized by its guard and no other error is', () => {
    expect(isProviderSessionUnavailableError(new ProviderSessionUnavailableError())).toBe(true);
    expect(isProviderSessionUnavailableError(new Error('unrelated'))).toBe(false);
    expect(isProviderSessionUnavailableError(null)).toBe(false);
  });

  it('preserves the triggering error as cause', () => {
    const cause = new Error('connection lost');
    const error = new ProviderSessionUnavailableError('unavailable', { cause });
    expect(error.cause).toBe(cause);
  });
});
