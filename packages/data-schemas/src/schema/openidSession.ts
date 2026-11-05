import { Schema } from 'mongoose';
import type { IOpenIDSession } from '~/types';

const openidSessionSchema: Schema<IOpenIDSession> = new Schema<IOpenIDSession>({
  issuer: {
    type: String,
    required: true,
  },
  clientId: {
    type: String,
    required: true,
  },
  subject: {
    type: String,
    required: true,
  },
  sid: {
    type: String,
    required: true,
  },
  firstLoginIat: {
    type: Number,
  },
  createdAt: {
    type: Date,
    required: true,
    default: Date.now,
  },
  revokedAt: {
    type: Date,
  },
});

openidSessionSchema.index({ issuer: 1, clientId: 1, sid: 1 }, { unique: true });

export default openidSessionSchema;
