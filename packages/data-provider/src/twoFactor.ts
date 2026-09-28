/**
 * Hand-off channel for the required-enrollment setup token.
 *
 * The token is a bearer credential in its own right: it can generate a TOTP secret of the
 * holder's choosing and then drive confirm, acknowledge, and finalize into a real session, with
 * no victim secret involved. Carrying it in the query string would leave it in browser history,
 * in access and reverse-proxy logs, and potentially in a Referer header, so it is handed to the
 * setup screen out of band instead.
 *
 * Session storage survives the hard navigation the response interceptor performs and is scoped to
 * the one tab. The in-memory mirror keeps the flow working where storage is blocked, which is why
 * persisting reports whether it reached durable storage: a navigation that replaces the document
 * would drop the mirror, so the interceptor stays inside the document when only the mirror holds.
 */

const SETUP_TOKEN_STORAGE_KEY = 'two_factor_setup_token';

interface TwoFactorSetupWindow extends Window {
  __librechatTwoFactorSetupToken?: string;
}

/**
 * Returns whether the token reached storage that outlives the current document. Callers that were
 * about to replace the document need to know, because the in-memory mirror does not survive that.
 */
export function persistTwoFactorSetupToken(tempToken: string): boolean {
  const trimmed = tempToken.trim();
  (window as TwoFactorSetupWindow).__librechatTwoFactorSetupToken = trimmed;
  try {
    window.sessionStorage.setItem(SETUP_TOKEN_STORAGE_KEY, trimmed);
    return true;
  } catch {
    // Session storage can be blocked in embedded or private contexts.
    return false;
  }
}

export function readTwoFactorSetupToken(): string {
  try {
    const stored = window.sessionStorage.getItem(SETUP_TOKEN_STORAGE_KEY)?.trim();
    if (stored) {
      return stored;
    }
  } catch {
    // Fall through to the in-memory mirror.
  }

  return (window as TwoFactorSetupWindow).__librechatTwoFactorSetupToken?.trim() ?? '';
}

export function clearTwoFactorSetupToken(): void {
  delete (window as TwoFactorSetupWindow).__librechatTwoFactorSetupToken;
  try {
    window.sessionStorage.removeItem(SETUP_TOKEN_STORAGE_KEY);
  } catch {
    // Ignore unavailable storage.
  }
}
