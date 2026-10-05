import type {
  MediaApi,
  MediaAsset,
  MediaRendition,
  MediaRenditionKind,
  MediaRecoveryRequest,
  FileStorage,
  MediaImportReceipt,
  MediaImportRequest,
  MediaIntegration,
  MediaImageContext,
  MediaAssetContext,
  MediaJob,
  MediaJobDiagnosticsResponse,
  MediaProviderDiagnostic,
  MediaOutput,
  MediaSubmissionReceipt,
  MediaSubmissionRequest,
  MediaThread,
  MediaThreadListRequest,
  MediaTurn,
} from 'librechat-data-provider';

export type MediaRecoveryDecision = {
  actorId: string;
  createdAt: string;
  fingerprint: string;
  request: MediaRecoveryRequest;
};

/** A reserved UUID-compatible namespace keeps ordinary chat attachment validators working. */
export const MEDIA_FILE_ID_PREFIX: string = 'f17ecafe-';
export function isMediaFileId(fileId: string): boolean {
  return fileId.toLowerCase().startsWith(MEDIA_FILE_ID_PREFIX);
}

/** Scope is always explicit, including for workers running in tenant context. */
export type MediaOwnerScope = { tenantId: string | null; ownerId: string };
/** Durable account fence. It survives removal of the User document. */
export type MediaStoredOwner = MediaOwnerScope & {
  status: 'initializing' | 'active' | 'deleting' | 'deleted';
  creationToken?: string;
  workIds: string[];
  deletionToken?: string;
  deletionPrepared?: boolean;
  updatedAt: Date;
  expiresAt?: Date;
};
export type MediaPage<T> = { items: T[]; nextCursor?: string };
export type MediaPublicationOptions = {
  maxRetainers: number;
  maxTitleChars: number;
  /** When set, a new thread published from a temporary request expires this long after creation. */
  temporaryRetentionMs?: number;
};
export type MediaPageInput = { scope: MediaOwnerScope; limit: number; cursor?: string };
export type MediaTokenPricing = {
  source: 'tokenValues' | 'imageTokenValues' | 'endpointTokenConfig';
  valueKey: string;
  prompt: number;
  completion: number;
  imagePrompt?: number;
  cacheRead?: number;
  imageCacheRead?: number;
  premium?: { threshold: number; prompt: number; completion: number };
};
export type MediaExecutionSnapshot = {
  connectionId: string;
  modelId: string;
  api: MediaApi;
  endpointRef?: MediaIntegration['endpointRef'];
  credentialName?: string;
  catalogVersion: string;
  /** Hash of destination/account identity, never the credential itself. */
  bindingRevision: string;
  billing?: MediaIntegration['billing'];
  providerTag?: string;
  accountingMode?: 'balance' | 'transactions' | 'none';
  tokenPricing?: MediaTokenPricing;
  accountingShortfall?: 'debt' | 'absorb';
  cancellation?: 'best-effort' | 'confirmed';
};
export type MediaJobFence = {
  scope: MediaOwnerScope;
  jobId: string;
  leaseToken: string;
  expectedVersion: number;
};
export type MediaProviderState = {
  certainty: 'unsubmitted' | 'unknown' | 'submitted' | 'terminal';
  operationId?: string;
  requestId?: string;
  cancellationAttemptedAt?: string;
  cancellationAcknowledged?: boolean;
  /** Private bounded recovery descriptor. Never included in the public view. */
  recovery?: {
    diagnostic?: MediaProviderDiagnostic;
    /** The submission was definitively rejected; release its hold instead of charging on replay. */
    rejectedSubmission?: boolean;
    parts?: Array<
      | { kind: 'text'; ordinal: number; text: string; thoughtSignature?: string }
      | {
          kind: 'image' | 'video';
          ordinal: number;
          type: string;
          url?: string;
          fileId?: string;
          thoughtSignature?: string;
        }
    >;
    usage?: {
      inputTokens?: number;
      outputTokens?: number;
      textInputTokens?: number;
      imageInputTokens?: number;
      cachedTextInputTokens?: number;
      cachedImageInputTokens?: number;
      cachedInputTokens?: number;
      costUSD?: number;
    };
    terminalStatus?: 'completed' | 'failed' | 'cancelled';
  };
};
export type MediaStoredJob = Omit<MediaJob, 'createdAt' | 'updatedAt'> &
  MediaOwnerScope & {
    createdAt: Date;
    updatedAt: Date;
    queueCapacity: number;
    accounting?: {
      settlementId: string;
      phase: 'held' | 'settled';
      credits?: number;
      debtCredits?: number;
    };
    temporary?: boolean;
    nativeSource?: {
      conversationId: string;
      messageId: string;
      modelRunId: string;
      expiresAt?: string;
    };
    nativeLimits?: { maxParts: number; maxPartBytes: number; maxRecordingBytes: number };
    nativePartKeys?: Array<{ key: string; fingerprint: string; bytes: number }>;
    nativePartBytes?: number;
    /** Conversation consumers own native continuation independently of the Studio presentation. */
    nativeConsumers?: string[];
    nativeRetentionState?: 'live' | 'purging' | 'purged';
    nativeCleanupPending?: boolean;
    nativeConsumerClaims?: Array<{ conversationId: string; expiresAt: string }>;
    nativeConsumersCheckedAt?: Date;
    nativeConsumersTracked?: boolean;
    publicationExpiresAt?: Date | null;
    payloadPurgedAt?: Date;
    recoveryDecisions?: MediaRecoveryDecision[];
    clientRequestId: string;
    fingerprint: string;
    request: MediaSubmissionRequest;
    execution: MediaExecutionSnapshot;
    receipt: MediaSubmissionReceipt;
    newThread: boolean;
    threadEpoch: number;
    provider: MediaProviderState;
    dueAt: Date;
    recoveryFailures?: number;
    activeSlot?: number;
    leaseToken?: string;
    leaseOwner?: string;
    leaseUntil?: Date;
    cancelRequestedAt?: Date;
    dispatchGrantedAt?: Date;
    /** Prior durable phase retained when an overdue credit hold needs operator review. */
    accountingReview?: { reviewAt: string; overdueAt: string; previousPhase: MediaJob['phase'] };
  };
export type MediaStoredThread = Omit<MediaThread, 'createdAt' | 'updatedAt' | 'expiresAt'> &
  MediaOwnerScope & {
    createdAt: Date;
    updatedAt: Date;
    expiresAt?: Date;
    status: 'active' | 'retiring' | 'retired';
    retiredAt?: Date;
    epoch: number;
    originRequestId: string;
    nextTurnSequence: number;
    pendingTurnId?: string;
    /** Admission intents are bounded by the active-job capacity. */
    dispatchJobIds: string[];
    coverExplicit?: boolean;
    payloadPurgedAt?: Date;
    /** Paid title dispatch is one-shot: an ambiguous invocation is never retried automatically. */
    titleClaim?: { jobId: string; claimedAt: Date };
  };
export type MediaStoredTurn = Omit<MediaTurn, 'jobs' | 'assets' | 'createdAt'> &
  MediaOwnerScope & {
    updatedAt: Date;
    createdAt: Date;
    sequence?: number;
    threadEpoch: number;
    sourceJobId?: string;
    newThread: boolean;
    importRequest?: MediaImportRequest;
    importIdentityRequest?: MediaImportRequest;
    importReceipt?: MediaImportReceipt;
    clientRequestId?: string;
    fingerprint?: string;
    publicationPhase: 'preparing' | 'accepted' | 'rejected';
    publicationExpiresAt?: Date | null;
  };
export type StageMediaSubmissionInput = {
  scope: MediaOwnerScope;
  request: MediaSubmissionRequest;
  execution: MediaExecutionSnapshot;
  maxActiveJobs: number;
  maxPendingTotal: number;
  executionOwner?: 'media';
  /** Host-derived chat retention overrides the public request when provided. */
  temporary?: boolean;
  /** Resolved at admission; null explicitly preserves a permanent presentation across recovery. */
  publicationExpiresAt?: string | null;
};
export type MediaJobObservation = {
  phase: MediaJob['phase'];
  provider?: MediaProviderState;
  outputs?: MediaOutput[];
  error?: MediaJob['error'];
  dueAt?: Date | string;
  recoveryFailures?: number;
  /** Keep the lease while writing a provider response, or release it for polling. */
  releaseLease?: boolean;
};
export interface MediaBacklogMetrics {
  queued: number;
  requiresAttention: number;
  activePermits: number;
  activeJobs: number;
  oldestQueuedAgeSeconds: number;
  oldestExpiredLeaseSeconds: number;
  pendingAccountDeletions: number;
}
export type MediaRenditionContent = MediaRendition & {
  source: FileStorage;
  storageKey: string;
  storageRegion?: string;
  contentDigest: string;
};
export type MediaRenditionLocation = {
  kind: MediaRenditionKind;
  source: FileStorage;
  storageKey: string;
  storageRegion?: string;
  filepath?: string;
};
export type MediaAssetContent = MediaAsset & {
  source: string;
  storageKey?: string;
  storageRegion?: string;
  contentDigest: string;
  expiredAt?: string | null;
  hardExpiresAt?: string | null;
  mediaRenditions?: Partial<Record<MediaRenditionKind, MediaRenditionContent>>;
  mediaRenditionLocations?: MediaRenditionLocation[];
};
export type MediaAssetWrite = MediaOwnerScope & {
  writeId: string;
  outputKey: string;
  rendition: string;
  ingestToken: string;
  fileId: string;
  storageKey: string;
  source?: FileStorage;
  storageRegion?: string;
  filepath?: string;
  renditionLocations?: MediaRenditionLocation[];
  fingerprint: string;
  state: 'reserved' | 'committing' | 'published' | 'abandoned' | 'deleted';
  createdAt: Date;
  updatedAt: Date;
  asset?: MediaAsset;
  publicationContent?: MediaAssetContent;
  deletionToken?: string;
  deletionRetryAt?: Date;
  deletionAttempts?: number;
};
export type MediaSourceFile = Omit<MediaAssetContent, 'contentDigest'> & { sourceRevision: string };
export type MediaPermit = MediaOwnerScope & {
  permitId: string;
  capacityKey: string;
  kind: 'queue' | 'deployment' | 'integration' | 'owner';
  slot: number;
  jobId: string;
  jobIdentity: string;
  createdAt: Date;
};

export interface MediaMethods {
  assertMediaOwnerActive(scope: MediaOwnerScope): Promise<void>;
  getMediaBacklogMetrics(): Promise<MediaBacklogMetrics>;
  prepareMediaAccountDeletion(input: { scope: MediaOwnerScope; token: string }): Promise<boolean>;
  cancelMediaAccountDeletion(input: { scope: MediaOwnerScope; token: string }): Promise<void>;
  completeMediaAccountDeletion(input: { scope: MediaOwnerScope; token: string }): Promise<void>;
  reconcileMediaAccountDeletion(input: {
    scope: MediaOwnerScope;
    limit: number;
    retentionMs?: number;
  }): Promise<number>;
  activateMedia(): Promise<void>;
  hasMediaActivation(): Promise<boolean>;
  ensureMediaIndexes(): Promise<void>;
  stageMediaSubmission(input: StageMediaSubmissionInput): Promise<MediaSubmissionReceipt>;
  publishMediaSubmission(
    scope: MediaOwnerScope,
    jobId: string,
    options: MediaPublicationOptions,
  ): Promise<MediaSubmissionReceipt | null>;
  getMediaSubmission(
    scope: MediaOwnerScope,
    clientRequestId: string,
  ): Promise<MediaSubmissionReceipt | null>;
  stageMediaImport(input: {
    scope: MediaOwnerScope;
    request: MediaImportRequest;
    identityRequest?: MediaImportRequest;
    publicationExpiresAt?: string | null;
  }): Promise<MediaImportReceipt>;
  publishMediaImport(
    scope: MediaOwnerScope,
    turnId: string,
    options: MediaPublicationOptions,
  ): Promise<MediaImportReceipt | null>;
  getMediaImport(
    scope: MediaOwnerScope,
    clientRequestId: string,
  ): Promise<MediaImportReceipt | null>;
  getMediaThread(scope: MediaOwnerScope, threadId: string): Promise<MediaThread | null>;
  listMediaThreads(
    input: MediaPageInput & Pick<MediaThreadListRequest, 'filter' | 'include' | 'search'>,
  ): Promise<MediaPage<MediaThread>>;
  listMediaTurns(
    input: MediaPageInput & { threadId: string; jobsPerTurn: number },
  ): Promise<MediaPage<MediaTurn>>;
  getMediaLatestImageContext(input: {
    scope: MediaOwnerScope;
    threadId: string;
  }): Promise<MediaImageContext | null>;
  getMediaLatestVideoContext(input: {
    scope: MediaOwnerScope;
    threadId: string;
  }): Promise<MediaAssetContext | null>;
  listMediaTurnJobs(
    input: MediaPageInput & { turnId: string; threadId?: string },
  ): Promise<MediaPage<MediaJob>>;
  getMediaParentContext(
    scope: MediaOwnerScope,
    threadId: string,
    parentTurnId: string,
  ): Promise<MediaStoredJob | null>;
  getMediaJob(scope: MediaOwnerScope, jobId: string): Promise<MediaStoredJob | null>;
  getMediaJobView(scope: MediaOwnerScope, jobId: string): Promise<MediaJob | null>;
  getMediaJobDiagnostics(
    scope: MediaOwnerScope,
    jobId: string,
  ): Promise<MediaJobDiagnosticsResponse | null>;
  updateMediaThread(input: {
    scope: MediaOwnerScope;
    threadId: string;
    expectedVersion: number;
    title?: string;
    coverFileId?: string | null;
  }): Promise<MediaThread | null>;
  /** Swaps a prompt-derived title for a generated one only while the title is still unchanged. */
  replaceMediaThreadTitle(input: {
    scope: MediaOwnerScope;
    threadId: string;
    expectedTitle: string;
    title: string;
  }): Promise<boolean>;
  claimMediaJob(input: {
    scope: MediaOwnerScope;
    workerId: string;
    now: Date | string;
    leaseMs: number;
    takeoverSkewMs?: number;
  }): Promise<MediaStoredJob | null>;
  renewMediaJob(
    input: MediaJobFence & { now: Date | string; leaseMs: number },
  ): Promise<MediaStoredJob | null>;
  releaseMediaJobLease(
    input: Pick<MediaJobFence, 'scope' | 'jobId' | 'leaseToken'>,
  ): Promise<boolean>;
  beginMediaSubmission(input: MediaJobFence & { now: string }): Promise<MediaStoredJob | null>;
  recordMediaJobObservation(
    input: MediaJobFence & { observation: MediaJobObservation; now: string },
  ): Promise<MediaStoredJob | null>;
  cancelMediaJob(
    scope: MediaOwnerScope,
    jobId: string,
    providerApis?: MediaApi[],
  ): Promise<MediaJob | null>;
  retryMediaJob(input: {
    scope: MediaOwnerScope;
    jobId: string;
    clientRequestId: string;
    maxActiveJobs: number;
    maxPendingTotal: number;
    /** Replaces the failed job's execution snapshot; the original is copied when omitted. */
    execution?: MediaExecutionSnapshot;
  }): Promise<MediaSubmissionReceipt>;
  retireMediaThread(scope: MediaOwnerScope, threadId: string): Promise<boolean>;
  retireAllMediaThreads(scope: MediaOwnerScope): Promise<number>;
  /** Retires temporary threads whose `expiresAt` has passed; returns how many were retired. */
  retireExpiredMediaThreads(input: {
    scope: MediaOwnerScope;
    now: Date | string;
    limit: number;
  }): Promise<number>;
  /** Only call in an explicit system tenant context. Returns identities, never content. */
  listDueMediaScopes(input: {
    now: Date | string;
    limit: number;
    cursor?: string;
  }): Promise<MediaPage<MediaOwnerScope>>;
  recoverMediaPublications(
    input: { scope: MediaOwnerScope; limit: number } & MediaPublicationOptions,
  ): Promise<number>;
  reserveMediaAssetWrite(input: {
    scope: MediaOwnerScope;
    outputKey: string;
    rendition: string;
    ingestToken: string;
    fingerprint: string;
    storageKey: string;
    source?: FileStorage;
    storageRegion?: string;
    filepath?: string;
    renditionLocations?: MediaRenditionLocation[];
  }): Promise<MediaAssetWrite>;
  commitMediaAssetWrite(input: {
    scope: MediaOwnerScope;
    writeId: string;
    content: MediaAssetContent;
  }): Promise<MediaAsset>;
  recoverMediaAssetWrites(input: { scope: MediaOwnerScope; limit: number }): Promise<number>;
  listMediaAssetWritesForCleanup(input: {
    scope: MediaOwnerScope;
    limit: number;
    staleBefore: Date | string;
    now?: Date | string;
  }): Promise<MediaAssetWrite[]>;
  incrementMediaAssetWriteDeletionAttempts(input: {
    scope: MediaOwnerScope;
    writeId: string;
  }): Promise<number>;
  deferMediaAssetWriteCleanup(input: {
    scope: MediaOwnerScope;
    writeId: string;
    retryAt: Date | string;
  }): Promise<void>;
  claimMediaAssetWriteDeletion(input: {
    scope: MediaOwnerScope;
    writeId: string;
    token: string;
    staleBefore: Date | string;
  }): Promise<
    | (Pick<
        MediaAssetWrite,
        | 'writeId'
        | 'fileId'
        | 'storageKey'
        | 'source'
        | 'storageRegion'
        | 'filepath'
        | 'renditionLocations'
      > & { token: string })
    | null
  >;
  completeMediaAssetWriteDeletion(input: {
    scope: MediaOwnerScope;
    writeId: string;
    token: string;
  }): Promise<boolean>;
  getMediaAsset(scope: MediaOwnerScope, fileId: string): Promise<MediaAsset | null>;
  getAvailableMediaFileIds(input: {
    scope: MediaOwnerScope;
    fileIds: readonly string[];
  }): Promise<string[]>;
  getPublishedMediaAsset(input: {
    scope: MediaOwnerScope;
    outputKey: string;
    rendition: string;
  }): Promise<MediaAsset | null>;
  getMediaAssetContent(scope: MediaOwnerScope, fileId: string): Promise<MediaAssetContent | null>;
  getMediaSourceFile(scope: MediaOwnerScope, fileId: string): Promise<MediaSourceFile | null>;
  isMediaFile(scope: MediaOwnerScope, fileId: string): Promise<boolean>;
  retainMediaThreadAsset(input: {
    scope: MediaOwnerScope;
    threadId: string;
    fileId: string;
    maxRetainers: number;
  }): Promise<boolean>;
  retainMediaAsset(input: {
    scope: MediaOwnerScope;
    fileId: string;
    retainer: string;
    maxRetainers: number;
  }): Promise<boolean>;
  releaseMediaAsset(input: {
    scope: MediaOwnerScope;
    fileId: string;
    retainer: string;
  }): Promise<boolean>;
  claimMediaAssetDeletion(input: {
    scope: MediaOwnerScope;
    fileId: string;
    token: string;
  }): Promise<MediaAssetContent | null>;
  completeMediaAssetDeletion(input: {
    scope: MediaOwnerScope;
    fileId: string;
    token: string;
  }): Promise<boolean>;
  acquireMediaPermit(input: {
    scope: MediaOwnerScope;
    jobId: string;
    kind: MediaPermit['kind'];
    capacity: number;
    key?: string;
  }): Promise<boolean>;
  /** Acquires every permit in order; on any failure the permits this call inserted are removed. */
  acquireMediaPermits(input: {
    scope: MediaOwnerScope;
    jobId: string;
    permits: Array<{ kind: MediaPermit['kind']; capacity: number; key?: string }>;
  }): Promise<boolean>;
  releaseMediaPermits(input: {
    scope: MediaOwnerScope;
    jobId: string;
    kind?: MediaPermit['kind'];
  }): Promise<boolean>;
  reconcileMediaPermits(input: {
    limit: number;
    cursor?: string;
  }): Promise<{ inspected: number; nextCursor?: string }>;
  listMediaCleanupScopes(input: {
    limit: number;
    cursor?: string;
    now: Date | string;
  }): Promise<MediaPage<MediaOwnerScope>>;
  reconcileMediaRetirements(input: { scope: MediaOwnerScope; limit: number }): Promise<number>;
  /** Erases retired presentation payloads after provider/accounting and surviving consumers settle. */
  purgeMediaThreadPayloads(input: { scope: MediaOwnerScope; threadId: string }): Promise<boolean>;
  listMediaRetiringAssets(input: {
    scope: MediaOwnerScope;
    limit: number;
    now: Date | string;
  }): Promise<MediaSourceFile[]>;
}
