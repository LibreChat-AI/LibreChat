import { Schema, Document } from 'mongoose';

/** A file upload held by the NMB gateway for human review. Holds no file content. */
export interface INmbFileHold extends Document {
  userId: string;
  /** SHA-256 of the uploaded bytes; a later identical upload by the same user is matched on it. */
  sha256: string;
  reviewId: string;
  /** Set once the approved, sanitised content has been released for one upload. */
  releasedAt?: Date;
  tenantId?: string;
  createdAt?: Date;
}

const nmbFileHoldSchema: Schema<INmbFileHold> = new Schema<INmbFileHold>(
  {
    userId: { type: String, required: true },
    sha256: { type: String, required: true },
    reviewId: { type: String, required: true, unique: true },
    releasedAt: { type: Date },
    tenantId: { type: String, index: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

nmbFileHoldSchema.index({ userId: 1, sha256: 1 });
/** Holds are short-lived pointers; the scanner owns the review itself. */
nmbFileHoldSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30 });

export default nmbFileHoldSchema;
