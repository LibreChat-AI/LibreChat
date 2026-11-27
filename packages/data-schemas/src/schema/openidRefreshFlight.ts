import { Schema } from 'mongoose';
import type { IOpenIDRefreshFlight } from '~/types';

const openidRefreshFlightSchema: Schema<IOpenIDRefreshFlight> = new Schema<IOpenIDRefreshFlight>({
  key: {
    type: String,
    required: true,
    unique: true,
  },
  ownerId: {
    type: String,
    required: true,
  },
  status: {
    type: String,
    enum: ['pending', 'completed', 'failed', 'revoked'],
    required: true,
    default: 'pending',
    index: true,
  },
  encryptedResult: {
    type: String,
  },
  errorMessage: {
    type: String,
  },
  deliveryId: {
    type: String,
  },
  deliveryExpiresAt: {
    type: Date,
  },
  revocationRequestedAt: {
    type: Date,
  },
  createdAt: {
    type: Date,
    required: true,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    required: true,
    default: Date.now,
  },
  lockExpiresAt: {
    type: Date,
    required: true,
    index: true,
  },
  expiresAt: {
    type: Date,
    required: true,
  },
});

openidRefreshFlightSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default openidRefreshFlightSchema;
