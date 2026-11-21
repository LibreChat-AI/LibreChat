import type { ScheduleMCPOutcome, ScheduledMCPIdentity } from 'librechat-data-provider';
import type { RunGrantExecutionFactory } from '~/agents/authority/execution';
import type { RequestScopedMCPConnectionStore } from '~/mcp/types';
import type { ExecutionContext } from '~/agents/authority/context';
import type { ScheduleMCPCompletionLookup } from './continuation';
import type { RunGrantOfferDeps } from '~/agents/authority/offer';
import {
  isScheduledMCPCompletionRequest,
  resolveScheduleMCPCompletion,
  parseScheduleMCPCompletion,
} from './continuation';
import {
  createRunGrantExecution,
  scheduledMCPIdentity,
  getScheduleMCPExecution,
} from '~/agents/authority/execution';
import {
  readScheduleFireContext,
  isScheduleFireRequest,
  restoreSkippedMCPServers,
} from '../trigger';
import { getScheduleSource, toScheduledTokenContext } from '~/agents/authority/context';
import { createScheduleMCPConsentHost, createMCPUseCheck } from './host';
import { RunGrantPolicyError } from '~/agents/authority/policy';
import { createRunGrantOffer } from '~/agents/authority/offer';
import { getAppConfigOptionsFromUser } from '~/app/service';
import { createScheduleLimitsResolver } from '../service';
import { isOwnedAbortError } from '~/utils/errors';

type RuntimeRequest = Parameters<typeof readScheduleFireContext>[0] & {
  user: { id: string; tenantId?: string };
};

export function createScheduleMCPRuntimeHost(
  deps: Omit<
    Parameters<typeof createScheduleMCPConsentHost>[0],
    'resolveEnrollment' | 'resolveTools' | 'resolveServers' | 'getLimits'
  > & {
    enrollment: RunGrantOfferDeps;
    getScheduleMCPCompletionState?: ScheduleMCPCompletionLookup;
    methods: {
      /** The MCP outcomes an occurrence's run row holds. */
      getScheduleRunMCP: (
        scheduleId: string,
        scheduledFor: string | Date,
      ) => Promise<ScheduleMCPOutcome[]>;
      /** The same, for the occurrence that started a conversation. */
      getScheduleConversationMCP: (
        scope: Pick<ScheduledMCPIdentity, 'scheduleId' | 'ownerId' | 'tenantId'>,
        conversationId: string,
      ) => Promise<ScheduleMCPOutcome[]>;
    };
  },
): {
  consent: ReturnType<typeof createScheduleMCPConsentHost>;
  execution: RunGrantExecutionFactory;
  prepare: (input: {
    req: RuntimeRequest;
    signal?: AbortSignal;
    context?: RequestScopedMCPConnectionStore;
    executionContext?: ExecutionContext;
    restoredJob?: {
      scheduleId?: string;
      /** The occurrence the saved job belongs to: its run row holds what it went without. */
      scheduledFor?: string | Date;
      scheduleManual?: boolean;
      scheduleMCPCompletion?: ScheduledMCPIdentity;
      /** The conversation the saved job ran in. */
      conversationId?: string;
    };
    /** Tool calls the owner approved in the request that resumes this run. */
    approvedToolCalls?: readonly string[];
  }) => Promise<void>;
} {
  function createEvaluation(enrollment: RunGrantOfferDeps) {
    const offer = createRunGrantOffer({
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
  const execution = createRunGrantExecution({
    storage: deps.storage,
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
          if (!context) throw new RunGrantPolicyError('binding_mismatch', '');
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
            throw new RunGrantPolicyError('binding_mismatch', '');
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
            throw new RunGrantPolicyError('binding_mismatch', '');
          // The turn reports on a task one occurrence started, in the conversation that
          // occurrence started, and is a request of its own: neither that occurrence's
          // trigger nor its saved job. The servers the occurrence went without are read from
          // its run row, found by the conversation, so the turn goes without them too and
          // does not stop to ask for a sign-in nobody is there to give. The conversation is
          // the signed host's, or the saved job's when the turn is resumed.
          const conversationId =
            completion !== undefined ? restoredJob?.conversationId : req.body?.conversationId;
          if (typeof conversationId === 'string' && conversationId !== '')
            restoreSkippedMCPServers(
              req,
              await deps.methods.getScheduleConversationMCP(identity, conversationId),
            );
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
            throw new RunGrantPolicyError('binding_mismatch', '');
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
        if (!scheduleId || !context) throw new RunGrantPolicyError('binding_mismatch', '');
        const row = await deps.methods.getScheduleById(scheduleId, req.user.id);
        if (!row || (row.tenantId ?? null) !== (req.user.tenantId ?? null))
          throw new RunGrantPolicyError('binding_mismatch', '');
        const enrolled = row.mcpConsent !== undefined;
        const rootId =
          restoredContext?.agentId ??
          (fresh ? executionContext?.agentId : undefined) ??
          (!enrolled ? row.agent_id : undefined);
        if (typeof rootId !== 'string' || rootId !== row.agent_id)
          throw new RunGrantPolicyError('binding_mismatch', '');
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
          throw new RunGrantPolicyError('binding_mismatch', '');
        // A resumed run rebuilds its tools on a request that is not a trigger. The servers its
        // occurrence was started without are read back from the occurrence's own run row, so
        // the resumed run goes without the same ones.
        if (schedule?.resumed === true && restoredJob?.scheduledFor != null)
          restoreSkippedMCPServers(
            req,
            await deps.methods.getScheduleRunMCP(scheduleId, restoredJob.scheduledFor),
          );
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
    if (error instanceof RunGrantPolicyError || isOwnedAbortError(error, signal)) throw error;
    throw new RunGrantPolicyError('dependency_unavailable', '');
  }
}
