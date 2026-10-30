import { checkpointerSchema, responseReviewDecisionSchema } from 'librechat-data-provider';
import type { ResponseTerminalReceipt, StoredResponseRecord } from '@librechat/data-schemas';
import type { Request, Response as HttpResponse } from 'express';
import type { Agents, TMessage } from 'librechat-data-provider';
import type { Run, IState } from '@librechat/agents';
import type { ExecuteAgentRunParams, AgentExecutionConnection } from '../remote/host';
import type { GenerationJobManagerClass } from '~/stream/GenerationJobManager';
import type { MarkToolApprovalAllowAlwaysOptions } from '../hitl/allow';
import type { AgentExecutionEnrollment } from '../remote/lifecycle';
import type { ResponseTerminalCompletion } from './foreground';
import type { ResponsesRunEnvelope } from '../envelope';
import type { ResponseAggregator } from './service';
import type { ReachableAgent } from '../traversal';
import type { ServerRequest } from '~/types/http';
import type { Response } from './types';
import type { createRun } from '../run';
import {
  createResponseCompletion,
  createResponseExecutionRelease,
  createResponseExecutionConfirmation,
} from './completion';
import {
  computeAgentRequestFingerprint,
  computeLegacyAgentRequestFingerprint,
  pickResumeContext,
} from '../hitl/policy';
import {
  markToolApprovalAllowAlways,
  resolveRunToolApprovalAllows,
  recordToolApprovalAllows,
} from '../hitl/allow';
import {
  getApprovalTtlMs,
  resolveCheckpointerConfig,
  LIBRECHAT_CHECKPOINT_NAMESPACE_KEY,
} from '../checkpointer';
import { combineResponseSegments, seedResponseAggregator } from './segments';
import { checkpointOwnerNamespacePrefix } from '~/stream/checkpoints';
import { getRunDiscoveredTools, getRunMCPToolAliases } from '../run';
import { markNativeCodeToolApprovalRequests } from '../hitl/byom';
import { assertCodeExecutionApprovalBinding } from '../execution';
import { getBackgroundResponseWorkerAdmission } from './worker';
import { getChatProjectContextKey } from '~/projects/context';
import { buildPendingBackgroundResponse } from './background';
import { resolveResponseContinuation } from './persistence';
import { captureRunPendingAction } from '../hitl/capture';
import { cleanupResponseCheckpoint } from './checkpoint';
import { createResponseRetirement } from './retirement';
import { collectReachableAgents } from '../traversal';
import { pauseResponseForReview } from './pause';
import { generateResponseId } from './service';
import { responseTenantId } from './scope';

type TerminalResponse = Response & { status: ResponseTerminalReceipt['status'] };
type ReviewAgent = NonNullable<Parameters<typeof captureRunPendingAction>[0]['agents'][number]> &
  NonNullable<Parameters<typeof markNativeCodeToolApprovalRequests>[1][number]> &
  NonNullable<NonNullable<MarkToolApprovalAllowAlwaysOptions['agents']>[number]>;
interface ReviewAgentNode
  extends Omit<ReviewAgent, keyof ReachableAgent<never>>,
    ReachableAgent<ReviewAgentNode> {}

/** Capture and rebuild must describe the same initialized participant identities. */
function responseParticipantIds(primaryId: string, agents: readonly ReviewAgentNode[]): string[] {
  const participants = new Set<string>([primaryId]);
  for (const agent of agents) {
    if (typeof agent.id !== 'string' || !agent.id)
      throw new Error('Response graph participant identity unavailable');
    participants.add(agent.id);
  }
  return [...participants];
}

function responseBody(value: unknown): value is TerminalResponse {
  return (
    value != null &&
    typeof value === 'object' &&
    'object' in value &&
    value.object === 'response' &&
    'id' in value &&
    typeof value.id === 'string' &&
    'model' in value &&
    typeof value.model === 'string' &&
    'status' in value &&
    ['completed', 'failed', 'incomplete', 'cancelled'].includes(String(value.status)) &&
    'output' in value &&
    Array.isArray(value.output)
  );
}

export interface ResponseExecutionRuntime {
  completion?: ResponseTerminalCompletion;
  responseId: string;
  inputChain: <T>(chain: { messages: T[]; parentMessageId: string }) => {
    messages: T[];
    parentMessageId: string;
  };
  graphOptions: (
    agents?: Parameters<typeof createRun>[0]['agents'],
  ) => Promise<
    Pick<
      Parameters<typeof createRun>[0],
      | 'hitlCapable'
      | 'discoveredToolNames'
      | 'reviewedToolApprovals'
      | 'sessionStartSource'
      | 'toolApprovalStorage'
      | 'toolApprovalAllows'
    >
  >;
  seedAggregator: (aggregator: ResponseAggregator | null) => void;
  composeResponse: (response: Response) => Response;
  visibleOutputTokens: (current: number) => number;
  completeTurn: <T>(
    input: {
      run: Pick<Run<IState>, 'getInterrupt'> & Parameters<typeof getRunDiscoveredTools>[0];
      execution: AgentExecutionEnrollment;
      agents: Parameters<typeof createRun>[0]['agents'];
      buildPartial: () => Response;
      visibleOutputTokens: number;
      persistence: {
        saveConversation: () => Promise<void>;
        saveInput: () => Promise<void>;
        saveOutput: (partial: Response) => Promise<Partial<TMessage> | void>;
      };
    },
    complete: () => Promise<T>,
  ) => Promise<T | undefined>;
  /** A rebuilt graph restores messages from its checkpoint, not from a fresh input turn. */
  graphMessages: <T>(messages: T[]) => T[];
  toolContext: (execution: { createdAt: number }) => {
    streamId: string | null;
    jobCreatedAt?: number;
  };
  connection?: AgentExecutionConnection;
  hooks: Pick<
    ExecuteAgentRunParams<unknown>,
    | 'onEnrolled'
    | 'afterPause'
    | 'afterSettle'
    | 'clientRequestId'
    | 'resume'
    | 'retainTerminalPersistence'
  >;
  processRun: (
    run: Pick<Run<IState>, 'processStream' | 'resume'>,
    ...args: Parameters<Run<IState>['processStream']>
  ) => ReturnType<Run<IState>['processStream']>;
  resolveContinuation: (envelope: ResponsesRunEnvelope) => Promise<{
    conversationId: string;
    parentMessageId: string;
  }>;
}

/** Adapt only trusted background-worker requests; normal Responses keeps its synchronous lifecycle. */
export function createResponseExecutionRuntime(
  req: Request,
  res: HttpResponse,
  continuation: Parameters<typeof resolveResponseContinuation>[2] & {
    generateResponseId?: () => string;
    jobs?: Pick<
      GenerationJobManagerClass,
      'getJob' | 'abortJob' | 'finishProviderTerminalPersistence'
    > &
      Partial<Pick<GenerationJobManagerClass, 'updateMetadata'>>;
    pluginHookSource?: MarkToolApprovalAllowAlwaysOptions['pluginHookSource'];
    toolApprovalStorage?: Parameters<typeof createRun>[0]['toolApprovalStorage'];
    addConvoToolApprovalAllows?: Parameters<
      typeof recordToolApprovalAllows
    >[0]['addConvoToolApprovalAllows'];
  },
): ResponseExecutionRuntime {
  const admission = getBackgroundResponseWorkerAdmission(req);
  if (
    admission &&
    (!continuation.jobs?.finishProviderTerminalPersistence || !continuation.jobs.abortJob)
  )
    throw new Error('Response terminal publication release capability is unavailable');
  const interactive =
    admission?.interactive === true &&
    continuation.jobs != null &&
    resolveCheckpointerConfig((req as ServerRequest).config?.endpoints?.agents?.checkpointer)
      .type === 'mongo';
  let checkpoint: { checkpointNamespace: string; checkpointConfigJSON: string } | undefined;
  let enrolledExecution: AgentExecutionEnrollment | undefined;
  let rememberedTools: string[] = [];
  let responseParentMessageId: string | undefined;
  let prefix: Response | undefined;
  const seeded = new WeakSet<ResponseAggregator>();
  function previous(): Response | undefined {
    if (!admission?.resume) return;
    if (prefix) return prefix;
    let restored: Response;
    try {
      restored = JSON.parse(admission.record.review?.partialResponseJSON ?? 'null');
    } catch {
      throw new Error('Response resume output is unavailable');
    }
    if (
      !restored ||
      restored.id !== admission.record.responseId ||
      restored.model !== admission.record.agentId ||
      !Array.isArray(restored.output) ||
      !restored.background ||
      !restored.store
    )
      throw new Error('Response resume output identity changed');
    prefix = restored;
    return prefix;
  }
  function visibleOutputTokens(current: number): number {
    if (!admission?.resume) return current;
    const prior = admission.record.review?.visibleOutputTokens;
    if (
      prior == null ||
      !Number.isSafeInteger(prior) ||
      prior < 0 ||
      !Number.isSafeInteger(current) ||
      current < 0 ||
      !Number.isSafeInteger(prior + current)
    )
      throw new Error('Response visible token counter is unavailable');
    return prior + current;
  }
  function composeResponse(response: Response): Response {
    const prior = previous();
    return prior && admission?.resume
      ? combineResponseSegments(prior, response, admission.resume.intentId)
      : response;
  }
  let candidate: TerminalResponse | undefined;
  const completion = admission
    ? createResponseCompletion({
        storage: admission.storage,
        cleanupCheckpoint: cleanupResponseCheckpoint,
        confirmExecution: createResponseExecutionConfirmation(continuation.jobs!),
        releaseExecution: createResponseExecutionRelease(continuation.jobs!),
      })
    : undefined;
  const hooks: Pick<
    ExecuteAgentRunParams<unknown>,
    | 'onEnrolled'
    | 'afterPause'
    | 'afterSettle'
    | 'clientRequestId'
    | 'resume'
    | 'retainTerminalPersistence'
  > = admission
    ? {
        retainTerminalPersistence: true,
        clientRequestId: admission.record.responseId,
        ...(admission.resume
          ? {
              resume: {
                generationCreatedAt: admission.resume.generationCreatedAt,
                providerExecutionId: admission.resume.providerExecutionId,
              },
            }
          : {}),
        onEnrolled: async (execution) => {
          enrolledExecution = execution;
          const current = await admission.storage.read(
            admission.record,
            admission.record.responseId,
          );
          if (admission.resume) {
            if (
              !current ||
              current.generationCreatedAt !== execution.createdAt ||
              current.resume?.intentId !== admission.resume.intentId ||
              current.resume.state !== 'admitted' ||
              current.resume.providerExecutionId !== admission.resume.providerExecutionId ||
              current.status !== 'in_progress'
            )
              throw new Error('Background response resume enrollment changed');
            admission.record = current;
            if (current.cancellationRequestedAt != null) execution.abort();
            res.status(202).json({
              id: current.responseId,
              object: 'response',
              model: current.agentId,
              status: 'in_progress',
              background: true,
              store: true,
            });
            return;
          }
          if (!current || current.generationCreatedAt != null)
            throw new Error('Background response execution already published');
          const publishEnrollment = (
            record: StoredResponseRecord,
            status: 'queued' | 'in_progress',
          ) =>
            admission.storage.publish(record, record.responseId, record.revision, {
              status,
              responseJSON: JSON.stringify({ ...buildPendingBackgroundResponse(record), status }),
              generationCreatedAt: execution.createdAt,
            });
          const cancelled = current.cancellationRequestedAt != null;
          if (cancelled) execution.abort();
          let result = await publishEnrollment(current, cancelled ? 'queued' : 'in_progress');
          if (!result.ok && !cancelled) {
            const latest = await admission.storage.read(current, current.responseId);
            if (
              latest?.status === 'queued' &&
              latest.generationCreatedAt == null &&
              latest.cancellationRequestedAt != null
            ) {
              execution.abort();
              result = await publishEnrollment(latest, 'queued');
            }
          }
          if (!result.ok) throw new Error('Background response enrollment publication failed');
          admission.record = result.record;
          res.status(202).json({
            id: result.record.responseId,
            object: 'response',
            model: result.record.agentId,
            status: result.record.status,
            background: true,
            store: true,
          });
        },
        afterPause: async (execution) => {
          if (!execution.isPaused || !execution.ownsSettlement)
            throw new Error('Background response pause ownership changed');
          const current = await admission.storage.read(
            admission.record,
            admission.record.responseId,
          );
          if (current && current.generationCreatedAt !== execution.createdAt)
            throw new Error('Background response pause identity changed');
          if (
            current &&
            current.cancellationRequestedAt == null &&
            !['completed', 'failed', 'cancelled', 'incomplete'].includes(current.status)
          )
            return;
          if (!current) {
            const identity = await admission.storage.readCleanupIdentity(
              admission.record,
              admission.record.responseId,
              { ...admission.record, generationCreatedAt: execution.createdAt, ...checkpoint },
            );
            if (!identity?.retirement || identity.generationCreatedAt !== execution.createdAt)
              throw new Error('Background response pause retirement identity unavailable');
            const job = await continuation.jobs!.getJob(admission.record.responseId);
            if (!job) {
              // The owned settled pause proves local drain; this permits only checkpoint cleanup.
              if (identity.requiresCheckpointCleanup) {
                if (!identity.checkpointNamespace || !identity.checkpointConfigJSON)
                  throw new Error('Background response pause checkpoint identity unavailable');
                await cleanupResponseCheckpoint(
                  { ...identity, pendingTerminal: identity },
                  identity.checkpointNamespace,
                );
              }
              return;
            }
          }
          const stopped = await createResponseRetirement({
            storage: admission.storage,
            jobs: continuation.jobs!,
            cleanupCheckpoint: cleanupResponseCheckpoint,
          })(admission.record, admission.record.responseId);
          if (stopped !== 'stopped')
            throw new Error('Background response pause retirement is pending');
        },
        afterSettle: async (execution, error) => {
          let current = await admission.storage.read(admission.record, admission.record.responseId);
          if (!current || current.generationCreatedAt == null) {
            const retired = await admission.storage.readCleanupIdentity(
              admission.record,
              admission.record.responseId,
              { ...admission.record, generationCreatedAt: execution.createdAt, ...checkpoint },
            );
            if (retired?.retirement && retired.generationCreatedAt === execution.createdAt)
              current = { ...admission.record, ...retired };
            else if (
              current?.status === 'cancelled' &&
              current.cancellationRequestedAt != null &&
              current.generationCreatedAt == null
            ) {
              // Stop won the enrollment CAS. This exact local attempt must still release its drain proof.
              await completion!.finish({ ...current, generationCreatedAt: execution.createdAt });
              return;
            }
          }
          if (!current || current.generationCreatedAt !== execution.createdAt)
            throw new Error('Background response settlement identity changed');
          if (['completed', 'failed', 'cancelled', 'incomplete'].includes(current.status)) {
            await completion!.finish(current);
            return;
          }
          if (current.pendingTerminal || current.preparedTerminal) {
            admission.record = await completion!.finish(current);
            if (admission.record.preparedTerminal || admission.record.pendingTerminal)
              throw new Error('Background response terminal publication is pending');
            return;
          }
          const identity = await execution.confirmTerminalIdentity();
          // Normal manager teardown aborts the local signal too; only durable outcome/intent classifies Stop.
          const cancelled =
            identity.outcome === 'aborted' || current.cancellationRequestedAt != null;
          const result: TerminalResponse = candidate ?? {
            ...(previous() ?? buildPendingBackgroundResponse(current)),
            status: cancelled ? 'cancelled' : 'failed',
            completed_at: Math.floor(Date.now() / 1000),
            required_action: undefined,
            error: cancelled
              ? null
              : {
                  type: 'server_error',
                  code: 'execution_failed',
                  message: 'The Agent could not complete this request.',
                },
          };
          let final = result;
          if (cancelled)
            final = {
              ...result,
              status: 'cancelled',
              completed_at: Math.floor(Date.now() / 1000),
              error: null,
            };
          else if ((error || identity.outcome === 'error') && result.status === 'completed')
            final = {
              ...result,
              status: 'failed',
              completed_at: Math.floor(Date.now() / 1000),
              error: {
                type: 'server_error',
                code: 'execution_failed',
                message: 'The Agent could not complete this request.',
              },
            };

          admission.record = await completion!.stageAndFinish(current, {
            ...identity,
            status: final.status,
            responseJSON: JSON.stringify(final),
            ...(checkpoint ??
              (admission.resume && current.review?.checkpointConfigJSON
                ? {
                    checkpointNamespace: admission.resume.checkpointNamespace,
                    checkpointConfigJSON: current.review.checkpointConfigJSON,
                  }
                : {})),
          });
        },
      }
    : {};

  const settle = hooks.afterSettle;
  return {
    completion:
      admission && completion && settle
        ? {
            async prepare(response) {
              if (
                !enrolledExecution ||
                candidate ||
                !responseBody(response) ||
                response.id !== admission.record.responseId ||
                response.model !== admission.record.agentId ||
                response.store !== true
              )
                throw new Error('Background response output identity changed');
              const prepared = { ...response, background: true, store: true };
              const result = await completion.prepare(admission.record, {
                ...enrolledExecution.getPersistenceIdentity(),
                status: prepared.status,
                responseJSON: JSON.stringify(prepared),
                ...(checkpoint ??
                  (admission.resume && admission.record.review?.checkpointConfigJSON
                    ? {
                        checkpointNamespace: admission.resume.checkpointNamespace,
                        checkpointConfigJSON: admission.record.review.checkpointConfigJSON,
                      }
                    : {})),
              });
              if (result.retirement) return;
              admission.record = result;
              candidate = prepared;
            },
            afterSettle: async (execution, error) => {
              await settle(execution, error);
            },
          }
        : undefined,
    composeResponse,
    inputChain(chain) {
      if (!admission?.resume) {
        responseParentMessageId = chain.parentMessageId;
        return chain;
      }
      const action: Agents.PendingAction = JSON.parse(
        admission.record.review?.pendingActionJSON ?? 'null',
      );
      const parent = action?.resumeContext?.responseParentMessageId;
      if (typeof parent !== 'string' || parent.length === 0)
        throw new Error('Response resumed input identity unavailable');
      responseParentMessageId = parent;
      return { messages: [], parentMessageId: parent };
    },
    visibleOutputTokens,
    seedAggregator(aggregator) {
      if (!aggregator || seeded.has(aggregator)) return;
      const prior = previous();
      if (prior) seedResponseAggregator(aggregator, prior);
      seeded.add(aggregator);
    },
    async graphOptions(agents) {
      const hitlCapable = interactive;
      const request = req as ServerRequest;
      const policy = () =>
        hitlCapable
          ? {
              toolApprovalStorage: continuation.toolApprovalStorage,
              toolApprovalAllows: resolveRunToolApprovalAllows(
                request.config?.endpoints?.agents?.toolApproval,
                {
                  conversationId: admission!.record.conversationId,
                  toolApprovalAllows: [
                    ...new Set([
                      ...resolveRunToolApprovalAllows(
                        request.config?.endpoints?.agents?.toolApproval,
                        request.resolvedConversation,
                        admission!.record.conversationId,
                      ),
                      ...rememberedTools,
                    ]),
                  ],
                },
                admission!.record.conversationId,
              ),
            }
          : {};
      if (!admission?.resume) return { hitlCapable, ...policy() };
      const action: Agents.PendingAction = JSON.parse(
        admission.record.review?.pendingActionJSON ?? 'null',
      );
      if (!action || !agents) throw new Error('Response resume graph is unavailable');
      if (
        action.requestFingerprint !== computeLegacyAgentRequestFingerprint(request.body) ||
        action.requestFingerprintV2 !== computeAgentRequestFingerprint(request.body)
      )
        throw new Error('Response resume graph configuration changed');
      const retained = resolveCheckpointerConfig(
        checkpointerSchema.parse(
          JSON.parse(admission.record.review?.checkpointConfigJSON ?? 'null'),
        ),
      );
      const current = resolveCheckpointerConfig(
        (req as ServerRequest).config?.endpoints?.agents?.checkpointer,
      );
      if (
        retained.type !== 'mongo' ||
        current.type !== retained.type ||
        current.checkpointCollectionName !== retained.checkpointCollectionName ||
        current.checkpointWritesCollectionName !== retained.checkpointWritesCollectionName
      )
        throw new Error('Response checkpoint storage settings changed');
      const reviewedAgents = collectReachableAgents<ReviewAgentNode>(agents);
      assertCodeExecutionApprovalBinding(action.codeExecutionBinding, reviewedAgents);
      const participants = new Set(
        responseParticipantIds(admission.record.agentId, reviewedAgents),
      );
      const retainedParticipants = action.resumeAgentIds;
      if (
        !Array.isArray(retainedParticipants) ||
        retainedParticipants.length === 0 ||
        new Set(retainedParticipants).size !== retainedParticipants.length ||
        participants.size !== retainedParticipants.length ||
        retainedParticipants.some((id) => typeof id !== 'string' || !participants.has(id))
      )
        throw new Error('Response resume participants changed');
      const decision = responseReviewDecisionSchema.parse(
        JSON.parse(admission.record.resume?.decisionJSON ?? 'null'),
      );
      if (decision.actionId !== action.actionId)
        throw new Error('Response reviewed action changed');
      const discovered = action.resumeContext?.discoveredToolNames;
      if (
        discovered != null &&
        (!Array.isArray(discovered) || discovered.some((name) => typeof name !== 'string'))
      )
        throw new Error('Response discovered tools are unavailable');
      if (
        decision.decisions?.some((item) => item.decision === 'approve' && item.scope === 'session')
      ) {
        const { record, resume } = admission;
        const job = await continuation.jobs?.getJob(record.responseId);
        if (
          !continuation.addConvoToolApprovalAllows ||
          !enrolledExecution?.ownsSettlement ||
          enrolledExecution.createdAt !== record.generationCreatedAt ||
          !job ||
          job.status !== 'running' ||
          job.createdAt !== record.generationCreatedAt ||
          job.metadata.userId !== record.userId ||
          responseTenantId(job.metadata.tenantId) !== responseTenantId(record.tenantId) ||
          job.metadata.agent_id !== record.agentId ||
          job.metadata.endpoint !== 'responses' ||
          job.metadata.conversationId !== record.conversationId ||
          job.metadata.responseMessageId !== record.responseId ||
          job.metadata.providerExecutionId !== resume.providerExecutionId ||
          job.metadata.providerExecutionStartedId !== resume.providerExecutionId ||
          !job.metadata.providerExecutionOwnerId
        )
          throw new Error('Response remembered approval ownership unavailable');
        const request = req as ServerRequest;
        const persisted = await recordToolApprovalAllows({
          userId: record.userId,
          conversationId: record.conversationId,
          policy: request.config?.endpoints?.agents?.toolApproval,
          pendingAction: action,
          resolutions: decision.decisions,
          agents: reviewedAgents,
          hookContext: {
            userId: record.userId,
            tenantId: responseTenantId(record.tenantId),
            conversationId: record.conversationId,
            appConfig: request.config,
          },
          pluginHookSource: continuation.pluginHookSource,
          request,
          addConvoToolApprovalAllows: continuation.addConvoToolApprovalAllows,
        });
        rememberedTools = [...new Set([...rememberedTools, ...persisted])];
      }
      return {
        hitlCapable,
        ...policy(),
        sessionStartSource: 'resume',
        ...(Array.isArray(discovered) ? { discoveredToolNames: discovered } : {}),
        reviewedToolApprovals: {
          bindings: action.toolApprovalBindings,
          decisions: decision.decisions ?? [],
        },
      };
    },
    async completeTurn(input, complete) {
      if (!admission || !interactive || !continuation.jobs) return complete();
      if (!input.run.getInterrupt()) return complete();
      const request = req as ServerRequest;
      const config = request.config?.endpoints?.agents;
      const agents = collectReachableAgents<ReviewAgentNode>(input.agents);
      const aliases = getRunMCPToolAliases(input.run);
      const partial = {
        ...composeResponse(input.buildPartial()),
        status: 'in_progress' as const,
        background: true,
        store: true,
      };
      const paused = await pauseResponseForReview(
        {
          run: input.run,
          execution: input.execution,
          record: admission.record,
          partial,
          visibleOutputTokens: visibleOutputTokens(input.visibleOutputTokens),
          checkpointer: config?.checkpointer,
        },
        {
          storage: admission.storage,
          jobs: continuation.jobs,
          persistUnfinished: async (response) => {
            await input.persistence.saveConversation();
            await input.persistence.saveInput();
            await input.persistence.saveOutput(response);
          },
          buildAction: async (interrupt) => {
            const payload =
              interrupt.payload.type === 'tool_approval'
                ? markToolApprovalAllowAlways(
                    markNativeCodeToolApprovalRequests(interrupt.payload, agents),
                    {
                      policy: config?.toolApproval,
                      agents,
                      aliases,
                      storedTools: resolveRunToolApprovalAllows(
                        config?.toolApproval,
                        request.resolvedConversation,
                        admission.record.conversationId,
                      ),
                      hookContext: {
                        userId: admission.record.userId,
                        tenantId: responseTenantId(admission.record.tenantId),
                        conversationId: admission.record.conversationId,
                        appConfig: request.config,
                      },
                      pluginHookSource: continuation.pluginHookSource,
                    },
                  )
                : interrupt.payload;
            return captureRunPendingAction({
              run: input.run,
              payload,
              agents,
              resumeAgentIds: responseParticipantIds(admission.record.agentId, agents),
              aliases,
              context: {
                streamId: admission.record.responseId,
                responseMessageId: admission.record.responseId,
                conversationId: admission.record.conversationId,
                threadId: admission.record.conversationId,
                runId: interrupt.checkpointNs ?? admission.record.responseId,
                interruptId: interrupt.interruptId,
                ttlMs: getApprovalTtlMs(config?.checkpointer),
                projectContextKey: getChatProjectContextKey(request.chatProjectContext),
                requestFingerprint: computeLegacyAgentRequestFingerprint(request.body),
                requestFingerprintV2: computeAgentRequestFingerprint(request.body),
                resumeContext: {
                  ...pickResumeContext(request.body, request.reasoningOverrideBase),
                  discoveredToolNames: getRunDiscoveredTools(input.run),
                  responseParentMessageId,
                },
              },
            });
          },
        },
      );
      if (!paused && !input.execution.signal.aborted)
        throw new Error('Response interrupt could not be retained');
      return undefined;
    },
    graphMessages: (messages) => (admission?.resume ? [] : messages),
    async processRun(run, input, config, options) {
      if (!admission?.resume) {
        if (!admission || !interactive || !continuation.jobs)
          return run.processStream(input, config, options);
        const record = admission.record;
        const job = await continuation.jobs.getJob(record.responseId);
        const namespace = job?.metadata.checkpointNamespace;
        if (
          !job ||
          job.status !== 'running' ||
          job.createdAt !== record.generationCreatedAt ||
          job.metadata.userId !== record.userId ||
          responseTenantId(job.metadata.tenantId) !== responseTenantId(record.tenantId) ||
          job.metadata.agent_id !== record.agentId ||
          job.metadata.endpoint !== 'responses' ||
          job.metadata.responseMessageId !== record.responseId ||
          job.metadata.conversationId !== record.conversationId ||
          !namespace?.startsWith(checkpointOwnerNamespacePrefix(record.userId, record.tenantId))
        )
          throw new Error('Response checkpoint enrollment identity unavailable');
        const settings = resolveCheckpointerConfig(
          (req as ServerRequest).config?.endpoints?.agents?.checkpointer,
        );
        if (settings.type !== 'mongo')
          throw new Error('Response interrupt requires durable checkpoint storage');
        checkpoint = {
          checkpointNamespace: namespace,
          checkpointConfigJSON: JSON.stringify({
            type: settings.type,
            ttl: settings.ttlSeconds,
            checkpointCollectionName: settings.checkpointCollectionName,
            checkpointWritesCollectionName: settings.checkpointWritesCollectionName,
          }),
        };
        if (!continuation.jobs?.updateMetadata)
          throw new Error('Response checkpoint cleanup persistence unavailable');
        await continuation.jobs.updateMetadata(
          record.responseId,
          {
            responseCheckpointConfigJSON: checkpoint.checkpointConfigJSON,
          },
          job.createdAt,
        );
        return run.processStream(
          input,
          {
            ...config,
            configurable: {
              ...config.configurable,
              thread_id: record.conversationId,
              [LIBRECHAT_CHECKPOINT_NAMESPACE_KEY]: namespace,
            },
          },
          options,
        );
      }
      const { record, resume } = admission;
      if (
        record.resume?.intentId !== resume.intentId ||
        !record.review?.checkpointId ||
        record.review.checkpointNs == null
      )
        throw new Error('Response resume checkpoint identity unavailable');
      const resolution: unknown = JSON.parse(record.resume.resolutionJSON);
      return run.resume(
        resolution,
        {
          ...config,
          configurable: {
            ...config.configurable,
            thread_id: record.conversationId,
            checkpoint_id: record.review.checkpointId,
            checkpoint_ns: record.review.checkpointNs,
            [LIBRECHAT_CHECKPOINT_NAMESPACE_KEY]: resume.checkpointNamespace,
          },
        },
        options,
      );
    },
    toolContext: (execution) =>
      admission
        ? { streamId: admission.record.responseId, jobCreatedAt: execution.createdAt }
        : { streamId: null },
    responseId:
      admission?.record.responseId ?? (continuation.generateResponseId ?? generateResponseId)(),
    connection: admission
      ? undefined
      : {
          isClosed: () => res.destroyed === true && res.writableEnded !== true,
          onClose: (listener: () => void) => {
            const close = () => {
              if (res.writableEnded !== true) listener();
            };
            res.once('close', close);
            return () => {
              res.off('close', close);
            };
          },
        },
    hooks,
    async resolveContinuation(envelope: ResponsesRunEnvelope) {
      if (!admission)
        return resolveResponseContinuation(
          envelope.payload.previous_response_id,
          envelope.principal.userId,
          continuation,
        );
      const record = admission.record;
      if (
        envelope.principal.userId !== record.userId ||
        responseTenantId(envelope.principal.tenantId) !== responseTenantId(record.tenantId) ||
        envelope.payload.model !== record.agentId
      )
        throw new Error('Background response principal changed');
      return { conversationId: record.conversationId, parentMessageId: record.parentMessageId };
    },
  };
}
