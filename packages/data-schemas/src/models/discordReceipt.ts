import { Schema } from 'mongoose';
import type { Model } from 'mongoose';

/** Global opaque replay fence; deliberately contains no tenant, actor, destination or payload data. */
export interface DiscordReceiptRecord {
  applicationId: string;
  eventId: string;
  fingerprint: string;
  purgeAt: Date;
}
export function createDiscordReceiptModel(
  mongoose: typeof import('mongoose'),
): Model<DiscordReceiptRecord> {
  const schema = new Schema<DiscordReceiptRecord>(
    {
      applicationId: { type: String, required: true, immutable: true },
      eventId: { type: String, required: true, immutable: true },
      fingerprint: { type: String, required: true, immutable: true },
      purgeAt: { type: Date, required: true },
    },
    { versionKey: false },
  );
  schema.index({ applicationId: 1, eventId: 1 }, { unique: true });
  schema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });
  return (
    mongoose.models.DiscordReceipt ?? mongoose.model<DiscordReceiptRecord>('DiscordReceipt', schema)
  );
}
