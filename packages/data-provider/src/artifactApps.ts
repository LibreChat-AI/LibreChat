import { z } from 'zod';

/**
 * Shared types and Zod schemas for the Artifact Apps feature (PLAN.md §6, §8, §9).
 * Consumed by both the backend (packages/api, data-schemas) and the client.
 */

// ===== ENUMS =====

export const artifactAppStatusSchema = z.enum([
  'draft',
  'pending_review',
  'published',
  'suspended',
  'archived',
]);
export type ArtifactAppStatus = z.infer<typeof artifactAppStatusSchema>;

export const artifactAppVisibilitySchema = z.enum(['private', 'restricted', 'tenant', 'public']);
export type ArtifactAppVisibility = z.infer<typeof artifactAppVisibilitySchema>;

export const artifactRuntimeTypeSchema = z.enum([
  'react',
  'html',
  'svg',
  'mermaid',
  'markdown',
  'text',
  'code',
  'document',
  'spreadsheet',
  'presentation',
]);
export type ArtifactRuntimeType = z.infer<typeof artifactRuntimeTypeSchema>;

export const artifactAppListScopeSchema = z.enum(['personal', 'shared', 'all']);
export type ArtifactAppListScope = z.infer<typeof artifactAppListScopeSchema>;

/** Stable namespace for automatically generated artifact catalog identities. */
export const ARTIFACT_SOURCE_KEY_PREFIX = 'artifact:v1:' as const;

export const DEFAULT_ARTIFACT_APPS_CONFIG = {
  catalogPageSize: 20,
  versionPageSize: 20,
  scanBatchSize: 100,
  aclBatchSize: 100,
  maxScanBatches: 10,
  syncLockLeaseMs: 5_000,
  syncLockRetryDelayMs: 50,
  syncLockRetryAttempts: 100,
  syncWriteRetryAttempts: 3,
  clientSyncSettleDelayMs: 500,
  clientPreviewCaptureTimeoutMs: 5_000,
  clientSyncRetryBaseDelayMs: 1_000,
  clientSyncRetryMaxDelayMs: 30_000,
} as const;

function boundedInteger(min: number, max: number, defaultValue: number) {
  return z.number().int().min(min).max(max).default(defaultValue);
}

export const artifactAppsConfigSchema = z
  .object({
    catalogPageSize: boundedInteger(1, 50, DEFAULT_ARTIFACT_APPS_CONFIG.catalogPageSize),
    versionPageSize: boundedInteger(1, 50, DEFAULT_ARTIFACT_APPS_CONFIG.versionPageSize),
    scanBatchSize: boundedInteger(1, 1_000, DEFAULT_ARTIFACT_APPS_CONFIG.scanBatchSize),
    aclBatchSize: boundedInteger(1, 100, DEFAULT_ARTIFACT_APPS_CONFIG.aclBatchSize),
    maxScanBatches: boundedInteger(1, 100, DEFAULT_ARTIFACT_APPS_CONFIG.maxScanBatches),
    syncLockLeaseMs: boundedInteger(1_000, 300_000, DEFAULT_ARTIFACT_APPS_CONFIG.syncLockLeaseMs),
    syncLockRetryDelayMs: boundedInteger(
      1,
      5_000,
      DEFAULT_ARTIFACT_APPS_CONFIG.syncLockRetryDelayMs,
    ),
    syncLockRetryAttempts: boundedInteger(
      1,
      1_000,
      DEFAULT_ARTIFACT_APPS_CONFIG.syncLockRetryAttempts,
    ),
    syncWriteRetryAttempts: boundedInteger(
      1,
      20,
      DEFAULT_ARTIFACT_APPS_CONFIG.syncWriteRetryAttempts,
    ),
    clientSyncSettleDelayMs: boundedInteger(
      0,
      60_000,
      DEFAULT_ARTIFACT_APPS_CONFIG.clientSyncSettleDelayMs,
    ),
    clientPreviewCaptureTimeoutMs: boundedInteger(
      500,
      30_000,
      DEFAULT_ARTIFACT_APPS_CONFIG.clientPreviewCaptureTimeoutMs,
    ),
    clientSyncRetryBaseDelayMs: boundedInteger(
      100,
      60_000,
      DEFAULT_ARTIFACT_APPS_CONFIG.clientSyncRetryBaseDelayMs,
    ),
    clientSyncRetryMaxDelayMs: boundedInteger(
      100,
      600_000,
      DEFAULT_ARTIFACT_APPS_CONFIG.clientSyncRetryMaxDelayMs,
    ),
  })
  .default({});
export type ArtifactAppsConfig = z.infer<typeof artifactAppsConfigSchema>;

export const artifactAppListRequestSchema = z.object({
  scope: artifactAppListScopeSchema.default('personal'),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().min(1).optional(),
  search: z.string().trim().max(200).optional(),
});
export type TArtifactAppListRequest = z.infer<typeof artifactAppListRequestSchema>;

export const artifactVersionListRequestSchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().min(1).optional(),
});
export type TArtifactVersionListRequest = z.infer<typeof artifactVersionListRequestSchema>;

export const artifactVersionStateSchema = z.enum(['draft', 'released', 'withdrawn']);
export type ArtifactVersionState = z.infer<typeof artifactVersionStateSchema>;

export const artifactRiskClassSchema = z.enum(['none', 'read', 'write', 'external']);
export type ArtifactRiskClass = z.infer<typeof artifactRiskClassSchema>;

export const artifactCostClassSchema = z.enum(['free', 'low', 'medium', 'high']);
export type ArtifactCostClass = z.infer<typeof artifactCostClassSchema>;

// ===== NESTED SCHEMAS =====

export const artifactToolPolicySchema = z.object({
  enabled: z.boolean().default(false),
  allowedServers: z.array(z.string()).default([]),
  allowedTools: z.array(z.string()).default([]),
  requireConfirmationForWrites: z.boolean().default(true),
});
export type ArtifactToolPolicy = z.infer<typeof artifactToolPolicySchema>;

export const artifactMarketplaceSchema = z.object({
  listed: z.boolean().default(false),
  featured: z.boolean().default(false),
  summary: z.string().optional(),
  riskClass: artifactRiskClassSchema.default('none'),
  costClass: artifactCostClassSchema.default('free'),
});
export type ArtifactMarketplace = z.infer<typeof artifactMarketplaceSchema>;

export const artifactSourceMetadataSchema = z.object({
  conversationId: z.string().optional(),
  messageId: z.string().optional(),
  originalArtifactId: z.string().optional(),
  sourceKey: z.string().optional(),
});
export type ArtifactSourceMetadata = z.infer<typeof artifactSourceMetadataSchema>;

export const artifactRuntimeConfigSchema = z.object({
  dependencies: z.record(z.string()).optional(),
  entryPoint: z.string().optional(),
  renderMode: z.string().optional(),
});
export type ArtifactRuntimeConfig = z.infer<typeof artifactRuntimeConfigSchema>;

export const ARTIFACT_PREVIEW_MAX_URL_LENGTH = 75_000;

const artifactPreviewDataUrlPattern =
  /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/i;

/** Artifact catalog previews must be self-contained and must not initiate network requests. */
export function isAllowedArtifactPreviewUrl(imageUrl: string): boolean {
  if (imageUrl.length > ARTIFACT_PREVIEW_MAX_URL_LENGTH) {
    return false;
  }

  const match = artifactPreviewDataUrlPattern.exec(imageUrl);
  if (!match || match[2].length % 4 !== 0) {
    return false;
  }

  try {
    const binary = globalThis.atob(match[2]);
    const mimeType = match[1].toLowerCase();
    if (mimeType === 'png') {
      return (
        binary.length >= 8 &&
        binary.charCodeAt(0) === 0x89 &&
        binary.slice(1, 4) === 'PNG' &&
        binary.charCodeAt(4) === 0x0d &&
        binary.charCodeAt(5) === 0x0a &&
        binary.charCodeAt(6) === 0x1a &&
        binary.charCodeAt(7) === 0x0a
      );
    }
    if (mimeType === 'jpeg') {
      return (
        binary.length >= 3 &&
        binary.charCodeAt(0) === 0xff &&
        binary.charCodeAt(1) === 0xd8 &&
        binary.charCodeAt(2) === 0xff
      );
    }
    return binary.length >= 12 && binary.slice(0, 4) === 'RIFF' && binary.slice(8, 12) === 'WEBP';
  } catch {
    return false;
  }
}

export const artifactPreviewSchema = z.object({
  type: z.literal('image'),
  imageUrl: z
    .string()
    .max(ARTIFACT_PREVIEW_MAX_URL_LENGTH)
    .refine(
      isAllowedArtifactPreviewUrl,
      'Artifact preview must be a base64 PNG, JPEG, or WebP image',
    ),
  alt: z.string().max(500).optional(),
});
export type ArtifactPreview = z.infer<typeof artifactPreviewSchema>;

// ===== REQUEST SCHEMAS =====

/** The already-extracted artifact payload sent from the client at publish time. */
export const artifactSnapshotInputSchema = z.object({
  type: artifactRuntimeTypeSchema,
  content: z.string().min(1),
  title: z.string().optional(),
  language: z.string().optional(),
  runtimeConfig: artifactRuntimeConfigSchema.optional(),
  preview: artifactPreviewSchema.optional(),
});
export type ArtifactSnapshotInput = z.infer<typeof artifactSnapshotInputSchema>;

/** POST /api/artifact-apps */
export const publishArtifactAppSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  icon: z.string().optional(),
  category: z.string().optional(),
  tags: z.array(z.string()).optional(),
  visibility: artifactAppVisibilitySchema.default('private'),
  allowEmbed: z.boolean().optional(),
  allowFork: z.boolean().optional(),
  allowAnonymousView: z.boolean().optional(),
  toolPolicy: artifactToolPolicySchema.partial().optional(),
  marketplace: artifactMarketplaceSchema.partial().optional(),
  artifact: artifactSnapshotInputSchema,
  source: artifactSourceMetadataSchema.optional(),
  changelog: z.string().optional(),
  versionLabel: z.string().optional(),
});
export type TPublishArtifactAppRequest = z.infer<typeof publishArtifactAppSchema>;

/** POST /api/artifact-apps/sync — idempotently register an artifact in the catalog. */
export const syncArtifactAppSchema = z.object({
  title: z.string().min(1).max(200),
  artifact: artifactSnapshotInputSchema,
  /**
   * The `latestVersionNumber` this edit was made against, per the client's local catalog
   * cache. The server rejects the write as a conflict (409) if that baseline is already behind
   * its own `latestVersionNumber` — otherwise a request queued from stale tab state could still
   * create and activate a new version after a newer one from another tab has already landed.
   */
  basedOnVersionNumber: z.number().int().nonnegative().optional(),
  source: artifactSourceMetadataSchema
    .extend({
      conversationId: z.string().min(1),
      /**
       * `artifact:v1:` keys are the unambiguous current format. The three
       * unversioned prefixes remain accepted while older browser bundles drain
       * during rolling deployments. The server maps them into the v1 namespace
       * and removes the MIME suffix used by the original identifier format.
       */
      sourceKey: z
        .string()
        .min(1)
        .max(500)
        .refine(
          (value) => /^(?:artifact:v1:)?(?:identifier|file|message):.+$/.test(value),
          'Invalid artifact source key',
        ),
      /** Pre-hash truncated key emitted only while migrating an overlong source identity. */
      legacySourceKey: z.string().min(1).max(500).optional(),
    })
    .superRefine((source, context) => {
      if (
        source.legacySourceKey &&
        (source.sourceKey.length !== 500 ||
          source.legacySourceKey.length !== 500 ||
          !/:[0-9a-f]{8}$/.test(source.sourceKey) ||
          source.sourceKey.slice(0, 491) !== source.legacySourceKey.slice(0, 491))
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['legacySourceKey'],
          message: 'Legacy artifact source key does not match the hashed source key',
        });
      }
    }),
});
export type TSyncArtifactAppRequest = z.infer<typeof syncArtifactAppSchema>;

/** PATCH /api/artifact-apps/:id */
export const updateArtifactAppSchema = z
  .object({
    title: z.string().min(1).max(200),
    description: z.string().max(2000),
    icon: z.string(),
    category: z.string(),
    tags: z.array(z.string()),
    visibility: artifactAppVisibilitySchema,
    allowEmbed: z.boolean(),
    allowFork: z.boolean(),
    allowAnonymousView: z.boolean(),
    toolPolicy: artifactToolPolicySchema.partial(),
    marketplace: artifactMarketplaceSchema.partial(),
  })
  .partial();
export type TUpdateArtifactAppRequest = z.infer<typeof updateArtifactAppSchema>;

// ===== RESPONSE TYPES (client-facing; dates serialized as ISO strings) =====

export interface TArtifactApp {
  /** MongoDB resource id used by the generic ACL endpoints. */
  id: string;
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
  toolPolicy: ArtifactToolPolicy;
  marketplace: ArtifactMarketplace;
  preview?: ArtifactPreview;
  sourceMetadata?: ArtifactSourceMetadata;
  review?: {
    submittedAt?: string;
    submittedBy?: string;
    reviewedAt?: string;
    reviewedBy?: string;
    result?: 'approved' | 'rejected';
    comment?: string;
  };
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
  /** Effective ACL bits for the current viewer. Present on catalog list items. */
  permissionBits?: number;
}

export interface TArtifactVersion {
  artifactVersionId: string;
  artifactAppId: string;
  tenantId?: string;
  versionNumber: number;
  versionLabel?: string;
  changelog?: string;
  artifactType: ArtifactRuntimeType;
  sourceSnapshot: string;
  runtimeConfig: ArtifactRuntimeConfig;
  preview?: ArtifactPreview;
  integrity: {
    sourceHash: string;
    schemaVersion: number;
  };
  createdBy: string;
  createdAt: string;
  publication: {
    state: ArtifactVersionState;
    releasedBy?: string;
    releasedAt?: string;
  };
}

export type TArtifactVersionSummary = Omit<
  TArtifactVersion,
  'sourceSnapshot' | 'runtimeConfig' | 'integrity'
>;

export interface TArtifactAppWithVersion {
  app: TArtifactApp;
  version: TArtifactVersion | null;
}

/** Temporary rollout union accepted while older pods may still return a raw app. */
export type TArtifactAppDetailResponse = TArtifactAppWithVersion | TArtifactApp;

export function normalizeArtifactAppDetail(
  response: TArtifactAppDetailResponse,
): TArtifactAppWithVersion {
  if ('app' in response) {
    return response;
  }
  return { app: response, version: null };
}

export interface TSyncArtifactAppResponse extends TArtifactAppWithVersion {
  created: boolean;
  versionCreated: boolean;
}

export interface TArtifactAppList {
  apps: TArtifactApp[];
  has_more: boolean;
  after: string | null;
}

export interface TArtifactVersionList {
  versions: TArtifactVersionSummary[];
  has_more: boolean;
  after: string | null;
}
