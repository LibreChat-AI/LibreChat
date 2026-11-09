import type { Request } from 'express';
import type { NmbConfig, ScanContext } from './types';

export interface GatewayIdentity {
  userId: string;
  role: string;
  ctx: ScanContext;
}

type SessionUser = { id?: string; _id?: { toString(): string }; role?: string };

/**
 * Builds the scanner identity from the authenticated session only. The request body and query
 * are never consulted, so a client cannot choose its own user, department, roles or scope.
 *
 * Placeholders are scoped per user (`u:<id>`), not per conversation: a new conversation has no id
 * yet when its first message and attachments are scanned, and one namespace keeps `<ACCOUNT_001>`
 * meaning the same value across text, files and replies.
 */
export function resolveIdentity(req: Request, config: NmbConfig): GatewayIdentity | null {
  const user = (req as Request & { user?: SessionUser }).user;
  const userId = user?.id ?? user?._id?.toString();
  if (!userId) {
    return null;
  }
  const role = user?.role ?? 'USER';
  const department = config.roleDepartments[role] ?? config.defaultDepartment;
  return {
    userId,
    role,
    ctx: {
      scope: `u:${userId}`,
      user: userId,
      department,
      roles: [role.toLowerCase()],
    },
  };
}

/** Scanner roles for a reviewer call. Authorisation is decided by LibreChat (capability); this only satisfies the scanner. */
export const SCANNER_REVIEWER_ROLES = ['reviewer'];
