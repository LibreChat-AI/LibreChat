import { readTwoFactorSetupToken } from 'librechat-data-provider';

export const REDIRECT_PARAM = 'redirect_to';
export const SESSION_KEY = 'post_login_redirect_to';

/** Matches `/login` as a full path segment, with optional basename prefix (e.g. `/librechat/login/2fa`) */
const LOGIN_PATH_RE = /(?:^|\/)login(?:\/|$)/;

/**
 * The URL parser removes every ASCII tab and newline before resolving, so a target
 * like `/\t/evil.com` would clear the prefix checks below and then resolve to
 * `//evil.com`. Reject C0 controls outright rather than trying to match the parser.
 */
function hasControlChar(url: string): boolean {
  for (let i = 0; i < url.length; i++) {
    if (url.charCodeAt(i) <= 0x1f) {
      return true;
    }
  }
  return false;
}

/** Confirms the target resolves to this origin, which is what the browser will actually navigate to */
function resolvesToSameOrigin(url: string): boolean {
  const origin = typeof window === 'undefined' ? undefined : window.location?.origin;
  if (origin == null || origin === 'null') {
    return false;
  }
  try {
    return new URL(url, origin).origin === origin;
  } catch {
    return false;
  }
}

interface PostLoginRedirectWindow extends Window {
  __librechatPostLoginRedirect?: string;
}

/**
 * Session storage is blocked outright in embedded and private contexts, where it throws on access
 * rather than returning null. The destination is a convenience, never a credential, so a blocked
 * store must never take down the sign-in that carries it: access degrades to an in-memory mirror,
 * which still reaches the hand-offs that stay inside the document.
 *
 * Storage stays authoritative whenever it answers, and the mirror is written only where storage
 * refused. Mirroring every write would let a destination that storage has since dropped come back
 * from the dead.
 */
const readStoredRedirect = (): string | null => {
  try {
    return window.sessionStorage.getItem(SESSION_KEY);
  } catch {
    return (window as PostLoginRedirectWindow).__librechatPostLoginRedirect ?? null;
  }
};

const writeStoredRedirect = (value: string): void => {
  try {
    window.sessionStorage.setItem(SESSION_KEY, value);
    delete (window as PostLoginRedirectWindow).__librechatPostLoginRedirect;
  } catch {
    (window as PostLoginRedirectWindow).__librechatPostLoginRedirect = value;
  }
};

const dropStoredRedirect = (): void => {
  delete (window as PostLoginRedirectWindow).__librechatPostLoginRedirect;
  try {
    window.sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // Ignore unavailable storage.
  }
};

/** Suffix rather than whole path, so a deployment served under a basename still matches. */
const SETUP_PATH_SUFFIX = '/login/2fa/setup';

/**
 * The mandatory enrollment screen holding a live setup token is a destination in its own right, so
 * it is exempt from the post-login redirects that would otherwise send an authenticated but
 * unenrolled user on to the app.
 *
 * The router matches case-insensitively and ignores a trailing slash, so recognising the route by
 * its exact spelling would strand anyone whose URL differs only in those: the screen renders, this
 * reports it unprotected, and the redirect pulls them off a live enrollment. Normalize the same way
 * the router does before comparing.
 */
export function isRequiredTwoFactorSetupRoute(): boolean {
  const pathname = window.location.pathname.toLowerCase().replace(/\/+$/, '');
  return pathname.endsWith(SETUP_PATH_SUFFIX) && !!readTwoFactorSetupToken();
}

/** Validates that a redirect target is a safe relative path (not an absolute or protocol-relative URL) */
export function isSafeRedirect(url: string): boolean {
  if (hasControlChar(url)) {
    return false;
  }
  if (!url.startsWith('/') || url.startsWith('//') || url.includes('\\')) {
    return false;
  }
  const path = url.split('?')[0].split('#')[0];
  if (LOGIN_PATH_RE.test(path)) {
    return false;
  }
  return resolvesToSameOrigin(url);
}

/**
 * Resolves the post-login redirect from URL params and sessionStorage,
 * cleans up both sources, and returns the validated target (or null).
 */
export function getPostLoginRedirect(searchParams: URLSearchParams): string | null {
  const target = peekPostLoginRedirect(searchParams);
  dropStoredRedirect();
  return target;
}

/** Drops a pending destination, so a later sign-in starts from a clean slate. */
export function clearPostLoginRedirect(): void {
  dropStoredRedirect();
}

export function peekPostLoginRedirect(searchParams: URLSearchParams): string | null {
  const urlRedirect = searchParams.get(REDIRECT_PARAM);
  const storedRedirect = readStoredRedirect();

  const target = urlRedirect ?? storedRedirect;

  if (target == null || !isSafeRedirect(target)) {
    return null;
  }

  return target;
}

/**
 * Prefixes an app-relative path with the deployment's `<base href>` so installs served
 * from a subdirectory navigate inside the router instead of to the host root. Reads the
 * same source the router uses for its basename, keeping full-page navigations aligned
 * with router navigations.
 */
export function withBasePath(path: string): string {
  if (typeof document === 'undefined') {
    return path;
  }
  const href = document.querySelector('base')?.getAttribute('href');
  if (href == null || href === '') {
    return path;
  }
  try {
    const base = new URL(href, window.location.origin).pathname.replace(/\/+$/, '');
    return base ? `${base}${path}` : path;
  } catch {
    return path;
  }
}

export function persistRedirectToSession(value: string): void {
  if (isSafeRedirect(value)) {
    writeStoredRedirect(value);
  }
}
