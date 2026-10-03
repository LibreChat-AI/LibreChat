import { roleDefaults, SystemRoles } from 'librechat-data-provider';
import { RoleConflictError, logger } from '@librechat/data-schemas';
import type { PrincipalModel, PrincipalType, TCustomConfig } from 'librechat-data-provider';
import type { ClientSession, Model, Mongoose, Types } from 'mongoose';
import type { IConfig, IRole } from '@librechat/data-schemas';
import type { RoleAdminService } from './service';
import { createRoleAdminService } from './service';

const baseFilter = { tenantId: { $in: [null, undefined] } };
const systemRoleNames = new Set<string>(Object.values(SystemRoles));

interface BaseRoleServiceDeps {
  invalidateRoleCache: (name: string) => Promise<void>;
  invalidateConfigCaches: () => Promise<void>;
}

/** Creates the deployment service for records without a tenant. */
export function createBaseRoleAdminService(
  mongoose: Mongoose,
  deps: BaseRoleServiceDeps,
): RoleAdminService {
  const Role = mongoose.models.Role as Model<IRole>;
  const Config = mongoose.models.Config as Model<IConfig>;

  const invalidateRoleCache = async (name: string): Promise<void> => {
    try {
      await deps.invalidateRoleCache(name);
    } catch (error) {
      logger.error(`[createBaseRoleAdminService] cache invalidation failed for "${name}":`, error);
    }
  };

  const getRoleByName = async (name: string): Promise<IRole | null> => {
    const role = await Role.findOne({ name, ...baseFilter }).lean<IRole>();
    if (role || !systemRoleNames.has(name)) {
      return role;
    }
    const created = await new Role(roleDefaults[name as keyof typeof roleDefaults]).save();
    await invalidateRoleCache(name);
    return created.toObject();
  };

  const createRoleByName = async (role: Partial<IRole>): Promise<IRole> => {
    const name = role.name?.trim();
    if (!name) {
      throw new Error('Role name is required');
    }
    if (systemRoleNames.has(name.toUpperCase())) {
      throw new RoleConflictError(`Cannot create role with reserved system name: ${name}`);
    }
    if (await Role.exists({ name, ...baseFilter })) {
      throw new RoleConflictError(`Role "${name}" already exists`);
    }
    try {
      const created = await new Role({ ...role, name, tenantId: undefined }).save();
      await invalidateRoleCache(name);
      return created.toObject();
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 11000) {
        throw new RoleConflictError(`Role "${name}" already exists`);
      }
      throw error;
    }
  };

  const updateRoleByName = async (name: string, updates: Partial<IRole>): Promise<IRole> => {
    const role = await Role.findOneAndUpdate(
      { name, ...baseFilter },
      { $set: updates },
      { new: true },
    )
      .select('-__v')
      .lean<IRole>();
    await invalidateRoleCache(name);
    return role as IRole;
  };

  const findConfigByPrincipal = async (
    principalType: PrincipalType,
    principalId: string | Types.ObjectId,
    options?: { includeInactive?: boolean },
    session?: ClientSession,
  ): Promise<IConfig | null> => {
    return await Config.findOne({
      principalType,
      principalId: principalId.toString(),
      ...baseFilter,
      ...(!options?.includeInactive ? { isActive: true } : {}),
    })
      .session(session ?? null)
      .lean<IConfig>();
  };

  const upsertConfig = async (
    principalType: PrincipalType,
    principalId: string | Types.ObjectId,
    principalModel: PrincipalModel,
    overrides: Partial<TCustomConfig>,
    priority: number,
    session?: ClientSession,
  ): Promise<IConfig | null> => {
    const query = { principalType, principalId: principalId.toString(), ...baseFilter };
    const update = {
      $set: { principalModel, overrides, priority, isActive: true },
      $inc: { configVersion: 1 },
    };
    try {
      return await Config.findOneAndUpdate(query, update, {
        upsert: true,
        new: true,
        setDefaultsOnInsert: true,
        ...(session ? { session } : {}),
      });
    } catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 11000) {
        throw error;
      }
      return await Config.findOneAndUpdate(query, update, {
        new: true,
        ...(session ? { session } : {}),
      });
    }
  };

  const clearConfigTombstones = async (
    principalType: PrincipalType,
    principalId: string,
  ): Promise<void> => {
    await Config.updateOne(
      { principalType, principalId, ...baseFilter },
      { $set: { tombstones: [] } },
    );
  };

  return createRoleAdminService({
    getRoleByName,
    createRoleByName,
    updateRoleByName,
    findConfigByPrincipal,
    upsertConfig,
    clearConfigTombstones,
    invalidateConfigCaches: deps.invalidateConfigCaches,
  });
}
