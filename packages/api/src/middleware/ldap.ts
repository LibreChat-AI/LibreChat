import type { RequestHandler } from 'express';

/**
 * Chooses the credential check a password sign-in route runs: the directory when LDAP is
 * configured, since a directory user has no local password, and local accounts otherwise. The
 * caller supplies the LDAP config and both checks, so every sign-in route makes the same choice.
 */
export function selectLoginAuth({
  ldap,
  directory,
  local,
}: {
  ldap?: { enabled?: boolean };
  directory: RequestHandler;
  local: RequestHandler;
}): RequestHandler {
  return ldap?.enabled ? directory : local;
}

/** LDAP libraries can throw outside Express when asynchronous binds receive non-string credentials. */
export const validateLdapCredentials: RequestHandler = (req, res, next) => {
  const { email, password } = req.body ?? {};
  if (
    typeof email !== 'string' ||
    email.length === 0 ||
    typeof password !== 'string' ||
    password.length === 0
  ) {
    res.status(400).json({ message: 'Invalid credentials' });
    return;
  }
  next();
};
