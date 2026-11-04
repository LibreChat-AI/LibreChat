import type { Document, Types } from 'mongoose';

export interface IOpenIDBinding extends Document {
  sessionId: Types.ObjectId;
  user: Types.ObjectId;
  /** Normalized by the binding methods: an absent, null or empty tenant always stores as `null`. */
  tenantId: string | null;
  issuer: string;
  clientId: string;
  sid: string;
  createdAt: Date;
}

export interface OpenIDBindingInput {
  sessionId: Types.ObjectId | string;
  user: Types.ObjectId | string;
  tenantId?: string | null;
}

export interface OpenIDBindingQuery {
  sessionId: Types.ObjectId | string;
  user: Types.ObjectId | string;
  tenantId?: string | null;
}

export interface OpenIDBindingBySidQuery {
  issuer: string;
  clientId: string;
  sid: string;
  user: Types.ObjectId | string;
  tenantId?: string | null;
}
