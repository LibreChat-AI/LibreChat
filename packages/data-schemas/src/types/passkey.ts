import type { Document, Types } from 'mongoose';

export type PasskeyDeviceType = 'singleDevice' | 'multiDevice';

export interface IPasskey extends Document {
  _id: Types.ObjectId;
  user: Types.ObjectId;
  /** Base64URL-encoded credential ID, unique across the deployment */
  credentialId: string;
  /** COSE public key bytes returned by the authenticator */
  publicKey: Buffer;
  /** Signature counter, used to detect cloned authenticators */
  counter: number;
  transports: string[];
  deviceType: PasskeyDeviceType;
  backedUp: boolean;
  /** User-supplied label shown in account settings */
  name: string;
  lastUsedAt?: Date | null;
  tenantId?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface PasskeyCreateData {
  user: string;
  credentialId: string;
  publicKey: Buffer;
  counter: number;
  transports?: string[];
  deviceType: PasskeyDeviceType;
  backedUp: boolean;
  name: string;
}

/**
 * A stored passkey as a plain record. The data-schemas methods return this
 * shape so Mongoose documents stay inside this package; `id` and `userId` are
 * strings rather than ObjectIds, and `publicKey` is a real `Buffer`.
 */
export interface PasskeyRecord {
  id: string;
  userId: string;
  credentialId: string;
  /** COSE public key bytes returned by the authenticator */
  publicKey: Buffer;
  /** Signature counter, used to detect cloned authenticators */
  counter: number;
  transports: string[];
  deviceType: PasskeyDeviceType;
  backedUp: boolean;
  /** User-supplied label shown in account settings */
  name: string;
  lastUsedAt: Date | null;
  tenantId?: string;
  createdAt?: Date;
}
