import type { GenerationJobManagerClass } from '~/stream';
import type { GenerationJob } from '~/types/stream';
import { GenerationJobManager } from '~/stream';

const ACCOUNT_DELETION_ERROR = 'Account deletion is in progress';
const REMOTE_EXECUTION_ERROR = 'Remote agent execution failed';

export class AgentExecutionAdmissionError extends Error {
  readonly code: 'ACCOUNT_DELETION_IN_PROGRESS' | 'RUN_REPLACED';
  readonly status = 409;

  constructor(message: string, code: 'ACCOUNT_DELETION_IN_PROGRESS' | 'RUN_REPLACED') {
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
}

interface AgentExecutionEnrollmentDeps {
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
  private readonly trailingWrites: Promise<unknown>[] = [];
  private providerStarted = false;
  private settlement?: Promise<void>;

  constructor(manager: GenerationJobManagerClass, job: GenerationJob) {
    const providerExecutionId = job.metadata.providerExecutionId;
    if (!providerExecutionId) {
      throw new Error('Agent execution enrollment is missing its provider identity');
    }
    this.manager = manager;
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
      started = await this.manager.beginProviderExecution(
        this.runId,
        this.createdAt,
        this.providerExecutionId,
      );
    } catch (error) {
      /** The CAS may have committed before its response was lost. Provider work has
       * not begun, but settlement still owns acknowledgement of that possible fence. */
      this.providerStarted = true;
      throw error;
    }
    if (!started) {
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

  settle(error?: unknown): Promise<void> {
    this.settlement ??= this.settleInternal(error);
    return this.settlement;
  }

  private async settleInternal(error?: unknown): Promise<void> {
    let terminalError: unknown;
    try {
      await this.manager.completeJob(
        this.runId,
        error == null ? undefined : REMOTE_EXECUTION_ERROR,
        this.createdAt,
      );
    } catch (settleError) {
      terminalError = settleError;
    }

    await Promise.allSettled(this.trailingWrites);

    /** A failed terminal write is not allowed to become a drained running job. Retry
     * after trailing persistence settles; if another terminal owner won meanwhile,
     * exact-generation readback is the idempotent success receipt. */
    if (terminalError != null) {
      try {
        const completed = await this.manager.completeJob(
          this.runId,
          error == null ? undefined : REMOTE_EXECUTION_ERROR,
          this.createdAt,
        );
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
        const drained = await this.manager.markProviderExecutionDrained(
          this.runId,
          this.createdAt,
          this.providerExecutionId,
        );
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
}

async function retireRejectedEnrollment(
  manager: GenerationJobManagerClass,
  job: GenerationJob,
): Promise<void> {
  await manager.completeJob(job.streamId, ACCOUNT_DELETION_ERROR, job.createdAt);
}

export async function enrollAgentExecution(
  params: AgentExecutionEnrollmentParams,
  deps: AgentExecutionEnrollmentDeps = { manager: GenerationJobManager },
): Promise<AgentExecutionEnrollment> {
  const { runId, userId, conversationId, agentId, protocol, isPrincipalActive } = params;
  const job = await deps.manager.createJob(runId, userId, conversationId, {
    initialMetadata: {
      agent_id: agentId,
      endpoint: protocol,
      model: agentId,
      responseMessageId: runId,
    },
  });

  let active = false;
  try {
    active = await isPrincipalActive(userId);
  } catch (error) {
    await retireRejectedEnrollment(deps.manager, job).catch(() => undefined);
    throw error;
  }
  if (!active) {
    await retireRejectedEnrollment(deps.manager, job);
    throw new AgentExecutionAdmissionError(ACCOUNT_DELETION_ERROR, 'ACCOUNT_DELETION_IN_PROGRESS');
  }

  return new AgentExecutionEnrollment(deps.manager, job);
}
