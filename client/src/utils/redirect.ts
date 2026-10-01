export const REDIRECT_PARAM = 'redirect_to';
export const SESSION_KEY = 'post_login_redirect_to';

/** Matches `/login` as a full path segment, with optional basename prefix (e.g. `/librechat/login/2fa`) */
const LOGIN_PATH_RE = /(?:^|\/)login(?:\/|$)/;

/** Session storage is blocked outright in embedded and private contexts, where it throws on
 * access rather than returning null. The destination is a convenience, never a credential, so a
 * blocked store must cost the deep link, never the sign-in that carries it: every access
 * degrades to "no destination stored". Every other session-storage consumer in the client is
 * already guarded this way; the redirect flow was the one reaching for the store bare-handed. */
export const readStoredRedirect = (): string | null => {
  try {
    return sessionStorage.getItem(SESSION_KEY);
  } catch {
    return null;
  }
};

export const dropStoredRedirect = (): void => {
  try {
    sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // A blocked store holds nothing to drop.
  }
};

const writeStoredRedirect = (value: string): void => {
  try {
    sessionStorage.setItem(SESSION_KEY, value);
  } catch {
    // The destination cannot cross a document swap in this context; the sign-in continues.
  }
};

/** Validates that a redirect target is a safe relative path (not an absolute or protocol-relative URL) */
export function isSafeRedirect(url: string): boolean {
  if (!url.startsWith('/') || url.startsWith('//') || url.includes('\\')) {
    return false;
  }
  const path = url.split('?')[0].split('#')[0];
  return !LOGIN_PATH_RE.test(path);
}

/** Whether a destination is waiting to be consumed; storage that refuses to answer counts as none. */
export const hasStoredRedirect = (): boolean => readStoredRedirect() != null;

/**
 * Resolves the post-login redirect from URL params and sessionStorage,
 * cleans up both sources, and returns the validated target (or null).
 */
export function getPostLoginRedirect(searchParams: URLSearchParams): string | null {
  const urlRedirect = searchParams.get(REDIRECT_PARAM);
  const storedRedirect = readStoredRedirect();

  const target = urlRedirect ?? storedRedirect;

  if (storedRedirect) {
    dropStoredRedirect();
  }

  if (target == null || !isSafeRedirect(target)) {
    return null;
  }

  return target;
}

export function persistRedirectToSession(value: string): void {
  if (isSafeRedirect(value)) {
    writeStoredRedirect(value);
  }
}
