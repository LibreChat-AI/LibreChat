import type { Document, Types } from 'mongoose';

export interface IBalanceRequest extends Document {
  user: Types.ObjectId;
  status: 'pending' | 'resolved';
  reason?: string;
  requestedAt: Date;
  resolvedAt?: Date;
  resolvedBy?: Types.ObjectId;
  resolvedAmount?: number;
  tenantId?: string;
  /**
   * Time-boxed claim on the *attempt* to credit and resolve this request —
   * never a permanent gate on its own. See `claimBalanceRequestResolution`
   * in methods/balanceRequest.ts.
   */
  resolutionLeaseExpiresAt?: Date;
}

/**
 * A pending request with its requester resolved — the admin "Requests" view
 * needs the requester's name/email (to search/display) and role/tenantId (to
 * resolve their effective balance config), not just the raw `user` ObjectId
 * ref that `IBalanceRequest` carries.
 */
export interface PendingBalanceRequestWithUser {
  requestId: string;
  requestedAt: Date;
  reason?: string;
  user: {
    id: string;
    name?: string;
    email?: string;
    avatar?: string;
    role?: string;
    tenantId?: string;
  };
}
