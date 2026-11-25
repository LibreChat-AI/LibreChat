import { getTokenHeader } from 'librechat-data-provider';

/**
 * Who the requests going out right now belong to.
 *
 * Read from the Authorization header rather than from React state, because the
 * two do not change together: `setUserContext` installs the new header in one
 * synchronous call, while a Recoil set or an effect publishes the user later.
 * Work queued by one account and sent during that gap would be attributed to
 * the previous user while travelling as the new one.
 *
 * Not always a LibreChat user id. With OpenID token reuse the bearer is the
 * provider's own `id_token`, which identifies its subject as `sub` under an
 * issuer and carries no `id`. What matters is only that one account is never
 * mistaken for another, so any stable identifier the credential offers will do.
 */
export const getSessionPrincipal = (): string | undefined => {
  const header = getTokenHeader();
  if (header == null) {
    return undefined;
  }

  const token = header.replace(/^Bearer /, '');
  const claims = decodeClaims(token);

  if (typeof claims?.id === 'string') {
    return `user:${claims.id}`;
  }
  if (typeof claims?.sub === 'string') {
    /* Scoped by issuer, since subjects are only unique within one. */
    const issuer = typeof claims.iss === 'string' ? claims.iss : '';
    return `oidc:${issuer}:${claims.sub}`;
  }

  /* An opaque token names no one, and two unnamed sessions must not read as the
   * same person. The credential itself is what distinguishes them; the cost is
   * that a refresh looks like a new session and abandons whatever it had
   * queued, which is the safe direction to fail in. */
  return `token:${token}`;
};

const decodeClaims = (
  token: string,
): { id?: unknown; sub?: unknown; iss?: unknown } | undefined => {
  const payload = token.split('.')[1];
  if (payload == null) {
    return undefined;
  }
  try {
    /* base64url, so the alphabet differs and the padding is dropped. */
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
    return JSON.parse(atob(padded));
  } catch {
    return undefined;
  }
};
