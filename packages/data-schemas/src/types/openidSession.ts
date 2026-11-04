import type { Document } from 'mongoose';

export interface IOpenIDSession extends Document {
  issuer: string;
  clientId: string;
  subject: string;
  sid: string;
  /** Epoch seconds; the earliest login `iat` seen for this session. */
  firstLoginIat?: number;
  createdAt: Date;
  revokedAt?: Date;
}

export interface OpenIDSessionLoginInput {
  issuer: string;
  clientId: string;
  subject: string;
  sid: string;
  /** Epoch seconds, from the login token's `iat`; undefined when the token carried none. */
  loginIat?: number;
  now?: Date;
}

export interface OpenIDSessionLogoutInput {
  issuer: string;
  clientId: string;
  subject: string;
  sid: string;
  revokedAt: Date;
}

export interface OpenIDSessionQuery {
  issuer: string;
  clientId: string;
  sid: string;
}

export type OpenIDSessionLoginResult =
  | { ok: true; session: IOpenIDSession }
  | { ok: false; error: { code: 'subject_mismatch' } };
