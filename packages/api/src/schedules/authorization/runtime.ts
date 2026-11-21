import type { ScheduleMCPOutcome, ScheduledMCPIdentity } from 'librechat-data-provider';
import type { RunGrantExecutionFactory } from '~/agents/authority/execution';
import type { ScheduleMCPCompletionLookup } from './continuation';
import type { RunGrantOfferDeps } from '~/agents/authority/offer';
import type { ScheduleInput, ScheduleHost } from './subject';
import {
  SCHEDULE_WORDING,
  scheduledMCPIdentity,
  completionOrigin,
  scheduleSubject,
} from './subject';
import { restoreSkippedMCPServers, readSkippedMCPServers, isScheduleFireRequest } from '../trigger';
import { resolveScheduleMCPCompletion, parseScheduleMCPCompletion } from './continuation';
import { getScheduleSource, toScheduledTokenContext } from '~/agents/authority/context';
import { isCompletionTurn, completionMarker, placeRun } from '~/agents/authority/host';
import { createScheduleMCPConsentHost, createMCPUseCheck } from './host';
import { createRunGrantExecution } from '~/agents/authority/execution';
import { RunGrantPolicyError } from '~/agents/authority/policy';
import { createRunGrantOffer } from '~/agents/authority/offer';
import { getAppConfigOptionsFromUser } from '~/app/service';
import { createScheduleLimitsResolver } from '../service';

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
  /** Puts a request's run under its schedule, where the request is a schedule's. */
  prepare: (input: ScheduleInput) => Promise<void>;
} & ScheduleHost {
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
    wording: SCHEDULE_WORDING,
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
  const host: ReturnType<typeof createScheduleMCPRuntimeHost> = {
    consent,
    execution,
    async resolve(input) {
      const { req, context, executionContext, restoredJob } = input;
      const completion = restoredJob?.scheduleMCPCompletion;
      if (completion !== undefined || isCompletionTurn(req)) {
        if (!context) throw new RunGrantPolicyError('binding_mismatch', '');
        completionMarker(req);
        const identity =
          completion !== undefined
            ? parseScheduleMCPCompletion(completion)
            : await resolveScheduleMCPCompletion(
                {
                  ownerId: req.user.id,
                  tenantId: req.user.tenantId ?? null,
                  scheduleMCPIdentity: completionOrigin(req),
                },
                deps.getScheduleMCPCompletionState,
              );
        if (!identity) return;
        if (identity.ownerId !== req.user.id || identity.tenantId !== (req.user.tenantId ?? null))
          throw new RunGrantPolicyError('binding_mismatch', '');
        // Resolved afresh: the turn runs under the grant the schedule holds now, if any, and
        // not at all where the schedule can no longer be put over it. A resumed turn carries
        // the approvals its owner gave while it was paused.
        return {
          identity,
          context,
          stage: completion !== undefined ? 'resume' : 'invoke',
          require: 'run',
          options: {
            completion: true,
            ...(completion !== undefined && { approvedToolCalls: input.approvedToolCalls }),
          },
        };
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
      return {
        identity,
        context,
        stage: restoredContext ? 'resume' : 'invoke',
        // A schedule that holds a grant runs under it or not at all.
        ...(enrolled && { require: 'grant' as const }),
        options: {
          legacy: !enrolled,
          manual: restoredContext
            ? restoredJob?.scheduleId === scheduleId && restoredJob.scheduleManual === true
            : fresh?.manual === true,
          // Only a resumed run can carry approvals: a fresh occurrence has asked nobody yet.
          ...(restoredContext && { approvedToolCalls: input.approvedToolCalls }),
        },
      };
    },
    /**
     * A fresh occurrence carries what it goes without on its trigger. A request that is not
     * the occurrence's own reads it back and puts it on the request, where the trigger would
     * have: a resumed run from the occurrence's run row, and a completion turn from the run
     * row of the occurrence that started its conversation, so neither stops to ask for a
     * sign-in nobody is there to give. The conversation is the signed host's, or the saved
     * job's when the turn is resumed.
     */
    async restore({ req, executionContext, restoredJob }, found) {
      if (found.options?.completion === true) {
        const conversationId =
          restoredJob?.scheduleMCPCompletion !== undefined
            ? restoredJob.conversationId
            : req.body?.conversationId;
        if (typeof conversationId === 'string' && conversationId !== '')
          restoreSkippedMCPServers(
            req,
            await deps.methods.getScheduleConversationMCP(found.identity, conversationId),
          );
      } else if (
        getScheduleSource(executionContext)?.resumed === true &&
        restoredJob?.scheduledFor != null
      )
        restoreSkippedMCPServers(
          req,
          await deps.methods.getScheduleRunMCP(found.identity.scheduleId, restoredJob.scheduledFor),
        );
      return readSkippedMCPServers(req);
    },
    prepare: (input) => placeRun([scheduleSubject(() => host)], input),
  };
  return host;
}
