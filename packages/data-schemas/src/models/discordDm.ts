import { Schema } from 'mongoose';
import { discordDmSourceSchema, discordDmSelectionSchema } from 'librechat-data-provider';
import type { DiscordDmSource, DiscordDmSelection } from 'librechat-data-provider';
import type { Model } from 'mongoose';
import { applyTenantIsolation } from './plugins/tenantIsolation';

export interface DiscordDmCodeRecord {
  tenantId?: string;
  applicationId: string;
  externalUserId: string;
  codeHash: string;
  source: DiscordDmSource;
  issuedAtMs: number;
  consumedAtMs?: number;
  expiresAtMs: number;
  state: 'pending' | 'consumed' | 'revoked';
  selectionId?: string;
  dmChannelId?: string;
  purgeAt: Date;
}
export interface DiscordDmSelectionRecord extends DiscordDmSelection {
  tenantId?: string;
  state: 'active' | 'revoked';
  authorityWrites: number;
  purgeAt: Date;
}
const sourceSchema = () => {
  const schema = new Schema<DiscordDmSource>(
    {
      applicationId: { type: String, required: true },
      externalUserId: { type: String, required: true },
      guildId: { type: String, required: true },
      externalChannelId: { type: String, required: true },
      installationId: { type: String, required: true },
      installationRevision: { type: String, required: true },
      channelId: { type: String, required: true },
      channelRevision: { type: String, required: true },
      agentId: { type: String, required: true },
      userId: { type: String, required: true },
      linkId: { type: String, required: true },
      linkRevision: { type: String, required: true },
    },
    { _id: false },
  );
  schema.pre('validate', function () {
    if (!discordDmSourceSchema.safeParse(this.toObject()).success)
      this.invalidate('applicationId', 'Invalid Discord DM source');
  });
  return schema;
};
export function createDiscordDmCodeModel(
  mongoose: typeof import('mongoose'),
): Model<DiscordDmCodeRecord> {
  const schema = new Schema<DiscordDmCodeRecord>({
    tenantId: String,
    applicationId: { type: String, required: true },
    externalUserId: { type: String, required: true },
    codeHash: { type: String, required: true, select: false },
    source: { type: sourceSchema(), required: true },
    issuedAtMs: { type: Number, required: true },
    consumedAtMs: Number,
    expiresAtMs: { type: Number, required: true },
    state: { type: String, enum: ['pending', 'consumed', 'revoked'], required: true },
    selectionId: String,
    dmChannelId: String,
    purgeAt: { type: Date, required: true },
  });
  schema.index({ codeHash: 1 }, { unique: true });
  schema.index({ tenantId: 1, applicationId: 1, state: 1, expiresAtMs: 1 });
  schema.index({ tenantId: 1, applicationId: 1, externalUserId: 1, state: 1 });
  schema.index({ tenantId: 1, 'source.userId': 1 });
  schema.index({ tenantId: 1, 'source.channelId': 1 });
  schema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });
  applyTenantIsolation(schema);
  return (
    mongoose.models.DiscordDmCode ?? mongoose.model<DiscordDmCodeRecord>('DiscordDmCode', schema)
  );
}
export function createDiscordDmSelectionModel(
  mongoose: typeof import('mongoose'),
): Model<DiscordDmSelectionRecord> {
  const schema = new Schema<DiscordDmSelectionRecord>({
    tenantId: String,
    scope: { type: String, enum: ['dm'], required: true },
    selectionId: { type: String, required: true },
    revision: { type: String, required: true },
    applicationId: { type: String, required: true },
    externalUserId: { type: String, required: true },
    dmChannelId: { type: String, required: true },
    confirmationEventId: { type: String, required: true },
    createdAtMs: { type: Number, required: true },
    source: { type: sourceSchema(), required: true },
    expiresAtMs: { type: Number, required: true },
    state: { type: String, enum: ['active', 'revoked'], required: true },
    authorityWrites: { type: Number, required: true, default: 0 },
    purgeAt: { type: Date, required: true },
  });
  schema.pre('validate', function () {
    const value = this.toObject();
    if (
      !discordDmSelectionSchema.safeParse({
        scope: this.scope,
        selectionId: this.selectionId,
        revision: this.revision,
        applicationId: this.applicationId,
        externalUserId: this.externalUserId,
        dmChannelId: this.dmChannelId,
        confirmationEventId: this.confirmationEventId,
        source: value.source,
        createdAtMs: this.createdAtMs,
        expiresAtMs: this.expiresAtMs,
      }).success
    )
      this.invalidate('selectionId', 'Invalid Discord DM selection');
  });
  schema.index(
    { tenantId: 1, applicationId: 1, externalUserId: 1, dmChannelId: 1 },
    { unique: true },
  );
  schema.index({ tenantId: 1, selectionId: 1 }, { unique: true });
  schema.index({ tenantId: 1, applicationId: 1, state: 1, expiresAtMs: 1 });
  schema.index({ tenantId: 1, 'source.userId': 1, selectionId: 1 });
  schema.index({ tenantId: 1, 'source.channelId': 1 });
  schema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });
  applyTenantIsolation(schema);
  return (
    mongoose.models.DiscordDmSelection ??
    mongoose.model<DiscordDmSelectionRecord>('DiscordDmSelection', schema)
  );
}
