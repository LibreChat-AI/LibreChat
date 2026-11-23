import { Schema } from 'mongoose';
import type { SlackWorkspace } from 'librechat-data-provider';
import type { Model } from 'mongoose';
import { applyTenantIsolation } from './plugins/tenantIsolation';

/** An organization installation; the person who installed it is not its execution owner. */
export interface SlackWorkspaceRecord extends SlackWorkspace {
  encryptedBotToken?: string;
  installOrder: number;
  removedAt?: Date;
  authorityWrites?: number;
}

export interface SlackInstallRecord {
  tenantId?: string;
  stateHash: string;
  userId: string;
  appId: string;
  clientId: string;
  generation: string;
  installOrder: number;
  expiresAt: Date;
  workspaceId?: string;
  workspaceRevision?: string;
  callbackId?: string;
}

export type SlackClaimedInstall = SlackInstallRecord & { callbackId: string };

export interface SlackInstallGeneration {
  tenantId?: string;
  partition: string;
  appId: string;
  revision: string;
  writes: number;
  clientId?: string;
  name?: string;
  encryptedClientSecret?: string;
  encryptedSigningSecret?: string;
}

export function createSlackWorkspaceModel(
  mongoose: typeof import('mongoose'),
): Model<SlackWorkspaceRecord> {
  const schema = new Schema<SlackWorkspaceRecord>(
    {
      tenantId: String,
      workspaceId: { type: String, required: true },
      appId: { type: String, required: true },
      teamId: { type: String, required: true },
      teamName: { type: String, required: true },
      botUserId: { type: String, required: true },
      status: { type: String, enum: ['active', 'disconnected'], required: true },
      revision: { type: String, required: true },
      scopes: { type: [String], required: true },
      encryptedBotToken: { type: String, select: false },
      installOrder: { type: Number, required: true },
      authorityWrites: { type: Number, default: 0 },
      removedAt: Date,
    },
    { timestamps: true },
  );
  schema.index({ workspaceId: 1 }, { unique: true });
  // Slack sends one event stream per app/workspace. Its tenant owner must be unambiguous.
  schema.index({ appId: 1, teamId: 1 }, { unique: true });
  schema.index(
    { appId: 1 },
    { unique: true, partialFilterExpression: { status: 'active' }, name: 'slack_active_app' },
  );
  schema.index({ tenantId: 1, workspaceId: 1 });
  applyTenantIsolation(schema);
  return (
    mongoose.models.SlackWorkspace ?? mongoose.model<SlackWorkspaceRecord>('SlackWorkspace', schema)
  );
}

export function createSlackInstallModel(
  mongoose: typeof import('mongoose'),
): Model<SlackInstallRecord> {
  const schema = new Schema<SlackInstallRecord>(
    {
      tenantId: String,
      stateHash: { type: String, required: true, select: false },
      userId: { type: String, required: true },
      appId: { type: String, required: true },
      clientId: { type: String, required: true },
      generation: { type: String, required: true },
      installOrder: { type: Number, required: true },
      expiresAt: { type: Date, required: true },
      workspaceId: String,
      workspaceRevision: String,
      callbackId: { type: String, select: false },
    },
    { timestamps: true },
  );
  schema.index({ stateHash: 1 }, { unique: true });
  schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  schema.index({ tenantId: 1, userId: 1 });
  applyTenantIsolation(schema);
  return mongoose.models.SlackInstall ?? mongoose.model<SlackInstallRecord>('SlackInstall', schema);
}

export function createSlackInstallGenerationModel(
  mongoose: typeof import('mongoose'),
): Model<SlackInstallGeneration> {
  const schema = new Schema<SlackInstallGeneration>({
    tenantId: String,
    partition: { type: String, required: true },
    appId: { type: String, required: true },
    revision: { type: String, required: true },
    writes: { type: Number, required: true, default: 0 },
    clientId: String,
    name: { type: String, trim: true, maxlength: 100 },
    encryptedClientSecret: { type: String, select: false },
    encryptedSigningSecret: { type: String, select: false },
  });
  schema.index({ partition: 1, appId: 1 }, { unique: true });
  applyTenantIsolation(schema);
  return (
    mongoose.models.SlackInstallGeneration ??
    mongoose.model<SlackInstallGeneration>('SlackInstallGeneration', schema)
  );
}
