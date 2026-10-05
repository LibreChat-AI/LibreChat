import type { MediaRecoveryRequest } from 'librechat-data-provider';
import type { MediaOwnerScope, MediaPage, MediaStoredJob, MediaProviderState } from './media';

export type { MediaRecoveryDecision } from './media';
export type MediaRecoveryRecord = Pick<
  MediaStoredJob,
  | 'ownerId'
  | 'tenantId'
  | 'jobId'
  | 'threadId'
  | 'version'
  | 'phase'
  | 'executionOwner'
  | 'operation'
  | 'selection'
  | 'createdAt'
  | 'updatedAt'
  | 'error'
  | 'execution'
  | 'accounting'
> & {
  provider: Pick<MediaProviderState, 'certainty' | 'operationId' | 'requestId'>;
  hasTerminalRecovery: boolean;
};
export interface MediaRecoveryMethods {
  listMediaRecoveryJobs(input: {
    tenantId: string | null;
    limit: number;
    cursor?: string;
  }): Promise<MediaPage<MediaRecoveryRecord>>;
  resolveMediaRecovery(input: {
    scope: MediaOwnerScope;
    jobId: string;
    actorId: string;
    request: MediaRecoveryRequest;
    maxEvidenceChars: number;
    maxDecisions: number;
    now: string;
  }): Promise<MediaStoredJob>;
}
