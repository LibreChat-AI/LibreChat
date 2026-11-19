import type { ScheduledMCPIdentity } from 'librechat-data-provider';
import type { RequestScopedMCPConnectionStore } from '~/mcp/types';
import type { ExecutionContext } from '~/agents/authority/context';
import type { ScheduleMCPCompletionLookup } from './continuation';
import type { ScheduleMCPExecutionFactory } from './execution';
import type { ScheduleMCPEnrollmentDeps } from './enrollment';
import {
  isScheduledMCPCompletionRequest,
  resolveScheduleMCPCompletion,
  parseScheduleMCPCompletion,
} from './continuation';
import {
  createScheduleMCPExecution,
  scheduledMCPIdentity,
  getScheduleMCPExecution,
} from './execution';
import { getScheduleSource, toScheduledTokenContext } from '~/agents/authority/context';
import { readScheduleFireContext, isScheduleFireRequest } from '../trigger';
import { createScheduleMCPConsentHost, createMCPUseCheck } from './host';
import { getAppConfigOptionsFromUser } from '~/app/service';
import { createScheduleLimitsResolver } from '../service';
import { createScheduleMCPOffer } from './enrollment';
import { isOwnedAbortError } from '~/utils/errors';
import { ScheduledMCPPolicyError } from './policy';

type RuntimeRequest = Parameters<typeof readScheduleFireContext>[0] & {
  user: { id: string; tenantId?: string };
};

export function createScheduleMCPRuntimeHost(
  deps: Omit<
    Parameters<typeof createScheduleMCPConsentHost>[0],
    'resolveEnrollment' | 'resolveTools' | 'resolveServers' | 'getLimits'
  > & {
    enrollment: ScheduleMCPEnrollmentDeps;
    getScheduleMCPCompletionState?: ScheduleMCPCompletionLookup;
  },
): {
  consent: ReturnType<typeof createScheduleMCPConsentHost>;
  execution: ScheduleMCPExecutionFactory;
  prepare: (input: {
    req: RuntimeRequest;
    signal?: AbortSignal;
    context?: RequestScopedMCPConnectionStore;
    executionContext?: ExecutionContext;
    restoredJob?: {
      scheduleId?: string;
      scheduleManual?: boolean;
      scheduleMCPCompletion?: ScheduledMCPIdentity;
    };
    /** Tool calls the owner approved in the request that resumes this run. */
    approvedToolCalls?: readonly string[];
  }) => Promise<void>;
} {
  function createEvaluation(enrollment: ScheduleMCPEnrollmentDeps) {
    const offer = createScheduleMCPOffer({
      ...enrollment,
      canUseMCP: createMCPUseCheck(deps.getRoleByName),
    });
    const consent = createScheduleMCPConsentHost({
      ...deps,
      findUser: enrollment.findUser,
      getLimits: createScheduleLimitsResolver((options = {}) => enrollment.getAppConfig(options)),
      resolveEnrollment: offer.targets,
      resolveTools: offer.tools,
      resolveServers: offer.servers,
    });
    return { consent };
  }
  const { consent } = createEvaluation(deps.enrollment);
  /**
   * For the question a run asks: does this schedule need a grant it does not have. A config
   * service that cannot read a tenant, role or user override falls back to the deployment's
   * base, which may not require consent at all. Asked fail-closed, that outage refuses the
   * call instead of lifting the requirement.
   */
  const required = createEvaluation({
    ...deps.enrollment,
    getAppConfig: (options) => deps.enrollment.getAppConfig({ ...options, failClosed: true }),
  }).consent.service.requiresGrant;
  const execution = createScheduleMCPExecution({
    storage: deps.methods,
    requiresGrant: required,
    // A schedule's grant covers the whole run: the agents' other tools load only if listed.
    coversTools: true,
    // A background task's completion turn finds the schedule again by its captured identity.
    detaches: true,
    async loadAuthorization(identity) {
      // Private to this attempt. No resolved principal, config or allow decision survives it.
      const principal = deps.findUser(identity.ownerId).then((user) => {
        if (!user || (user.tenantId ?? null) !== identity.tenantId) return null;
        user.id = identity.ownerId;
        return user;
      });
      const effectiveConfig = principal.then((user) =>
        user
          ? deps.enrollment.getAppConfig({ ...getAppConfigOptionsFromUser(user), failClosed: true })
          : undefined,
      );
      const baseConfig = deps.enrollment.getAppConfig({ baseOnly: true, failClosed: true });
      const [user, config, base] = await Promise.all([principal, effectiveConfig, baseConfig]);
      const evaluation = createEvaluation({
        ...deps.enrollment,
        findUser: async () => user,
        /** The base config carries the deployment-wide schedule stop that limits honour. */
        getAppConfig: async (options) => (options?.baseOnly ? base : config),
      });
      return { authority: evaluation.consent.service.authority };
    },
  });
  return {
    consent,
    execution,
    prepare: (input) =>
      prepareSafely(async () => {
        const { req, context, executionContext, restoredJob } = input;
        const completion = restoredJob?.scheduleMCPCompletion;
        if (completion !== undefined || isScheduledMCPCompletionRequest(req)) {
          if (!context) throw new ScheduledMCPPolicyError('binding_mismatch', '');
          const marker = req.body?.agentCompletion;
          if (
            marker != null &&
            (typeof marker !== 'object' ||
              !('version' in marker) ||
              marker.version !== 1 ||
              !('sourceId' in marker) ||
              !['subagent-completion', 'background-tool-completion'].includes(
                String(marker.sourceId),
              ))
          )
            throw new ScheduledMCPPolicyError('binding_mismatch', '');
          const origin =
            marker && typeof marker === 'object' && 'scheduleMCPIdentity' in marker
              ? marker.scheduleMCPIdentity
              : undefined;
          const identity =
            completion !== undefined
              ? parseScheduleMCPCompletion(completion)
              : await resolveScheduleMCPCompletion(
                  {
                    ownerId: req.user.id,
                    tenantId: req.user.tenantId ?? null,
                    scheduleMCPIdentity: origin,
                  },
                  deps.getScheduleMCPCompletionState,
                );
          if (!identity) return;
          if (identity.ownerId !== req.user.id || identity.tenantId !== (req.user.tenantId ?? null))
            throw new ScheduledMCPPolicyError('binding_mismatch', '');
          // Resolved afresh: the turn runs under the grant the schedule holds now, if any.
          // A resumed turn carries the approvals its owner gave while it was paused.
          await execution.attach(
            context,
            identity,
            completion !== undefined ? 'resume' : 'invoke',
            false,
            {
              completion: true,
              ...(completion !== undefined && { approvedToolCalls: input.approvedToolCalls }),
            },
          );
          if (!getScheduleMCPExecution(context))
            throw new ScheduledMCPPolicyError('binding_mismatch', '');
          return;
        }
        if (!isScheduleFireRequest(req)) return;
        const schedule = getScheduleSource(executionContext);
        /** A resumed run whose saved job restored a complete identity. */
        const restoredContext = schedule?.resumed
          ? toScheduledTokenContext(executionContext)
          : undefined;
        const fresh = schedule?.resumed === false ? schedule : undefined;
        const scheduleId = restoredContext?.scheduleId ?? fresh?.id ?? restoredJob?.scheduleId;
        if (!scheduleId || !context) throw new ScheduledMCPPolicyError('binding_mismatch', '');
        const row = await deps.methods.getScheduleById(scheduleId, req.user.id);
        if (!row || (row.tenantId ?? null) !== (req.user.tenantId ?? null))
          throw new ScheduledMCPPolicyError('binding_mismatch', '');
        const enrolled = row.mcpConsent !== undefined;
        const rootId =
          restoredContext?.agentId ??
          (fresh ? executionContext?.agentId : undefined) ??
          (!enrolled ? row.agent_id : undefined);
        if (typeof rootId !== 'string' || rootId !== row.agent_id)
          throw new ScheduledMCPPolicyError('binding_mismatch', '');
        const identity = scheduledMCPIdentity({
          scheduleId,
          ownerId: req.user.id,
          tenantId: req.user.tenantId,
          agentId: rootId,
          invocationMode: 'delegated',
        });
        if (
          restoredContext &&
          (restoredContext.ownerId !== req.user.id ||
            (restoredContext.tenantId ?? null) !== (req.user.tenantId ?? null))
        )
          throw new ScheduledMCPPolicyError('binding_mismatch', '');
        await execution.attach(context, identity, restoredContext ? 'resume' : 'invoke', enrolled, {
          legacy: !enrolled,
          manual: restoredContext
            ? restoredJob?.scheduleId === scheduleId && restoredJob.scheduleManual === true
            : fresh?.manual === true,
          // Only a resumed run can carry approvals: a fresh occurrence has asked nobody yet.
          ...(restoredContext && { approvedToolCalls: input.approvedToolCalls }),
        });
      }, input.signal),
  };
}

/** Ordinary startup keeps its original synchronous admission of independent reads. */
export function initializeWithScheduleMCPExecution<T>(
  input: Parameters<ReturnType<typeof createScheduleMCPRuntimeHost>['prepare']>[0],
  getHost: () => Pick<ReturnType<typeof createScheduleMCPRuntimeHost>, 'prepare'>,
  initialize: () => Promise<T>,
  retainCompletion?: (identity: ScheduledMCPIdentity) => Promise<void>,
): Promise<T> {
  if (
    input.restoredJob?.scheduleMCPCompletion === undefined &&
    !isScheduleFireRequest(input.req) &&
    !isScheduledMCPCompletionRequest(input.req)
  )
    return initialize();
  return prepareSafely(async () => {
    await getHost().prepare(input);
    const execution = getScheduleMCPExecution(input.context);
    if (
      isScheduledMCPCompletionRequest(input.req) &&
      execution &&
      input.restoredJob?.scheduleMCPCompletion === undefined
    )
      await retainCompletion?.(execution.identity);
  }, input.signal).then(initialize);
}

/** Only authorization preparation is projected; provider failures remain caller-owned. */
async function prepareSafely(operation: () => Promise<void>, signal?: AbortSignal): Promise<void> {
  try {
    signal?.throwIfAborted();
    await operation();
    signal?.throwIfAborted();
  } catch (error) {
    if (error instanceof ScheduledMCPPolicyError || isOwnedAbortError(error, signal)) throw error;
    throw new ScheduledMCPPolicyError('dependency_unavailable', '');
  }
}
