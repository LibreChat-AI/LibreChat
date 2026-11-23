import {
  isRequiredTwoFactorSetupRoute,
  persistRedirectToSession,
  clearPostLoginRedirect,
  getPostLoginRedirect,
  peekPostLoginRedirect,
  isSafeRedirect,
  withBasePath,
  SESSION_KEY,
} from '../redirect';

describe('withBasePath', () => {
  afterEach(() => {
    document.querySelector('base')?.remove();
  });

  const setBaseHref = (href: string) => {
    const base = document.createElement('base');
    base.setAttribute('href', href);
    document.head.appendChild(base);
  };

  it('returns the path unchanged when no base element is present', () => {
    expect(withBasePath('/c/new')).toBe('/c/new');
  });

  it('returns the path unchanged for a root base href', () => {
    setBaseHref('/');
    expect(withBasePath('/c/new')).toBe('/c/new');
  });

  it('prefixes a subdirectory base href', () => {
    setBaseHref('/librechat/');
    expect(withBasePath('/c/new')).toBe('/librechat/c/new');
  });

  it('prefixes a subdirectory base href without a trailing slash', () => {
    setBaseHref('/librechat');
    expect(withBasePath('/')).toBe('/librechat/');
  });

  it('uses only the pathname of an absolute base href', () => {
    setBaseHref('https://example.com/librechat/');
    expect(withBasePath('/login/2fa?tempToken=abc')).toBe('/librechat/login/2fa?tempToken=abc');
  });
});

describe('isRequiredTwoFactorSetupRoute', () => {
  const setPathname = (pathname: string) => {
    window.history.replaceState({}, '', pathname);
  };

  afterEach(() => {
    sessionStorage.clear();
    setPathname('/');
  });

  /** The router matches these spellings, so the guard has to recognise them too. */
  it.each([
    '/login/2fa/setup',
    '/login/2fa/setup/',
    '/LOGIN/2FA/SETUP',
    '/Login/2FA/Setup/',
    '/librechat/login/2fa/setup/',
  ])('recognises %s as the enrollment screen', (pathname) => {
    sessionStorage.setItem('two_factor_setup_token', 'setup-token');
    setPathname(pathname);

    expect(isRequiredTwoFactorSetupRoute()).toBe(true);
  });

  it('does not claim the route without a live setup token', () => {
    setPathname('/login/2fa/setup/');

    expect(isRequiredTwoFactorSetupRoute()).toBe(false);
  });

  it('does not claim a route that merely contains the setup path', () => {
    sessionStorage.setItem('two_factor_setup_token', 'setup-token');
    setPathname('/login/2fa/setup/extra');

    expect(isRequiredTwoFactorSetupRoute()).toBe(false);
  });
});

describe('isSafeRedirect', () => {
  it('accepts a simple relative path', () => {
    expect(isSafeRedirect('/c/new')).toBe(true);
  });

  it('accepts a path with query params and hash', () => {
    expect(isSafeRedirect('/c/new?q=hello&submit=true#section')).toBe(true);
  });

  it('accepts a nested path', () => {
    expect(isSafeRedirect('/dashboard/settings/profile')).toBe(true);
  });

  it('rejects an absolute http URL', () => {
    expect(isSafeRedirect('https://evil.com')).toBe(false);
  });

  it('rejects an absolute http URL with path', () => {
    expect(isSafeRedirect('https://evil.com/phishing')).toBe(false);
  });

  it('rejects a protocol-relative URL', () => {
    expect(isSafeRedirect('//evil.com')).toBe(false);
  });

  it('rejects a bare domain', () => {
    expect(isSafeRedirect('evil.com')).toBe(false);
  });

  it('rejects a backslash protocol-relative URL (CVE-2025-68470 class)', () => {
    expect(isSafeRedirect('/\\evil.com')).toBe(false);
  });

  it('rejects a double-backslash URL', () => {
    expect(isSafeRedirect('\\\\evil.com')).toBe(false);
  });

  it('rejects a backslash anywhere in the path', () => {
    expect(isSafeRedirect('/c/new\\x')).toBe(false);
  });

  it('rejects an empty string', () => {
    expect(isSafeRedirect('')).toBe(false);
  });

  it('rejects /login to prevent redirect loops', () => {
    expect(isSafeRedirect('/login')).toBe(false);
  });

  it('rejects /login with query params', () => {
    expect(isSafeRedirect('/login?redirect_to=/c/new')).toBe(false);
  });

  it('rejects /login sub-paths', () => {
    expect(isSafeRedirect('/login/2fa')).toBe(false);
  });

  it('rejects /login with hash', () => {
    expect(isSafeRedirect('/login#foo')).toBe(false);
  });

  it('accepts the root path', () => {
    expect(isSafeRedirect('/')).toBe(true);
  });

  /**
   * The URL parser strips ASCII tab and newline before resolving, so these clear the
   * prefix checks as written but navigate to `//evil.com`.
   */
  it('rejects a tab-smuggled protocol-relative URL', () => {
    expect(isSafeRedirect(decodeURIComponent('/%09/evil.com'))).toBe(false);
  });

  it('rejects a newline-smuggled protocol-relative URL', () => {
    expect(isSafeRedirect(decodeURIComponent('/%0A/evil.com'))).toBe(false);
  });

  it('rejects a carriage-return-smuggled protocol-relative URL', () => {
    expect(isSafeRedirect(decodeURIComponent('/%0D/evil.com'))).toBe(false);
  });

  it('rejects a control character anywhere in the path', () => {
    expect(isSafeRedirect(decodeURIComponent('/c/new%09x'))).toBe(false);
  });

  /** The login guard reads the raw path, so a target that only normalizes onto /login stays rejected */
  it('rejects a path that reaches /login before normalization', () => {
    expect(isSafeRedirect('/login/../c/new')).toBe(false);
  });

  it('accepts a same-origin path containing dot segments', () => {
    expect(isSafeRedirect('/c/../dashboard')).toBe(true);
  });
});

describe('getPostLoginRedirect', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it('returns the redirect_to param when valid', () => {
    const params = new URLSearchParams('redirect_to=%2Fc%2Fnew');
    expect(getPostLoginRedirect(params)).toBe('/c/new');
  });

  it('falls back to sessionStorage when no URL param', () => {
    sessionStorage.setItem(SESSION_KEY, '/c/abc123');
    const params = new URLSearchParams();
    expect(getPostLoginRedirect(params)).toBe('/c/abc123');
  });

  it('prefers URL param over sessionStorage', () => {
    sessionStorage.setItem(SESSION_KEY, '/c/old');
    const params = new URLSearchParams('redirect_to=%2Fc%2Fnew');
    expect(getPostLoginRedirect(params)).toBe('/c/new');
  });

  it('clears sessionStorage after reading', () => {
    sessionStorage.setItem(SESSION_KEY, '/c/abc123');
    const params = new URLSearchParams();
    getPostLoginRedirect(params);
    expect(sessionStorage.getItem(SESSION_KEY)).toBeNull();
  });

  it('returns null when no redirect source exists', () => {
    const params = new URLSearchParams();
    expect(getPostLoginRedirect(params)).toBeNull();
  });

  it('rejects an absolute URL from params', () => {
    const params = new URLSearchParams('redirect_to=https%3A%2F%2Fevil.com');
    expect(getPostLoginRedirect(params)).toBeNull();
  });

  it('rejects a protocol-relative URL from params', () => {
    const params = new URLSearchParams('redirect_to=%2F%2Fevil.com');
    expect(getPostLoginRedirect(params)).toBeNull();
  });

  it('rejects an encoded backslash URL from params', () => {
    const params = new URLSearchParams('redirect_to=%2F%5Cevil.com');
    expect(getPostLoginRedirect(params)).toBeNull();
  });

  it('rejects a backslash URL from sessionStorage', () => {
    sessionStorage.setItem(SESSION_KEY, '/\\evil.com');
    const params = new URLSearchParams();
    expect(getPostLoginRedirect(params)).toBeNull();
  });

  it('rejects an absolute URL from sessionStorage', () => {
    sessionStorage.setItem(SESSION_KEY, 'https://evil.com');
    const params = new URLSearchParams();
    expect(getPostLoginRedirect(params)).toBeNull();
  });

  it('rejects /login redirect to prevent loops', () => {
    const params = new URLSearchParams('redirect_to=%2Flogin');
    expect(getPostLoginRedirect(params)).toBeNull();
  });

  it('rejects /login sub-path redirect', () => {
    const params = new URLSearchParams('redirect_to=%2Flogin%2F2fa');
    expect(getPostLoginRedirect(params)).toBeNull();
  });

  it('still clears sessionStorage even when target is unsafe', () => {
    sessionStorage.setItem(SESSION_KEY, 'https://evil.com');
    const params = new URLSearchParams();
    getPostLoginRedirect(params);
    expect(sessionStorage.getItem(SESSION_KEY)).toBeNull();
  });
});

describe('peekPostLoginRedirect', () => {
  beforeEach(() => sessionStorage.clear());

  it('preserves a safe stored destination across repeated setup mounts', () => {
    sessionStorage.setItem(SESSION_KEY, '/c/deep-link?model=test');

    expect(peekPostLoginRedirect(new URLSearchParams())).toBe('/c/deep-link?model=test');
    expect(peekPostLoginRedirect(new URLSearchParams())).toBe('/c/deep-link?model=test');
    expect(sessionStorage.getItem(SESSION_KEY)).toBe('/c/deep-link?model=test');
  });
});

describe('login error redirect_to preservation (AuthContext onError pattern)', () => {
  /** Mirrors the logic in AuthContext.tsx loginUser.onError */
  function buildLoginErrorPath(search: string): string {
    const redirectTo = new URLSearchParams(search).get('redirect_to');
    return redirectTo && isSafeRedirect(redirectTo)
      ? `/login?redirect_to=${encodeURIComponent(redirectTo)}`
      : '/login';
  }

  it('preserves a valid redirect_to across login failure', () => {
    const result = buildLoginErrorPath('?redirect_to=%2Fc%2Fnew');
    expect(result).toBe('/login?redirect_to=%2Fc%2Fnew');
  });

  it('drops an open-redirect attempt (absolute URL)', () => {
    const result = buildLoginErrorPath('?redirect_to=https%3A%2F%2Fevil.com');
    expect(result).toBe('/login');
  });

  it('drops a /login redirect_to to prevent loops', () => {
    const result = buildLoginErrorPath('?redirect_to=%2Flogin');
    expect(result).toBe('/login');
  });

  it('returns plain /login when no redirect_to param exists', () => {
    const result = buildLoginErrorPath('');
    expect(result).toBe('/login');
  });
});

describe('persistRedirectToSession', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it('stores a valid relative path', () => {
    persistRedirectToSession('/c/new?q=hello');
    expect(sessionStorage.getItem(SESSION_KEY)).toBe('/c/new?q=hello');
  });

  it('rejects an absolute URL', () => {
    persistRedirectToSession('https://evil.com');
    expect(sessionStorage.getItem(SESSION_KEY)).toBeNull();
  });

  it('rejects a protocol-relative URL', () => {
    persistRedirectToSession('//evil.com');
    expect(sessionStorage.getItem(SESSION_KEY)).toBeNull();
  });

  it('rejects /login paths', () => {
    persistRedirectToSession('/login?redirect_to=/c/new');
    expect(sessionStorage.getItem(SESSION_KEY)).toBeNull();
  });
});

/**
 * Embedded and private contexts deny session storage by throwing on access. The destination is a
 * convenience, so a denial must degrade rather than take down the sign-in that carries it.
 */
describe('blocked session storage', () => {
  const denyStorage = () => {
    const denied = () => {
      throw new DOMException('denied', 'SecurityError');
    };
    jest.spyOn(Storage.prototype, 'setItem').mockImplementation(denied);
    jest.spyOn(Storage.prototype, 'getItem').mockImplementation(denied);
    jest.spyOn(Storage.prototype, 'removeItem').mockImplementation(denied);
  };

  beforeEach(() => {
    clearPostLoginRedirect();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    clearPostLoginRedirect();
  });

  it('does not throw when persisting a destination', () => {
    denyStorage();
    expect(() => persistRedirectToSession('/c/abc123')).not.toThrow();
  });

  it('does not throw when consuming a destination', () => {
    denyStorage();
    expect(() => getPostLoginRedirect(new URLSearchParams())).not.toThrow();
  });

  it('does not throw when clearing a destination', () => {
    denyStorage();
    expect(() => clearPostLoginRedirect()).not.toThrow();
  });

  it('still resolves the URL destination while storage is denied', () => {
    denyStorage();
    expect(getPostLoginRedirect(new URLSearchParams('redirect_to=%2Fc%2Fabc123'))).toBe(
      '/c/abc123',
    );
  });

  /** The in-document hand-off never replaces the document, so the mirror still reaches it. */
  it('carries the destination in memory across a persist and consume pair', () => {
    denyStorage();
    persistRedirectToSession('/c/abc123');

    expect(getPostLoginRedirect(new URLSearchParams())).toBe('/c/abc123');
  });

  it('consumes the in-memory destination exactly once', () => {
    denyStorage();
    persistRedirectToSession('/c/abc123');

    expect(getPostLoginRedirect(new URLSearchParams())).toBe('/c/abc123');
    expect(getPostLoginRedirect(new URLSearchParams())).toBeNull();
  });

  it('drops the in-memory destination on clear', () => {
    denyStorage();
    persistRedirectToSession('/c/abc123');
    clearPostLoginRedirect();

    expect(getPostLoginRedirect(new URLSearchParams())).toBeNull();
  });

  it('still refuses an unsafe destination while storage is denied', () => {
    denyStorage();
    persistRedirectToSession('https://evil.com');

    expect(getPostLoginRedirect(new URLSearchParams())).toBeNull();
  });

  /**
   * Storage answers here, so it is the authority. A mirror written on every persist would outlive
   * a destination cleared straight out of storage and resurrect it on the next sign-in.
   */
  it('does not resurrect a destination dropped straight from storage', () => {
    persistRedirectToSession('/c/abc123');
    sessionStorage.clear();

    expect(getPostLoginRedirect(new URLSearchParams())).toBeNull();
  });

  it('does not let a denied write outlive a later working one', () => {
    denyStorage();
    persistRedirectToSession('/c/denied');
    jest.restoreAllMocks();

    persistRedirectToSession('/c/stored');
    sessionStorage.clear();

    expect(getPostLoginRedirect(new URLSearchParams())).toBeNull();
  });
});
