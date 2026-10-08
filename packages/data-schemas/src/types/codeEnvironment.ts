import type { CodeEnvironmentUserSettings } from 'librechat-data-provider';
import type { Document, Types } from 'mongoose';

export type CodeEnvironment = {
  environmentId: string;
  name: string;
  type: 'managed' | 'attached';
  baseURL: string;
  controlPlaneId: string;
  createdBy: Types.ObjectId;
  ownerSlot?: number;
  pendingAgentReferences?: Array<{
    reservationId: string;
    expiresAt: Date;
  }>;
  deletionStartedAt?: Date;
  deletionLeaseId?: string;
  deletionLeaseExpiresAt?: Date;
  deletionCommittedAt?: Date;
  registrationPendingAt?: Date;
  registrationLeaseId?: string;
  registrationLeaseExpiresAt?: Date;
  registrationReconcileAfter?: Date;
  revocationPendingAt?: Date;
  revocationAttempts?: number;
  revocationLastError?: string;
  revocationReconcileAfter?: Date;
  revocationLeaseId?: string;
  revocationLeaseExpiresAt?: Date;
  workerId?: string;
  revocationTokenEnv?: string;
  workerPrincipal?: {
    type: 'deployment' | 'tenant' | 'user' | 'role' | 'group';
    id: string;
  };
  settings?: CodeEnvironmentUserSettings;
  tenantId?: string;
  createdAt: Date;
  updatedAt: Date;
};

export type CodeEnvironmentDocument = CodeEnvironment &
  Document<Types.ObjectId> & {
    _id: Types.ObjectId;
  };
