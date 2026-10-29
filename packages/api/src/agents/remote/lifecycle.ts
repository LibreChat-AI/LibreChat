import { randomUUID } from 'node:crypto';
import type { Agents } from 'librechat-data-provider';
import type { ApprovalPauseOptions } from '~/stream/ApprovalLifecycle';
import type { GenerationJobManagerClass } from '~/stream';
import type { GenerationJob } from '~/types/stream';
import { GenerationJobManager, GenerationAdmissionDeniedError } from '~/stream';

const ACCOUNT_DELETION_ERROR = 'Account deletion is in progress';
const REMOTE_EXECUTION_ERROR = 'Remote agent execution failed';

export class AgentExecutionAdmissionError extends Error {
  readonly code: 'ACCOUNT_DELETION_IN_PROGRESS' | 'RUN_REPLACED' | 'RUN_ALREADY_ADMITTED';
  readonly status = 409;

  constructor(message: string, code: AgentExecutionAdmissionError['code']) {
    super(message);
    this.name = 'AgentExecutionAdmissionError';
    this.code = code;
  }
}

export interface AgentExecutionEnrollmentParams {
  runId: string;
  userId: string;
  conversationId: string;
  agentId: string;
  protocol: 'chat.completions' | 'responses';
  isPrincipalActive: (userId: string) => Promise<boolean>;
  clientRequestId?: string;
  retainTerminalPersistence?: true;
}

export interface AgentExecutionEnrollmentDeps {
  manager: GenerationJobManagerClass;
}

export async function waitForAgentExecutionWrites<T>(writes: readonly Promise<T>[]): Promise<void> {
  const results = await Promise.allSettled(writes);
  const failure = results.find((result) => result.status === 'rejected');
  if (failure?.status === 'rejected') {
    throw failure.reason;
  }
}

export class AgentExecutionEnrollment {
  readonly runId: string;
  readonly createdAt: number;
  readonly signal: AbortSignal;

  private readonly manager: GenerationJobManagerClass;
  private readonly providerExecutionId: string;
  private readonly abortController: AbortController;
  private readonly ownerId?: string;
  private readonly retainTerminalPersistence?: true;
  private readonly trailingWrites: Promise<unknown>[] = [];
  private providerStarted = false;
  private providerStartRejected = false;
  private settlement?: Promise<void>;
  private pendingPause?: string;
  private paused = false;

  get isPaused(): boolean {
    return this.paused;
  }

  /** A definitive start-CAS loser owns neither terminal publication nor provider drain. */
  get isStartRejected(): boolean {
    return this.providerStartRejected;
  }

  get ownsSettlement(): boolean {
    return !this.providerStartRejected && (this.ownerId == null || this.providerStarted);
  }

  constructor(
    manager: GenerationJobManagerClass,
    job: GenerationJob,
    ownerId?: string,
    retainTerminalPersistence?: true,
  ) {
    const providerExecutionId = job.metadata.providerExecutionId;
    if (!providerExecutionId) {
      throw new Error('Agent execution enrollment is missing its provider identity');
    }
    this.manager = manager;
    this.ownerId = ownerId;
    this.retainTerminalPersistence = retainTerminalPersistence;
    this.runId = job.streamId;
    this.createdAt = job.createdAt;
    this.providerExecutionId = providerExecutionId;
    this.abortController = job.abortController;
    this.signal = job.abortController.signal;
  }

  abort(reason?: unknown): void {
    this.abortController.abort(reason);
  }

  track<T>(write: Promise<T>): Promise<T> {
    if (this.settlement) {
      throw new Error('Agent execution enrollment is already settling');
    }
    this.trailingWrites.push(write);
    void write.catch(() => undefined);
    return write;
  }

  async beginProviderExecution(): Promise<void> {
    if (this.providerStarted) {
      throw new Error('Agent provider execution has already started');
    }
    if (this.signal.aborted) {
      throw new AgentExecutionAdmissionError(
        'Agent execution stopped before provider startup',
        'RUN_REPLACED',
      );
    }
    let started: boolean;
    try {
      started =
        this.ownerId == null
          ? await this.manager.beginProviderExecution(
              this.runId,
              this.createdAt,
              this.providerExecutionId,
            )
          : await this.manager.beginProviderExecution(
              this.runId,
              this.createdAt,
              this.providerExecutionId,
              this.ownerId,
            );
    } catch (error) {
      /** Legacy enrollment owns its unique segment. A resumed attempt instead needs its
       * exact start receipt; the manager reconciles that receipt before returning success.
       * An unresolved failure is not authority to terminalize or drain another attempt. */
      if (this.ownerId == null) this.providerStarted = true;
      else this.providerStartRejected = true;
      throw error;
    }
    if (!started) {
      this.providerStartRejected = true;
      throw new AgentExecutionAdmissionError(
        'Agent execution stopped before provider startup',
        'RUN_REPLACED',
      );
    }
    this.providerStarted = true;
    if (this.signal.aborted) {
      throw new AgentExecutionAdmissionError(
        'Agent execution stopped before provider startup',
        'RUN_REPLACED',
      );
    }
  }

  /** The SDK checkpoint must already be durable; persist its unfinished turn behind the shared barrier. */
  async pauseForReview(
    action: Agents.PendingAction,
    persist: () => Promise<void>,
    options: Omit<
      ApprovalPauseOptions,
      'expectedCreatedAt' | 'expectedProviderExecutionId' | 'persistencePending'
    > = {},
  ): Promise<boolean> {
    if (this.settlement || this.pendingPause || !this.providerStarted)
      throw new Error('Agent execution cannot publish another pause');
    if (this.manager.getJobStore().providerGuardedStatusTransitions !== true)
      throw new Error('Agent review requires provider-guarded status transitions');
    if (this.signal.aborted) return false;
    const job = await this.manager.getJob(this.runId);
    if (
      job?.createdAt !== this.createdAt ||
      job.status !== 'running' ||
      job.metadata.providerExecutionId !== this.providerExecutionId
    )
      return false;
    if (
      action.streamId !== this.runId ||
      action.responseMessageId !== this.runId ||
      action.conversationId !== job.metadata.conversationId ||
      !action.actionId
    )
      throw new Error('Agent approval identity changed');
    const pauseOptions = {
      ...options,
      expectedCreatedAt: this.createdAt,
      expectedProviderExecutionId: this.providerExecutionId,
      persistencePending: true,
    };
    let published: boolean;
    try {
      published = await this.manager.approvals.pause(this.runId, action, pauseOptions);
    } catch (error) {
      // A lost CAS acknowledgement is not permission to publish a second action.
      if (
        !(await this.manager.approvals.ownsPausePersistence(
          this.runId,
          action.actionId,
          this.createdAt,
          this.providerExecutionId,
        ))
      )
        throw error;
      published = true;
    }
    if (!published) return false;
    this.pendingPause = action.actionId;
    try {
      if (
        !(await this.manager.approvals.ownsPausePersistence(
          this.runId,
          action.actionId,
          this.createdAt,
          this.providerExecutionId,
        ))
      )
        throw new Error('Agent approval persistence ownership changed');
      await persist();
    } catch (error) {
      await this.manager.failPausePersistence(
        this.runId,
        action.actionId,
        REMOTE_EXECUTION_ERROR,
        this.createdAt,
        this.providerExecutionId,
      );
      throw error;
    }
    return true;
  }

  settle(error?: unknown): Promise<void> {
    this.settlement ??= this.settleInternal(error);
    return this.settlement;
  }

  /** The journal may retain this proof after the generation's transient job expires. */
  async confirmTerminalIdentity(): Promise<{
    generationCreatedAt: number;
    providerExecutionId: string;
    ownerId?: string;
    outcome: 'complete' | 'error' | 'aborted';
  }> {
    if (!this.settlement || !this.ownsSettlement || this.isPaused)
      throw new Error('Agent terminal ownership is unavailable');
    await this.settlement;
    const job = await this.manager.getJob(this.runId);
    if (
      !job ||
      job.createdAt !== this.createdAt ||
      job.metadata.providerExecutionId !== this.providerExecutionId ||
      job.metadata.providerDrained !== true ||
      ['running', 'requires_action'].includes(job.status) ||
      (this.ownerId != null && job.metadata.providerExecutionOwnerId !== this.ownerId)
    )
      throw new Error('Agent terminal settlement could not be confirmed');
    let outcome: 'complete' | 'error' | 'aborted' = 'complete';
    if (job.status === 'aborted') outcome = 'aborted';
    else if (job.status === 'error') outcome = 'error';
    return {
      generationCreatedAt: this.createdAt,
      providerExecutionId: this.providerExecutionId,
      outcome,
      ...(this.ownerId == null ? {} : { ownerId: this.ownerId }),
    };
  }

  private complete(error?: unknown): Promise<boolean> {
    const args = [
      this.runId,
      error == null ? undefined : REMOTE_EXECUTION_ERROR,
      this.createdAt,
    ] as const;
    if (this.manager.getJobStore().providerGuardedStatusTransitions !== true)
      return this.manager.completeJob(...args);
    return this.manager.completeJob(...args, {
      expectedProviderExecutionId: this.providerExecutionId,
      persistencePending: this.retainTerminalPersistence,
    });
  }

  private async settleInternal(error?: unknown): Promise<void> {
    if (!this.ownsSettlement) {
      await waitForAgentExecutionWrites(this.trailingWrites);
      return;
    }
    if (this.pendingPause && error == null) return this.settlePause(this.pendingPause);
    if (this.pendingPause) {
      try {
        await this.manager.failPausePersistence(
          this.runId,
          this.pendingPause,
          REMOTE_EXECUTION_ERROR,
          this.createdAt,
          this.providerExecutionId,
        );
      } catch (pauseError) {
        await Promise.allSettled(this.trailingWrites);
        this.manager.abandonProviderExecution(this.runId, this.createdAt, this.providerExecutionId);
        throw pauseError;
      }
    }
    let terminalError: unknown;
    try {
      await this.complete(error);
    } catch (settleError) {
      terminalError = settleError;
    }

    await Promise.allSettled(this.trailingWrites);

    /** A failed terminal write is not allowed to become a drained running job. Retry
     * after trailing persistence settles; if another terminal owner won meanwhile,
     * exact-generation readback is the idempotent success receipt. */
    if (terminalError != null) {
      try {
        const completed = await this.complete(error);
        if (!completed) {
          const job = await this.manager.getJob(this.runId);
          if (
            job?.createdAt !== this.createdAt ||
            job.status === 'running' ||
            job.status === 'requires_action'
          ) {
            throw terminalError;
          }
        }
        terminalError = undefined;
      } catch (retryError) {
        terminalError = retryError;
      }
    }

    let drainError: unknown;
    if (this.providerStarted && terminalError != null) {
      /** Provider work and trailing writes have settled, but terminalization gave up, so no
       *  drain marker is published on purpose — a successor must still see the truth. The
       *  shutdown tracker has no other path to release, though; abandon it explicitly or it
       *  outlives this run and every later graceful shutdown waits its full budget on it. */
      this.manager.abandonProviderExecution(this.runId, this.createdAt, this.providerExecutionId);
    }
    if (this.providerStarted && terminalError == null) {
      try {
        const args = [this.runId, this.createdAt, this.providerExecutionId] as const;
        const drained = await (this.retainTerminalPersistence
          ? this.manager.markProviderExecutionDrained(...args, true)
          : this.manager.markProviderExecutionDrained(...args));
        if (!drained) {
          throw new Error('Agent provider execution drain could not be confirmed');
        }
      } catch (error) {
        drainError = error;
      }
    }

    if (terminalError != null) {
      throw terminalError;
    }
    if (drainError != null) {
      throw drainError;
    }
  }

  private async settlePause(actionId: string): Promise<void> {
    try {
      await waitForAgentExecutionWrites(this.trailingWrites);
      const job = await this.manager.getJob(this.runId);
      if (
        job?.createdAt !== this.createdAt ||
        job.metadata.providerExecutionId !== this.providerExecutionId ||
        !(await this.manager.approvals.ownsPausePersistence(
          this.runId,
          actionId,
          this.createdAt,
          this.providerExecutionId,
        ))
      )
        throw new Error('Agent approval settlement ownership changed');
      if (
        !(await this.manager.markProviderExecutionDrained(
          this.runId,
          this.createdAt,
          this.providerExecutionId,
        ))
      )
        throw new Error('Agent approval provider drain could not be confirmed');
      if (
        !(await this.manager.approvals.finishPausePersistence(
          this.runId,
          actionId,
          this.createdAt,
          this.providerExecutionId,
        ))
      )
        throw new Error('Agent approval persistence could not be confirmed');
      this.paused = true;
    } catch (error) {
      try {
        const failed = await this.manager.failPausePersistence(
          this.runId,
          actionId,
          REMOTE_EXECUTION_ERROR,
          this.createdAt,
          this.providerExecutionId,
        );
        if (failed)
          await this.manager.markProviderExecutionDrained(
            this.runId,
            this.createdAt,
            this.providerExecutionId,
          );
      } finally {
        this.manager.abandonProviderExecution(this.runId, this.createdAt, this.providerExecutionId);
      }
      throw error;
    }
  }
}

export async function enrollAgentExecution(
  params: AgentExecutionEnrollmentParams,
  deps: AgentExecutionEnrollmentDeps = { manager: GenerationJobManager },
): Promise<AgentExecutionEnrollment> {
  const { runId, userId, conversationId, agentId, protocol, isPrincipalActive } = params;
  if (
    params.retainTerminalPersistence &&
    deps.manager.getJobStore().providerTerminalPersistence !== true
  )
    throw new Error('Agent terminal persistence barrier is unavailable');
  const claim =
    params.clientRequestId == null
      ? undefined
      : await deps.manager.claimGeneration(userId, params.clientRequestId, runId, conversationId);
  if (claim && !claim.claimed)
    throw new AgentExecutionAdmissionError(
      'Agent execution was already admitted',
      'RUN_ALREADY_ADMITTED',
    );
  let job: GenerationJob;
  try {
    /** The principal predicate replaces the default guard, so admission is one post-commit read
     * and a refused run takes the manager's retire-and-purge path. */
    job = await deps.manager.createJob(runId, userId, conversationId, {
      ...(claim
        ? {
            idempotencyClientRequestId: params.clientRequestId,
            idempotencyClaimToken: claim.existing?.claimToken,
          }
        : {}),
      admissionCheck: isPrincipalActive,
      initialMetadata: {
        agent_id: agentId,
        endpoint: protocol,
        model: agentId,
        responseMessageId: runId,
      },
    });
  } catch (error) {
    if (error instanceof GenerationAdmissionDeniedError) {
      throw new AgentExecutionAdmissionError(
        ACCOUNT_DELETION_ERROR,
        'ACCOUNT_DELETION_IN_PROGRESS',
      );
    }
    throw error;
  }

  return new AgentExecutionEnrollment(
    deps.manager,
    job,
    undefined,
    params.retainTerminalPersistence,
  );
}
export interface ResumedAgentExecutionIdentity {
  generationCreatedAt: number;
  providerExecutionId: string;
}

/** Reuse an already resolved job; never replace its epoch or claim a fresh conversation. */
export async function enrollResumedAgentExecution(
  params: AgentExecutionEnrollmentParams & ResumedAgentExecutionIdentity & { tenantId?: string },
  deps: AgentExecutionEnrollmentDeps = { manager: GenerationJobManager },
): Promise<AgentExecutionEnrollment> {
  if (!(await params.isPrincipalActive(params.userId)))
    throw new AgentExecutionAdmissionError(ACCOUNT_DELETION_ERROR, 'ACCOUNT_DELETION_IN_PROGRESS');
  const job = await deps.manager.getJob(params.runId);
  if (
    deps.manager.getJobStore().providerStartOwnership !== true ||
    (params.retainTerminalPersistence &&
      deps.manager.getJobStore().providerTerminalPersistence !== true) ||
    !job ||
    job.status !== 'running' ||
    job.createdAt !== params.generationCreatedAt ||
    job.metadata.userId !== params.userId ||
    job.metadata.tenantId !== params.tenantId ||
    job.metadata.agent_id !== params.agentId ||
    job.metadata.conversationId !== params.conversationId ||
    job.metadata.endpoint !== params.protocol ||
    job.metadata.responseMessageId !== params.runId ||
    job.metadata.providerExecutionId !== params.providerExecutionId
  )
    throw new AgentExecutionAdmissionError(
      'Resumed agent execution identity changed',
      'RUN_REPLACED',
    );
  return new AgentExecutionEnrollment(
    deps.manager,
    job,
    randomUUID(),
    params.retainTerminalPersistence,
  );
}
