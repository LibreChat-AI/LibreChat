import { Schema } from 'mongoose';
import type { ChannelExternalIdentity } from 'librechat-data-provider';
import type { Model } from 'mongoose';
import { applyTenantIsolation } from './plugins/tenantIsolation';
import { applyManagedRegistry } from './plugins/registry';
import { applyChannelStorage } from './plugins/managed';

export interface ChannelIdentityRecord {
  tenantId: string;
  identity: ChannelExternalIdentity;
  linkId: string;
  revision: string;
  state: 'pending' | 'accepted' | 'active' | 'revoked';
  ticketHash: string;
  ticketExpiresAtMs: number;
  expiresAtMs: number;
  userId?: string;
  accountLabel?: string;
}

// Every field explicitly chooses private erasure or retained coordination metadata.
const privateFields: Record<keyof ChannelIdentityRecord, boolean> = {
  tenantId: false,
  identity: false,
  linkId: false,
  revision: false,
  state: false,
  ticketHash: true,
  ticketExpiresAtMs: false,
  expiresAtMs: false,
  userId: true,
  accountLabel: true,
};
const privateIdentityFields: Record<keyof ChannelExternalIdentity, boolean> = {
  tenantId: false,
  channelId: false,
  channelRevision: false,
  teamId: false,
  agentId: false,
  externalUserId: true,
};
export const CHANNEL_IDENTITY_PRIVATE_FIELDS: readonly string[] = [
  ...Object.entries(privateFields)
    .filter(([, privateField]) => privateField)
    .map(([field]) => field),
  ...Object.entries(privateIdentityFields)
    .filter(([, privateField]) => privateField)
    .map(([field]) => `identity.${field}`),
];

export function createChannelIdentityModel(
  mongoose: typeof import('mongoose'),
): Model<ChannelIdentityRecord> {
  const identity = new Schema<ChannelExternalIdentity>(
    {
      tenantId: { type: String, required: true },
      channelId: { type: String, required: true },
      channelRevision: { type: String, required: true },
      teamId: { type: String, required: true },
      externalUserId: { type: String, required: true },
      agentId: { type: String, required: true },
    },
    { _id: false },
  );
  const schema = new Schema<ChannelIdentityRecord>(
    {
      tenantId: { type: String, required: true },
      identity: { type: identity, required: true },
      linkId: { type: String, required: true },
      revision: { type: String, required: true },
      state: { type: String, enum: ['pending', 'accepted', 'active', 'revoked'], required: true },
      ticketHash: { type: String, required: true, select: false },
      ticketExpiresAtMs: { type: Number, required: true },
      expiresAtMs: { type: Number, required: true },
      userId: String,
      accountLabel: String,
    },
    { timestamps: true },
  );
  schema.index(
    { tenantId: 1, 'identity.channelId': 1, 'identity.teamId': 1, 'identity.externalUserId': 1 },
    { unique: true },
  );
  schema.index({ tenantId: 1, linkId: 1 }, { unique: true });
  schema.index({ tenantId: 1, ticketHash: 1 }, { unique: true });
  schema.index({ tenantId: 1, userId: 1 });
  schema.index({ linkId: 1 });
  applyManagedRegistry(schema);
  applyChannelStorage(schema);
  applyTenantIsolation(schema);
  return (
    mongoose.models.ChannelIdentity ??
    mongoose.model<ChannelIdentityRecord>('ChannelIdentity', schema)
  );
}
