import { responseReference, isReservedTenantId, SYSTEM_TENANT_ID } from '@librechat/data-schemas';
import type { StoredResponseRecord } from '@librechat/data-schemas';
import type { GenerationJob } from '~/types/stream';

/** Legacy persisted tenantless rows use missing, null or empty values. */
export function responseTenantId(value: string | null | undefined): string | undefined {
  return value || undefined;
}

/** Internal partition sentinels never acquire response execution authority. */
export function isResponseTenantId(value: unknown): value is string | null | undefined {
  return (
    value == null ||
    (typeof value === 'string' && value !== SYSTEM_TENANT_ID && !isReservedTenantId(value))
  );
}

/** Same metadata-only physical binding in worker tokens, queue fingerprints and jobs. */
export function responseRootBinding(
  record: Pick<StoredResponseRecord, 'userId' | 'tenantId' | 'responseId' | 'storageTarget'>,
): { responseRootId: string; responseRootIncarnation: string } {
  const { target } = responseReference(record);
  return { responseRootId: target.id, responseRootIncarnation: target.incarnation };
}
export function matchesResponseRoot(
  record: Pick<StoredResponseRecord, 'storageTarget'>,
  binding: { responseRootId?: string; responseRootIncarnation?: string },
): boolean {
  return (
    !!record.storageTarget &&
    record.storageTarget.id === binding.responseRootId &&
    record.storageTarget.incarnation === binding.responseRootIncarnation
  );
}

/** Canonical ownership shared by recovery and terminal-proof import. */
export function matchesResponseJob(
  record: Pick<
    StoredResponseRecord,
    | 'storageTarget'
    | 'generationCreatedAt'
    | 'userId'
    | 'tenantId'
    | 'agentId'
    | 'conversationId'
    | 'responseId'
  >,
  job: Pick<GenerationJob, 'createdAt' | 'metadata'>,
): boolean {
  return (
    (record.generationCreatedAt == null || job.createdAt === record.generationCreatedAt) &&
    matchesResponseRoot(record, job.metadata) &&
    job.metadata.userId === record.userId &&
    responseTenantId(job.metadata.tenantId) === responseTenantId(record.tenantId) &&
    job.metadata.agent_id === record.agentId &&
    job.metadata.endpoint === 'responses' &&
    job.metadata.responseMessageId === record.responseId &&
    job.metadata.conversationId === record.conversationId
  );
}
