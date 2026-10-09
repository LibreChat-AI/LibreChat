import { PrincipalType, PrincipalModel } from 'librechat-data-provider';
import type { TCustomConfig } from 'librechat-data-provider';
import type { Document, Types } from 'mongoose';

/**
 * Configuration override for a principal (user, group, or role).
 * Stores partial overrides at the TCustomConfig (YAML) level,
 * which are merged with the base config before processing through AppService.
 */
export type Config = {
  /** The type of principal (user, group, role) */
  principalType: PrincipalType;
  /** The ID of the principal (ObjectId for users/groups, string for roles) */
  principalId: Types.ObjectId | string;
  /** The model name for the principal */
  principalModel: PrincipalModel;
  /** Priority level for determining merge order (higher = more specific) */
  priority: number;
  /** Configuration overrides matching librechat.yaml structure */
  overrides: Partial<TCustomConfig>;
  /** Dot-paths that suppress inherited config values during resolution */
  tombstones?: string[];
  /** Whether this config override is currently active */
  isActive: boolean;
  /** Version number for cache invalidation, auto-increments on overrides change */
  configVersion: number;
  /** Tenant identifier for multi-tenancy isolation */
  tenantId?: string;
  /** When this config was created */
  createdAt?: Date;
  /** When this config was last updated */
  updatedAt?: Date;
};

export type IConfig = Config &
  Document & {
    _id: Types.ObjectId;
  };
