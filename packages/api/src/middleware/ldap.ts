import type { RequestHandler } from 'express';

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
