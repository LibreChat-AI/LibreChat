import type { PrincipalType } from 'librechat-data-provider';

export type PermissionSnapshot = {
  permBits: number;
  roleId: string;
};

/** A grant, update or revoke on one principal, as plain ids and bits. */
export type PermissionChange = {
  action: 'assigned' | 'removed';
  principal: { type: PrincipalType; id?: string | null };
  previous: PermissionSnapshot | null;
  written: PermissionSnapshot | null;
};
