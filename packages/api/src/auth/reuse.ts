import jwt from 'jsonwebtoken';

export function getValidOpenIdReuseUserId(
  openidUserId: string | undefined,
  secret: string | undefined = process.env.JWT_REFRESH_SECRET,
): string | null {
  if (!openidUserId || !secret) {
    return null;
  }

  try {
    const payload = jwt.verify(openidUserId, secret);
    return typeof payload === 'object' && payload != null && typeof payload.id === 'string'
      ? payload.id
      : null;
  } catch {
    return null;
  }
}
