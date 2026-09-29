import { FileContext, FileSources } from 'librechat-data-provider';
import type {
  RunArtifactFile,
  RunArtifactClaim,
  RunArtifactScope,
  RunArtifactContent,
  CodeFileCommitData,
  PublishRunArtifactInput,
} from '@librechat/data-schemas';
import type { RunFileProvenance, TFile } from 'librechat-data-provider';
import type { CodeExecutionContext } from '~/agents/execution';

export type CodeOutputStoredFile = CodeFileCommitData;

export type CodeOutputDownloadFallback = Pick<TFile, 'filename' | 'filepath' | 'conversationId'> & {
  expiresAt: number;
  messageId?: string;
  toolCallId?: string;
  agentId?: string;
};

interface CodeOutputClaimInput {
  filename: string;
  conversationId: string;
  file_id: string;
  user: string;
  tenantId?: string | null;
  sourceDispatchedAt?: number;
}

interface CodeOutputClaim {
  file_id: string;
  usage?: number;
  messageId?: string;
  createdAt?: Date | string;
  updatedAt?: Date | string;
  metadata?: TFile['metadata'];
}

export interface CodeOutputPublication {
  scope: RunArtifactScope;
  provenance: RunFileProvenance;
  publish: (input: PublishRunArtifactInput) => Promise<RunArtifactFile>;
  find: (scope: RunArtifactScope) => Promise<RunArtifactFile | null>;
  discard: (file: TFile) => Promise<void>;
  /** Includes the shared run lifetime as well as request cancellation. */
  signal?: AbortSignal;
  /** Attempt-local ownership notifications; no database row exists for this object yet. */
  trackStored?: (file: TFile) => void;
  releaseStored?: (file: TFile) => void;
}

export interface CodeOutputPersistence {
  context: FileContext;
  claim: (input: CodeOutputClaimInput) => Promise<CodeOutputClaim>;
  commit: (file: CodeOutputStoredFile) => Promise<boolean>;
  trackStored: (file: CodeOutputStoredFile) => void;
  finalize: <T>(
    file: CodeOutputStoredFile,
    finalize: () => Promise<T>,
  ) => (() => Promise<T>) | undefined;
}

function artifactContent(file: CodeOutputStoredFile): RunArtifactContent {
  return {
    ...file,
    text: file.text ?? undefined,
    status: file.status ?? undefined,
    previewError: file.previewError ?? undefined,
    previewRevision: file.previewRevision ?? undefined,
  };
}

function storedObject(file: CodeOutputStoredFile): TFile {
  return {
    ...artifactContent(file),
    file_id: file.file_id,
    user: file.user,
    tenantId: file.tenantId,
    object: 'file',
    embedded: false,
    usage: 0,
    metadata: undefined,
  };
}

function sameStoredObject(left: CodeOutputStoredFile, right: RunArtifactFile): boolean {
  return (
    left.source === right.source &&
    (left.storageKey ?? left.filepath) === (right.storageKey ?? right.filepath)
  );
}

/** Reuses code-output storage while giving every publication attempt a separate object key. */
export function createCodeOutputPersistence({
  publication,
  claim,
  commit,
}: {
  publication?: CodeOutputPublication;
  claim: (input: CodeOutputClaimInput) => Promise<CodeOutputClaim>;
  commit: (file: CodeOutputStoredFile) => Promise<boolean>;
}): CodeOutputPersistence {
  if (publication == null) {
    return {
      context: FileContext.execute_code,
      claim,
      commit,
      trackStored: () => undefined,
      finalize: (_file, finalize) => finalize,
    };
  }
  const ownedFiles = new WeakSet<CodeOutputStoredFile>();
  const discardAttempt = async (file: CodeOutputStoredFile): Promise<void> => {
    const stored = storedObject(file);
    await publication.discard(stored);
    publication.releaseStored?.(stored);
  };
  return {
    context: FileContext.run_artifact,
    trackStored: (file) => publication.trackStored?.(storedObject(file)),
    claim: async (input) => {
      publication.signal?.throwIfAborted();
      if (
        input.user !== publication.scope.userId ||
        (input.tenantId ?? null) !== (publication.scope.tenantId ?? null) ||
        input.conversationId !== publication.scope.conversationId
      ) {
        throw new Error('The generated file does not match its publication owner');
      }
      return { file_id: input.file_id };
    },
    commit: async (file) => {
      if (
        file.user !== publication.scope.userId ||
        (file.tenantId ?? null) !== (publication.scope.tenantId ?? null) ||
        file.conversationId !== publication.scope.conversationId
      ) {
        throw new Error('The generated file does not match its publication owner');
      }
      // Storage writes finish before the processor hands us the complete record.
      // Cancellation at that boundary must remove the uncommitted attempt object.
      if (publication.signal?.aborted) {
        await discardAttempt(file);
        publication.signal.throwIfAborted();
      }
      let published: RunArtifactFile;
      try {
        published = await publication.publish({
          scope: publication.scope,
          provenance: publication.provenance,
          file: artifactContent(file),
        });
      } catch (error) {
        let recovered: RunArtifactFile | null;
        try {
          recovered = await publication.find(publication.scope);
        } catch (readError) {
          // The write may have committed. Deleting its bytes while the database
          // cannot answer would corrupt a durable publication.
          publication.releaseStored?.(storedObject(file));
          throw readError;
        }
        if (recovered == null) {
          await discardAttempt(file);
          throw error;
        }
        published = recovered;
      }
      if (sameStoredObject(file, published)) {
        ownedFiles.add(file);
        publication.releaseStored?.(storedObject(file));
      } else {
        await discardAttempt(file);
      }
      Object.assign(file, published);
      return true;
    },
    finalize: (file, finalize) => (ownedFiles.has(file) ? finalize : undefined),
  };
}

export interface RunArtifactDescriptor {
  id: string;
  name: string;
  sessionId: string;
  /** Opaque host-owned copy; never an agent-supplied filesystem path. */
  snapshotId?: string;
  codeExecutionContext?: Pick<
    CodeExecutionContext,
    'baseUrl' | 'executionProfile' | 'executionRouteKey' | 'bridgeWorkerId'
  >;
}

export interface ProcessPublishedCodeOutputInput {
  id: string;
  name: string;
  session_id: string;
  conversationId: string;
  messageId: string;
  agentId: string;
  publication: CodeOutputPublication;
  preparedBuffer?: Buffer;
  codeApiBaseUrl?: string;
  executionProfile?: CodeExecutionContext['executionProfile'];
  executionRouteKey?: string;
  bridgeWorkerId?: string;
}

export interface CodeOutputResult {
  file: CodeOutputStoredFile | CodeOutputDownloadFallback | null;
  finalize?: () => Promise<CodeOutputStoredFile | null>;
  previewRevision?: string;
}

export interface PublishedCodeOutputResult extends CodeOutputResult {
  file: CodeOutputStoredFile;
}

export interface PublishGeneratedRunArtifactInput {
  scope: RunArtifactScope;
  provenance: RunFileProvenance;
  artifact: RunArtifactDescriptor;
  signal?: AbortSignal;
}

export function createRunArtifactPublisher({
  claimRunArtifactFile,
  publishRunArtifactFile,
  findRunArtifactFile,
  processCodeOutput,
  prepare,
  discard,
  finalize,
}: {
  claimRunArtifactFile: (scope: RunArtifactScope) => Promise<RunArtifactClaim>;
  publishRunArtifactFile: CodeOutputPublication['publish'];
  findRunArtifactFile: CodeOutputPublication['find'];
  processCodeOutput: (input: ProcessPublishedCodeOutputInput) => Promise<CodeOutputResult | null>;
  prepare: (artifact: RunArtifactDescriptor, signal?: AbortSignal) => Promise<Buffer>;
  discard: CodeOutputPublication['discard'];
  finalize: (result: PublishedCodeOutputResult) => void;
}): (input: PublishGeneratedRunArtifactInput) => Promise<RunArtifactFile> {
  return async ({ scope, provenance, artifact, signal }) => {
    signal?.throwIfAborted();
    if (
      provenance.sourceFileId !== scope.sourceFileId ||
      provenance.runId !== scope.runId ||
      provenance.executionId !== scope.executionId ||
      provenance.agentId !== scope.agentId ||
      artifact.sessionId.trim().length === 0
    ) {
      throw new Error('The generated artifact does not match its publication identity');
    }
    const existing = await claimRunArtifactFile(scope);
    signal?.throwIfAborted();
    if (existing.file != null) {
      return existing.file;
    }
    const preparedBuffer = await prepare(artifact, signal);
    signal?.throwIfAborted();
    const publicationResult: { file: RunArtifactFile | null } = { file: null };
    const pendingObjects = new Map<string, TFile>();
    const objectKey = (file: TFile): string =>
      JSON.stringify([file.source, file.storageKey ?? file.filepath]);
    try {
      const result = await processCodeOutput({
        id: artifact.id,
        name: artifact.name,
        session_id: artifact.sessionId,
        conversationId: scope.conversationId,
        messageId: scope.runId,
        agentId: scope.agentId,
        preparedBuffer,
        codeApiBaseUrl: artifact.codeExecutionContext?.baseUrl,
        executionProfile: artifact.codeExecutionContext?.executionProfile,
        executionRouteKey: artifact.codeExecutionContext?.executionRouteKey,
        bridgeWorkerId: artifact.codeExecutionContext?.bridgeWorkerId,
        publication: {
          scope,
          provenance,
          signal,
          trackStored: (file) => pendingObjects.set(objectKey(file), file),
          releaseStored: (file) => pendingObjects.delete(objectKey(file)),
          publish: async (input) => {
            signal?.throwIfAborted();
            const file = await publishRunArtifactFile(input);
            publicationResult.file = file;
            pendingObjects.delete(objectKey(file));
            return file;
          },
          find: async (identity) => {
            const file = await findRunArtifactFile(identity);
            publicationResult.file = file;
            if (file != null) pendingObjects.delete(objectKey(file));
            return file;
          },
          discard,
        },
      });
      const file = result?.file;
      if (
        file == null ||
        !('file_id' in file) ||
        file.context !== FileContext.run_artifact ||
        file.source === FileSources.execute_code
      ) {
        signal?.throwIfAborted();
        throw new Error('The generated artifact could not be published to durable storage');
      }
      const published = publicationResult.file;
      if (published == null || published.file_id !== file.file_id) {
        throw new Error('The generated artifact publication could not be verified');
      }
      // Complete previews for a record that committed before cancellation; emitting
      // the attachment still waits for the cancellation check below.
      finalize({ ...result, file });
      signal?.throwIfAborted();
      return published;
    } finally {
      // The legacy processor can fail after saving bytes but before it constructs
      // its complete metadata. Its storage notifications make those failures owned
      // by this attempt, while committed or uncertain objects were released above.
      await Promise.all([...pendingObjects.values()].map((file) => discard(file)));
    }
  };
}
