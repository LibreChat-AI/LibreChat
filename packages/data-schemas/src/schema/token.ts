import { Schema } from 'mongoose';
import { IToken } from '~/types';

const tokenSchema: Schema<IToken> = new Schema({
  userId: {
    type: Schema.Types.ObjectId,
    required: true,
    ref: 'user',
  },
  email: {
    type: String,
    /** `findToken` and `deleteTokens` both apply `.trim().toLowerCase()` to the email
     * before querying, so the write side has to match on both counts or a token
     * created with mixed case or surrounding whitespace can never be found again —
     * an invite issued to `User@Example.com` was unredeemable. `User.email` sets
     * `lowercase` alone; the read contract here also trims, so this adds `trim`. */
    lowercase: true,
    trim: true,
  },
  type: {
    type: String,
  },
  identifier: {
    type: String,
  },
  token: {
    type: String,
    required: true,
  },
  createdAt: {
    type: Date,
    required: true,
    default: Date.now,
  },
  expiresAt: {
    type: Date,
    required: true,
  },
  metadata: {
    type: Map,
    of: Schema.Types.Mixed,
  },
  tenantId: {
    type: String,
    index: true,
  },
});

tokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
tokenSchema.index({ userId: 1, type: 1, identifier: 1, tenantId: 1 });

export default tokenSchema;
