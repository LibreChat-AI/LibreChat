import mongoose, { Schema, Document, Types } from 'mongoose';
import type { SharedFileSnapshot } from '~/types';

export interface ISharedLink extends Document {
  conversationId: string;
  title?: string;
  user?: string;
  messages?: Types.ObjectId[];
  shareId?: string;
  targetMessageId?: string;
  expiredAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
  tenantId?: string;
  snapshotFiles?: boolean;
  fileSnapshots?: SharedFileSnapshot[];
}

/**
 * Immutable file snapshot embedded on a shared link. Captures the metadata the
 * share-scoped file routes need to stream/preview each referenced file without
 * consulting the original owner's live file ACL. References the original stored
 * object (no byte copy).
 */
const fileSnapshotSchema = new Schema<SharedFileSnapshot>(
  {
    file_id: { type: String, required: true },
    source: { type: String },
    storageKey: { type: String },
    filepath: { type: String },
    type: { type: String },
    filename: { type: String },
    bytes: { type: Number },
    width: { type: Number },
    height: { type: Number },
    model: { type: String },
    llmDeliveryPath: { type: String, enum: ['provider', 'text', 'none'] },
    previewRevision: { type: String },
    sourceDispatchedAt: { type: Number },
    tenantId: { type: String },
  },
  { _id: false },
);

const shareSchema: Schema<ISharedLink> = new Schema(
  {
    conversationId: {
      type: String,
      required: true,
    },
    title: {
      type: String,
      index: true,
    },
    user: {
      type: String,
      index: true,
    },
    messages: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Message' }],
    shareId: {
      type: String,
      index: true,
    },
    targetMessageId: {
      type: String,
      required: false,
      index: true,
    },
    tenantId: {
      type: String,
      index: true,
    },
    expiredAt: {
      type: Date,
    },
    snapshotFiles: {
      type: Boolean,
    },
    fileSnapshots: {
      type: [fileSnapshotSchema],
      default: undefined,
    },
  },
  { timestamps: true },
);

shareSchema.index({ expiredAt: 1 }, { expireAfterSeconds: 0 });
shareSchema.index({ conversationId: 1, user: 1, targetMessageId: 1, tenantId: 1 });
/** The sidebar's "shared" filter asks the opposite question of the index above: which
 * conversations has THIS user shared. That leads with `conversationId`, so a user-scoped
 * lookup could not use it and would scan every link in the deployment. */
shareSchema.index({ user: 1, conversationId: 1 });
shareSchema.index({ updatedAt: -1 });

export default shareSchema;
