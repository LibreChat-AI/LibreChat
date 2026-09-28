import {
  persistRedirectToSession,
  getPostLoginRedirect,
  isSafeRedirect,
  hasStoredRedirect,
  SESSION_KEY,
} from '../redirect';

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

describe('blocked session storage', () => {
  /** Embedded and private contexts throw on access rather than answering null. */
  const originalDescriptor = Object.getOwnPropertyDescriptor(window, 'sessionStorage');

  beforeEach(() => {
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      get() {
        throw new DOMException('Storage is blocked in this context', 'SecurityError');
      },
    });
  });

  afterAll(() => {
    if (originalDescriptor != null) {
      Object.defineProperty(window, 'sessionStorage', originalDescriptor);
    }
  });

  it('persisting a destination does not take down the sign-in', () => {
    expect(() => persistRedirectToSession('/c/new')).not.toThrow();
  });

  it('a blocked store reads as empty so the URL param still resolves', () => {
    const params = new URLSearchParams('redirect_to=%2Fc%2Fnew');
    expect(getPostLoginRedirect(params)).toBe('/c/new');
  });

  it('no destination resolves when only the blocked store exists', () => {
    expect(getPostLoginRedirect(new URLSearchParams())).toBeNull();
  });

  it('hasStoredRedirect counts a blocked store as empty', () => {
    expect(hasStoredRedirect()).toBe(false);
  });
});
