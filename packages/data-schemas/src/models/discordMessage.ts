import { Schema } from 'mongoose';
import type { Model } from 'mongoose';

/** Global opaque replay fence, retaining neither actor, destination, prompt nor tenant. */
export interface DiscordMessageReceiptRecord {
  applicationId: string;
  messageId: string;
  fingerprint: string;
  outcome: 'admitted' | 'ignored';
  purgeAt: Date;
}
export function createDiscordMessageReceiptModel(
  mongoose: typeof import('mongoose'),
): Model<DiscordMessageReceiptRecord> {
  const schema = new Schema<DiscordMessageReceiptRecord>(
    {
      applicationId: { type: String, required: true, immutable: true },
      messageId: { type: String, required: true, immutable: true },
      fingerprint: { type: String, required: true, immutable: true },
      outcome: { type: String, required: true, enum: ['admitted', 'ignored'], immutable: true },
      purgeAt: { type: Date, required: true },
    },
    { versionKey: false },
  );
  schema.index({ applicationId: 1, messageId: 1 }, { unique: true });
  schema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });
  return (
    mongoose.models.DiscordMessageReceipt ??
    mongoose.model<DiscordMessageReceiptRecord>('DiscordMessageReceipt', schema)
  );
}
