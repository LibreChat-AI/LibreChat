import { Schema } from 'mongoose';
import type { DiscordIngressAction } from 'librechat-data-provider';
import type { Model } from 'mongoose';
import { applyTenantIsolation } from './plugins/tenantIsolation';

export interface DiscordCancelResult {
  runId?: string;
  cancelled: boolean;
}

/** Private ingress payloads are erased at completion; only deduplication metadata survives. */
export interface DiscordInboxRecord {
  tenantId?: string;
  eventId: string;
  applicationId: string;
  applicationRevision: string;
  guildId: string;
  channelId: string;
  channelRevision: string;
  agentId: string;
  externalChannelId: string;
  externalUserId: string;
  fingerprint: string;
  action?: DiscordIngressAction;
  encryptedToken?: string;
  encryptedReply?: string;
  commandResult?: DiscordCancelResult;
  state: 'queued' | 'processing' | 'reply' | 'done' | 'failed';
  receivedAt: number;
  expiresAt: number;
  purgeAt: Date;
  nextAttemptAt: number;
  leaseOwner?: string;
  leaseEpoch: number;
  leaseExpiresAt: number;
  authorityWrites: number;
  result?: 'completed' | 'expired' | 'authority_changed' | 'unavailable';
}

export function createDiscordInboxModel(
  mongoose: typeof import('mongoose'),
): Model<DiscordInboxRecord> {
  if (mongoose.models.DiscordInbox) return mongoose.model<DiscordInboxRecord>('DiscordInbox');
  const schema = new Schema<DiscordInboxRecord>(
    {
      tenantId: String,
      eventId: { type: String, required: true },
      applicationId: { type: String, required: true },
      applicationRevision: { type: String, required: true },
      guildId: { type: String, required: true },
      channelId: { type: String, required: true },
      channelRevision: { type: String, required: true },
      agentId: { type: String, required: true },
      externalChannelId: { type: String, required: true },
      externalUserId: { type: String, required: true },
      fingerprint: { type: String, required: true },
      action: { type: Schema.Types.Mixed, select: false },
      encryptedToken: { type: String, select: false },
      encryptedReply: { type: String, select: false },
      commandResult: { type: Schema.Types.Mixed, select: false },
      state: {
        type: String,
        required: true,
        enum: ['queued', 'processing', 'reply', 'done', 'failed'],
      },
      receivedAt: { type: Number, required: true },
      expiresAt: { type: Number, required: true },
      purgeAt: { type: Date, required: true },
      nextAttemptAt: { type: Number, required: true },
      leaseOwner: String,
      leaseEpoch: { type: Number, required: true },
      leaseExpiresAt: { type: Number, required: true },
      authorityWrites: { type: Number, required: true },
      result: { type: String, enum: ['completed', 'expired', 'authority_changed', 'unavailable'] },
    },
    { versionKey: false },
  );
  schema.index({ applicationId: 1, eventId: 1 }, { unique: true });
  schema.index({
    tenantId: 1,
    applicationId: 1,
    state: 1,
    nextAttemptAt: 1,
    leaseExpiresAt: 1,
    receivedAt: 1,
  });
  schema.index({ tenantId: 1, channelId: 1, externalUserId: 1, state: 1 });
  schema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });
  applyTenantIsolation(schema);
  return mongoose.model<DiscordInboxRecord>('DiscordInbox', schema);
}
