import {
  checkpointerSchema,
  messageFilterSchema,
  responseReviewDecisionSchema,
  MAX_SUBAGENT_GRAPH_NODES,
} from 'librechat-data-provider';
import type {
  AppConfig,
  IUser,
  ResponseStorage,
  StoredResponseRecord,
  ResponseOwner,
} from '@librechat/data-schemas';
import type { Agents, Agent } from 'librechat-data-provider';
import type { GenerationJobManagerClass } from '~/stream/GenerationJobManager';
import type { ResumeContentProtectionDependencies } from '../hitl/protection';
import type { ResolveChatProjectContextDeps } from '~/projects/context';
import type { Response, ResponseResumeAdmissionResult } from './types';
import type { JobMetadataPatch } from '~/stream/interfaces/IJobStore';
import type { ResponseDecisionDependencies } from './decision';
import type { GenerationJob } from '~/types/stream';
import {
  buildResolvedAskUserQuestion,
  appendResolvedAskUserQuestion,
  attachAskUserQuestionAnswers,
} from '../hitl/resume';
import {
  computeAgentRequestFingerprint,
  computeLegacyAgentRequestFingerprint,
} from '../hitl/policy';
import { hasDurableAgentInterruptCheckpoint, resolveCheckpointerConfig } from '../checkpointer';
import { getChatProjectContextKey, resolveChatProjectContext } from '~/projects/context';
import { checkpointOwnerNamespacePrefix } from '~/stream/checkpoints';
import { getResumeAgentSnapshot } from '../hitl/inspection';
import { preflightResumeContent } from '../hitl/preflight';
import { getLookupConcurrency } from '~/utils/concurrency';
import { resolveResponseReviewDecision } from './decision';
import { canonicalResponseJSON } from './background';
import { isResponseTenantId } from './scope';
import { responseTenantId } from './scope';

export interface ResponseResumeValidationDependencies {
  findUser: (userId: string) => Promise<IUser | null>;
  getConfig: (user: IUser) => Promise<AppConfig>;
  content: ResumeContentProtectionDependencies;
  projects: ResolveChatProjectContextDeps;
  jobs: Pick<GenerationJobManagerClass, 'getResumeState'>;
}

/** Shared owner-submit and worker preflight. Rechecks the retained checkpoint even when
 * content filters are disabled, and never consumes an approval or initializes tools. */
export function createResponseResumeValidation(deps: ResponseResumeValidationDependencies): {
  validateDecision: ResponseDecisionDependencies['validate'];
  validateResume: ResponseResumeAdmissionDependencies['validate'];
} {
  async function inspect(input: Parameters<ResponseDecisionDependencies['validate']>[0]) {
    const { record, job, action, decision, resolution } = input;
    if (resolution.type !== action.payload.type) return;
    const participants = action.resumeAgentIds;
    if (
      !Array.isArray(participants) ||
      participants.length === 0 ||
      participants.length > MAX_SUBAGENT_GRAPH_NODES ||
      participants.some((id) => typeof id !== 'string' || !id) ||
      new Set(participants).size !== participants.length ||
      !participants.includes(record.agentId) ||
      !isResponseTenantId(record.tenantId) ||
      !record.review?.checkpointConfigJSON
    )
      return;
    let retained: ReturnType<typeof checkpointerSchema.safeParse>;
    try {
      retained = checkpointerSchema.safeParse(JSON.parse(record.review.checkpointConfigJSON));
    } catch {
      return;
    }
    if (!retained.success) return;
    const originalRequest = JSON.parse(record.requestJSON);
    if (
      !action.requestFingerprint ||
      !action.requestFingerprintV2 ||
      action.requestFingerprint !== computeLegacyAgentRequestFingerprint(originalRequest) ||
      action.requestFingerprintV2 !== computeAgentRequestFingerprint(originalRequest)
    )
      return;
    const foundUser = await deps.findUser(record.userId);
    if (
      !foundUser ||
      String(foundUser._id) !== record.userId ||
      !isResponseTenantId(foundUser.tenantId) ||
      responseTenantId(foundUser.tenantId) !== responseTenantId(record.tenantId)
    )
      return;
    const user = Object.assign({}, foundUser, {
      id: record.userId,
      role: foundUser.role,
      tenantId: responseTenantId(record.tenantId),
    });
    const config = await deps.getConfig(user);
    const current = resolveCheckpointerConfig(config.endpoints?.agents?.checkpointer);
    const pinned = resolveCheckpointerConfig(retained.data);
    const namespace = job.metadata.checkpointNamespace;
    if (
      pinned.type !== 'mongo' ||
      current.type !== pinned.type ||
      current.checkpointCollectionName !== pinned.checkpointCollectionName ||
      current.checkpointWritesCollectionName !== pinned.checkpointWritesCollectionName ||
      !namespace?.startsWith(checkpointOwnerNamespacePrefix(record.userId, record.tenantId)) ||
      !record.review?.checkpointId ||
      !action.interruptId ||
      !(await hasDurableAgentInterruptCheckpoint(record.conversationId, retained.data, {
        checkpointNamespace: namespace,
        checkpointId: record.review.checkpointId,
        checkpointNs: record.review.checkpointNs,
        interruptId: action.interruptId,
      }))
    )
      return;
    let unavailableParticipant = false;
    const loadedAgents = new Map<string, Promise<Agent | null>>();
    const loadAgent = (id: string): Promise<Agent | null> => {
      let pending = loadedAgents.get(id);
      if (!pending) {
        pending = (async () => {
          const agent = await deps.content.getAgent({ id });
          if (!agent || agent.id !== id || !(await deps.content.canAccessAgent(agent, user))) {
            unavailableParticipant = true;
            return null;
          }
          return agent;
        })();
        loadedAgents.set(id, pending);
      }
      return pending;
    };
    const [agent, project] = await Promise.all([
      loadAgent(record.agentId),
      resolveChatProjectContext(
        {
          userId: record.userId,
          tenantId: responseTenantId(record.tenantId),
          conversationId: record.conversationId,
          includeResources: true,
        },
        deps.projects,
      ),
    ]);
    if (!agent || action.projectContextKey !== getChatProjectContextKey(project)) return;
    const additionalRoots: Agent[] = [];
    const concurrency = getLookupConcurrency(config, 'resumeAgentLoads');
    for (let offset = 0; offset < participants.length; offset += concurrency) {
      const chunk = await Promise.all(
        participants.slice(offset, offset + concurrency).map(loadAgent),
      );
      for (const participant of chunk) if (participant) additionalRoots.push(participant);
    }
    const snapshot = await getResumeAgentSnapshot({
      primaryAgent: agent,
      additionalRoots,
      subagentsEnabled: true,
      getAgent: (filter) => loadAgent(filter.id),
      appConfig: config,
    });
    const present = new Set(snapshot.map((participant) => participant.id));
    if (unavailableParticipant || participants.some((id) => !present.has(id))) return;
    const batch =
      resolution.type === 'ask_user_question' && 'answers' in resolution.value
        ? resolution.value.answers
        : undefined;
    const answer = batch == null ? decision.answer : JSON.stringify({ answers: batch });
    let inspectionResolution: Parameters<typeof preflightResumeContent>[0]['resumeValue'];
    if (resolution.type === 'tool_approval') inspectionResolution = resolution.value;
    else if ('answers' in resolution.value)
      inspectionResolution = { answer: JSON.stringify({ answers: resolution.value.answers }) };
    else inspectionResolution = resolution.value;
    const resumeState = await deps.jobs.getResumeState(record.responseId, job.createdAt, {
      validateEarlyBufferRecovery: true,
    });
    const messages = await deps.content.getMessages({
      conversationId: record.conversationId,
      user: record.userId,
    });
    const originalMessage = messages?.find(
      (message) => message.messageId === job.metadata.userMessage?.messageId,
    );
    const prepared = await preflightResumeContent(
      {
        appConfig: {
          ...config,
          messageFilter: messageFilterSchema.optional().parse(config.messageFilter),
        },
        endpointOption: { agent: Promise.resolve(agent) },
        conversationId: record.conversationId,
        user,
        jobMetadata: job.metadata,
        pendingAction: action,
        body: { ...(answer == null ? {} : { answer }), decisions: decision.decisions },
        resumeValue: inspectionResolution,
        resumeState:
          resumeState && job.metadata.resolvedAskUserQuestions?.length
            ? {
                ...resumeState,
                aggregatedContent: attachAskUserQuestionAnswers(
                  resumeState.aggregatedContent ?? [],
                  job.metadata.resolvedAskUserQuestions,
                ),
              }
            : resumeState,
        liveFiles: originalMessage?.files?.filter((file) => file != null) ?? [],
        isTemporary: job.metadata.isTemporary === true,
        checkpointNamespace: namespace,
        resolvedAddedAgent: undefined,
      },
      {
        ...deps.content,
        getAgent: (filter) => loadAgent(filter.id),
        canAccessAgent: async (candidate) => (await loadAgent(candidate.id)) != null,
      },
    );
    return {
      userSubmittedPaths: prepared.userSubmittedPaths,
      userSubmittedMessageFieldPaths: prepared.userSubmittedMessageFieldPaths,
      resolvedAskUserQuestions: appendResolvedAskUserQuestion(
        job.metadata.resolvedAskUserQuestions,
        buildResolvedAskUserQuestion(action, decision),
      ),
    };
  }
  const validateDecision: ResponseDecisionDependencies['validate'] = async (input) =>
    (await inspect(input)) != null;
  const validateResume: ResponseResumeAdmissionDependencies['validate'] = async (record, job) => {
    const action: Agents.PendingAction = JSON.parse(record.review?.pendingActionJSON ?? 'null');
    const parsed = responseReviewDecisionSchema.safeParse(
      JSON.parse(record.resume?.decisionJSON ?? 'null'),
    );
    if (!action || !parsed.success || action.actionId !== parsed.data.actionId)
      return { ok: false };
    const decision = parsed.data;
    const mapped = resolveResponseReviewDecision(action, decision);
    if (
      !('resolution' in mapped) ||
      canonicalResponseJSON(mapped.resolution.value) !==
        canonicalResponseJSON(JSON.parse(record.resume?.resolutionJSON ?? 'null'))
    )
      return { ok: false };
    const provenance = await inspect({
      record,
      job,
      action,
      decision,
      resolution: mapped.resolution,
    });
    return provenance ? { ok: true, provenance } : { ok: false };
  };
  return { validateDecision, validateResume };
}

type ResumeProvenance = Pick<
  JobMetadataPatch,
  'userSubmittedPaths' | 'userSubmittedMessageFieldPaths' | 'resolvedAskUserQuestions'
>;

export interface ResponseResumeAdmissionDependencies {
  storage: ResponseStorage;
  jobs: Pick<GenerationJobManagerClass, 'getJob' | 'approvals'>;
  authorize: (record: StoredResponseRecord) => Promise<boolean>;
  /** Revalidate the retained checkpoint snapshot, current graph/tool/credential bindings,
   * and model-bound answer content. This must run on retries after the job consumed its action too. */
  validate: (
    record: StoredResponseRecord,
    job: GenerationJob,
  ) => Promise<{ ok: true; provenance: ResumeProvenance } | { ok: false }>;
  now?: () => number;
}

export type { ResponseResumeAdmissionResult } from './types';

/** Reconcile Mongo decision intent with the existing approval CAS. This never starts a provider.
 * The execution host must still acquire beginProviderExecution for the selected segment exactly once. */
export function createResponseResumeAdmission(deps: ResponseResumeAdmissionDependencies) {
  return async (
    owner: ResponseOwner,
    responseId: string,
    intentId: string,
  ): Promise<ResponseResumeAdmissionResult> => {
    const unavailable = { ok: false, code: 'response_resume_unavailable' } as const;
    const record = await deps.storage.read(owner, responseId);
    const intent = record?.resume;
    const review = record?.review;
    if (
      !record ||
      record.pendingTerminal != null ||
      !intent ||
      !review ||
      intent.intentId !== intentId ||
      !review.pendingActionJSON ||
      record.generationCreatedAt == null ||
      record.cancellationRequestedAt != null ||
      !['requires_action', 'in_progress'].includes(record.status) ||
      intent.actionId !== review.actionId ||
      intent.previousProviderExecutionId !== review.providerExecutionId ||
      intent.providerExecutionId === intent.previousProviderExecutionId ||
      !(await deps.authorize(record))
    )
      return unavailable;
    const matches = (job: GenerationJob | undefined): job is GenerationJob =>
      job != null &&
      job.createdAt === record.generationCreatedAt &&
      job.metadata.userId === record.userId &&
      responseTenantId(job.metadata.tenantId) === responseTenantId(record.tenantId) &&
      job.metadata.agent_id === record.agentId &&
      job.metadata.endpoint === 'responses' &&
      job.metadata.conversationId === record.conversationId &&
      job.metadata.responseMessageId === responseId;
    let job = await deps.jobs.getJob(responseId);
    if (!matches(job)) return unavailable;
    const checkpointNamespace = job.metadata.checkpointNamespace;
    if (
      !checkpointNamespace?.startsWith(
        checkpointOwnerNamespacePrefix(record.userId, record.tenantId),
      )
    )
      return unavailable;
    const alreadyResolved = (value: GenerationJob) =>
      value.status === 'running' &&
      value.metadata.providerExecutionId === intent.providerExecutionId;
    if (
      !alreadyResolved(job) &&
      (job.status !== 'requires_action' ||
        job.metadata.providerExecutionId !== intent.previousProviderExecutionId ||
        job.metadata.pendingAction?.actionId !== intent.actionId ||
        job.metadata.providerDrained !== true ||
        job.metadata.terminalPersistencePending === true ||
        review.expiresAt <= (deps.now ?? Date.now)())
    )
      return unavailable;
    const validation = await deps.validate(record, job);
    if (!validation.ok) return unavailable;
    if (!alreadyResolved(job)) {
      let resolutionError: unknown;
      try {
        await deps.jobs.approvals.resolve(
          responseId,
          intent.actionId,
          {
            ...validation.provenance,
            providerExecutionId: intent.providerExecutionId,
            providerDrained: true,
          },
          record.generationCreatedAt,
          intent.previousProviderExecutionId,
        );
      } catch (error) {
        resolutionError = error;
      }
      job = await deps.jobs.getJob(responseId);
      if (!matches(job) || !alreadyResolved(job)) {
        if (resolutionError) throw resolutionError;
        return unavailable;
      }
    }
    // A lost approval-CAS acknowledgement is recoverable only by this exact selected provider.
    // Do not treat a replacement generation, another action or a missing job as successful resume.
    const current = await deps.storage.read(owner, responseId);
    if (
      !current ||
      current.resume?.intentId !== intentId ||
      current.cancellationRequestedAt != null ||
      !['requires_action', 'in_progress'].includes(current.status) ||
      !(await deps.authorize(current))
    )
      return unavailable;
    const response: Response = JSON.parse(current.responseJSON ?? '{}');
    const { required_action: _previousAction, ...resuming } = response;
    const admitted = await deps.storage.admitResume(
      owner,
      responseId,
      intentId,
      record.generationCreatedAt,
      intent.providerExecutionId,
      JSON.stringify({ ...resuming, status: 'in_progress' }),
      (deps.now ?? Date.now)(),
    );
    if (!admitted.ok) return unavailable;
    return {
      ok: true,
      record: admitted.record,
      checkpointNamespace,
      status:
        job.metadata.providerExecutionStartedId === intent.providerExecutionId
          ? 'attached'
          : 'ready',
    };
  };
}
