import { PrincipalType, PrincipalModel } from 'librechat-data-provider';
import type { Config, CreateRoleRequest, IRole, UpdateRoleRequest } from '@librechat/data-schemas';
import type { AdminConfigDeps } from '../config';
import type { AdminRolesDeps } from '../roles';
import { validateDescription, validateRoleName } from '../roles';
import { prepareConfigOverrides } from './prepare';

type RoleServiceDeps = Pick<
  AdminRolesDeps,
  'getRoleByName' | 'createRoleByName' | 'updateRoleByName'
> &
  Pick<AdminConfigDeps, 'findConfigByPrincipal' | 'upsertConfig'> & {
    clearConfigTombstones: (principalType: PrincipalType, principalId: string) => Promise<void>;
    invalidateConfigCaches: () => Promise<void>;
  };

export interface RoleAdminService {
  getRole: (name: string) => Promise<IRole | null>;
  createRole: (role: CreateRoleRequest) => Promise<IRole>;
  updateRole: (
    name: string,
    updates: Pick<UpdateRoleRequest, 'description' | 'permissions'>,
  ) => Promise<IRole>;
  upsertRoleConfig: (name: string, config: Pick<Config, 'priority' | 'overrides'>) => Promise<void>;
}

/** Applies the existing Admin API validation rules without performing a write. */
export function validateRoleMetadata(name: string, description?: string): void {
  const nameError = validateRoleName(name, true);
  if (nameError) {
    throw new TypeError(nameError);
  }
  validateRoleDescription(description);
}

function normalizeRoleName(name: string): string {
  const error = validateRoleName(name, true);
  if (error) {
    throw new TypeError(error);
  }
  return name.trim();
}

function validateRoleDescription(description?: string): void {
  const error = validateDescription(description);
  if (error) {
    throw new TypeError(error);
  }
}

function validatePermissions(permissions: CreateRoleRequest['permissions']): void {
  if (!permissions || typeof permissions !== 'object' || Array.isArray(permissions)) {
    throw new TypeError('permissions must be an object');
  }
}

export function createRoleAdminService(deps: RoleServiceDeps): RoleAdminService {
  async function createRole(role: CreateRoleRequest): Promise<IRole> {
    validateRoleMetadata(role.name, role.description);
    const name = role.name.trim();
    validatePermissions(role.permissions);
    return await deps.createRoleByName({ ...role, name });
  }

  async function updateRole(
    name: string,
    updates: Pick<UpdateRoleRequest, 'description' | 'permissions'>,
  ): Promise<IRole> {
    const normalizedName = normalizeRoleName(name);
    validateRoleDescription(updates.description);

    const existing = await deps.getRoleByName(normalizedName);
    if (!existing) {
      throw new Error(`Role "${normalizedName}" was not found`);
    }

    const roleUpdates: UpdateRoleRequest = {};
    if (updates.description !== undefined) {
      roleUpdates.description = updates.description;
    }
    if (updates.permissions !== undefined) {
      validatePermissions(updates.permissions);
      roleUpdates.permissions = updates.permissions;
    }
    if (Object.keys(roleUpdates).length === 0) {
      return existing;
    }
    const role = await deps.updateRoleByName(normalizedName, roleUpdates);
    if (!role) {
      throw new Error(`Role "${normalizedName}" was not found`);
    }
    return role;
  }

  async function upsertRoleConfig(
    name: string,
    config: Pick<Config, 'priority' | 'overrides'>,
  ): Promise<void> {
    const normalizedName = normalizeRoleName(name);
    if (
      !config.overrides ||
      typeof config.overrides !== 'object' ||
      Array.isArray(config.overrides)
    ) {
      throw new TypeError('overrides must be a plain object');
    }
    if (typeof config.priority !== 'number' || config.priority < 0) {
      throw new TypeError('priority must be a non-negative number');
    }
    const existingConfig = await deps.findConfigByPrincipal(PrincipalType.ROLE, normalizedName, {
      includeInactive: true,
    });
    const overrides = prepareConfigOverrides(config.overrides, existingConfig?.overrides);
    await deps.upsertConfig(
      PrincipalType.ROLE,
      normalizedName,
      PrincipalModel.ROLE,
      overrides,
      config.priority,
    );
    try {
      await deps.clearConfigTombstones(PrincipalType.ROLE, normalizedName);
    } finally {
      await deps.invalidateConfigCaches();
    }
  }

  return {
    getRole: deps.getRoleByName,
    createRole,
    updateRole,
    upsertRoleConfig,
  };
}
