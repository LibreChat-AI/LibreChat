import type { Document } from 'mongoose';

export type OpenIDLogoutState = 'received' | 'enforced';

export interface IOpenIDLogout extends Document {
  issuer: string;
  clientId: string;
  subject: string;
  sid?: string;
  /** Epoch seconds, from this logout token's `iat`. */
  boundaryIat: number;
  jti: string;
  receivedAt: Date;
  state: OpenIDLogoutState;
  /** Set only once `state` becomes `enforced`; a `received` record must stay unset so the
   *  recovery worker still finds it. */
  expiresAt?: Date;
}

export interface OpenIDLogoutEventInput {
  issuer: string;
  clientId: string;
  subject: string;
  sid?: string;
  /** Epoch seconds, from this logout token's `iat`. */
  boundaryIat: number;
  jti: string;
  receivedAt: Date;
}

export interface OpenIDLogoutEventQuery {
  issuer: string;
  clientId: string;
  jti: string;
}

export interface OpenIDLogoutEventEnforceInput extends OpenIDLogoutEventQuery {
  expiresAt?: Date;
}

export interface OpenIDLogoutEventRecordResult {
  created: boolean;
  event: IOpenIDLogout;
}
