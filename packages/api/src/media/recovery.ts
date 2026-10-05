import type {
  MediaStoredJob,
  MediaOwnerScope,
  MediaRecoveryMethods,
  MediaRecoveryRecord,
  MediaNativeMethods,
  AuditOutcome,
} from '@librechat/data-schemas';
import type {
  MediaConfig,
  MediaIntegration,
  MediaRecoveryJob,
  MediaRecoveryRequest,
  MediaRecoveryPage,
} from 'librechat-data-provider';
import type { MediaServiceDependencies } from './service';
import type { MediaProviderUsage } from './provider';
import { isMediaConnectionBinding } from './provider';
import { assertMediaAccess } from './service';
import { MediaServiceError } from './errors';

export function resolveMediaJobIntegration(
  job: MediaStoredJob,
  config: MediaConfig,
): MediaIntegration | undefined {
  return (
    config.integrations.find((entry) => entry.id === job.execution.connectionId) ??
    (job.provider.certainty !== 'unsubmitted' && job.execution.endpointRef
      ? {
          id: job.execution.connectionId,
          api: job.execution.api,
          endpointRef: job.execution.endpointRef,
          catalog: { kind: 'configured', models: [job.execution.modelId] },
          operations: [job.operation],
          billing: job.execution.billing,
        }
      : undefined)
  );
}

/** An explicit settlement decision overrides the original no-charge submission rejection. */
export function hasRejectedMediaSubmission(job: MediaStoredJob): boolean {
  return (
    job.executionOwner === 'media' &&
    job.provider.certainty === 'terminal' &&
    job.provider.recovery?.rejectedSubmission === true &&
    !job.recoveryDecisions?.some((decision) => decision.request.action === 'settle')
  );
}

/** A confirmed final cost can settle without reacquiring a provider credential or invoking its API. */
export function getMediaTerminalRecovery(
  job: MediaStoredJob,
): { status: 'failed' | 'cancelled'; usage: MediaProviderUsage } | undefined {
  if (job.executionOwner !== 'media') return;
  const decision = job.recoveryDecisions?.[job.recoveryDecisions.length - 1]?.request;
  if (decision?.action === 'settle') {
    return {
      status: decision.terminalStatus,
      usage: { ...job.provider.recovery?.usage, costUSD: decision.costUSD },
    };
  }
  const recovery = job.provider.recovery;
  if (
    job.provider.certainty === 'terminal' &&
    (recovery?.terminalStatus === 'failed' || recovery?.terminalStatus === 'cancelled') &&
    recovery.usage?.costUSD !== undefined
  ) {
    return { status: recovery.terminalStatus, usage: recovery.usage };
  }
}

/** Completed output observations can finish locally without restoring a revoked provider key. */
function hasPublishedCompletion(job: MediaStoredJob): boolean {
  const recovery = job.provider.recovery;
  return (
    job.provider.certainty === 'terminal' &&
    recovery?.terminalStatus === 'completed' &&
    recovery.parts !== undefined &&
    recovery.parts.length > 0 &&
    recovery.parts.every(
      (part) =>
        part.kind === 'text' ||
        (!!part.fileId &&
          job.outputs.some(
            (output) =>
              output.kind === part.kind &&
              output.ordinal === part.ordinal &&
              output.state === 'ready' &&
              output.asset?.file_id === part.fileId,
          )),
    )
  );
}

export function createMediaRecoveryServices(
  deps: MediaServiceDependencies,
  repository: MediaRecoveryMethods & Pick<MediaNativeMethods, 'failMediaNativeRecording'>,
  config: MediaConfig,
): MediaRecoveryServices {
  const adapters = new Map(deps.adapters.map((adapter) => [adapter.api, adapter]));
  function view(job: MediaRecoveryRecord | MediaStoredJob): MediaRecoveryJob {
    const attention = job.phase === 'requires_attention';
    const terminalRecovery =
      'hasTerminalRecovery' in job
        ? job.hasTerminalRecovery
        : !!(job.provider.certainty === 'terminal' && job.provider.recovery);
    return {
      ownerId: job.ownerId,
      jobId: job.jobId,
      threadId: job.threadId,
      version: job.version,
      phase: job.phase,
      executionOwner: job.executionOwner,
      operation: job.operation,
      selection: job.selection,
      createdAt: job.createdAt.toISOString(),
      updatedAt: job.updatedAt.toISOString(),
      ...(job.error ? { errorCode: job.error.code } : {}),
      provider: {
        certainty: job.provider.certainty,
        ...(job.provider.operationId ? { operationId: job.provider.operationId } : {}),
        ...(job.provider.requestId ? { requestId: job.provider.requestId } : {}),
      },
      accounting: {
        mode: job.execution.accountingMode ?? (job.execution.billing ? 'balance' : 'none'),
        ...(job.accounting ? { phase: job.accounting.phase, credits: job.accounting.credits } : {}),
      },
      allowedActions: {
        resume:
          attention &&
          job.executionOwner === 'media' &&
          (job.provider.certainty === 'unsubmitted' ||
            !!(job.provider.operationId && adapters.get(job.execution.api)?.poll) ||
            terminalRecovery),
        settle: attention && job.executionOwner === 'media' && job.accounting?.phase !== 'settled',
        acknowledge: attention && job.executionOwner === 'chat',
      },
    };
  }
  return {
    async list(input: {
      tenantId: string | null;
      limit?: number;
      cursor?: string;
    }): Promise<MediaRecoveryPage> {
      const page = await repository.listMediaRecoveryJobs({
        ...input,
        limit: Math.min(input.limit ?? config.limits.pageSize, config.limits.maxPageSize),
      });
      return {
        items: page.items.map(view),
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
        maxEvidenceChars: config.recovery.maxEvidenceChars,
      };
    },
    async resolve(input: {
      scope: MediaOwnerScope;
      jobId: string;
      actorId: string;
      request: MediaRecoveryRequest;
      audit(outcome: AuditOutcome, errorCode?: string): Promise<void>;
    }): Promise<MediaRecoveryJob> {
      const job = await deps.repository.getMediaJob(input.scope, input.jobId);
      if (!job) throw new MediaServiceError('not_found', 404, 'The media job is unavailable.');
      const replay = job.recoveryDecisions?.some(
        (decision) => decision.request.clientRequestId === input.request.clientRequestId,
      );
      if (!replay) {
        if (input.request.evidence.length > config.recovery.maxEvidenceChars)
          throw new MediaServiceError(
            'invalid_request',
            422,
            'Recovery evidence exceeds its configured limit.',
          );
        if (job.phase !== 'requires_attention' || job.version !== input.request.expectedVersion)
          throw new MediaServiceError('version_conflict', 409, 'The media job changed.');
        if (!view(job).allowedActions[input.request.action])
          throw new MediaServiceError('not_ready', 409, 'This recovery action is unavailable.');
        if (
          input.request.action === 'settle' &&
          job.execution.billing?.creditsPerUSD !== undefined
        ) {
          const credits = input.request.costUSD * job.execution.billing.creditsPerUSD;
          if (
            !Number.isFinite(credits) ||
            credits > Number.MAX_SAFE_INTEGER ||
            (input.request.costUSD > 0 && credits === 0)
          )
            throw new MediaServiceError(
              'invalid_request',
              422,
              'Final media cost exceeds the supported credit range.',
            );
        }
        if (
          input.request.action === 'resume' &&
          !hasRejectedMediaSubmission(job) &&
          !getMediaTerminalRecovery(job) &&
          !hasPublishedCompletion(job)
        ) {
          const context = await deps.loadContext(input.scope);
          if (job.provider.certainty === 'unsubmitted') assertMediaAccess(context, true);
          const integration = resolveMediaJobIntegration(job, context.config);
          if (
            !integration ||
            (job.provider.certainty === 'unsubmitted' && integration.enabled === false)
          )
            throw new MediaServiceError(
              'not_ready',
              409,
              'The original media integration is unavailable.',
            );
          const connection = await deps.resolveConnection({
            scope: input.scope,
            integration,
            appConfig: context.appConfig,
            minValidityMs: context.config.credentials.minValidityAtDispatchMs,
            user: context.user,
          });
          if (!isMediaConnectionBinding(connection, job.execution.bindingRevision))
            throw new MediaServiceError(
              'credentials_required',
              409,
              'The original credential binding must be restored.',
            );
        }
        await input.audit('pending');
      }
      try {
        let resolved = await repository.resolveMediaRecovery({
          ...input,
          maxEvidenceChars: config.recovery.maxEvidenceChars,
          maxDecisions: config.recovery.maxDecisionsPerJob,
          now: new Date(deps.now()).toISOString(),
        });
        if (input.request.action === 'acknowledge') {
          resolved =
            (await repository.failMediaNativeRecording({
              scope: input.scope,
              jobId: input.jobId,
              reason: 'provider',
              resolutionId: input.request.clientRequestId,
            })) ?? resolved;
        }
        await input.audit('success');
        return view(resolved);
      } catch (error) {
        try {
          await input.audit(
            'failure',
            error instanceof MediaServiceError ? error.code : 'recovery_failed',
          );
        } catch (auditError) {
          deps.log(
            '[media] Recovery failure audit could not be recorded.',
            auditError instanceof Error ? auditError : undefined,
          );
        }
        throw error;
      }
    },
  };
}
export interface MediaRecoveryServices {
  list(input: {
    tenantId: string | null;
    limit?: number;
    cursor?: string;
  }): Promise<MediaRecoveryPage>;
  resolve(input: {
    scope: MediaOwnerScope;
    jobId: string;
    actorId: string;
    request: MediaRecoveryRequest;
    audit(outcome: AuditOutcome, errorCode?: string): Promise<void>;
  }): Promise<MediaRecoveryJob>;
}
