import { Document, Types } from 'mongoose';
import type {
  CodeEnvRef,
  CodeEnvRefMap,
  FileContext,
  RunFileProvenance,
  TFile,
} from 'librechat-data-provider';

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
  object: 'file';
  embedded?: boolean;
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
    /** The user named this destination, so absent ones were declined. */
    destinationChosen?: boolean;
    /** The type the delivery route was resolved against, when conversion changed it. */
    routingMimeType?: string;
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
