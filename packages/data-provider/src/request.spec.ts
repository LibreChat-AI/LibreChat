/**
 * @jest-environment jsdom
 */
import { readTwoFactorSetupToken, clearTwoFactorSetupToken } from './twoFactor';
import { getTokenHeader, setTokenHeader } from './headers-helpers';
import { TWO_FACTOR_ENROLLMENT_REQUIRED_CODE } from './config';
import request from './request';

interface AuthRecoveryWindow extends Window {
  __librechatAuthRecovery?: unknown;
}

const enrollmentBody = {
  code: TWO_FACTOR_ENROLLMENT_REQUIRED_CODE,
  twoFAPending: true,
  twoFASetupRequired: true,
  tempToken: 'setup-token',
};

const blockStorage = () =>
  jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('storage blocked');
  });

describe('two-factor enrollment responses outside the interceptors', () => {
  let pushState: jest.SpyInstance;
  let redirectEvents: CustomEvent<{ href: string; inDocument: boolean }>[];

  const captureRedirectEvent = (event: Event) => {
    redirectEvents.push(event as CustomEvent<{ href: string; inDocument: boolean }>);
  };

  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    clearTwoFactorSetupToken();
    setTokenHeader(undefined);
    delete (window as AuthRecoveryWindow).__librechatAuthRecovery;
    window.history.pushState(null, '', '/c/new');
    pushState = jest.spyOn(window.history, 'pushState');
    redirectEvents = [];
    window.addEventListener('authRedirectStarted', captureRedirectEvent);
  });

  afterEach(() => {
    window.removeEventListener('authRedirectStarted', captureRedirectEvent);
    jest.restoreAllMocks();
  });

  it('opens setup from a parsed enrollment body', () => {
    expect(request.redirectIfTwoFactorSetupPayload(enrollmentBody)).toBe(true);
    expect(readTwoFactorSetupToken()).toBe('setup-token');
  });

  /** Stream transports hand over the raw body, so the helper has to parse it itself. */
  it('opens setup from an enrollment body that arrives as text', () => {
    expect(request.redirectIfTwoFactorSetupPayload(JSON.stringify(enrollmentBody))).toBe(true);
    expect(readTwoFactorSetupToken()).toBe('setup-token');
  });

  it('ignores a 403 body that is not an enrollment response', () => {
    expect(request.redirectIfTwoFactorSetupPayload({ message: 'Forbidden' })).toBe(false);
    expect(readTwoFactorSetupToken()).toBe('');
    expect(pushState).not.toHaveBeenCalled();
  });

  it('ignores a body that is not JSON at all', () => {
    expect(request.redirectIfTwoFactorSetupPayload('<html>gateway</html>')).toBe(false);
    expect(readTwoFactorSetupToken()).toBe('');
    expect(pushState).not.toHaveBeenCalled();
  });

  it('ignores an enrollment body with no usable token', () => {
    expect(request.redirectIfTwoFactorSetupPayload({ ...enrollmentBody, tempToken: '   ' })).toBe(
      false,
    );
    expect(pushState).not.toHaveBeenCalled();
  });

  /**
   * Session storage outlives the document, so the redirect may replace it and clear the app state
   * along the way. Routing in place here would leave that stale state behind.
   */
  it('replaces the document when the token reached durable storage', () => {
    request.redirectIfTwoFactorSetupPayload(enrollmentBody);

    expect(window.sessionStorage.getItem('two_factor_setup_token')).toBe('setup-token');
    expect(pushState).not.toHaveBeenCalled();
    expect(redirectEvents).toHaveLength(1);
    expect(redirectEvents[0].detail.inDocument).toBe(false);
  });

  /**
   * With storage blocked the in-memory mirror is the only copy, and replacing the document would
   * destroy it, stranding the setup screen on its expired state with no way back.
   */
  it('keeps the document when only the in-memory mirror holds the token', () => {
    const setItem = blockStorage();

    expect(request.redirectIfTwoFactorSetupPayload(enrollmentBody)).toBe(true);

    setItem.mockRestore();
    expect(pushState).toHaveBeenCalledTimes(1);
    expect(window.location.pathname).toBe('/login/2fa/setup');
    expect(readTwoFactorSetupToken()).toBe('setup-token');
  });

  /**
   * The surviving document keeps the app mounted, so the hand-off has to say so: the session it
   * redirects away from is still live and nothing else would tell the app to let it go.
   */
  it('reports the surviving document to the app before routing in place', () => {
    const setItem = blockStorage();

    request.redirectIfTwoFactorSetupPayload(enrollmentBody);

    setItem.mockRestore();
    expect(redirectEvents).toHaveLength(1);
    expect(redirectEvents[0].detail.inDocument).toBe(true);
    expect(redirectEvents[0].detail.href).toContain('/login/2fa/setup');
  });

  it('redirects once while a redirect is already under way', () => {
    const setItem = blockStorage();

    request.redirectIfTwoFactorSetupPayload(enrollmentBody);
    request.redirectIfTwoFactorSetupPayload(enrollmentBody);

    setItem.mockRestore();
    expect(pushState).toHaveBeenCalledTimes(1);
  });

  /**
   * Another tab writes the shared navigation marker first. This tab still has to keep its own
   * setup token and drop the retired bearer; skipping those leaves it on the app with failing
   * requests until the marker expires.
   */
  it('persists the setup token when another tab already started a redirect', () => {
    window.localStorage.setItem('librechat.auth.redirect.startedAt', String(Date.now()));
    setTokenHeader('retired-bearer');

    expect(request.redirectIfTwoFactorSetupPayload(enrollmentBody)).toBe(true);

    expect(readTwoFactorSetupToken()).toBe('setup-token');
    expect(getTokenHeader()).toBeUndefined();
    expect(pushState).not.toHaveBeenCalled();
    expect(redirectEvents).toHaveLength(0);
  });
});
