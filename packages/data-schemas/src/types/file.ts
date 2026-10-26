import { Document, Types } from 'mongoose';
import type {
  CodeEnvRef,
  CodeEnvRefMap,
  FileContext,
  RunFileProvenance,
  TFile,
  TFileWorkspaceImports,
} from 'librechat-data-provider';

export type FileStorageScope = {
  file_id: string;
  userId: string;
  tenantId?: string | null;
};

export type FileStorageClaim = FileStorageScope & {
  token: string;
};

export type FileProvisionCommit = {
  claim: FileStorageClaim;
  code?: { routeKey: string; ref: CodeEnvRef; legacyRef?: CodeEnvRef };
  entityId?: string;
  embedded?: boolean;
  output?: { file: CodeFileCommitData; sourceDispatchedAt?: number };
  releaseOnly?: boolean;
};

export type FileStorageDeleteClaim = FileStorageClaim & {
  updatedAt?: Date | string;
};

/** Content snapshot whose primary and secondary storage cleanup must agree. */
export type FileStorageCleanupParams = {
  file_id: string;
  userId: string;
  tenantId?: string | null;
  updatedAt?: Date | string;
  source?: string;
  embedded?: boolean;
  embeddedEntities?: string[];
  /** Authorized provider-only assistant files have no persisted local snapshot. */
  allowMissingFileRecord?: boolean;
};

export type FileDeletionSnapshot = Omit<FileStorageCleanupParams, 'userId' | 'embeddedEntities'> & {
  user?: { toString(): string };
  metadata?: { embeddedEntities?: string[] };
};

export type DeleteFilesResult = {
  deletedCount?: number;
  deletedFileIds?: string[];
  failedFileIds?: string[];
};

export type DeleteFilesOptions = {
  files: FileDeletionSnapshot[];
  userId: string;
};

export type ClearFileCodeEnvRefsParams = {
  file_id: string;
  userId: string;
  tenantId?: string;
  refs: Array<{ routeKey: string; ref: CodeEnvRef }>;
};

export type RunArtifactRunScope = {
  userId: string;
  tenantId?: string | null;
  conversationId: string;
  runId: string;
};

export type RunArtifactScope = RunArtifactRunScope & {
  executionId: string;
  agentId: string;
  sourceFileId: string;
};

export type RunArtifactFile = TFile & {
  conversationId: string;
  messageId?: string;
  expiredAt?: Date | null;
  previewRevision?: string;
  metadata: NonNullable<TFile['metadata']> & { runFile: RunFileProvenance };
};

export type RunArtifactContent = Pick<
  TFile,
  | 'filename'
  | 'filepath'
  | 'bytes'
  | 'type'
  | 'source'
  | 'storageKey'
  | 'storageRegion'
  | 'text'
  | 'textFormat'
  | 'width'
  | 'height'
  | 'status'
  | 'previewError'
  | 'llmDeliveryPath'
> & {
  messageId?: string;
  expiredAt?: Date | null;
  previewRevision?: string;
  metadata?: Omit<NonNullable<TFile['metadata']>, 'runFile'>;
};

export type CodeFileCommitData = Omit<
  RunArtifactContent,
  'text' | 'status' | 'previewError' | 'previewRevision'
> & {
  file_id: string;
  user: string;
  tenantId?: string;
  conversationId?: string;
  context?: FileContext;
  object?: 'file';
  embedded?: boolean;
  usage?: number;
  text?: string | null;
  status?: TFile['status'] | null;
  previewError?: string | null;
  previewRevision?: string | null;
  createdAt?: Date | string;
  updatedAt?: Date | string;
};

export type PublishRunArtifactInput = {
  scope: RunArtifactScope;
  file: RunArtifactContent;
  provenance: RunFileProvenance;
};

export type RunArtifactClaim = {
  file_id: string;
  file?: RunArtifactFile;
};

export interface IMongoFile extends Omit<Document, 'model'> {
  user: Types.ObjectId;
  conversationId?: string;
  messageId?: string;
  file_id: string;
  temp_file_id?: string;
  bytes: number;
  text?: string;
  /**
   * Format of the `text` field — `'html'` when the backend produced
   * a sanitized full-document HTML preview (e.g. office types via
   * `bufferToOfficeHtml`), `'text'` for plain-text extracts (e.g.
   * RAG mammoth/pdf-parse output), `undefined` for legacy records
   * that pre-date the field. Clients MUST treat `undefined` as
   * `'text'` and refuse to inject the value into HTML contexts —
   * otherwise plain document text containing `<script>` tags would
   * become executable markup. See Codex P1 review on PR #12934.
   */
  textFormat?: 'html' | 'text';
  /**
   * Lifecycle of the inline preview rendered from `text`. Tracks the
   * deferred-preview code-execution flow (PR #12951 follow-up): the
   * immediate persist step saves the file blob and emits the attachment
   * record with `status: 'pending'`; a background render runs HTML
   * extraction and updates the record to `'ready'` (with `text` +
   * `textFormat`) or `'failed'` (with `previewError`). Decouples the
   * agent's final response from CPU-heavy office-format rendering.
   *
   * Absent for legacy records and for files that never expect a preview
   * (RAG uploads, images, plain-text artifacts). Clients MUST treat
   * `undefined` as `'ready'` so prior-version records render normally.
   */
  status?: 'pending' | 'ready' | 'failed';
  /**
   * Short machine-readable reason when `status === 'failed'` —
   * `'timeout'`, `'parser-error'`, `'oversized'`, `'orphaned'`. UI hint
   * for tooltip text; not user-facing prose. Absent otherwise.
   */
  previewError?: string;
  /**
   * Generation marker for the deferred-preview lifecycle. The
   * immediate persist step stamps a fresh UUID on every emit; the
   * deferred render's update only commits when the marker still
   * matches. Guards against an older render overwriting a newer
   * record on cross-turn filename reuse. Absent for legacy records
   * and for files that never expect a preview.
   */
  previewRevision?: string;
  filename: string;
  filepath: string;
  storageKey?: string;
  storageRegion?: string;
  storageOperations?: {
    provisioning?: string[];
    deleting?: string;
    deletionPending?: boolean;
  };
  object: 'file';
  embedded?: boolean;
  /** Absent on legacy records, including partially adopted namespace lists. */
  embeddingOwnersComplete?: boolean;
  embeddingOwnersTrackedAt?: Date;
  type: string;
  context?: string;
  usage: number;
  source: string;
  model?: string;
  width?: number;
  height?: number;
  metadata?: {
    runFile?: RunFileProvenance;
    /**
     * Code-environment cache pointer for files re-uploadable to
     * codeapi (chat attachments, agent tool resources, code-output
     * files). Carries the resource kind + identity so codeapi can
     * derive the sessionKey explicitly.
     */
    codeEnvRef?: CodeEnvRef;
    codeEnvRefs?: CodeEnvRefMap;
    /** Dispatch-order stamp for the current source artifact generation. */
    sourceDispatchedAt?: number;
    /** Vector namespaces this file has been embedded into. */
    embeddedEntities?: string[];
    /** Code remains a destination even after its remote pointers are cleared. */
    codeDestination?: boolean;
    /** Search remains a destination even after its vectors are cleared. */
    searchDestination?: boolean;
    /** The user named this destination, so absent ones were declined. */
    destinationChosen?: boolean;
    /** The type the delivery route was resolved against, when conversion changed it. */
    routingMimeType?: string;
    /** Copies placed in attached workspaces. */
    workspaceImports?: TFileWorkspaceImports;
  };
  /** Upload-time inference, not a durable contract. See the schema field for why. */
  llmDeliveryPath?: string;
  expiresAt?: Date;
  expiredAt?: Date | null;
  /**
   * Consecutive failed retention-sweep deletions. The sweep backs off
   * between attempts and parks the file once this reaches the configured
   * cap, so a file whose backing storage refuses deletion cannot occupy
   * the sweep's bounded queue. Absent until the first failure.
   */
  deletionAttempts?: number;
  /**
   * Earliest time the retention sweep may retry this file, and the only
   * thing holding it back. Set alongside `deletionAttempts` on every
   * failure; absent until the first one.
   */
  deletionRetryAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
  tenantId?: string;
}
