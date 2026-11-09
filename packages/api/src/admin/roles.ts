import { PrincipalType, SystemRoles, partialWithoutDefaults } from 'librechat-data-provider';
import {
  logger,
  RoleConflictError,
  isConfigMoveRefused,
  RoleDeletionError,
  isValidObjectIdString,
  BASE_CONFIG_PRINCIPAL_ID,
} from '@librechat/data-schemas';
import type {
  IRole,
  IUser,
  ConfigRecord,
  AdminMember,
  ISystemGrant,
  AuditSeverity,
  SystemGrantMove,
  RoleDeletion,
  ConfigMoveOptions,
} from '@librechat/data-schemas';
import type { FilterQuery, Types } from 'mongoose';
import type { Response } from 'express';
import type { z } from 'zod';
import type { ServerRequest } from '~/types/http';
import type { RecordAuditEntry } from './audit';
import type { CascadeStep } from './cascade';
import { createAdminAuditEmitter, diffRolePermissions, configTarget } from './audit';
import { cascadeStep, runCascade, invalidatingConfigStore } from './cascade';
import { getSafeErrorMetadata } from '~/utils/errors';
import { getActivePartition } from './partition';
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

/**
 * Whether a role name keys its own config profile. The tenant-wide Base document is keyed
 * `role` / `__base__`, so a role by that name (reserved now, but one may predate that) must
 * never move or delete it: that would let `manage:roles` rewrite what every user gets, which
 * otherwise needs broad `manage:configs`.
 */
function hasOwnConfigProfile(roleName: string): boolean {
  return roleName !== BASE_CONFIG_PRINCIPAL_ID;
}

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

/** A rejected role name as the 400 body; a reserved name carries a code the client can map. */
interface RoleNameError {
  error: string;
  code?: 'ROLE_NAME_RESERVED';
}

function validateRoleName(name: unknown, required: boolean): RoleNameError | null {
  if (name === undefined) {
    return required ? { error: 'name is required' } : null;
  }
  if (typeof name !== 'string' || !name.trim()) {
    return { error: required ? 'name is required' : 'name must be a non-empty string' };
  }
  const trimmed = name.trim();
  if (trimmed.length > MAX_NAME_LENGTH) {
    return { error: `name must not exceed ${MAX_NAME_LENGTH} characters` };
  }
  if (CONTROL_CHAR_RE.test(trimmed)) {
    return { error: 'name contains invalid characters' };
  }
  if (RESERVED_ROLE_NAMES.has(trimmed)) {
    return { error: 'name is a reserved path segment', code: 'ROLE_NAME_RESERVED' };
  }
  if (!hasOwnConfigProfile(trimmed)) {
    return { error: 'name is reserved for the base config', code: 'ROLE_NAME_RESERVED' };
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

/**
 * Role ids are names every tenant reuses, so every role operation here addresses the role of the
 * caller's tenant partition and what it holds there (members, profile, grants and ACL entries):
 * the active tenant's, or for an admin without a tenant only the platform-level ones, never each
 * tenant's own role of the same name. The routes wire the data-schemas methods that keep to that
 * partition, and a member added or removed by id must be a user of it too.
 */
export interface AdminRolesDeps {
  /** The roles of the caller's tenant partition (`listRoles`). */
  listRoles: (options?: { limit?: number; offset?: number }) => Promise<RoleListItem[]>;
  countRoles: () => Promise<number>;
  /**
   * The role of exactly this name in the caller's tenant partition, read as stored
   * (`getPartitionRole`); a missing system role is created there.
   */
  getRoleByName: (name: string, fields?: string | string[] | null) => Promise<IRole | null>;
  createRoleByName: (roleData: Partial<IRole>) => Promise<IRole>;
  /** With `options.id`, updates only the role document with that `_id`. */
  updateRoleByName: (
    name: string,
    updates: Partial<IRole>,
    options?: { id?: string },
  ) => Promise<IRole | null>;
  updateAccessPermissions: (
    name: string,
    perms: Record<string, Record<string, boolean>>,
    roleData?: IRole,
  ) => Promise<void>;
  /** With `options.id`, deletes only the role that still has that `_id`, so a role recreated
   * under the same name is never removed by a request that targeted the original. Reassigns the
   * role's members in the caller's partition to USER, and resolves to the deleted role with the
   * ids of the accounts its write moved; `null` when it deleted nothing. */
  deleteRoleByName: (name: string, options?: { id?: string }) => Promise<RoleDeletion | null>;
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
  /** Moves the role's members in the caller's partition to `newRole` (a rename's migration). */
  updateUsersByRole: (oldRole: string, newRole: string) => Promise<void>;
  /** The ids of the role's members in the caller's partition. */
  findUserIdsByRole: (roleName: string) => Promise<string[]>;
  /** With `fromRole`, only users whose role is still that one change. */
  updateUsersRoleByIds: (
    userIds: string[],
    newRole: string,
    options?: { fromRole?: string },
  ) => Promise<void>;
  listUsersByRole: (
    roleName: string,
    options?: { limit?: number; offset?: number },
  ) => Promise<IUser[]>;
  countUsersByRole: (roleName: string) => Promise<number>;
  /** Removes the per-principal config override (keyed by type + name, not ObjectId). */
  deleteConfig: (
    principalType: PrincipalType,
    principalId: string | Types.ObjectId,
  ) => Promise<ConfigRecord | null>;
  /** Removes the role's ACL entries in the caller's partition (`deletePrincipalAclEntries`). */
  deleteAclEntries: (filter: {
    principalType: PrincipalType;
    principalId: string | Types.ObjectId;
  }) => Promise<void>;
  /** Drops cached prompt group access IDs; role deletion can remove PROMPTGROUP grants. */
  invalidatePromptGroupAccessContext?: () => Promise<void>;
  /** Removes the system capability grants this principal holds in one scope (exactly
   * `tenantId`, or platform-level ones without it) and returns the removed grants so each can be
   * audited. */
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
  /** A role's profile in the caller's tenant partition (platform-level without a tenant), the
   * partition `renameConfigPrincipal` moves in. */
  findConfigByPrincipal?: (
    principalType: PrincipalType,
    principalId: string,
    options?: { includeInactive?: boolean },
  ) => Promise<ConfigRecord | null>;
  /** Re-creates a deleted config document in full, only if none exists. Resolves
   * to whether it inserted. */
  restoreConfig?: (snapshot: ConfigRecord) => Promise<boolean>;
  /**
   * Role rename moves what is keyed by the role's name (this config profile, and the grants
   * and ACL entries below), so it follows the role instead of applying to nobody, and to any
   * later role that reuses the old name. Each move is undone if the rename cannot complete; a
   * dependent without its mover stays where it is.
   *
   * Moves the config profile within the caller's tenant partition (platform-level without a
   * tenant, never a tenant's role of the same name); `null` when there is none. Throws
   * `ConfigMoveRefusedError`, changing nothing, when the new name already has one in that
   * partition (`CONFIG_PRINCIPAL_EXISTS`) or either name is the Base principal id. With
   * `identity`, moves only that document, and resolves to `null` when the source holds another.
   */
  renameConfigPrincipal?: (
    principalType: PrincipalType,
    fromPrincipalId: string,
    toPrincipalId: string,
    options?: ConfigMoveOptions,
  ) => Promise<ConfigRecord | null>;
  /** Moves the system grants of exactly `tenantId`, or platform-level ones without it; returns what it changed. */
  moveGrantsToPrincipal?: (
    principalType: PrincipalType,
    fromPrincipalId: string,
    toPrincipalId: string,
    options?: { tenantId?: string },
  ) => Promise<SystemGrantMove>;
  /** Undoes exactly what `moveGrantsToPrincipal` returned it changed; a grant revoked since stays revoked. */
  restoreMovedGrants?: (
    principalType: PrincipalType,
    fromPrincipalId: string,
    toPrincipalId: string,
    move: SystemGrantMove,
  ) => Promise<void>;
  /** Moves the ACL entries of the request's tenant (platform-level ones without a tenant) and
   * returns their ids; with `ids`, moves only those (the undo). */
  moveAclEntriesToPrincipal?: (
    principalType: PrincipalType,
    fromPrincipalId: string,
    toPrincipalId: string,
    options?: { ids?: readonly string[] },
  ) => Promise<string[]>;
  /** Clears the merged-config caches (on every instance, with Redis) once a rename moved a
   * profile, or a deletion removed or restored one, before the response, as config writes do. */
  invalidateConfigCaches?: (tenantId?: string) => Promise<void>;
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

/**
 * Whether a user belongs to the caller's tenant partition, the one a role name addresses. Outside
 * a tenant a user is found by id in any tenant, but a tenant user's `role` names that tenant's own
 * role, so the platform role's member routes never change it.
 */
function isPartitionUser(user: Pick<IUser, 'tenantId'>): boolean {
  return (user.tenantId || undefined) === getActivePartition();
}

/** The document a role was read as, so a write changes that role and no other of its name. */
function roleIdentity(role: Pick<IRole, '_id'>): { id: string } | undefined {
  return role._id != null ? { id: String(role._id) } : undefined;
}

/** What a role rename moved to the new name along with the role. */
interface RoleDependentsMoved {
  /** The profile as the new name now holds it; `null` when the role had none. */
  config: ConfigRecord | null;
  /** The grants that now apply under the new name: re-keyed, or already held there. */
  grants: ISystemGrant[];
  aclEntries: number;
}

type RoleRenameResult =
  | { ok: true; role: IRole; moved: RoleDependentsMoved }
  | { ok: false; code: 'ROLE_NOT_FOUND' | 'ROLE_CONFIG_CONFLICT' | 'ROLE_RENAME_FAILED' };

function renameFailureResponse(
  res: Response,
  code: Extract<RoleRenameResult, { ok: false }>['code'],
  newName: string,
): Response {
  if (code === 'ROLE_NOT_FOUND') {
    return res.status(404).json({ error: 'Role not found' });
  }
  if (code === 'ROLE_CONFIG_CONFLICT') {
    return res.status(409).json({
      error: `A config profile already exists for role "${newName}"`,
      code,
    });
  }
  return res.status(500).json({
    error: 'Failed to move the role profile, grants or permissions; the role was not renamed',
    code,
  });
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
    renameConfigPrincipal,
    moveGrantsToPrincipal,
    restoreMovedGrants,
    moveAclEntriesToPrincipal,
    invalidateConfigCaches,
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
        /** Scope each entry to the removed grant's own tenant, so a removal
         * always lands in the chain of the tenant whose grant it was. */
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
        return res.status(400).json(nameError);
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
      await updateUsersRoleByIds(migratedIds, currentName, { fromRole: newName });
    } catch (rollbackError) {
      logger.error(
        `[adminRoles] CRITICAL: rename rollback failed — ${migratedIds.length} users have dangling role "${newName}": [${migratedIds.join(', ')}]`,
        rollbackError,
      );
    }
  }

  /**
   * Puts the role document back under its old name (and description) after a failed rename.
   * The description goes back only while it is still the one this rename set, so an edit made
   * meanwhile is kept. A role stored without a description gets the schema default (`''`)
   * back: the update only sets fields, and an undefined one would be dropped, keeping the new
   * description.
   */
  async function revertRoleUpdate(
    existing: IRole,
    currentName: string,
    newName: string,
    extraUpdates?: Partial<IRole>,
  ): Promise<void> {
    const revert: Partial<IRole> = { name: currentName };
    if (extraUpdates?.description !== undefined) {
      const renamed = await getRoleByName(newName).catch(() => null);
      if (renamed?.description === extraUpdates.description) {
        revert.description = existing.description ?? '';
      }
    }
    try {
      await updateRoleByName(newName, revert, roleIdentity(existing));
    } catch (revertError) {
      logger.error(
        `[adminRoles] CRITICAL: rename rollback failed — role "${currentName}" is still named "${newName}"`,
        getSafeErrorMetadata(revertError),
      );
    }
  }

  /**
   * Moves what is keyed by the role's name, concurrently, and undoes every completed move when
   * any fails. `configConflict` reports that the new name already had a profile; any other
   * failure of the profile move (it kept changing, or a copy could not be withdrawn) is a
   * failed rename, not a conflict at the new name.
   */
  async function moveRoleDependents(
    currentName: string,
    newName: string,
    tenantId: string | undefined,
  ): Promise<
    | { ok: true; moved: RoleDependentsMoved }
    | { ok: false; code: 'ROLE_CONFIG_CONFLICT' | 'ROLE_RENAME_FAILED' }
  > {
    let configConflict = false;
    const steps: CascadeStep[] = [];
    if (renameConfigPrincipal && hasOwnConfigProfile(currentName)) {
      steps.push(
        cascadeStep(
          'config',
          async () => {
            try {
              return await renameConfigPrincipal(PrincipalType.ROLE, currentName, newName);
            } catch (error) {
              configConflict = isConfigMoveRefused(error, 'CONFIG_PRINCIPAL_EXISTS');
              throw error;
            }
          },
          async (moved: ConfigRecord | null) => {
            if (!moved) {
              return;
            }
            /** Only the profile this rename moved goes back, with any edit made to it since. */
            const restored = await renameConfigPrincipal(PrincipalType.ROLE, newName, currentName, {
              identity: moved._id,
            });
            if (!restored) {
              logger.warn(
                `[adminRoles] rename rollback left role "${newName}"'s profile in place: it is no longer the one the rename moved`,
              );
            }
          },
        ),
      );
    }
    if (moveGrantsToPrincipal) {
      steps.push(
        cascadeStep(
          'grants',
          () => moveGrantsToPrincipal(PrincipalType.ROLE, currentName, newName, { tenantId }),
          restoreMovedGrants
            ? (move: SystemGrantMove) =>
                restoreMovedGrants(PrincipalType.ROLE, currentName, newName, move)
            : undefined,
        ),
      );
    }
    if (moveAclEntriesToPrincipal) {
      steps.push(
        cascadeStep(
          'acl',
          () => moveAclEntriesToPrincipal(PrincipalType.ROLE, currentName, newName),
          async (ids: string[]) => {
            await moveAclEntriesToPrincipal(PrincipalType.ROLE, newName, currentName, { ids });
          },
        ),
      );
    }
    if (steps.length === 0) {
      return { ok: true, moved: { config: null, grants: [], aclEntries: 0 } };
    }
    const cascade = await runCascade(steps, '[adminRoles] rename');
    if (cascade.failed.length > 0) {
      await cascade.compensate();
      return { ok: false, code: configConflict ? 'ROLE_CONFIG_CONFLICT' : 'ROLE_RENAME_FAILED' };
    }
    const { config, grants, acl } = cascade.removed as {
      config?: ConfigRecord | null;
      grants?: SystemGrantMove;
      acl?: string[];
    };
    return {
      ok: true,
      moved: {
        config: config ?? null,
        grants: grants ? [...grants.moved, ...grants.superseded] : [],
        aclEntries: acl?.length ?? 0,
      },
    };
  }

  /**
   * Records a profile a rename moved in the config trail of both principals, so neither
   * chain starts or ends without a cause: deleted from the old name, created at the new one.
   */
  async function emitProfileMove(
    req: ServerRequest,
    previousName: string,
    newName: string,
    profile: ConfigRecord | null,
  ): Promise<void> {
    if (!profile) {
      return;
    }
    const from = configTarget(PrincipalType.ROLE, previousName);
    const to = configTarget(PrincipalType.ROLE, newName);
    await emitAudit(req, {
      action: 'config.deleted',
      target: from,
      metadata: { cause: 'role_renamed', movedTo: to.id },
    });
    await emitAudit(req, {
      action: 'config.created',
      target: to,
      metadata: {
        operation: 'move',
        cause: 'role_renamed',
        movedFrom: from.id,
        priority: profile.priority,
      },
    });
  }

  /** Clears what a rename's moves (or their undo) leave stale; failures are logged, not thrown. */
  async function invalidateRenamedRole(tenantId: string | undefined): Promise<void> {
    const results = await Promise.allSettled([
      invalidateConfigCaches?.(tenantId),
      invalidatePromptGroupAccessContext?.(),
    ]);
    for (const result of results) {
      if (result.status === 'rejected') {
        logger.error(
          '[adminRoles] cache invalidation after rename failed:',
          getSafeErrorMetadata(result.reason),
        );
      }
    }
  }

  /**
   * Renames a role: migrates its users, renames the role document, then moves the config
   * profile, grants and ACL entries keyed by the old name. A failure at any step undoes the
   * earlier ones, so the role is either fully renamed or left as it was.
   *
   * The ID snapshot from `findUserIdsByRole` is a point-in-time read. Users assigned
   * to `currentName` between the snapshot and the bulk `updateUsersByRole` write will
   * be moved to `newName` but will NOT be reverted on rollback. This window is narrow
   * and only relevant under concurrent admin operations during a rename.
   */
  async function renameRole(
    existing: IRole,
    currentName: string,
    newName: string,
    tenantId: string | undefined,
    extraUpdates?: Partial<IRole>,
  ): Promise<RoleRenameResult> {
    const migratedIds = await findUserIdsByRole(currentName);
    await updateUsersByRole(currentName, newName);
    let role: IRole | null;
    try {
      const updates: Partial<IRole> = { name: newName, ...extraUpdates };
      role = await updateRoleByName(currentName, updates, roleIdentity(existing));
    } catch (error) {
      await rollbackMigratedUsers(migratedIds, currentName, newName);
      throw error;
    }
    if (!role) {
      await rollbackMigratedUsers(migratedIds, currentName, newName);
      return { ok: false, code: 'ROLE_NOT_FOUND' };
    }
    const dependents = await moveRoleDependents(currentName, newName, tenantId);
    if (!dependents.ok) {
      await revertRoleUpdate(existing, currentName, newName, extraUpdates);
      await rollbackMigratedUsers(migratedIds, currentName, newName);
    }
    await invalidateRenamedRole(tenantId);
    return dependents.ok ? { ok: true, role, moved: dependents.moved } : dependents;
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
        return res.status(400).json(nameError);
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
        const [duplicate, targetProfile] = await Promise.all([
          getRoleByName(trimmedName),
          renameConfigPrincipal && findConfigByPrincipal
            ? findConfigByPrincipal(PrincipalType.ROLE, trimmedName, { includeInactive: true })
            : null,
        ]);
        if (duplicate) {
          return res.status(409).json({ error: `Role "${trimmedName}" already exists` });
        }
        if (targetProfile) {
          return res.status(409).json({
            error: `A config profile already exists for role "${trimmedName}"`,
            code: 'ROLE_CONFIG_CONFLICT',
          });
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
        const renamed = await renameRole(
          existing,
          name,
          trimmedName,
          req.user?.tenantId,
          descUpdate,
        );
        if (!renamed.ok) {
          return renameFailureResponse(res, renamed.code, trimmedName);
        }
        const { role, moved } = renamed;
        await emitAudit(req, {
          action: 'role.updated',
          target: roleTarget(trimmedName),
          metadata: {
            previousName: name,
            descriptionChanged: descUpdate !== undefined,
            configMoved: moved.config != null,
            grantsMoved: moved.grants.length,
            grantCapabilities: moved.grants.map((grant) => grant.capability).join(',') || null,
            aclEntriesMoved: moved.aclEntries,
          },
        });
        await emitProfileMove(req, name, trimmedName, moved.config);
        return res.status(200).json({ role });
      }

      const role = await updateRoleByName(name, updates, roleIdentity(existing));
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
   * The re-fetch via `getRoleByName` after `updateAccessPermissions` reads the role as
   * stored (`getPartitionRole` reads no cache), so it returns what the update wrote.
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
      /** The grants as they were, so removals are audited even when a removal rejects after committing. */
      const grantSnapshot = findGrantsForPrincipal
        ? await findGrantsForPrincipal(PrincipalType.ROLE, name, { tenantId })
        : null;
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

      const { deleteConfig: removeProfile, restoreConfig: restoreProfile } =
        invalidatingConfigStore(
          { deleteConfig, restoreConfig },
          { invalidateConfigCaches, tenantId, logPrefix: '[adminRoles]' },
        );
      const configStep = cascadeStep(
        'config',
        () => removeProfile(PrincipalType.ROLE, name),
        restoreProfile
          ? async (config) => {
              if (!config) {
                return;
              }
              /** The profile is keyed by name: put it back only while the name still holds the
               * targeted role, never onto a role recreated under it. This covers the restore of a
               * removal that rejected as well as `compensate`. When the role cannot be read, the
               * restore fails instead, so the cascade keeps the snapshot for `compensate` to retry. */
              const lookup = await lookupRole();
              if (!lookup.known) {
                throw new Error('role unreadable; config restore deferred');
              }
              if (!isTargetedRole(lookup.role)) {
                logger.warn('[adminRoles] config restore skipped, role changed:', name);
                return;
              }
              /** Insert-only: an override written after the snapshot is kept. */
              const restored = await restoreProfile(config);
              if (!restored) {
                logger.warn('[adminRoles] config restore skipped, override exists:', name);
              }
            }
          : undefined,
        findConfigByPrincipal
          ? () => findConfigByPrincipal(PrincipalType.ROLE, name, { includeInactive: true })
          : undefined,
      );
      const cascade = await runCascade(
        [
          ...(hasOwnConfigProfile(name) ? [configStep] : []),
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

      /** Each account the delete moved is recorded (chunked) before the outcome entry. */
      const auditReassignedMembers = async (userIds: string[]) => {
        for (let i = 0; i < userIds.length; i += AUDIT_MEMBER_CHUNK) {
          const chunk = userIds.slice(i, i + AUDIT_MEMBER_CHUNK);
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
      };

      let deleted: RoleDeletion | null;
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
        /** Members moved before the failure stay moved, whatever happened to the role. */
        const movedBeforeFailure =
          error instanceof RoleDeletionError ? error.reassignedUserIds : [];
        if (lookup.known && isTargetedRole(lookup.role)) {
          await cascade.compensate();
          await invalidateAccess();
          await auditRemovedGrants();
          await auditReassignedMembers(movedBeforeFailure);
          await recordOutcome('failure', 'ROLE_CLEANUP_FAILED');
          return res.status(500).json({ error: 'Failed to delete role' });
        }
        await invalidateAccess();
        if (!lookup.known || lookup.role) {
          await auditRemovedGrants();
          await auditReassignedMembers(movedBeforeFailure);
          await recordOutcome('failure', 'ROLE_STATE_UNVERIFIABLE');
          logger.error('[adminRoles] dependents not restored, role state unverifiable:', name);
          return res.status(500).json({ error: 'Failed to delete role' });
        }
        if (error instanceof RoleDeletionError && error.reason !== 'delete_failed') {
          /** Another request deleted the role; the members this one moved first are audited. */
          await auditRemovedGrants();
          await auditReassignedMembers(movedBeforeFailure);
          await recordOutcome('failure', 'not_found');
          return res.status(404).json({ error: 'Role not found' });
        }
        /** Confirmed absent after the delete itself rejected: it committed with its
         * acknowledgement lost, so it is audited and reported as one, with the members it moved. */
        deleted = { role: existing, reassignedUserIds: movedBeforeFailure };
      }
      await invalidateAccess();
      if (!deleted) {
        await auditRemovedGrants();
        await recordOutcome('failure', 'not_found');
        return res.status(404).json({ error: 'Role not found' });
      }
      const removedGrants = cascade.removed.grants as ISystemGrant[];
      await auditRemovedGrants();
      const audited = deleted.reassignedUserIds;
      await auditReassignedMembers(audited);
      await recordOutcome('success', undefined, {
        grantsRemoved: removedGrants.length,
        membersReassigned: audited.length,
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
      if (!user || !isPartitionUser(user)) {
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
      if (!user || !isPartitionUser(user)) {
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
  /** Zod object schema for one permission type; parsed as a partial update without its defaults. */
  schema: z.ZodObject<Record<string, z.ZodType<boolean, boolean | undefined>>>;
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
    const parsed = partialWithoutDefaults(config.schema).safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).send({ message: config.errorMessage, error: parsed.error.issues });
    }
    const parsedUpdates: Record<string, boolean | undefined> = parsed.data;

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
