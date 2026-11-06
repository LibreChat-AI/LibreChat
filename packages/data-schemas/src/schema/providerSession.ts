import { Schema } from 'mongoose';
import type { IProviderSession } from '~/types';

const providerSessionSchema: Schema<IProviderSession> = new Schema<IProviderSession>({
  issuer: {
    type: String,
    required: true,
  },
  clientId: {
    type: String,
    required: true,
  },
  sid: {
    type: String,
    required: true,
  },
  subject: {
    type: String,
  },
  createdAt: {
    type: Date,
    required: true,
    default: Date.now,
  },
  revokedAt: {
    type: Date,
  },
  expiresAt: {
    type: Date,
    required: true,
  },
});

providerSessionSchema.index({ issuer: 1, clientId: 1, sid: 1 }, { unique: true });
providerSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default providerSessionSchema;
