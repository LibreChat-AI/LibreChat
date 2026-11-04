import { Schema } from 'mongoose';
import type { IOpenIDLogout } from '~/types';

const openidLogoutSchema: Schema<IOpenIDLogout> = new Schema<IOpenIDLogout>({
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
  },
  boundaryIat: {
    type: Number,
    required: true,
  },
  jti: {
    type: String,
    required: true,
  },
  receivedAt: {
    type: Date,
    required: true,
    default: Date.now,
  },
  state: {
    type: String,
    enum: ['received', 'enforced'],
    required: true,
    default: 'received',
  },
  expiresAt: {
    type: Date,
  },
});

openidLogoutSchema.index({ issuer: 1, clientId: 1, jti: 1 }, { unique: true });
openidLogoutSchema.index({ state: 1, receivedAt: 1 });
openidLogoutSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default openidLogoutSchema;
