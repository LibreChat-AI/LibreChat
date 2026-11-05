import mongoose, { Schema } from 'mongoose';
import { ISession } from '~/types';

const sessionSchema: Schema<ISession> = new Schema({
  refreshTokenHash: {
    type: String,
    required: true,
  },
  expiration: {
    type: Date,
    required: true,
    expires: 0,
  },
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  tenantId: {
    type: String,
    index: true,
  },
});

sessionSchema.index({ user: 1, refreshTokenHash: 1 }, { unique: true });
/** `deleteSession({ refreshToken })` has no user in its filter, so the compound index above cannot serve it. */
sessionSchema.index({ refreshTokenHash: 1 });

export default sessionSchema;
