import { Schema } from 'mongoose';
import type { CodeEnvironmentDocument } from '~/types';

const workerPrincipalSchema = new Schema(
  {
    type: {
      type: String,
      enum: ['deployment', 'tenant', 'user', 'role', 'group'],
      required: true,
    },
    id: {
      type: String,
      required: true,
    },
  },
  { _id: false },
);

const codeEnvironmentSettingsSchema = new Schema(
  {
    permissions: {
      type: new Schema(
        {
          fileWrite: { type: String, enum: ['allow', 'ask', 'deny'] },
          commandExecution: { type: String, enum: ['allow', 'ask', 'deny'] },
        },
        { _id: false },
      ),
    },
  },
  { _id: false },
);

const codeEnvironmentSchema: Schema<CodeEnvironmentDocument> = new Schema<CodeEnvironmentDocument>(
  {
    environmentId: {
      type: String,
      required: true,
    },
    name: {
      type: String,
      required: true,
    },
    type: {
      type: String,
      enum: ['managed', 'attached'],
      required: true,
    },
    baseURL: {
      type: String,
      required: true,
    },
    controlPlaneId: {
      type: String,
      required: true,
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    ownerSlot: {
      type: Number,
      min: 0,
    },
    pendingAgentReferences: {
      type: [
        new Schema(
          {
            reservationId: { type: String, required: true },
            expiresAt: { type: Date, required: true },
          },
          { _id: false },
        ),
      ],
      default: undefined,
    },
    deletionStartedAt: {
      type: Date,
    },
    deletionLeaseId: { type: String },
    deletionLeaseExpiresAt: { type: Date },
    deletionCommittedAt: { type: Date },
    registrationPendingAt: { type: Date },
    registrationLeaseId: { type: String },
    registrationLeaseExpiresAt: { type: Date },
    registrationReconcileAfter: { type: Date },
    revocationPendingAt: {
      type: Date,
    },
    revocationAttempts: {
      type: Number,
      min: 0,
    },
    revocationLastError: {
      type: String,
    },
    revocationReconcileAfter: { type: Date },
    revocationLeaseId: { type: String },
    revocationLeaseExpiresAt: { type: Date },
    workerId: {
      type: String,
    },
    revocationTokenEnv: {
      type: String,
    },
    workerPrincipal: {
      type: workerPrincipalSchema,
    },
    settings: {
      type: codeEnvironmentSettingsSchema,
    },
    tenantId: {
      type: String,
      index: true,
    },
  },
  { timestamps: true },
);

codeEnvironmentSchema.index({ environmentId: 1, tenantId: 1 }, { unique: true });
codeEnvironmentSchema.index({ updatedAt: -1, _id: 1 });

export default codeEnvironmentSchema;
