import { Schema } from 'mongoose';
import { normalizeServerName } from 'librechat-data-provider';
import type { MCPServerDocument } from '~/types';

const mcpServerSchema: Schema<MCPServerDocument> = new Schema<MCPServerDocument>(
  {
    serverName: {
      type: String,
      index: true,
      required: true,
    },
    normalizedServerName: {
      type: String,
      required: true,
    },
    config: {
      type: Schema.Types.Mixed,
      required: true,
      // Config contains: title, description, url, oauth, etc.
    },
    author: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    tenantId: {
      type: String,
      index: true,
    },
  },
  {
    timestamps: true,
  },
);

mcpServerSchema.pre('validate', function () {
  this.normalizedServerName = normalizeServerName(this.serverName);
});

mcpServerSchema.index({ serverName: 1, tenantId: 1 }, { unique: true });
mcpServerSchema.index(
  { normalizedServerName: 1, tenantId: 1 },
  {
    unique: true,
    partialFilterExpression: { normalizedServerName: { $exists: true } },
  },
);
mcpServerSchema.index({ updatedAt: -1, _id: 1 });

export default mcpServerSchema;
