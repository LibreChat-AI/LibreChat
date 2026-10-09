import { Schema } from 'mongoose';
import type { IPluginAuth } from '~/types';

const pluginAuthSchema: Schema<IPluginAuth> = new Schema(
  {
    authField: {
      type: String,
      required: true,
    },
    value: {
      type: String,
      required: true,
    },
    userId: {
      type: String,
      required: true,
    },
    pluginKey: {
      type: String,
    },
    tenantId: {
      type: String,
      index: true,
    },
  },
  { timestamps: true },
);

pluginAuthSchema.index({ userId: 1, pluginKey: 1, authField: 1, tenantId: 1 });

export default pluginAuthSchema;
