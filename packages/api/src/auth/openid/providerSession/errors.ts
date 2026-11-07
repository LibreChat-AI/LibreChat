import { AUTH_SESSION_CHECK_UNAVAILABLE } from 'librechat-data-provider';

/** The provider-session record could not be read or written while `enforce` authorized a
 *  restoration or renewal; the caller maps this to a `503` and keeps cookies. */
export class ProviderSessionUnavailableError extends Error {
  public readonly code: typeof AUTH_SESSION_CHECK_UNAVAILABLE = AUTH_SESSION_CHECK_UNAVAILABLE;
  public readonly status: number = 503;

  constructor(message = 'Provider session check unavailable', options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ProviderSessionUnavailableError';
  }
}

export function isProviderSessionUnavailableError(
  error: unknown,
): error is ProviderSessionUnavailableError {
  return error instanceof ProviderSessionUnavailableError;
}
