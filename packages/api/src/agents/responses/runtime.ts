import { randomUUID } from 'node:crypto';
import { responseReference } from '@librechat/data-schemas';
import { checkpointerSchema, responseReviewDecisionSchema } from 'librechat-data-provider';
import type { ResponseTerminalReceipt, StoredResponseRecord } from '@librechat/data-schemas';
import type { Request, Response as HttpResponse } from 'express';
import type { Agents } from 'librechat-data-provider';
import type { Run, IState } from '@librechat/agents';
import type {
  ResponseTerminalCompletion,
  ResponseConversationInput,
  ResponsePersistenceDependencies,
} from './foreground';
import type { ExecuteAgentRunParams, AgentExecutionConnection } from '../remote/host';
import type { GenerationJobManagerClass } from '~/stream/GenerationJobManager';
import type { MarkToolApprovalAllowAlwaysOptions } from '../hitl/allow';
import type { CheckpointWriteWitness } from '../checkpoints/witness';
import type { AgentExecutionEnrollment } from '../remote/lifecycle';
import type { TurnConversationRequest } from '~/conversations/save';
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
import { createCheckpointWriteWitness } from '../checkpoints/witness';
import { getRunDiscoveredTools, getRunMCPToolAliases } from '../run';
import { markNativeCodeToolApprovalRequests } from '../hitl/byom';
import { assertCodeExecutionApprovalBinding } from '../execution';
import { getBackgroundResponseWorkerAdmission } from './worker';
import { matchesResponseRoot, responseTenantId } from './scope';
import { createResponseConversationWrites } from './foreground';
import { normalizeResponseTurnIntent } from './turnProjection';
import { getChatProjectContextKey } from '~/projects/context';
import { buildPendingBackgroundResponse } from './background';
import { resolveResponseContinuation } from './persistence';
import { ResponseDocumentLimitError } from './persistence';
import { captureRunPendingAction } from '../hitl/capture';
import { cleanupResponseCheckpoint } from './checkpoint';
import { createResponseRetirement } from './retirement';
import { collectReachableAgents } from '../traversal';
import { pauseResponseForReview } from './pause';
import { generateResponseId } from './service';

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
  readonly conversationTarget?: StoredResponseRecord['conversationTarget'];
  completion?: ResponseTerminalCompletion;
  responseId: string;
  prepareConversation: (
    input: ResponseConversationInput,
    deps: Pick<ResponsePersistenceDependencies, 'resolveTitle'>,
  ) => Promise<void>;
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
      | 'checkpointWriteWitness'
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
    | 'onProviderStarted'
    | 'afterPause'
    | 'afterSettle'
    | 'clientRequestId'
    | 'resume'
    | 'retainTerminalPersistence'
    | 'responseRoot'
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
  let checkpointWriteWitness: CheckpointWriteWitness | undefined;
  let checkpointWriter:
    | ReturnType<NonNullable<typeof admission>['storage']['createCheckpointWriter']>
    | undefined;
  function checkpointOptions() {
    if (!interactive) return {};
    checkpointWriteWitness ??= createCheckpointWriteWitness({
      async open() {
        if (!checkpointWriter || !(await checkpointWriter.open()))
          throw new Error('Response checkpoint writer admission conflicted');
      },
      async settle() {
        if (!checkpointWriter || !(await checkpointWriter.settle()))
          throw new Error('Response checkpoint writer settlement conflicted');
      },
    });
    return { checkpointWriteWitness };
  }
  function bindCheckpointWriter(descriptor: NonNullable<typeof checkpoint>) {
    if (!admission || !enrolledExecution || !checkpointWriteWitness || checkpointWriter)
      throw new Error('Response checkpoint writer binding is unavailable');
    checkpointWriter = admission.storage.createCheckpointWriter(
      responseReference(admission.record),
      {
        ...enrolledExecution.getPersistenceIdentity(),
        writerId: randomUUID(),
        namespace: descriptor.checkpointNamespace,
        configJSON: descriptor.checkpointConfigJSON,
      },
    );
  }
  async function processCheckpointRun<T>(operation: () => Promise<T>): Promise<T> {
    const result = await Promise.resolve()
      .then(operation)
      .then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
    if (!checkpointWriteWitness || (await checkpointWriteWitness.close()) !== 'settled')
      throw new Error('Response checkpoint settlement is pending');
    if (!result.ok) throw result.error;
    return result.value;
  }

  let rememberedTools: string[] = [];
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
  let executionEnrolled = false;
  const completion = admission
    ? createResponseCompletion({
        storage: admission.storage,
        cleanupCheckpoint: cleanupResponseCheckpoint,
        confirmExecution: createResponseExecutionConfirmation(
          admission.storage,
          continuation.jobs!,
        ),
        releaseExecution: createResponseExecutionRelease(continuation.jobs!, admission.storage),
      })
    : undefined;
  const hooks: Pick<
    ExecuteAgentRunParams<unknown>,
    | 'onEnrolled'
    | 'onProviderStarted'
    | 'afterPause'
    | 'afterSettle'
    | 'clientRequestId'
    | 'resume'
    | 'retainTerminalPersistence'
    | 'responseRoot'
  > = admission
    ? {
        retainTerminalPersistence: true,
        responseRoot: responseReference(admission.record).target,
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
          if (!current) throw new Error('Background response journal is unavailable');
          if (
            !matchesResponseRoot(current, {
              responseRootId: execution.responseRoot?.id,
              responseRootIncarnation: execution.responseRoot?.incarnation,
            })
          )
            throw new Error('Background response job root identity changed');
          const binding = execution.getEnrollmentIdentity();
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
            if (current.cancellationRequestedAt != null) execution.abort();
            const resumed = await admission.storage.enrollExecution(
              current,
              binding,
              current.responseJSON ?? '{}',
            );
            if (!resumed.ok) throw new Error('Background response resume enrollment changed');
            admission.record = resumed.record;
            executionEnrolled = true;
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
            admission.storage.enrollExecution(
              record,
              binding,
              JSON.stringify({ ...buildPendingBackgroundResponse(record), status }),
            );
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
          executionEnrolled = true;
          res.status(202).json({
            id: result.record.responseId,
            object: 'response',
            model: result.record.agentId,
            status: result.record.status,
            background: true,
            store: true,
          });
        },
        onProviderStarted: async (execution) => {
          if (
            !(await admission.storage.bindExecution(
              admission.record,
              execution.getPersistenceIdentity(),
            ))
          )
            throw new Error('Background response provider ownership changed');
        },
        afterPause: async (execution) => {
          if (!execution.isPaused || !execution.ownsSettlement)
            throw new Error('Background response pause ownership changed');
          if (
            executionEnrolled &&
            !(await admission.storage.settleExecution(
              responseReference(admission.record),
              execution.getEnrollmentIdentity(),
            ))
          )
            throw new Error('Background response pause drain proof conflicted');
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
          const stopped = await createResponseRetirement({
            storage: admission.storage,
            jobs: continuation.jobs!,
            cleanupCheckpoint: cleanupResponseCheckpoint,
          })(admission.record, admission.record.responseId);
          if (stopped !== 'stopped')
            throw new Error('Background response pause retirement is pending');
        },
        afterSettle: async (execution, error) => {
          const identity = await execution.confirmTerminalIdentity();
          if (
            executionEnrolled &&
            !(await admission.storage.settleExecution(
              responseReference(admission.record),
              identity,
              identity.outcome,
            ))
          )
            throw new Error('Background response terminal drain proof conflicted');
          let current = await admission.storage.read(admission.record, admission.record.responseId);
          if (!current || current.generationCreatedAt == null) {
            const retired = await admission.storage.readCleanupIdentity(
              admission.record,
              admission.record.responseId,
              {
                ...admission.record,
                generationCreatedAt: executionEnrolled
                  ? execution.createdAt
                  : admission.record.generationCreatedAt,
                ...checkpoint,
              },
            );
            if (retired?.retirement && retired.generationCreatedAt == null) {
              const stopped = await createResponseRetirement({
                storage: admission.storage,
                jobs: continuation.jobs!,
                cleanupCheckpoint: cleanupResponseCheckpoint,
              })(admission.record, admission.record.responseId, retired);
              if (stopped !== 'stopped')
                throw new Error('Background response unused execution retirement is pending');
              return;
            }
            if (retired?.retirement && retired.generationCreatedAt === execution.createdAt)
              current = { ...admission.record, ...retired };
          }
          if (
            current &&
            !executionEnrolled &&
            current.generationCreatedAt == null &&
            ['completed', 'failed', 'cancelled', 'incomplete'].includes(current.status)
          ) {
            await completion!.finish(current);
            return;
          }
          if (!current || current.generationCreatedAt !== execution.createdAt)
            throw new Error('Background response settlement identity changed');
          if (['completed', 'failed', 'cancelled', 'incomplete'].includes(current.status)) {
            await completion!.finish(current);
            return;
          }
          if (current.persistenceFailure || current.pendingTerminal || current.preparedTerminal) {
            admission.record = await completion!.finish(current);
            return;
          }
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
    get conversationTarget() {
      return admission?.record.conversationTarget;
    },
    completion:
      admission && completion && settle
        ? {
            async prepare(response, turnJSON) {
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
                ...(turnJSON == null
                  ? {}
                  : { turnJSON: normalizeResponseTurnIntent(admission.record, turnJSON) }),
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
              if (
                !admission.record.preparedTerminal &&
                !admission.record.pendingTerminal &&
                !('retirement' in admission.record) &&
                admission.record.responseJSON &&
                ['completed', 'failed', 'incomplete', 'cancelled'].includes(admission.record.status)
              )
                return JSON.parse(admission.record.responseJSON) as Response;
            },
          }
        : undefined,
    composeResponse,
    async prepareConversation(input, deps) {
      if (!admission) return;
      if (!enrolledExecution) throw new Error('Background response enrollment is unavailable');
      const prepared = await admission.storage.prepareConversation(
        admission.record,
        enrolledExecution.getPersistenceIdentity(),
        createResponseConversationWrites(input, deps),
      );
      if (!prepared.ok) throw new Error('Background response conversation is unavailable');
      admission.record = prepared.record;
      if (prepared.record.expiredAt)
        (req as TurnConversationRequest)._agentEventBindingRetention = {
          expiredAt: prepared.record.expiredAt,
          isTemporary: prepared.record.isTemporary,
        };
    },
    inputChain(chain) {
      if (!admission?.resume) return chain;
      return { messages: [], parentMessageId: admission.record.parentMessageId };
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
      if (!admission?.resume) return { hitlCapable, ...policy(), ...checkpointOptions() };
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
          !matchesResponseRoot(record, job.metadata) ||
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
        ...checkpointOptions(),
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
      let paused: boolean;
      try {
        paused = await pauseResponseForReview(
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
                  },
                },
              });
            },
          },
        );
      } catch (error) {
        if (error instanceof ResponseDocumentLimitError && completion) {
          admission.record = await completion.fail(
            admission.record,
            input.execution.getPersistenceIdentity(),
            'document_limit',
          );
        }
        throw error;
      }
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
          !matchesResponseRoot(record, job.metadata) ||
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
        bindCheckpointWriter(checkpoint);
        return processCheckpointRun(() =>
          run.processStream(
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
          ),
        );
      }
      const { record, resume } = admission;
      if (
        record.resume?.intentId !== resume.intentId ||
        !record.review?.checkpointId ||
        record.review.checkpointNs == null
      )
        throw new Error('Response resume checkpoint identity unavailable');
      if (!record.review.checkpointConfigJSON)
        throw new Error('Response resume checkpoint settings unavailable');
      bindCheckpointWriter({
        checkpointNamespace: resume.checkpointNamespace,
        checkpointConfigJSON: record.review.checkpointConfigJSON,
      });
      const resolution: unknown = JSON.parse(record.resume.resolutionJSON);
      const { checkpointId, checkpointNs } = record.review;
      return processCheckpointRun(() =>
        run.resume(
          resolution,
          {
            ...config,
            configurable: {
              ...config.configurable,
              thread_id: record.conversationId,
              checkpoint_id: checkpointId,
              checkpoint_ns: checkpointNs,
              [LIBRECHAT_CHECKPOINT_NAMESPACE_KEY]: resume.checkpointNamespace,
            },
          },
          options,
        ),
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
