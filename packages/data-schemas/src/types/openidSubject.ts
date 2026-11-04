import type { Document } from 'mongoose';

export interface IOpenIDSubject extends Document {
  issuer: string;
  clientId: string;
  subject: string;
  /** Epoch seconds, from the latest logout token's `iat`. */
  boundaryIat: number;
}

export interface OpenIDSubjectBoundaryInput {
  issuer: string;
  clientId: string;
  subject: string;
  /** Epoch seconds, from the logout token's `iat`. */
  boundaryIat: number;
}

export interface OpenIDSubjectQuery {
  issuer: string;
  clientId: string;
  subject: string;
}
