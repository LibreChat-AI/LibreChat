import mongoose, { Schema, Document, Types } from 'mongoose';

export interface IKey extends Document {
  userId: Types.ObjectId;
  name: string;
  value: string;
  expiresAt?: Date;
  tenantId?: string;
}

const keySchema: Schema<IKey> = new Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  name: {
    type: String,
    required: true,
  },
  value: {
    type: String,
    required: true,
  },
  expiresAt: {
    type: Date,
  },
  tenantId: {
    type: String,
    index: true,
  },
});

keySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
/** Not unique: legacy databases can hold duplicate rows for one user and key name. */
keySchema.index({ userId: 1, name: 1, tenantId: 1 });

export default keySchema;
