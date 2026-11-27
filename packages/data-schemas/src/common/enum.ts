import { PermissionBits } from 'librechat-data-provider';

/**
 * Common role combinations. Values mirror unions of `PermissionBits` flags;
 * literals are required by `--isolatedDeclarations` (cross-file enum refs
 * aren't computable). The guard below fails fast on any drift.
 */
export enum RoleBits {
  /** VIEW */
  VIEWER = 1,
  /** VIEW | EDIT */
  EDITOR = 3,
  /** VIEW | EDIT | DELETE */
  MANAGER = 7,
  /** VIEW | EDIT | DELETE | SHARE */
  OWNER = 15,
}

if (
  (RoleBits.VIEWER as number) !== PermissionBits.VIEW ||
  (RoleBits.EDITOR as number) !== (PermissionBits.VIEW | PermissionBits.EDIT) ||
  (RoleBits.MANAGER as number) !==
    (PermissionBits.VIEW | PermissionBits.EDIT | PermissionBits.DELETE) ||
  (RoleBits.OWNER as number) !==
    (PermissionBits.VIEW | PermissionBits.EDIT | PermissionBits.DELETE | PermissionBits.SHARE)
) {
  throw new Error('RoleBits is out of sync with PermissionBits');
}
