import type { ScheduledMCPIdentity } from 'librechat-data-provider';
import type { RequestScopedMCPConnectionStore } from '~/mcp/types';
import type { ExecutionContext } from '~/agents/authority/context';
import type { ScheduleMCPCompletionLookup } from './continuation';
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
import { createScheduleMCPEnrollmentResolver } from './enrollment';
import { getAppConfigOptionsFromUser } from '~/app/service';
import { createScheduleLimitsResolver } from '../service';
import { createScheduleMCPConsentHost } from './host';
import { isOwnedAbortError } from '~/utils/errors';
import { ScheduledMCPPolicyError } from './policy';

type RuntimeRequest = Parameters<typeof readScheduleFireContext>[0] & {
  user: { id: string; tenantId?: string };
};

export function createScheduleMCPRuntimeHost(
  deps: Omit<
    Parameters<typeof createScheduleMCPConsentHost>[0],
    'resolveEnrollment' | 'getLimits'
  > & {
    enrollment: ScheduleMCPEnrollmentDeps;
    getScheduleMCPCompletionState?: ScheduleMCPCompletionLookup;
  },
): {
  consent: ReturnType<typeof createScheduleMCPConsentHost>;
  execution: ReturnType<typeof createScheduleMCPExecution>;
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
  }) => Promise<void>;
} {
  function createEvaluation(enrollment: ScheduleMCPEnrollmentDeps) {
    const resolveEnrollment = createScheduleMCPEnrollmentResolver(enrollment);
    const consent = createScheduleMCPConsentHost({
      ...deps,
      findUser: enrollment.findUser,
      getLimits: createScheduleLimitsResolver((options = {}) => enrollment.getAppConfig(options)),
      resolveEnrollment,
    });
    return { consent };
  }
  const { consent } = createEvaluation(deps.enrollment);
  const execution = createScheduleMCPExecution({
    storage: deps.methods,
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
          await execution.attach(
            context,
            identity,
            completion !== undefined ? 'resume' : 'invoke',
            false,
            { legacy: true },
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
