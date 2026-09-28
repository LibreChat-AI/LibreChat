import { Types } from 'mongoose';
import { PrincipalType, PrincipalModel } from 'librechat-data-provider';
import type { FilterQuery, Model, ClientSession } from 'mongoose';
import type { TCustomConfig } from 'librechat-data-provider';
import type { IConfig } from '~/types';
import { BASE_CONFIG_PRINCIPAL_ID } from '~/admin/capabilities';
import { escapeRegExp } from '~/utils/string';

/** Tombstones a field write clears: the written path and its ancestors below the section. */
export function getTombstonePathsToClear(fieldPath: string): string[] {
  const parts = fieldPath.split('.');
  if (parts.length <= 1) {
    return [fieldPath];
  }
  return parts.slice(1).map((_, index) => parts.slice(0, index + 2).join('.'));
}

function getPathAndDescendantsRegex(fieldPath: string): RegExp {
  return new RegExp(`^${escapeRegExp(fieldPath)}(?:\\.|$)`);
}

export function createConfigMethods(mongoose: typeof import('mongoose')): {
  listAllConfigs: (filter?: { isActive?: boolean }, session?: ClientSession) => Promise<IConfig[]>;
  findConfigByPrincipal: (
    principalType: PrincipalType,
    principalId: string | Types.ObjectId,
    options?: { includeInactive?: boolean },
    session?: ClientSession,
  ) => Promise<IConfig | null>;
  getApplicableConfigs: (
    principals?: Array<{ principalType: string; principalId?: string | Types.ObjectId }>,
    session?: ClientSession,
  ) => Promise<IConfig[]>;
  upsertConfig: (
    principalType: PrincipalType,
    principalId: string | Types.ObjectId,
    principalModel: PrincipalModel,
    overrides: Partial<TCustomConfig>,
    priority: number,
    session?: ClientSession,
    options?: { expectEmpty?: boolean; preservePriority?: boolean },
  ) => Promise<IConfig | null>;
  patchConfigFields: (
    principalType: PrincipalType,
    principalId: string | Types.ObjectId,
    principalModel: PrincipalModel,
    fields: Record<string, unknown>,
    priority: number,
    session?: ClientSession,
  ) => Promise<IConfig | null>;
  tombstoneConfigField: (
    principalType: PrincipalType,
    principalId: string | Types.ObjectId,
    principalModel: PrincipalModel,
    fieldPath: string,
    priority: number,
    session?: ClientSession,
  ) => Promise<IConfig | null>;
  unsetConfigField: (
    principalType: PrincipalType,
    principalId: string | Types.ObjectId,
    fieldPath: string,
    session?: ClientSession,
  ) => Promise<IConfig | null>;
  deleteConfig: (
    principalType: PrincipalType,
    principalId: string | Types.ObjectId,
    session?: ClientSession,
    options?: { expectEmpty?: boolean },
  ) => Promise<IConfig | null>;
  toggleConfigActive: (
    principalType: PrincipalType,
    principalId: string | Types.ObjectId,
    isActive: boolean,
    session?: ClientSession,
    options?: { expectEmpty?: boolean },
  ) => Promise<IConfig | null>;
} {
  async function findConfigByPrincipal(
    principalType: PrincipalType,
    principalId: string | Types.ObjectId,
    options?: { includeInactive?: boolean },
    session?: ClientSession,
  ): Promise<IConfig | null> {
    const Config = mongoose.models.Config as Model<IConfig>;
    const filter: { principalType: PrincipalType; principalId: string; isActive?: boolean } = {
      principalType,
      principalId: principalId.toString(),
    };
    if (!options?.includeInactive) {
      filter.isActive = true;
    }
    return await Config.findOne(filter)
      .session(session ?? null)
      .lean<IConfig>();
  }

  async function listAllConfigs(
    filter?: { isActive?: boolean },
    session?: ClientSession,
  ): Promise<IConfig[]> {
    const Config = mongoose.models.Config as Model<IConfig>;
    const where: { isActive?: boolean } = {};
    if (filter?.isActive !== undefined) {
      where.isActive = filter.isActive;
    }
    return await Config.find(where)
      .sort({ priority: 1 })
      .session(session ?? null)
      .lean<IConfig[]>();
  }

  async function getApplicableConfigs(
    principals?: Array<{ principalType: string; principalId?: string | Types.ObjectId }>,
    session?: ClientSession,
  ): Promise<IConfig[]> {
    const Config = mongoose.models.Config as Model<IConfig>;

    const basePrincipal = {
      principalType: PrincipalType.ROLE as string,
      principalId: BASE_CONFIG_PRINCIPAL_ID,
    };

    const principalsQuery = [basePrincipal];

    if (principals && principals.length > 0) {
      for (const p of principals) {
        if (p.principalId !== undefined) {
          principalsQuery.push({
            principalType: p.principalType,
            principalId: p.principalId.toString(),
          });
        }
      }
    }

    return await Config.find({
      $or: principalsQuery,
      isActive: true,
    })
      .sort({ priority: 1 })
      .session(session ?? null)
      .lean<IConfig[]>();
  }

  async function upsertConfig(
    principalType: PrincipalType,
    principalId: string | Types.ObjectId,
    principalModel: PrincipalModel,
    overrides: Partial<TCustomConfig>,
    priority: number,
    session?: ClientSession,
    options?: { expectEmpty?: boolean; preservePriority?: boolean },
  ): Promise<IConfig | null> {
    const Config = mongoose.models.Config as Model<IConfig>;

    const query: FilterQuery<IConfig> = {
      principalType,
      principalId: principalId.toString(),
    };
    if (options?.expectEmpty) {
      query.$and = [
        { $or: [{ overrides: { $eq: {} } }, { overrides: { $exists: false } }] },
        { $or: [{ tombstones: { $size: 0 } }, { tombstones: { $exists: false } }] },
      ];
    }

    const update = {
      $set: {
        principalModel,
        overrides,
        ...(options?.preservePriority ? {} : { priority }),
        isActive: true,
      },
      ...(options?.preservePriority ? { $setOnInsert: { priority } } : {}),
      $inc: { configVersion: 1 },
    };

    const mongoOptions = {
      upsert: true,
      new: true,
      setDefaultsOnInsert: true,
      ...(session ? { session } : {}),
    };

    try {
      return await Config.findOneAndUpdate(query, update, mongoOptions);
    } catch (err: unknown) {
      if ((err as { code?: number }).code === 11000) {
        if (options?.expectEmpty) {
          return null;
        }
        return await Config.findOneAndUpdate(
          { principalType, principalId: principalId.toString() },
          { $set: update.$set, $inc: update.$inc },
          { new: true, ...(session ? { session } : {}) },
        );
      }
      throw err;
    }
  }

  async function patchConfigFields(
    principalType: PrincipalType,
    principalId: string | Types.ObjectId,
    principalModel: PrincipalModel,
    fields: Record<string, unknown>,
    priority: number,
    session?: ClientSession,
  ): Promise<IConfig | null> {
    const Config = mongoose.models.Config as Model<IConfig>;

    const setPayload: { principalModel: PrincipalModel; priority: number; [key: string]: unknown } =
      {
        principalModel,
        priority,
      };

    for (const [path, value] of Object.entries(fields)) {
      setPayload[`overrides.${path}`] = value;
    }

    const tombstonesToClear = [...new Set(Object.keys(fields).flatMap(getTombstonePathsToClear))];

    const options = {
      upsert: true,
      new: true,
      setDefaultsOnInsert: true,
      ...(session ? { session } : {}),
    };

    const update: Record<string, unknown> = {
      $set: setPayload,
      $inc: { configVersion: 1 },
    };
    if (tombstonesToClear.length > 0) {
      update.$pull = { tombstones: { $in: tombstonesToClear } };
    }

    return await Config.findOneAndUpdate(
      { principalType, principalId: principalId.toString() },
      update,
      options,
    );
  }

  async function tombstoneConfigField(
    principalType: PrincipalType,
    principalId: string | Types.ObjectId,
    principalModel: PrincipalModel,
    fieldPath: string,
    priority: number,
    session?: ClientSession,
  ): Promise<IConfig | null> {
    const Config = mongoose.models.Config as Model<IConfig>;

    const options = {
      upsert: true,
      new: true,
      setDefaultsOnInsert: true,
      ...(session ? { session } : {}),
    };

    return await Config.findOneAndUpdate(
      { principalType, principalId: principalId.toString() },
      {
        $set: {
          principalModel,
          priority,
        },
        $unset: { [`overrides.${fieldPath}`]: '' },
        $addToSet: { tombstones: fieldPath },
        $inc: { configVersion: 1 },
      },
      options,
    );
  }

  async function unsetConfigField(
    principalType: PrincipalType,
    principalId: string | Types.ObjectId,
    fieldPath: string,
    session?: ClientSession,
  ): Promise<IConfig | null> {
    const Config = mongoose.models.Config as Model<IConfig>;

    const options = {
      new: true,
      ...(session ? { session } : {}),
    };

    return await Config.findOneAndUpdate(
      { principalType, principalId: principalId.toString() },
      {
        $unset: { [`overrides.${fieldPath}`]: '' },
        $pull: { tombstones: { $regex: getPathAndDescendantsRegex(fieldPath) } },
        $inc: { configVersion: 1 },
      },
      options,
    );
  }

  async function deleteConfig(
    principalType: PrincipalType,
    principalId: string | Types.ObjectId,
    session?: ClientSession,
    options?: { expectEmpty?: boolean },
  ): Promise<IConfig | null> {
    const Config = mongoose.models.Config as Model<IConfig>;
    const filter: FilterQuery<IConfig> = {
      principalType,
      principalId: principalId.toString(),
    };
    if (options?.expectEmpty) {
      filter.$and = [
        { $or: [{ overrides: { $eq: {} } }, { overrides: { $exists: false } }] },
        { $or: [{ tombstones: { $size: 0 } }, { tombstones: { $exists: false } }] },
      ];
    }
    return await Config.findOneAndDelete(filter).session(session ?? null);
  }

  async function toggleConfigActive(
    principalType: PrincipalType,
    principalId: string | Types.ObjectId,
    isActive: boolean,
    session?: ClientSession,
    options?: { expectEmpty?: boolean },
  ): Promise<IConfig | null> {
    const Config = mongoose.models.Config as Model<IConfig>;
    const filter: FilterQuery<IConfig> = {
      principalType,
      principalId: principalId.toString(),
    };
    if (options?.expectEmpty) {
      filter.$and = [
        { $or: [{ overrides: { $eq: {} } }, { overrides: { $exists: false } }] },
        { $or: [{ tombstones: { $size: 0 } }, { tombstones: { $exists: false } }] },
      ];
    }
    return await Config.findOneAndUpdate(
      filter,
      { $set: { isActive } },
      { new: true, ...(session ? { session } : {}) },
    );
  }

  return {
    listAllConfigs,
    findConfigByPrincipal,
    getApplicableConfigs,
    upsertConfig,
    patchConfigFields,
    tombstoneConfigField,
    unsetConfigField,
    deleteConfig,
    toggleConfigActive,
  };
}

export type ConfigMethods = ReturnType<typeof createConfigMethods>;
