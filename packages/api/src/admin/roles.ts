import { PrincipalType, SystemRoles } from 'librechat-data-provider';
import { logger, isValidObjectIdString, RoleConflictError } from '@librechat/data-schemas';
import type {
  IRole,
  IUser,
  IConfig,
  AdminMember,
  ISystemGrant,
  AuditSeverity,
} from '@librechat/data-schemas';
import type { FilterQuery, Types } from 'mongoose';
import type { Response } from 'express';
import type { ServerRequest } from '~/types/http';
import type { RecordAuditEntry } from './audit';
import { createAdminAuditEmitter, diffRolePermissions } from './audit';
import { getSafeErrorMetadata } from '~/utils/errors';
import { cascadeStep, runCascade } from './cascade';
import { parsePagination } from './pagination';

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
  /** With `options.id`, deletes only the role that still has that `_id`, so a role recreated
   * under the same name is never removed by a request that targeted the original. */
  deleteRoleByName: (name: string, options?: { id?: string }) => Promise<IRole | null>;
  findUser: (
    criteria: FilterQuery<IUser>,
    fields?: string | string[] | null,
  ) => Promise<IUser | null>;
  /** `expectedState` makes the write conditional: it resolves to null when the user no longer matches. */
  updateUser: (
    userId: string,
    data: Partial<IUser>,
    expectedState?: Record<string, unknown>,
  ) => Promise<IUser | null>;
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
  /** Snapshot source and restore sink for the config override removed by the role-deletion
   * cascade. Only the override is restored on failure: ACL entries and grants are never
   * re-inserted, since that could resurrect access a concurrent request revoked, and
   * their removal only narrows access. */
  /** Reads the grants before the cascade so their removal is audited even when it rejects after committing. */
  findGrantsForPrincipal?: (
    principalType: PrincipalType,
    principalId: string,
    options?: { tenantId?: string },
  ) => Promise<ISystemGrant[]>;
  findConfigByPrincipal?: (
    principalType: PrincipalType,
    principalId: string,
    options?: { includeInactive?: boolean },
  ) => Promise<IConfig | null>;
  /** Re-creates a deleted config document in full, only if none exists. Resolves
   * to whether it inserted. */
  restoreConfig?: (snapshot: Record<string, unknown>) => Promise<boolean>;
  /** Optional audit emission for role mutations and the grants removed by the
   * role-deletion cascade. Failure is logged unless `auditFailClosed` is set. */
  recordAuditEntry?: RecordAuditEntry;
  /** When true, a failed audit write surfaces as a 5xx after the mutation has
   * been persisted. Defaults to fail-open. */
  auditFailClosed?: boolean;
}

/** Account ids per entry, so a large role is audited in a few ordered writes. */
const AUDIT_MEMBER_CHUNK = 100;

/** Changing who holds ADMIN is the most sensitive membership change. */
function memberChangeSeverity(...roles: Array<string | undefined>): AuditSeverity {
  return roles.includes(SystemRoles.ADMIN) ? 'critical' : 'warning';
}

function roleTarget(name: string) {
  return { type: 'role', id: name, name };
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
    restoreConfig,
    findConfigByPrincipal,
    findGrantsForPrincipal,
    recordAuditEntry,
    auditFailClosed,
    invalidatePromptGroupAccessContext,
  } = deps;

  const emitAudit = createAdminAuditEmitter({
    recordAuditEntry,
    failClosed: auditFailClosed,
    logPrefix: '[adminRoles]',
  });
  /** Role deletion revokes access, so its lifecycle entries are always fail-open. */
  const emitRevocationAudit = createAdminAuditEmitter({
    recordAuditEntry,
    logPrefix: '[adminRoles]',
  });

  /** Emits a `grant.removed` audit entry for each grant the role-deletion cascade
   * removed, so the cascade leaves the same forensic trail as an explicit revoke.
   * Sequential to keep the per-tenant hash chain ordered. */
  async function emitGrantRemovals(
    req: ServerRequest,
    roleName: string,
    grants: ISystemGrant[],
  ): Promise<void> {
    for (const grant of grants) {
      await emitRevocationAudit(req, {
        action: 'grant.removed',
        severity: 'warning',
        target: { type: PrincipalType.ROLE, id: roleName, name: roleName },
        metadata: { capability: grant.capability },
        /** Scope each entry to the removed grant's own tenant: a platform
         * admin's role deletion can remove tenant-scoped grants, and those
         * removals must land in the affected tenant's chain, not the caller's. */
        tenantId: grant.tenantId,
      });
    }
  }

  async function listRolesHandler(req: ServerRequest, res: Response) {
    try {
      const { limit, offset } = parsePagination(req.query);
      const [roles, total] = await Promise.all([listRoles({ limit, offset }), countRoles()]);
      return res.status(200).json({ roles, total, limit, offset });
    } catch (error) {
      logger.error('[adminRoles] listRoles error:', getSafeErrorMetadata(error));
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
      logger.error('[adminRoles] getRole error:', getSafeErrorMetadata(error));
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
      const changes = diffRolePermissions(undefined, role.permissions);
      await emitAudit(req, {
        action: 'role.created',
        target: roleTarget(role.name),
        metadata: { permissions: changes.join(', ') || null },
      });
      return res.status(201).json({ role });
    } catch (error) {
      logger.error('[adminRoles] createRole error:', getSafeErrorMetadata(error));
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
      /** A description equal to the stored one is not a change: no write and no audit entry. */
      if (body.description !== undefined && body.description !== existing.description) {
        updates.description = body.description;
      }

      if (Object.keys(updates).length === 0) {
        return res.status(200).json({ role: existing });
      }

      if (isRename) {
        const descUpdate =
          updates.description !== undefined ? { description: updates.description } : undefined;
        const role = await renameRole(name, trimmedName, descUpdate);
        if (!role) {
          return res.status(404).json({ error: 'Role not found' });
        }
        await emitAudit(req, {
          action: 'role.updated',
          target: roleTarget(trimmedName),
          metadata: { previousName: name, descriptionChanged: descUpdate !== undefined },
        });
        return res.status(200).json({ role });
      }

      const role = await updateRoleByName(name, updates);
      if (!role) {
        return res.status(404).json({ error: 'Role not found' });
      }
      await emitAudit(req, {
        action: 'role.updated',
        target: roleTarget(name),
        metadata: { descriptionChanged: true },
      });
      return res.status(200).json({ role });
    } catch (error) {
      if (error instanceof RoleConflictError) {
        return res.status(409).json({ error: error.message });
      }
      logger.error('[adminRoles] updateRole error:', getSafeErrorMetadata(error));
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
      const changes = diffRolePermissions(existing.permissions, updated.permissions);
      if (changes.length > 0) {
        await emitAudit(req, {
          action: 'role.permissions_updated',
          severity: 'warning',
          target: roleTarget(name),
          metadata: { changes: changes.join(', '), changeCount: changes.length },
        });
      }
      return res.status(200).json({ role: updated });
    } catch (error) {
      logger.error('[adminRoles] updateRolePermissions error:', getSafeErrorMetadata(error));
      return res.status(500).json({ error: 'Failed to update role permissions' });
    }
  }

  async function deleteRoleHandler(req: ServerRequest, res: Response) {
    /** Set once the deletion attempt is recorded; the outer catch uses it for unexpected failures. */
    let recordOutcome:
      | ((
          outcome: 'success' | 'failure',
          code?: string,
          metadata?: Record<string, number>,
        ) => Promise<void>)
      | undefined;
    let waitForAttempt: () => Promise<void> = async () => undefined;
    try {
      const { name } = req.params as RoleNameParams;
      const paramError = validateNameParam(name);
      if (paramError) {
        return res.status(400).json({ error: paramError });
      }
      if (isSystemRoleName(name)) {
        return res.status(403).json({ error: 'Cannot delete system role' });
      }

      const existing = await getRoleByName(name);
      if (!existing) {
        return res.status(404).json({ error: 'Role not found' });
      }

      /**
       * The attempt is recorded as `pending` before any removal so a crash mid-cascade still
       * leaves a trail. The write is started without being awaited, so audit latency never
       * delays the revocation; every later entry waits for it to keep the chain ordered.
       */
      const target = roleTarget(name);
      const attempt = emitRevocationAudit(req, {
        action: 'role.deleted',
        outcome: 'pending',
        severity: 'warning',
        target,
      });
      waitForAttempt = () => attempt;
      recordOutcome = async (outcome, code, metadata) => {
        await attempt;
        await emitRevocationAudit(req, {
          action: 'role.deleted',
          outcome,
          severity: 'warning',
          target,
          ...(code || metadata ? { metadata: { ...(code ? { code } : {}), ...metadata } } : {}),
        });
      };

      /**
       * Grants, ACL entries and config overrides are keyed by role name, so they
       * are removed before the role itself: if any removal fails the role stays
       * and the admin can retry, instead of a later role with the same name
       * inheriting the leftovers. Every removal is idempotent.
       */
      const tenantId = req.user?.tenantId;
      /** deleteRoleByName reassigns members to USER, so who held the role is read first. */
      const memberIds = await findUserIdsByRole(name);
      /** The grants as they were, so removals are audited even when a removal rejects after committing. */
      const grantSnapshot = findGrantsForPrincipal
        ? await findGrantsForPrincipal(PrincipalType.ROLE, name, { tenantId })
        : null;
      const cascade = await runCascade(
        [
          cascadeStep(
            'config',
            () => deleteConfig(PrincipalType.ROLE, name),
            restoreConfig
              ? async (config) => {
                  if (!config) {
                    return;
                  }
                  /** Insert-only: an override written after the snapshot is kept. */
                  const plain = (config as { toObject?: () => unknown }).toObject?.() ?? config;
                  const restored = await restoreConfig(plain as Record<string, unknown>);
                  if (!restored) {
                    logger.warn('[adminRoles] config restore skipped, override exists:', name);
                  }
                }
              : undefined,
            findConfigByPrincipal
              ? () => findConfigByPrincipal(PrincipalType.ROLE, name, { includeInactive: true })
              : undefined,
          ),
          cascadeStep('acl', async () => {
            await deleteAclEntries({ principalType: PrincipalType.ROLE, principalId: name });
          }),
          cascadeStep('grants', () =>
            deleteGrantsForPrincipal(PrincipalType.ROLE, name, { tenantId }),
          ),
        ],
        '[adminRoles]',
      );

      /** The removed ACL entries can include PROMPTGROUP grants feeding the access
       * cache; the cache is stale after both a removal and a restore. */
      const invalidateAccess = async () => {
        try {
          await invalidatePromptGroupAccessContext?.();
        } catch (error) {
          /** The deletion already committed; a cache failure must not hide it from the audit trail. */
          logger.error(
            '[adminRoles] access cache invalidation failed:',
            getSafeErrorMetadata(error),
          );
        }
      };
      const cleanupFailedResponse = async () => {
        await recordOutcome?.('failure', 'ROLE_CLEANUP_FAILED');
        return res.status(500).json({
          error: 'Failed to remove the role grants and permissions; the role was not deleted',
          code: 'ROLE_CLEANUP_FAILED',
        });
      };

      /** Grants are never restored, so a failed delete still changed access and is audited. */
      const auditRemovedGrants = async () => {
        await waitForAttempt();
        let removed = cascade.removed.grants as ISystemGrant[] | undefined;
        if (!removed && grantSnapshot?.length && findGrantsForPrincipal) {
          /** The removal rejected and may have committed: audit what is no longer there. */
          const remaining = await findGrantsForPrincipal(PrincipalType.ROLE, name, {
            tenantId,
          }).then(
            (grants) => new Set(grants.map((g) => `${g.tenantId ?? ''}:${g.capability}`)),
            () => null,
          );
          removed = remaining
            ? grantSnapshot.filter((g) => !remaining.has(`${g.tenantId ?? ''}:${g.capability}`))
            : [];
        }
        await emitGrantRemovals(req, name, removed ?? []);
      };

      /** Reads the role again to learn whether it still is the one this request targeted. */
      const lookupRole = () =>
        getRoleByName(name).then(
          (role) => ({ known: true, role }),
          () => ({ known: false, role: null }),
        );
      /** A role recreated under the same name is a different role and must not inherit the
       * old one's dependents. */
      const isTargetedRole = (role: IRole | null) =>
        role != null &&
        (existing._id == null || role._id == null || String(existing._id) === String(role._id));

      if (cascade.failed.length > 0) {
        const lookup = await lookupRole();
        if (lookup.known && isTargetedRole(lookup.role)) {
          await cascade.compensate();
        } else {
          logger.warn('[adminRoles] config not restored, role changed during cleanup:', name);
        }
        await invalidateAccess();
        await auditRemovedGrants();
        return cleanupFailedResponse();
      }

      let deleted: IRole | null;
      try {
        deleted = await deleteRoleByName(name, {
          id: existing._id != null ? String(existing._id) : undefined,
        });
      } catch (error) {
        logger.error(
          '[adminRoles] deleteRole failed after cascade cleanup:',
          getSafeErrorMetadata(error),
        );
        /** The delete may have committed before it threw. Restoring dependents for a
         * role that is gone would orphan them for a later role with the same name. */
        const lookup = await lookupRole();
        if (lookup.known && isTargetedRole(lookup.role)) {
          await cascade.compensate();
          await invalidateAccess();
          await auditRemovedGrants();
          await recordOutcome('failure', 'ROLE_CLEANUP_FAILED');
          return res.status(500).json({ error: 'Failed to delete role' });
        }
        await invalidateAccess();
        if (!lookup.known || lookup.role) {
          await auditRemovedGrants();
          await recordOutcome('failure', 'ROLE_STATE_UNVERIFIABLE');
          logger.error('[adminRoles] dependents not restored, role state unverifiable:', name);
          return res.status(500).json({ error: 'Failed to delete role' });
        }
        /** Confirmed absent: the deletion did commit, so it is audited and reported as one. */
        deleted = existing;
      }
      await invalidateAccess();
      if (!deleted) {
        await auditRemovedGrants();
        await recordOutcome('failure', 'not_found');
        return res.status(404).json({ error: 'Role not found' });
      }
      const removedGrants = cascade.removed.grants as ISystemGrant[];
      await auditRemovedGrants();
      /** Each reassigned account is recorded (chunked) before the outcome entry. */
      const audited = memberIds;
      for (let i = 0; i < audited.length; i += AUDIT_MEMBER_CHUNK) {
        const chunk = audited.slice(i, i + AUDIT_MEMBER_CHUNK);
        await emitRevocationAudit(req, {
          action: 'role.member_removed',
          severity: memberChangeSeverity(name),
          target: roleTarget(name),
          metadata: {
            userIds: chunk.join(','),
            count: chunk.length,
            newRole: SystemRoles.USER,
            cause: 'role_deleted',
          },
        });
      }
      await recordOutcome('success', undefined, {
        grantsRemoved: removedGrants.length,
        membersReassigned: memberIds.length,
      });

      return res.status(200).json({ success: true });
    } catch (error) {
      logger.error('[adminRoles] deleteRole error:', getSafeErrorMetadata(error));
      await recordOutcome?.('failure', 'ROLE_DELETE_FAILED').catch(() => undefined);
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
      logger.error('[adminRoles] getRoleMembers error:', getSafeErrorMetadata(error));
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

      /** Conditional on the role read above: an overlapping identical request matches nothing,
       * so exactly one request records the transition. */
      const updated = await updateUser(userId, { role: name }, { role: user.role });
      if (!updated) {
        const current = await findUser({ _id: userId });
        if (!current) {
          return res.status(404).json({ error: 'User not found' });
        }
        if (current.role === name) {
          return res.status(200).json({ success: true });
        }
        return res.status(409).json({ error: 'User role changed concurrently' });
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

      await emitAudit(req, {
        action: 'role.member_added',
        severity: memberChangeSeverity(name, user.role),
        target: roleTarget(name),
        metadata: { userId, previousRole: user.role ?? null },
      });
      /** The single-role write also ends the user's membership of the previous role. */
      if (user.role) {
        await emitAudit(req, {
          action: 'role.member_removed',
          severity: memberChangeSeverity(user.role),
          target: roleTarget(user.role),
          metadata: { userId, newRole: name },
        });
      }
      return res.status(200).json({ success: true });
    } catch (error) {
      logger.error('[adminRoles] addRoleMember error:', getSafeErrorMetadata(error));
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

      const removed = await updateUser(userId, { role: SystemRoles.USER }, { role: name });
      if (!removed) {
        const current = await findUser({ _id: userId });
        if (!current) {
          return res.status(404).json({ error: 'User not found' });
        }
        if (current.role !== name) {
          return res.status(400).json({ error: 'User is not a member of this role' });
        }
        return res.status(409).json({ error: 'User role changed concurrently' });
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

      await emitAudit(req, {
        action: 'role.member_removed',
        severity: memberChangeSeverity(name),
        target: roleTarget(name),
        metadata: { userId, newRole: SystemRoles.USER },
      });
      return res.status(200).json({ success: true });
    } catch (error) {
      logger.error('[adminRoles] removeRoleMember error:', getSafeErrorMetadata(error));
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

export interface RolePermissionsUpdateDeps {
  getRoleByName: (name: string, fields?: string | string[] | null) => Promise<IRole | null>;
  updateRoleByName: (name: string, updates: Partial<IRole>) => Promise<IRole | null>;
  recordAuditEntry?: RecordAuditEntry;
  /** When true, a failed audit write surfaces as a 5xx after the update has
   * been persisted. Defaults to fail-open. */
  auditFailClosed?: boolean;
}

export interface RolePermissionsUpdateConfig {
  /** Zod object schema for one permission type; parsed as a partial update. */
  schema: { partial: () => { parse: (value: unknown) => Record<string, boolean | undefined> } };
  permissionType: string;
  errorMessage: string;
}

/**
 * Builds the `PUT /api/roles/:roleName/<type>` handler for one permission type:
 * merges the validated partial update into the role's permissions and records
 * a `role.permissions_updated` audit entry when a flag actually changed.
 */
export function createRolePermissionsUpdateHandler(
  deps: RolePermissionsUpdateDeps,
  config: RolePermissionsUpdateConfig,
): (req: ServerRequest, res: Response) => Promise<Response> {
  const { getRoleByName, updateRoleByName, recordAuditEntry, auditFailClosed } = deps;
  const emitAudit = createAdminAuditEmitter({
    recordAuditEntry,
    failClosed: auditFailClosed,
    logPrefix: '[roles]',
  });

  return async function updateRolePermissions(req, res) {
    const { roleName } = req.params as { roleName: string };
    let parsedUpdates: Record<string, boolean | undefined>;
    try {
      parsedUpdates = config.schema.partial().parse(req.body);
    } catch (error) {
      return res
        .status(400)
        .send({ message: config.errorMessage, error: (error as { errors?: unknown }).errors });
    }

    try {
      const role = await getRoleByName(roleName);
      if (!role) {
        return res.status(404).send({ message: 'Role not found' });
      }

      const permissions = (role.permissions ?? {}) as Record<
        string,
        Record<string, boolean | undefined> | undefined
      >;
      const legacyPermissions = (role as unknown as Record<string, unknown>)[
        config.permissionType
      ] as Record<string, boolean | undefined> | undefined;
      const currentPermissions = permissions[config.permissionType] || legacyPermissions || {};

      const mergedPermissions = {
        ...permissions,
        [config.permissionType]: { ...currentPermissions, ...parsedUpdates },
      };
      const updatedRole = await updateRoleByName(roleName, {
        permissions: mergedPermissions as IRole['permissions'],
      });

      const changes = diffRolePermissions(
        { [config.permissionType]: currentPermissions },
        { [config.permissionType]: mergedPermissions[config.permissionType] },
      );
      if (updatedRole && changes.length > 0) {
        await emitAudit(req, {
          action: 'role.permissions_updated',
          severity: 'warning',
          target: roleTarget(roleName),
          metadata: { changes: changes.join(', '), changeCount: changes.length },
        });
      }
      return res.status(200).send(updatedRole);
    } catch (error) {
      logger.error(
        `[roles] ${config.permissionType} permission update failed:`,
        getSafeErrorMetadata(error),
      );
      return res.status(500).send({ message: 'Failed to update role permissions' });
    }
  };
}
