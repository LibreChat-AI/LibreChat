import { Schema } from 'mongoose';
import { channelExternalIdentitySchema } from 'librechat-data-provider';
import type { ChannelExternalIdentity } from 'librechat-data-provider';
import type { Model } from 'mongoose';
import { applyTenantIsolation } from './plugins/tenantIsolation';

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
  /** Server-written native confirmation time; missing legacy consent must be confirmed again. */
  discordActivatedAtMs?: number;
  slackReply?: {
    encryptedUrl: string;
    expiresAtMs: number;
    attempt: string;
    claimed?: boolean;
  };
}

export function createChannelIdentityModel(
  mongoose: typeof import('mongoose'),
): Model<ChannelIdentityRecord> {
  const identity = new Schema<ChannelExternalIdentity>(
    {
      tenantId: { type: String, required: true },
      channelId: { type: String, required: true },
      channelRevision: { type: String, required: true },
      provider: { type: String, enum: ['discord'] },
      teamId: String,
      applicationId: String,
      guildId: String,
      externalUserId: { type: String, required: true },
      agentId: { type: String, required: true },
    },
    { _id: false },
  );
  identity.pre('validate', function () {
    const parsed = channelExternalIdentitySchema.safeParse(this.toObject());
    if (!parsed.success) this.invalidate('provider', 'Invalid channel provider identity');
  });
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
      discordActivatedAtMs: { type: Number, min: 1, validate: Number.isSafeInteger },
      slackReply: {
        type: new Schema(
          {
            encryptedUrl: { type: String, required: true },
            expiresAtMs: { type: Number, required: true },
            attempt: { type: String, required: true },
            claimed: Boolean,
          },
          { _id: false },
        ),
        select: false,
      },
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
  applyTenantIsolation(schema);
  return (
    mongoose.models.ChannelIdentity ??
    mongoose.model<ChannelIdentityRecord>('ChannelIdentity', schema)
  );
}
