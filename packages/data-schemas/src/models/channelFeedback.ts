import { Schema } from 'mongoose';
import { channelSnowflakeSchema, isDiscordFeedbackScope } from 'librechat-data-provider';
import type {
  ChannelReplyMapping,
  ChannelFeedbackEvent,
  ChannelRating,
  ChannelFeedbackVote,
} from 'librechat-data-provider';
import type { Model } from 'mongoose';
import { applyTenantIsolation } from './plugins/tenantIsolation';

export interface ChannelFeedbackRetention {
  expiredAt?: Date | null;
}

export type ChannelReplyRecord = ChannelReplyMapping & ChannelFeedbackRetention;

export interface ChannelFeedbackEventRecord extends ChannelFeedbackRetention {
  tenantId: string;
  channelId: string;
  eventId: string;
  digest: string;
  ledgerKey: string;
  event: ChannelFeedbackEvent;
  mapping: ChannelReplyMapping;
  rating: ChannelRating;
  processed: boolean;
  receiptExpiresAt?: Date;
  retryAtMs?: number;
}

export interface ChannelFeedbackLedger extends ChannelFeedbackRetention {
  tenantId: string;
  key: string;
  mapping: ChannelReplyMapping;
  externalUserId: string;
  scoreId: string;
  receiptEpoch?: number;
  scoreTimestamp?: Date;
  createdAt?: Date;
  votes: ChannelFeedbackVote[];
  revision: number;
  rating: ChannelRating | null;
  exportStatus: 'pending' | 'sent';
  retryAtMs: number;
  leaseId?: string;
  leaseUntilMs?: number;
}

function mappingSchema(): Schema<ChannelReplyRecord> {
  const schema = new Schema<ChannelReplyRecord>(
    {
      tenantId: { type: String, required: true },
      channelId: { type: String, required: true },
      channelRevision: { type: String, required: true },
      provider: { type: String, enum: ['discord'] },
      teamId: {
        type: String,
        required: function (this: { provider?: string }) {
          return this.provider !== 'discord';
        },
      },
      applicationId: String,
      guildId: String,
      scope: String,
      selectionId: String,
      selectionRevision: String,
      sourceGuildId: String,
      parentChannelId: String,
      confirmationEventId: String,
      externalChannelId: String,
      externalUserId: String,
      linkId: String,
      linkRevision: String,
      agentId: { type: String, required: true },
      externalMessageKey: { type: String, required: true },
      runId: { type: String, required: true },
      responseId: { type: String, required: true },
      messageId: { type: String, required: true },
      conversationId: { type: String, required: true },
      principalId: { type: String, required: true },
      traceId: { type: String, required: true },
      isTemporary: Boolean,
      sampled: Boolean,
      destinationIds: { type: [String], default: undefined },
      centralTraceExportEnabled: { type: Boolean, required: true },
      expiredAt: Date,
    },
    { _id: false },
  );
  schema.pre('validate', function () {
    if (this.provider === 'discord') {
      if (
        !isDiscordFeedbackScope(this) ||
        ![this.applicationId, this.externalChannelId, this.externalUserId].every(
          (value) => channelSnowflakeSchema.safeParse(value).success,
        ) ||
        !this.linkId ||
        !this.linkRevision
      )
        this.invalidate('provider', 'Invalid Discord feedback source');
    } else if (
      [
        'scope',
        'selectionId',
        'selectionRevision',
        'sourceGuildId',
        'parentChannelId',
        'confirmationEventId',
        'applicationId',
        'guildId',
        'externalChannelId',
        'externalUserId',
        'linkId',
        'linkRevision',
      ].some((field) => this.get(field) !== undefined)
    )
      this.invalidate('provider', 'Invalid Slack feedback source');
  });
  return schema;
}

export function createChannelReplyModel(
  mongoose: typeof import('mongoose'),
): Model<ChannelReplyRecord> {
  const schema = mappingSchema();
  schema.index({ tenantId: 1, channelId: 1, teamId: 1, externalMessageKey: 1 }, { unique: true });
  schema.index({ tenantId: 1, principalId: 1, conversationId: 1 });
  schema.index({ expiredAt: 1 }, { expireAfterSeconds: 0 });
  applyTenantIsolation(schema);
  return mongoose.models.ChannelReply ?? mongoose.model<ChannelReplyRecord>('ChannelReply', schema);
}

export function createChannelFeedbackEventModel(
  mongoose: typeof import('mongoose'),
): Model<ChannelFeedbackEventRecord> {
  const event = new Schema<ChannelFeedbackEvent>(
    {
      eventId: { type: String, required: true },
      provider: { type: String, enum: ['discord'] },
      eventTimestampUs: {
        type: Number,
        required: function (this: { provider?: string }) {
          return this.provider !== 'discord';
        },
      },
      externalMessageKey: { type: String, required: true },
      externalUserId: { type: String, required: true },
      reaction: { type: String, required: true },
      action: { type: String, enum: ['added', 'removed', 'replaced'], required: true },
    },
    { _id: false },
  );
  event.pre('validate', function () {
    if (this.provider === 'discord') {
      if (
        this.eventTimestampUs !== undefined ||
        this.action !== 'replaced' ||
        this.reaction !== 'discord-button' ||
        !channelSnowflakeSchema.safeParse(this.eventId).success ||
        !channelSnowflakeSchema.safeParse(this.externalUserId).success
      )
        this.invalidate('provider', 'Invalid Discord feedback event');
    } else if (this.get('action') === 'replaced')
      this.invalidate('action', 'Invalid Slack feedback event');
  });
  const schema = new Schema<ChannelFeedbackEventRecord>(
    {
      tenantId: { type: String, required: true },
      channelId: { type: String, required: true },
      eventId: { type: String, required: true },
      digest: { type: String, required: true },
      ledgerKey: { type: String, required: true },
      event: { type: event, required: true },
      mapping: { type: mappingSchema(), required: true },
      rating: { type: String, enum: ['thumbsUp', 'thumbsDown'], required: true },
      processed: { type: Boolean, required: true },
      receiptExpiresAt: Date,
      retryAtMs: { type: Number, default: 0 },
      expiredAt: Date,
    },
    { timestamps: true },
  );
  schema.index({ tenantId: 1, channelId: 1, eventId: 1 }, { unique: true });
  schema.index({ tenantId: 1, processed: 1, updatedAt: 1, _id: 1 });
  schema.index({ receiptExpiresAt: 1 }, { expireAfterSeconds: 0 });
  schema.index({
    tenantId: 1,
    ledgerKey: 1,
    processed: 1,
    receiptExpiresAt: 1,
  });
  schema.index({ tenantId: 1, ledgerKey: 1, 'event.eventTimestampUs': -1, 'event.eventId': -1 });
  schema.index({ tenantId: 1, 'mapping.principalId': 1, 'mapping.conversationId': 1 });
  schema.index({ expiredAt: 1 }, { expireAfterSeconds: 0 });
  applyTenantIsolation(schema);
  return (
    mongoose.models.ChannelFeedbackEvent ??
    mongoose.model<ChannelFeedbackEventRecord>('ChannelFeedbackEvent', schema)
  );
}

export function createChannelFeedbackModel(
  mongoose: typeof import('mongoose'),
): Model<ChannelFeedbackLedger> {
  const vote = new Schema<ChannelFeedbackVote>(
    {
      reaction: { type: String, required: true },
      externalMessageKey: { type: String, required: true },
      rating: { type: String, enum: ['thumbsUp', 'thumbsDown'], required: true },
      active: { type: Boolean, required: true },
      provider: { type: String, enum: ['discord'] },
      eventTimestampUs: {
        type: Number,
        required: function (this: { provider?: string }) {
          return this.provider !== 'discord';
        },
      },
      eventId: { type: String, required: true },
    },
    { _id: false },
  );
  vote.pre('validate', function () {
    if (
      this.provider === 'discord' &&
      (this.get('eventTimestampUs') !== undefined ||
        this.reaction !== 'discord-button' ||
        this.active !== true ||
        !channelSnowflakeSchema.safeParse(this.eventId).success)
    )
      this.invalidate('provider', 'Invalid Discord feedback vote');
  });
  const schema = new Schema<ChannelFeedbackLedger>(
    {
      tenantId: { type: String, required: true },
      key: { type: String, required: true },
      mapping: { type: mappingSchema(), required: true },
      externalUserId: { type: String, required: true },
      scoreId: { type: String, required: true },
      receiptEpoch: Number,
      scoreTimestamp: { type: Date, required: true, default: Date.now },
      expiredAt: Date,
      votes: { type: [vote], default: [] },
      revision: { type: Number, required: true },
      rating: { type: String, enum: ['thumbsUp', 'thumbsDown', null], default: null },
      exportStatus: { type: String, enum: ['pending', 'sent'], required: true },
      retryAtMs: { type: Number, required: true },
      leaseId: String,
      leaseUntilMs: Number,
    },
    { timestamps: true },
  );
  schema.index({ tenantId: 1, key: 1 }, { unique: true });
  schema.index({ tenantId: 1, exportStatus: 1, retryAtMs: 1 });
  schema.index({ tenantId: 1, 'mapping.principalId': 1, 'mapping.conversationId': 1 });
  schema.index({ tenantId: 1, 'mapping.channelId': 1 });
  schema.index({ expiredAt: 1 }, { expireAfterSeconds: 0 });
  applyTenantIsolation(schema);
  return (
    mongoose.models.ChannelFeedback ??
    mongoose.model<ChannelFeedbackLedger>('ChannelFeedback', schema)
  );
}
