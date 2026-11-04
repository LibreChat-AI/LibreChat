import {
  classifyOpenIDRefreshAuthorizationError,
  OPENID_SESSION_AUTHORIZATION_UNAVAILABLE_BODY,
  OPENID_SESSION_AUTHORIZATION_UNAVAILABLE_STATUS,
} from './refreshAuthorizationOutcome';
import {
  createOpenIDSessionAuthorizationDeniedError,
  createOpenIDSessionAuthorizationUnavailableError,
} from './sessions/authorize';

describe('classifyOpenIDRefreshAuthorizationError', () => {
  it('classifies the unavailable error', () => {
    expect(
      classifyOpenIDRefreshAuthorizationError(createOpenIDSessionAuthorizationUnavailableError()),
    ).toBe('unavailable');
  });

  it('classifies a denied error', () => {
    expect(
      classifyOpenIDRefreshAuthorizationError(
        createOpenIDSessionAuthorizationDeniedError('unknown_session'),
      ),
    ).toBe('denied');
  });

  it('classifies any other error as unhandled', () => {
    expect(classifyOpenIDRefreshAuthorizationError(new Error('boom'))).toBe('unhandled');
    expect(classifyOpenIDRefreshAuthorizationError(undefined)).toBe('unhandled');
  });
});

describe('OPENID_SESSION_AUTHORIZATION_UNAVAILABLE response', () => {
  it('is a 503 with the stable code', () => {
    expect(OPENID_SESSION_AUTHORIZATION_UNAVAILABLE_STATUS).toBe(503);
    expect(OPENID_SESSION_AUTHORIZATION_UNAVAILABLE_BODY).toEqual({
      code: 'OPENID_SESSION_AUTHORIZATION_UNAVAILABLE',
    });
  });
});
