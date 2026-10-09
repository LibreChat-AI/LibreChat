import { Schema } from 'mongoose';
import { PrincipalType, PrincipalModel } from 'librechat-data-provider';
import type { IConfig } from '~/types';

const configSchema: Schema<IConfig> = new Schema<IConfig>(
  {
    principalType: {
      type: String,
      enum: Object.values(PrincipalType),
      required: true,
      index: true,
    },
    principalId: {
      type: String,
      refPath: 'principalModel',
      required: true,
      index: true,
    },
    principalModel: {
      type: String,
      enum: Object.values(PrincipalModel),
      required: true,
    },
    priority: {
      type: Number,
      required: true,
      index: true,
    },
    overrides: {
      type: Schema.Types.Mixed,
      default: {},
    },
    tombstones: {
      type: [String],
      default: [],
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    configVersion: {
      type: Number,
      default: 0,
    },
    tenantId: {
      type: String,
      index: true,
    },
  },
  { timestamps: true },
);

// Enforce 1:1 principal-to-config (one config document per principal per tenant)
configSchema.index({ principalType: 1, principalId: 1, tenantId: 1 }, { unique: true });
configSchema.index({ principalType: 1, principalId: 1, isActive: 1, tenantId: 1 });
configSchema.index({ priority: 1, isActive: 1, tenantId: 1 });

export default configSchema;
