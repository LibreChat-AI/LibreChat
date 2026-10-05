import type {
  ArtifactAppStatus,
  ArtifactAppVisibility,
  ArtifactRuntimeType,
  ArtifactVersionState,
  ArtifactRiskClass,
  ArtifactCostClass,
  ArtifactAppsConfig,
  TUpdateArtifactAppRequest,
} from 'librechat-data-provider';
import type { Document, Types } from 'mongoose';

export interface IArtifactAppToolPolicy {
  enabled: boolean;
  allowedServers: string[];
  allowedTools: string[];
  requireConfirmationForWrites: boolean;
}

export interface IArtifactAppMarketplace {
  listed: boolean;
  featured: boolean;
  summary?: string;
  riskClass: ArtifactRiskClass;
  costClass: ArtifactCostClass;
}

export interface IArtifactAppSourceMetadata {
  conversationId?: string;
  messageId?: string;
  originalArtifactId?: string;
  /** Stable identity within a conversation, independent of the rendering message. */
  sourceKey?: string;
  /**
   * Durable tombstone written when the source conversation is deleted. Sync uses this
   * to refuse recreating a link to a conversation that no longer exists.
   */
  detachedConversationId?: string;
}

/**
 * Conversation-scoped admission tombstone, stored independently of ArtifactApp so a
 * first registration cannot insert a live source after deletion has already committed.
 */
export interface IArtifactSourceTombstone extends Document<Types.ObjectId> {
  createdBy: string;
  conversationId: string;
  tenantId?: string;
  createdAt: Date;
}

export interface IArtifactPreview {
  type: 'image';
  imageUrl: string;
  alt?: string;
}

export interface IArtifactAppSyncLock {
  token: string;
  expiresAt: Date;
}

export interface IArtifactAppDeletion {
  requestedBy: string;
  requestedAt: Date;
  finalizedAt?: Date;
}

export interface ArtifactAppListOptions {
  createdBy?: string;
  excludeCreatedBy?: string;
  cursor?: string;
  search?: string;
  limit: number;
}

export interface ArtifactAppListEntry {
  /** Internal resource id used for ACL resolution; display fields are hydrated after access. */
  id: string;
  cursor: string;
}

export interface ArtifactAppListPage {
  entries: ArtifactAppListEntry[];
  hasMore: boolean;
  after: string | null;
}

export interface IArtifactAppReview {
  submittedAt?: Date;
  submittedBy?: string;
  reviewedAt?: Date;
  reviewedBy?: string;
  result?: 'approved' | 'rejected';
  comment?: string;
}

interface ArtifactAppFields {
  artifactAppId: string;
  tenantId?: string;

  title: string;
  description?: string;
  icon?: string;
  category?: string;
  tags?: string[];

  createdBy: string;
  activeVersionId?: string;
  latestVersionNumber: number;

  status: ArtifactAppStatus;
  visibility: ArtifactAppVisibility;

  allowEmbed: boolean;
  allowFork: boolean;
  allowAnonymousView: boolean;

  toolPolicy: IArtifactAppToolPolicy;
  marketplace: IArtifactAppMarketplace;
  preview?: IArtifactPreview;
  sourceMetadata?: IArtifactAppSourceMetadata;
  review?: IArtifactAppReview;

  createdAt: Date;
  updatedAt: Date;
  archivedAt?: Date;
}

export interface ArtifactAppRecord extends ArtifactAppFields {
  id: string;
  deletion?: IArtifactAppDeletion;
}

export interface IArtifactApp extends Document<Types.ObjectId>, ArtifactAppFields {
  syncLock?: IArtifactAppSyncLock;
  deletion?: IArtifactAppDeletion;
}

export interface ArtifactAppDeletionResult {
  found: boolean;
  resourceId?: string;
  deletedVersions: number;
}

export interface IArtifactVersionRuntimeConfig {
  dependencies?: Record<string, string>;
  entryPoint?: string;
  renderMode?: string;
}

export interface IArtifactVersionIntegrity {
  sourceHash: string;
  schemaVersion: number;
}

export interface IArtifactVersionPublication {
  state: ArtifactVersionState;
  releasedBy?: string;
  releasedAt?: Date;
}

interface ArtifactVersionFields {
  artifactVersionId: string;
  artifactAppId: string;
  tenantId?: string;

  versionNumber: number;
  versionLabel?: string;
  changelog?: string;

  artifactType: ArtifactRuntimeType;
  sourceSnapshot: string;

  runtimeConfig: IArtifactVersionRuntimeConfig;
  preview?: IArtifactPreview;
  integrity: IArtifactVersionIntegrity;

  createdBy: string;
  createdAt: Date;

  publication: IArtifactVersionPublication;
}

export type ArtifactVersionRecord = ArtifactVersionFields;

export interface IArtifactVersion extends Document<Types.ObjectId>, ArtifactVersionFields {}

export type ArtifactVersionSummaryRecord = Omit<
  ArtifactVersionRecord,
  'sourceSnapshot' | 'runtimeConfig' | 'integrity'
>;

export interface ArtifactVersionListOptions extends ArtifactAppQuery {
  cursor?: string;
  limit: number;
  /** Viewer-only callers must not see a version history entry for withdrawn content. */
  excludeWithdrawn?: boolean;
}

export interface ArtifactVersionListPage {
  versions: ArtifactVersionSummaryRecord[];
  hasMore: boolean;
  after: string | null;
}

/** Version-1 create input threaded through the atomic publish transaction. */
export interface CreateArtifactAppInput {
  tenantId?: string;
  createdBy: string;
  title: string;
  description?: string;
  icon?: string;
  category?: string;
  tags?: string[];
  visibility: ArtifactAppVisibility;
  allowEmbed?: boolean;
  allowFork?: boolean;
  allowAnonymousView?: boolean;
  toolPolicy?: Partial<IArtifactAppToolPolicy>;
  marketplace?: Partial<IArtifactAppMarketplace>;
  sourceMetadata?: IArtifactAppSourceMetadata;
  version: CreateArtifactVersionInput;
}

export interface CreateArtifactVersionInput {
  artifactType: ArtifactRuntimeType;
  sourceSnapshot: string;
  runtimeConfig?: IArtifactVersionRuntimeConfig;
  preview?: IArtifactPreview;
  versionLabel?: string;
  changelog?: string;
  createdBy: string;
}

export interface ArtifactAppWithVersion {
  app: ArtifactAppRecord;
  version: ArtifactVersionRecord;
}

export interface SyncArtifactAppResult extends ArtifactAppWithVersion {
  created: boolean;
  versionCreated: boolean;
}

export interface ArtifactAppSourceQuery {
  tenantId?: string;
  createdBy: string;
  conversationId: string;
  sourceKey: string;
}

export type ArtifactAppQuery = {
  artifactAppId: string;
  tenantId?: string;
};

export type ArtifactVersionQuery = {
  artifactAppId: string;
  artifactVersionId?: string;
  versionNumber?: number;
  tenantId?: string;
};

export type ArtifactAppUpdate = TUpdateArtifactAppRequest;

export type ArtifactAppSyncOptions = Pick<
  ArtifactAppsConfig,
  'syncLockLeaseMs' | 'syncLockRetryDelayMs' | 'syncLockRetryAttempts' | 'syncWriteRetryAttempts'
>;
