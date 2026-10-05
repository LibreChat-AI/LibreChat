import { Schema } from 'mongoose';
import type { Model } from 'mongoose';
import { applyTenantIsolation } from './plugins/tenantIsolation';

interface ToolApprovalGrantRecord {
  user: string;
  tenantId?: string;
  agentId: string;
  toolName: string;
  conversationId: string;
  binding?: string;
  revocation?: string;
  generation?: number;
  approvedAgentGeneration?: number;
  approvedToolGeneration?: number;
  approvedRevocation?: string;
  oauthEpoch?: string | null;
}

const schema: Schema<ToolApprovalGrantRecord> = new Schema<ToolApprovalGrantRecord>(
  {
    user: { type: String, required: true },
    tenantId: { type: String },
    agentId: { type: String, required: true },
    toolName: { type: String, required: true },
    conversationId: { type: String, default: '' },
    binding: { type: String },
    revocation: { type: String },
    generation: { type: Number, min: 0 },
    approvedAgentGeneration: { type: Number, min: 0 },
    approvedToolGeneration: { type: Number, min: 0 },
    approvedRevocation: { type: String },
    oauthEpoch: { type: String, default: null },
  },
  { timestamps: true },
);
schema.index(
  { user: 1, tenantId: 1, agentId: 1, toolName: 1, conversationId: 1 },
  { unique: true },
);
schema.index({ user: 1, tenantId: 1, binding: 1, conversationId: 1 });

export function createToolApprovalGrantModel(
  mongoose: typeof import('mongoose'),
): Model<ToolApprovalGrantRecord> {
  applyTenantIsolation(schema);
  return mongoose.models.ToolApprovalGrant ?? mongoose.model('ToolApprovalGrant', schema);
}
