import { createChatExpirationDate, createFallbackRetentionDate } from '@librechat/data-schemas';
import type {
  IUser,
  ResponseOwner,
  ResponseStorage,
  StoredResponseRecord,
  ConversationMethods,
} from '@librechat/data-schemas';
import type { ResponseReviewView } from 'librechat-data-provider';
import type { Request, RequestHandler } from 'express';
import type { ResponseDecisionDependencies, ResponseDecisionSubmission } from './decision';
import type { GenerationJobManagerClass } from '~/stream/GenerationJobManager';
import type { BackgroundResponseAuthorityDependencies } from './authority';
import type { BackgroundResponseTransportDependencies } from './transport';
import type { BackgroundResponseWorkerDependencies } from './worker';
import type { AgentTriggerService } from '../triggers/service';
import type { BackgroundResponseResult } from './background';
import type { BackgroundResponseQueue } from './queue';
import type { ServerRequest } from '~/types/http';
import type { BoundAddress } from '~/app/origin';
import {
  createResponseCompletion,
  createResponseExecutionRelease,
  createResponseExecutionConfirmation,
} from './completion';
import { createBackgroundResponseWorkerAuth, getBackgroundResponseWorkerRecord } from './worker';
import { createBackgroundResponseTransport, createResponseResumeTransport } from './transport';
import { resolveImportRetentionFields, isTemporaryRecord } from '~/conversations/retention';
import { createBackgroundResponseQueue, createResponseResumeQueue } from './queue';
import { createBackgroundResponseAuthority } from './authority';
import { createBackgroundResponseService } from './background';
import { createBackgroundResponseHttpHandlers } from './http';
import { createResponseDecisionSubmission } from './decision';
import { resolveResponseContinuation } from './persistence';
import { cleanupResponseCheckpoint } from './checkpoint';
import { createResponseRetirement } from './retirement';
import { createResponseDispatchOutbox } from './outbox';
import { createResponseReview } from './review';
import { responseTenantId } from './scope';

export interface BackgroundResponsesHostDependencies
  extends BackgroundResponseAuthorityDependencies {
  storage: ResponseStorage;
  enqueue: AgentTriggerService['enqueue'];
  /** Reuse the queue owner’s live producer capability; listener binding alone is insufficient. */
  isQueueReady: AgentTriggerService['isReady'];
  jobs: Pick<
    GenerationJobManagerClass,
    'getJob' | 'abortJob' | 'getResumeState' | 'finishProviderTerminalPersistence'
  >;
  publicBaseURL?: string;
  getMessage: Parameters<typeof resolveResponseContinuation>[2]['getMessage'];
  getConvoRetention: ConversationMethods['getConvoRetention'];
  signingSecret: () => string;
  onError: (error: unknown) => void;
  fetch?: BackgroundResponseTransportDependencies['fetch'];
  decisions?: Pick<ResponseDecisionDependencies, 'validate' | 'enqueue'>;
  /** Install together: owner validation, durable dispatch, and same-checkpoint worker admission. */
  interactive?: {
    validate: ResponseDecisionDependencies['validate'];
    admitResume: NonNullable<BackgroundResponseWorkerDependencies['admitResume']>;
  };
}

export interface BackgroundResponsesHost {
  /** Trusted transports must derive this owner from current actor/source authority. Never expose directly as service-token authority. */
  readInteractiveReview: (
    owner: ResponseOwner,
    responseId: string,
  ) => Promise<ResponseReviewView | null>;
  submitInteractiveReview: ResponseDecisionSubmission;
  review: RequestHandler;
  submitReview: RequestHandler;
  cancelReview: RequestHandler;
  retireResponse: (owner: ResponseOwner, responseId: string) => Promise<'stopped' | 'pending'>;
  readResponse: (owner: ResponseOwner, responseId: string) => Promise<BackgroundResponseResult>;
  cancelResponse: (owner: ResponseOwner, responseId: string) => Promise<BackgroundResponseResult>;
  sourceDispatchers: BackgroundResponseQueue['sourceDispatchers'];
  initialize: (address: BoundAddress | string | null) => void;
  authenticate: (ordinary: RequestHandler) => RequestHandler;
  handlers: (ordinary: { create: RequestHandler; retrieve: RequestHandler }) => {
    create: RequestHandler;
    retrieve: RequestHandler;
    cancel: RequestHandler;
  };
}

/** A scoped execution credential is not the owner's interactive browser authority. */
function ownerReviewUser(req: Request): IUser | undefined {
  if (
    getBackgroundResponseWorkerRecord(req) ||
    ('_isAgentTrigger' in req && req._isAgentTrigger === true) ||
    ('apiKeyId' in req && req.apiKeyId != null)
  )
    return;
  return (req as ServerRequest).user;
}

export function createBackgroundResponsesHost(
  deps: BackgroundResponsesHostDependencies,
): BackgroundResponsesHost {
  if (deps.decisions && deps.interactive)
    throw new Error('Response decision transport must have one owner');
  let listener: BoundAddress | undefined;
  const isAdmissionReady = () => listener != null && deps.isQueueReady();
  const authorize = createBackgroundResponseAuthority(deps);
  const review = createResponseReview(deps);
  const completion = createResponseCompletion({
    storage: deps.storage,
    cleanupCheckpoint: cleanupResponseCheckpoint,
    releaseExecution: createResponseExecutionRelease(deps.jobs),
    confirmExecution: createResponseExecutionConfirmation(deps.jobs),
  });
  const retire = createResponseRetirement({
    storage: deps.storage,
    jobs: deps.jobs,
    now: deps.now,
    cleanupCheckpoint: cleanupResponseCheckpoint,
    recoverTerminal: completion.finish,
  });
  const transportDependencies: BackgroundResponseTransportDependencies = {
    storage: deps.storage,
    signingSecret: deps.signingSecret,
    fetch: deps.fetch,
    getOrigin: () => {
      if (!listener) throw new Error('Background Responses local listener is not initialized');
      return listener;
    },
    acknowledgementTimeoutMs: async (record) => {
      const user = await deps.findUser(record.userId);
      if (!user || responseTenantId(user.tenantId) !== responseTenantId(record.tenantId))
        throw new Error('Response principal unavailable');
      const timeout = (await deps.getConfig(user)).endpoints?.agents?.remoteApi?.background
        ?.acknowledgementTimeoutMs;
      if (timeout == null)
        throw new Error('Background response acknowledgement policy unavailable');
      return timeout;
    },
  };
  const transport = createBackgroundResponseTransport(transportDependencies);
  const queue = createBackgroundResponseQueue({
    storage: deps.storage,
    enqueue: deps.enqueue,
    authorize: (record) => authorize(record, record.agentId, record.sourceKeyId),
    execute: transport,
  });
  const resumeQueue = deps.interactive
    ? createResponseResumeQueue({
        storage: deps.storage,
        enqueue: deps.enqueue,
        authorize: (record) => authorize(record, record.agentId, record.sourceKeyId),
        resume: createResponseResumeTransport({ ...transportDependencies, jobs: deps.jobs }),
      })
    : undefined;
  const decisions =
    deps.interactive && resumeQueue
      ? { validate: deps.interactive.validate, enqueue: resumeQueue.enqueue }
      : deps.decisions;

  const outbox = createResponseDispatchOutbox({
    isReady: isAdmissionReady,
    storage: deps.storage,
    create: queue,
    resume: resumeQueue ?? (decisions ? { enqueue: decisions.enqueue } : undefined),
    authorize: (record) => authorize(record, record.agentId, record.sourceKeyId),
    retire: (record) => retire(record, record.responseId),
    onError: deps.onError,
  });

  const submitInteractiveReview: ResponseDecisionSubmission = async (owner, responseId, input) => {
    if (!decisions) return { ok: false, status: 409, code: 'response_decision_unavailable' };
    if (!isAdmissionReady())
      return { ok: false, status: 503, code: 'response_decision_unavailable' };
    return createResponseDecisionSubmission({
      storage: deps.storage,
      jobs: deps.jobs,
      now: deps.now,
      onDispatchError: deps.onError,
      ...decisions,
      authorize: (record) => authorize(record, record.agentId, record.sourceKeyId),
    })(owner, responseId, input);
  };

  function service(req?: Request) {
    const user = (req as ServerRequest | undefined)?.user;
    return createBackgroundResponseService({
      storage: deps.storage,
      enqueue: queue.enqueue,
      onDispatchError: deps.onError,
      deliveryKey: queue.deliveryKey,
      authorize: (owner, agentId, keyId) => authorize(owner, agentId, keyId, user),
      resolveContinuation: async (owner, previous) => {
        const continuation = await resolveResponseContinuation(previous, owner.userId, {
          getMessage: deps.getMessage,
        });
        const stored = previous
          ? await deps.getConvoRetention(owner.userId, continuation.conversationId)
          : null;
        if (previous && !stored) throw new Error('Response continuation is unavailable');
        const principal = user ?? (await deps.findUser(owner.userId));
        if (!principal) throw new Error('Response principal unavailable');
        const config = await deps.getConfig(principal);
        const policy = resolveImportRetentionFields(
          config.interfaceConfig,
          {
            createChatExpirationDate,
            createFallbackRetentionDate,
          },
          { sourceIsTemporary: isTemporaryRecord(stored ?? {}) },
        );
        let expiredAt = stored?.expiredAt ?? policy.expiredAt;
        if (policy.expiredAt && (!expiredAt || policy.expiredAt < expiredAt))
          expiredAt = policy.expiredAt;
        if (!expiredAt && stored && isTemporaryRecord(stored))
          expiredAt = createChatExpirationDate(config.interfaceConfig, true);
        return {
          ...continuation,
          ...(expiredAt ? { expiredAt } : {}),
          isTemporary: policy.isTemporary ?? isTemporaryRecord(stored ?? {}),
        };
      },
      // Runtime publication is authoritative; observers never reconstruct a terminal reply from progress.
      observe: review.observe,
      recoverTerminal: completion.finish,
      cancel: async (record) => {
        await retire(record, record.responseId);
      },
    });
  }

  return {
    submitInteractiveReview,
    readInteractiveReview: async (owner, responseId) => {
      const record = await deps.storage.read(owner, responseId);
      if (!record || !(await authorize(record, record.agentId, record.sourceKeyId))) return null;
      const view = await review.privateView(await completion.finish(record));
      // OAuth URLs stay behind the existing owner-authenticated browser flow.
      return {
        responseId: view.responseId,
        status: view.status,
        ...(view.recovery ? { recovery: view.recovery } : {}),
        oauth: [],
        pendingAction: view.pendingAction,
        pendingDecision: view.pendingDecision,
        canSubmitDecision: decisions != null && isAdmissionReady(),
      };
    },
    review: async (req, res) => {
      res.set('Cache-Control', 'no-store');
      res.set('Referrer-Policy', 'no-referrer');
      const user = ownerReviewUser(req);
      if (!user?.id) return void res.status(401).json({ error: 'unauthorized' });
      try {
        const owner = { userId: user.id, tenantId: responseTenantId(user.tenantId) };
        const record = await deps.storage.read(owner, req.params.id);
        if (!record || !(await authorize(owner, record.agentId, record.sourceKeyId, user)))
          return void res.status(404).json({ error: 'response_not_found' });
        const recovered = await completion.finish(record);
        res.json({
          ...(await review.privateView(recovered)),
          canSubmitDecision: decisions != null && isAdmissionReady(),
        });
      } catch (error) {
        deps.onError(error);
        res.status(503).json({ error: 'response_service_unavailable' });
      }
    },
    submitReview: async (req, res) => {
      res.set('Cache-Control', 'no-store');
      res.set('Referrer-Policy', 'no-referrer');
      const user = ownerReviewUser(req);
      if (!user?.id) return void res.status(401).json({ error: 'unauthorized' });
      if (!decisions || !isAdmissionReady())
        return void res.status(503).json({ error: 'response_decision_unavailable' });
      const submit = createResponseDecisionSubmission({
        storage: deps.storage,
        jobs: deps.jobs,
        now: deps.now,
        onDispatchError: deps.onError,
        ...decisions,
        authorize: (record) => authorize(record, record.agentId, record.sourceKeyId, user),
      });
      try {
        const result = await submit(
          { userId: user.id, tenantId: responseTenantId(user.tenantId) },
          req.params.id,
          req.body,
        );
        if (!result.ok) return void res.status(result.status).json({ error: result.code });
        res.status(202).json(result.receipt);
      } catch (error) {
        deps.onError(error);
        res.status(503).json({ error: 'response_service_unavailable' });
      }
    },
    cancelReview: async (req, res) => {
      res.set('Cache-Control', 'no-store');
      res.set('Referrer-Policy', 'no-referrer');
      const user = ownerReviewUser(req);
      if (!user?.id) return void res.status(401).json({ error: 'unauthorized' });
      try {
        const result = await service(req).cancel(
          { userId: user.id, tenantId: responseTenantId(user.tenantId) },
          req.params.id,
        );
        if (!result.ok) return void res.status(result.status).json({ error: result.code });
        res.json(result.response);
      } catch (error) {
        deps.onError(error);
        res.status(503).json({ error: 'response_service_unavailable' });
      }
    },
    retireResponse: retire,
    readResponse: (owner, responseId) => service().retrieve(owner, responseId),
    cancelResponse: (owner, responseId) => service().cancel(owner, responseId),
    sourceDispatchers: new Map([
      ...[...queue.sourceDispatchers].map(
        ([name, source]) => [name, { ...source, recoverPending: outbox.recoverPending }] as const,
      ),
      ...(resumeQueue?.sourceDispatchers ?? []),
    ]),
    initialize: (address: BoundAddress | string | null) => {
      listener = address != null && typeof address !== 'string' ? { ...address } : undefined;
    },
    authenticate: (ordinary: RequestHandler) =>
      createBackgroundResponseWorkerAuth(
        {
          storage: deps.storage,
          signingSecret: deps.signingSecret,
          findUser: deps.findUser,
          onError: deps.onError,
          admitResume: deps.interactive?.admitResume,
          authorize: (record: StoredResponseRecord, user: IUser) =>
            authorize(record, record.agentId, record.sourceKeyId, user),
        },
        ordinary,
      ),
    handlers: (ordinary: { create: RequestHandler; retrieve: RequestHandler }) =>
      createBackgroundResponseHttpHandlers({
        isAdmissionReady,
        service,
        ordinary,
        onError: deps.onError,
      }),
  };
}
