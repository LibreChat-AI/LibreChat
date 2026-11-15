import { Schema } from 'mongoose';
import type {
  DiscordIngressAction,
  DiscordThreadReference,
  DiscordDmInboxReference,
} from 'librechat-data-provider';
import type { Model } from 'mongoose';
import { applyTenantIsolation } from './plugins/tenantIsolation';

export interface DiscordCancelResult {
  runId?: string;
  cancelled: boolean;
}

/** Private ingress payloads are erased at completion; only deduplication metadata survives. */
interface DiscordInboxPayload {
  tenantId?: string;
  eventId: string;
  applicationId: string;
  applicationRevision: string;
  guildId?: string;
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
  inspectionEpoch?: number;
  result?: 'completed' | 'expired' | 'authority_changed' | 'unavailable';
}

/** Only resolved records may reach the command executor. Legacy records are resolved by default. */
export interface DiscordInboxRecord extends DiscordInboxPayload {
  routing?: 'bound';
  thread?: DiscordThreadReference;
  dm?: DiscordDmInboxReference;
  channelId: string;
  channelRevision: string;
  agentId: string;
}
/** No internal destination is invented before an owned client inspects the actual channel. */
export interface DiscordInboxUnresolvedRecord extends DiscordInboxPayload {
  routing: 'inspection';
  guildId: string;
  dm?: never;
  installationId: string;
  installationRevision: string;
}
export type DiscordInboxLeaseRecord = DiscordInboxRecord | DiscordInboxUnresolvedRecord;

function bound(this: { routing?: string }): boolean {
  return this.routing !== 'inspection';
}
function guild(this: { dm?: DiscordDmInboxReference }): boolean {
  return !this.dm;
}
function inspection(this: { routing?: string }): boolean {
  return this.routing === 'inspection';
}

export function createDiscordInboxModel(
  mongoose: typeof import('mongoose'),
): Model<DiscordInboxLeaseRecord> {
  if (mongoose.models.DiscordInbox) return mongoose.model<DiscordInboxLeaseRecord>('DiscordInbox');
  const schema = new Schema<DiscordInboxLeaseRecord>(
    {
      tenantId: String,
      eventId: { type: String, required: true },
      applicationId: { type: String, required: true },
      applicationRevision: { type: String, required: true },
      guildId: { type: String, required: guild },
      routing: { type: String, enum: ['bound', 'inspection'] },
      thread: Schema.Types.Mixed,
      dm: Schema.Types.Mixed,
      inspectionEpoch: Number,
      channelId: { type: String, required: bound },
      channelRevision: { type: String, required: bound },
      agentId: { type: String, required: bound },
      installationId: { type: String, required: inspection },
      installationRevision: { type: String, required: inspection },
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
  schema.index({
    tenantId: 1,
    applicationId: 1,
    guildId: 1,
    externalChannelId: 1,
    externalUserId: 1,
    state: 1,
    leaseExpiresAt: 1,
  });
  schema.index({ tenantId: 1, 'dm.source.userId': 1 });
  schema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });
  applyTenantIsolation(schema);
  return mongoose.model<DiscordInboxLeaseRecord>('DiscordInbox', schema);
}
