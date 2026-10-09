import { PrincipalType, SystemRoles } from 'librechat-data-provider';
import { logger, isValidObjectIdString, RoleConflictError } from '@librechat/data-schemas';
import type {
  IRole,
  IUser,
  IConfig,
  AdminMember,
  ISystemGrant,
  RecordAuditEntryInput,
  RecordAuditEntryOptions,
} from '@librechat/data-schemas';
import type { FilterQuery, Types } from 'mongoose';
import type { Response } from 'express';
import type { ServerRequest } from '~/types/http';
import { parsePagination } from './pagination';
import { buildAuditContext } from './context';

const systemRoleValues = new Set<string>(Object.values(SystemRoles));

/** Case-insensitive check — the legacy roles route uppercases params. */
function isSystemRoleName(name: string): boolean {
  return systemRoleValues.has(name.toUpperCase());
}

const MAX_NAME_LENGTH = 500;
const MAX_DESCRIPTION_LENGTH = 2000;
const CONTROL_CHAR_RE = /\p{Cc}/u;
/**
 * Role names that would create semantically ambiguous URLs.
 * e.g. GET /api/admin/roles/members — is that "list roles" or "get role named members"?
 * Express routing resolves this correctly (single vs multi-segment), but the URLs
 * are confusing for API consumers. Keep in sync with sub-path routes in routes/admin/roles.js.
 */
const RESERVED_ROLE_NAMES = new Set(['members', 'permissions']);

function validateNameParam(name: string): string | null {
  if (!name || typeof name !== 'string') {
    return 'name parameter is required';
  }
  if (name.length > MAX_NAME_LENGTH) {
    return `name must not exceed ${MAX_NAME_LENGTH} characters`;
  }
  if (CONTROL_CHAR_RE.test(name)) {
    return 'name contains invalid characters';
  }
  return null;
}

function validateRoleName(name: unknown, required: boolean): string | null {
  if (name === undefined) {
    return required ? 'name is required' : null;
  }
  if (typeof name !== 'string' || !name.trim()) {
    return required ? 'name is required' : 'name must be a non-empty string';
  }
  const trimmed = name.trim();
  if (trimmed.length > MAX_NAME_LENGTH) {
    return `name must not exceed ${MAX_NAME_LENGTH} characters`;
  }
  if (CONTROL_CHAR_RE.test(trimmed)) {
    return 'name contains invalid characters';
  }
  if (RESERVED_ROLE_NAMES.has(trimmed)) {
    return 'name is a reserved path segment';
  }
  return null;
}

function validateDescription(description: unknown): string | null {
  if (description === undefined) {
    return null;
  }
  if (typeof description !== 'string') {
    return 'description must be a string';
  }
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    return `description must not exceed ${MAX_DESCRIPTION_LENGTH} characters`;
  }
  return null;
}

interface RoleNameParams {
  name: string;
}

interface RoleMemberParams extends RoleNameParams {
  userId: string;
}

export type RoleListItem = { _id: Types.ObjectId | string; name: string; description?: string };

export interface AdminRolesDeps {
  listRoles: (options?: { limit?: number; offset?: number }) => Promise<RoleListItem[]>;
  countRoles: () => Promise<number>;
  getRoleByName: (name: string, fields?: string | string[] | null) => Promise<IRole | null>;
  createRoleByName: (roleData: Partial<IRole>) => Promise<IRole>;
  updateRoleByName: (name: string, updates: Partial<IRole>) => Promise<IRole | null>;
  updateAccessPermissions: (
    name: string,
    perms: Record<string, Record<string, boolean>>,
    roleData?: IRole,
  ) => Promise<void>;
  deleteRoleByName: (name: string) => Promise<IRole | null>;
  findUser: (
    criteria: FilterQuery<IUser>,
    fields?: string | string[] | null,
  ) => Promise<IUser | null>;
  updateUser: (userId: string, data: Partial<IUser>) => Promise<IUser | null>;
  updateUsersByRole: (oldRole: string, newRole: string) => Promise<void>;
  findUserIdsByRole: (roleName: string) => Promise<string[]>;
  updateUsersRoleByIds: (userIds: string[], newRole: string) => Promise<void>;
  listUsersByRole: (
    roleName: string,
    options?: { limit?: number; offset?: number },
  ) => Promise<IUser[]>;
  countUsersByRole: (roleName: string) => Promise<number>;
  /** Removes the per-principal config override (keyed by type + name, not ObjectId). */
  deleteConfig: (
    principalType: PrincipalType,
    principalId: string | Types.ObjectId,
  ) => Promise<IConfig | null>;
  /** Removes all ACL entries scoped to this principal. */
  deleteAclEntries: (filter: {
    principalType: PrincipalType;
    principalId: string | Types.ObjectId;
  }) => Promise<void>;
  /** Drops cached prompt group access IDs; role deletion can remove PROMPTGROUP grants. */
  invalidatePromptGroupAccessContext?: () => Promise<void>;
  /** Removes all system capability grants held by this principal and returns
   * the removed grants so each can be audited. */
  deleteGrantsForPrincipal: (
    principalType: PrincipalType,
    principalId: string | Types.ObjectId,
    options?: { tenantId?: string },
  ) => Promise<ISystemGrant[]>;
  /** Optional audit emission for grants removed by the role-deletion cascade.
   * Failure is logged but never blocks the deletion (which has already happened). */
  recordAuditEntry?: (
    input: RecordAuditEntryInput,
    options?: RecordAuditEntryOptions,
  ) => Promise<void>;
}

export function createAdminRolesHandlers(deps: AdminRolesDeps): {
  listRoles: (req: ServerRequest, res: Response) => Promise<Response>;
  getRole: (req: ServerRequest, res: Response) => Promise<Response>;
  createRole: (req: ServerRequest, res: Response) => Promise<Response>;
  updateRole: (req: ServerRequest, res: Response) => Promise<Response>;
  updateRolePermissions: (req: ServerRequest, res: Response) => Promise<Response>;
  deleteRole: (req: ServerRequest, res: Response) => Promise<Response>;
  getRoleMembers: (req: ServerRequest, res: Response) => Promise<Response>;
  addRoleMember: (req: ServerRequest, res: Response) => Promise<Response>;
  removeRoleMember: (req: ServerRequest, res: Response) => Promise<Response>;
} {
  const {
    listRoles,
    countRoles,
    getRoleByName,
    createRoleByName,
    updateRoleByName,
    updateAccessPermissions,
    deleteRoleByName,
    findUser,
    updateUser,
    updateUsersByRole,
    findUserIdsByRole,
    updateUsersRoleByIds,
    listUsersByRole,
    countUsersByRole,
    deleteConfig,
    deleteAclEntries,
    deleteGrantsForPrincipal,
    recordAuditEntry,
    invalidatePromptGroupAccessContext,
  } = deps;

  /** Emits a `grant.removed` audit entry for each grant the role-deletion cascade
   * removed, so the cascade leaves the same forensic trail as an explicit revoke.
   * Fail-open: the role is already deleted, so a failed audit is logged, not
   * propagated. Sequential to keep the per-tenant hash chain ordered. */
  async function emitGrantRemovals(
    req: ServerRequest,
    roleName: string,
    grants: ISystemGrant[],
  ): Promise<void> {
    if (!recordAuditEntry || grants.length === 0) return;
    const user = req.user;
    const userId = user?._id?.toString() ?? user?.id;
    if (!user || !userId) return;
    const actorName = user.name || user.username || user.email || userId;
    const context = buildAuditContext(req);
    for (const grant of grants) {
      try {
        await recordAuditEntry({
          action: 'grant.removed',
          outcome: 'success',
          severity: 'warning',
          actor: { type: 'user', id: userId, name: actorName },
          target: { type: PrincipalType.ROLE, id: roleName, name: roleName },
          metadata: { capability: grant.capability },
          context,
          /** Scope each entry to the removed grant's own tenant — a platform
           * admin's role deletion can remove tenant-scoped grants, and those
           * removals must land in the affected tenant's chain, not the caller's. */
          tenantId: grant.tenantId,
        });
      } catch (err) {
        logger.error('[adminRoles] grant.removed audit failed during role deletion', err);
      }
    }
  }

  async function listRolesHandler(req: ServerRequest, res: Response) {
    try {
      const { limit, offset } = parsePagination(req.query);
      const [roles, total] = await Promise.all([listRoles({ limit, offset }), countRoles()]);
      return res.status(200).json({ roles, total, limit, offset });
    } catch (error) {
      logger.error('[adminRoles] listRoles error:', error);
      return res.status(500).json({ error: 'Failed to list roles' });
    }
  }

  async function getRoleHandler(req: ServerRequest, res: Response) {
    try {
      const { name } = req.params as RoleNameParams;
      const paramError = validateNameParam(name);
      if (paramError) {
        return res.status(400).json({ error: paramError });
      }
      const role = await getRoleByName(name);
      if (!role) {
        return res.status(404).json({ error: 'Role not found' });
      }
      return res.status(200).json({ role });
    } catch (error) {
      logger.error('[adminRoles] getRole error:', error);
      return res.status(500).json({ error: 'Failed to get role' });
    }
  }

  async function createRoleHandler(req: ServerRequest, res: Response) {
    try {
      const { name, description, permissions } = req.body as {
        name?: string;
        description?: string;
        permissions?: IRole['permissions'];
      };
      const nameError = validateRoleName(name, true);
      if (nameError) {
        return res.status(400).json({ error: nameError });
      }
      const descError = validateDescription(description);
      if (descError) {
        return res.status(400).json({ error: descError });
      }
      if (
        permissions !== undefined &&
        (permissions === null || typeof permissions !== 'object' || Array.isArray(permissions))
      ) {
        return res.status(400).json({ error: 'permissions must be an object' });
      }
      const roleData: Partial<IRole> = {
        name: (name as string).trim(),
        permissions: permissions ?? {},
      };
      if (description !== undefined) {
        roleData.description = description;
      }
      const role = await createRoleByName(roleData);
      return res.status(201).json({ role });
    } catch (error) {
      logger.error('[adminRoles] createRole error:', error);
      if (error instanceof RoleConflictError) {
        return res.status(409).json({ error: error.message });
      }
      return res.status(500).json({ error: 'Failed to create role' });
    }
  }

  async function rollbackMigratedUsers(
    migratedIds: string[],
    currentName: string,
    newName: string,
  ): Promise<void> {
    if (migratedIds.length === 0) {
      return;
    }
    try {
      await updateUsersRoleByIds(migratedIds, currentName);
    } catch (rollbackError) {
      logger.error(
        `[adminRoles] CRITICAL: rename rollback failed — ${migratedIds.length} users have dangling role "${newName}": [${migratedIds.join(', ')}]`,
        rollbackError,
      );
    }
  }

  /**
   * Renames a role by migrating users to the new name and updating the role document.
   *
   * The ID snapshot from `findUserIdsByRole` is a point-in-time read. Users assigned
   * to `currentName` between the snapshot and the bulk `updateUsersByRole` write will
   * be moved to `newName` but will NOT be reverted on rollback. This window is narrow
   * and only relevant under concurrent admin operations during a rename.
   */
  async function renameRole(
    currentName: string,
    newName: string,
    extraUpdates?: Partial<IRole>,
  ): Promise<IRole | null> {
    const migratedIds = await findUserIdsByRole(currentName);
    await updateUsersByRole(currentName, newName);
    try {
      const updates: Partial<IRole> = { name: newName, ...extraUpdates };
      const role = await updateRoleByName(currentName, updates);
      if (!role) {
        await rollbackMigratedUsers(migratedIds, currentName, newName);
      }
      return role;
    } catch (error) {
      await rollbackMigratedUsers(migratedIds, currentName, newName);
      throw error;
    }
  }

  async function updateRoleHandler(req: ServerRequest, res: Response) {
    try {
      const { name } = req.params as RoleNameParams;
      const paramError = validateNameParam(name);
      if (paramError) {
        return res.status(400).json({ error: paramError });
      }
      const body = req.body as { name?: string; description?: string };
      const nameError = validateRoleName(body.name, false);
      if (nameError) {
        return res.status(400).json({ error: nameError });
      }
      const descError = validateDescription(body.description);
      if (descError) {
        return res.status(400).json({ error: descError });
      }

      const trimmedName = body.name?.trim() ?? '';
      const isRename = trimmedName !== '' && trimmedName !== name;

      if (isRename && isSystemRoleName(name)) {
        return res.status(403).json({ error: 'Cannot rename system role' });
      }
      if (isRename && isSystemRoleName(trimmedName)) {
        return res.status(403).json({ error: 'Cannot use a reserved system role name' });
      }

      const existing = await getRoleByName(name);
      if (!existing) {
        return res.status(404).json({ error: 'Role not found' });
      }

      if (isRename) {
        const duplicate = await getRoleByName(trimmedName);
        if (duplicate) {
          return res.status(409).json({ error: `Role "${trimmedName}" already exists` });
        }
      }

      const updates: Partial<IRole> = {};
      if (isRename) {
        updates.name = trimmedName;
      }
      if (body.description !== undefined) {
        updates.description = body.description;
      }

      if (Object.keys(updates).length === 0) {
        return res.status(200).json({ role: existing });
      }

      if (isRename) {
        const descUpdate =
          body.description !== undefined ? { description: body.description } : undefined;
        const role = await renameRole(name, trimmedName, descUpdate);
        if (!role) {
          return res.status(404).json({ error: 'Role not found' });
        }
        return res.status(200).json({ role });
      }

      const role = await updateRoleByName(name, updates);
      if (!role) {
        return res.status(404).json({ error: 'Role not found' });
      }
      return res.status(200).json({ role });
    } catch (error) {
      if (error instanceof RoleConflictError) {
        return res.status(409).json({ error: error.message });
      }
      logger.error('[adminRoles] updateRole error:', error);
      return res.status(500).json({ error: 'Failed to update role' });
    }
  }

  /**
   * The re-fetch via `getRoleByName` after `updateAccessPermissions` depends on the
   * callee having written the updated document to the role cache. If the cache layer
   * is refactored to stop writing from within `updateAccessPermissions`, this handler
   * must be updated to perform an explicit uncached DB read.
   */
  async function updateRolePermissionsHandler(req: ServerRequest, res: Response) {
    try {
      const { name } = req.params as RoleNameParams;
      const paramError = validateNameParam(name);
      if (paramError) {
        return res.status(400).json({ error: paramError });
      }
      const { permissions } = req.body as {
        permissions: Record<string, Record<string, boolean>>;
      };

      if (!permissions || typeof permissions !== 'object' || Array.isArray(permissions)) {
        return res.status(400).json({ error: 'permissions object is required' });
      }

      const existing = await getRoleByName(name);
      if (!existing) {
        return res.status(404).json({ error: 'Role not found' });
      }

      await updateAccessPermissions(name, permissions, existing);
      const updated = await getRoleByName(name);
      if (!updated) {
        return res.status(404).json({ error: 'Role not found' });
      }
      return res.status(200).json({ role: updated });
    } catch (error) {
      logger.error('[adminRoles] updateRolePermissions error:', error);
      return res.status(500).json({ error: 'Failed to update role permissions' });
    }
  }

  async function deleteRoleHandler(req: ServerRequest, res: Response) {
    try {
      const { name } = req.params as RoleNameParams;
      const paramError = validateNameParam(name);
      if (paramError) {
        return res.status(400).json({ error: paramError });
      }
      if (isSystemRoleName(name)) {
        return res.status(403).json({ error: 'Cannot delete system role' });
      }

      const deleted = await deleteRoleByName(name);
      if (!deleted) {
        return res.status(404).json({ error: 'Role not found' });
      }

      const tenantId = req.user?.tenantId;
      const [configResult, aclResult, grantsResult] = await Promise.allSettled([
        deleteConfig(PrincipalType.ROLE, name),
        deleteAclEntries({ principalType: PrincipalType.ROLE, principalId: name }),
        deleteGrantsForPrincipal(PrincipalType.ROLE, name, { tenantId }),
      ]);
      for (const result of [configResult, aclResult, grantsResult]) {
        if (result.status === 'rejected') {
          logger.error('[adminRoles] cascade cleanup failed for role:', name, result.reason);
        }
      }
      if (aclResult.status === 'fulfilled') {
        /** The removed entries can include PROMPTGROUP grants feeding the access cache */
        await invalidatePromptGroupAccessContext?.();
      }
      if (grantsResult.status === 'fulfilled') {
        await emitGrantRemovals(req, name, grantsResult.value);
      }

      return res.status(200).json({ success: true });
    } catch (error) {
      logger.error('[adminRoles] deleteRole error:', error);
      return res.status(500).json({ error: 'Failed to delete role' });
    }
  }

  async function getRoleMembersHandler(req: ServerRequest, res: Response) {
    try {
      const { name } = req.params as RoleNameParams;
      const paramError = validateNameParam(name);
      if (paramError) {
        return res.status(400).json({ error: paramError });
      }
      const existing = await getRoleByName(name);
      if (!existing) {
        return res.status(404).json({ error: 'Role not found' });
      }

      const { limit, offset } = parsePagination(req.query);

      const [users, total] = await Promise.all([
        listUsersByRole(name, { limit, offset }),
        countUsersByRole(name),
      ]);
      const members: AdminMember[] = users.map((u) => ({
        userId: u._id?.toString() ?? '',
        name: u.name ?? u._id?.toString() ?? '',
        email: u.email ?? '',
        avatarUrl: u.avatar,
      }));
      return res.status(200).json({ members, total, limit, offset });
    } catch (error) {
      logger.error('[adminRoles] getRoleMembers error:', error);
      return res.status(500).json({ error: 'Failed to get role members' });
    }
  }

  async function addRoleMemberHandler(req: ServerRequest, res: Response) {
    try {
      const { name } = req.params as RoleNameParams;
      const paramError = validateNameParam(name);
      if (paramError) {
        return res.status(400).json({ error: paramError });
      }
      const { userId } = req.body as { userId: string };

      if (!userId || typeof userId !== 'string') {
        return res.status(400).json({ error: 'userId is required' });
      }
      if (!isValidObjectIdString(userId)) {
        return res.status(400).json({ error: 'Invalid user ID format' });
      }

      if (isSystemRoleName(name) && name !== SystemRoles.ADMIN) {
        return res.status(403).json({ error: 'Cannot directly assign members to a system role' });
      }

      const existing = await getRoleByName(name);
      if (!existing) {
        return res.status(404).json({ error: 'Role not found' });
      }

      const user = await findUser({ _id: userId });
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      if (user.role === name) {
        return res.status(200).json({ success: true });
      }

      if (user.role === SystemRoles.ADMIN && name !== SystemRoles.ADMIN) {
        const adminCount = await countUsersByRole(SystemRoles.ADMIN);
        if (adminCount <= 1) {
          return res.status(400).json({ error: 'Cannot remove the last admin user' });
        }
      }

      const updated = await updateUser(userId, { role: name });
      if (!updated) {
        return res.status(404).json({ error: 'User not found' });
      }

      if (user.role === SystemRoles.ADMIN && name !== SystemRoles.ADMIN) {
        const postCount = await countUsersByRole(SystemRoles.ADMIN);
        if (postCount === 0) {
          try {
            await updateUser(userId, { role: SystemRoles.ADMIN });
          } catch (rollbackError) {
            logger.error(
              `[adminRoles] CRITICAL: admin rollback failed in addRoleMember for user ${userId}:`,
              rollbackError,
            );
          }
          return res.status(400).json({ error: 'Cannot remove the last admin user' });
        }
      }

      return res.status(200).json({ success: true });
    } catch (error) {
      logger.error('[adminRoles] addRoleMember error:', error);
      return res.status(500).json({ error: 'Failed to add role member' });
    }
  }

  async function removeRoleMemberHandler(req: ServerRequest, res: Response) {
    try {
      const { name, userId } = req.params as RoleMemberParams;
      const paramError = validateNameParam(name);
      if (paramError) {
        return res.status(400).json({ error: paramError });
      }
      if (!isValidObjectIdString(userId)) {
        return res.status(400).json({ error: 'Invalid user ID format' });
      }

      if (isSystemRoleName(name) && name !== SystemRoles.ADMIN) {
        return res.status(403).json({ error: 'Cannot remove members from a system role' });
      }

      const existing = await getRoleByName(name);
      if (!existing) {
        return res.status(404).json({ error: 'Role not found' });
      }

      const user = await findUser({ _id: userId });
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      if (user.role !== name) {
        return res.status(400).json({ error: 'User is not a member of this role' });
      }

      if (name === SystemRoles.ADMIN) {
        const adminCount = await countUsersByRole(SystemRoles.ADMIN);
        if (adminCount <= 1) {
          return res.status(400).json({ error: 'Cannot remove the last admin user' });
        }
      }

      const removed = await updateUser(userId, { role: SystemRoles.USER });
      if (!removed) {
        return res.status(404).json({ error: 'User not found' });
      }

      if (name === SystemRoles.ADMIN) {
        const postCount = await countUsersByRole(SystemRoles.ADMIN);
        if (postCount === 0) {
          try {
            await updateUser(userId, { role: SystemRoles.ADMIN });
          } catch (rollbackError) {
            logger.error(
              `[adminRoles] CRITICAL: admin rollback failed for user ${userId}:`,
              rollbackError,
            );
          }
          return res.status(400).json({ error: 'Cannot remove the last admin user' });
        }
      }

      return res.status(200).json({ success: true });
    } catch (error) {
      logger.error('[adminRoles] removeRoleMember error:', error);
      return res.status(500).json({ error: 'Failed to remove role member' });
    }
  }

  return {
    listRoles: listRolesHandler,
    getRole: getRoleHandler,
    createRole: createRoleHandler,
    updateRole: updateRoleHandler,
    updateRolePermissions: updateRolePermissionsHandler,
    deleteRole: deleteRoleHandler,
    getRoleMembers: getRoleMembersHandler,
    addRoleMember: addRoleMemberHandler,
    removeRoleMember: removeRoleMemberHandler,
  };
}
