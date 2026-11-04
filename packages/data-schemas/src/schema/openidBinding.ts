import mongoose, { Schema } from 'mongoose';
import type { IOpenIDBinding } from '~/types';

const openidBindingSchema: Schema<IOpenIDBinding> = new Schema<IOpenIDBinding>({
  sessionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'OpenIDSession',
    required: true,
  },
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  /** Normalized to `null` for an absent, null or empty tenant; never required. */
  tenantId: {
    type: String,
  },
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
  createdAt: {
    type: Date,
    required: true,
    default: Date.now,
  },
});

openidBindingSchema.index({ sessionId: 1, user: 1, tenantId: 1 }, { unique: true });
openidBindingSchema.index({ issuer: 1, clientId: 1, sid: 1, user: 1, tenantId: 1 });

export default openidBindingSchema;
