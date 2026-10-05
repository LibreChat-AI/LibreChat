import type { MediaExecutionSnapshot, MediaOwnerScope, MediaStoredJob } from './media';

export type MediaNativeLimits = NonNullable<MediaStoredJob['nativeLimits']>;
export type MediaNativePart =
  | { kind: 'text'; text: string; thoughtSignature?: string }
  | { kind: 'image'; mimeType: string; fileId: string; thoughtSignature?: string };
export type MediaNativePartRecord = MediaOwnerScope & {
  continuationRef: string;
  jobId: string;
  chunkIndex: number;
  partIndex: number;
  fingerprint: string;
  part: MediaNativePart;
  fileId?: string;
  createdAt: string;
  expiresAt?: string;
};
/** Stored shape: the expiry is a Date so the collection's TTL index can act on it. */
export type MediaNativePartDocument = Omit<MediaNativePartRecord, 'expiresAt' | 'createdAt'> & {
  expiresAt?: Date;
  createdAt: Date;
};
export type MediaNativeReference = { continuationRef?: string; fileId?: string };
export type MediaNativeExecution = Pick<
  MediaExecutionSnapshot,
  'api' | 'modelId' | 'bindingRevision'
>;

export interface MediaNativeMethods {
  ensureMediaNativeIndexes(): Promise<void>;
  failMediaNativeRecording(input: {
    scope: MediaOwnerScope;
    jobId: string;
    reason: 'aborted' | 'provider' | 'storage';
    resolutionId?: string;
  }): Promise<MediaStoredJob | null>;
  reconcileMediaNativeRecordings(input: {
    scope: MediaOwnerScope;
    now: string;
    staleBefore: string;
    limit: number;
  }): Promise<number>;
  getMediaNativeContinuations(input: {
    scope: MediaOwnerScope;
    references: readonly MediaNativeReference[];
    execution: MediaNativeExecution;
    conversationId?: string;
    limit: number;
  }): Promise<Array<MediaNativePartRecord | null>>;
  retainMediaNativeConversation(input: {
    scope: MediaOwnerScope;
    conversationId: string;
    continuationRefs: readonly string[];
    maxRetainers: number;
    limit: number;
    pendingUntil?: string;
  }): Promise<boolean>;
  confirmMediaNativeConversation(input: {
    scope: MediaOwnerScope;
    conversationId: string;
  }): Promise<void>;
  detachMediaNativeConversation(input: {
    scope: MediaOwnerScope;
    conversationId: string;
    continuationRefs: readonly string[];
  }): Promise<void>;
  reconcileMediaNativeMessageDeletion(input: {
    scope: MediaOwnerScope;
    conversationId: string;
  }): Promise<void>;
  releaseMediaNativeConversation(input: {
    scope: MediaOwnerScope;
    conversationId: string;
    maxRetainers: number;
  }): Promise<void>;
  reconcileMediaNativeConsumers(input: {
    scope: MediaOwnerScope;
    threadId?: string;
    maxRetainers: number;
    limit: number;
  }): Promise<number>;
}
