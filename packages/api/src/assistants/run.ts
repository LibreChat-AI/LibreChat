import { randomUUID } from 'crypto';
import { logger } from '@librechat/data-schemas';
import type { GenerationJobManagerClass } from '~/stream';
import { AgentExecutionAdmissionError, AgentExecutionEnrollment } from '~/agents/remote/lifecycle';
import { GenerationAdmissionDeniedError, GenerationAdmissionUnavailableError } from '~/stream';
import { getSafeErrorMetadata } from '~/utils/errors';

/**
 * Upper bound on how long settlement waits for the response's `close` event, so the close handler
 * registers first. The event follows `res.end()` within milliseconds; the bound only keeps a
 * controller that returned without ending its response from holding the account drain, which
 * has its own timeout. It is an internal protocol constant rather than a limit an operator sets or
 * a user sees, so it has no `configSchema` field.
 */
const RESPONSE_CLOSE_GRACE_MS = 2_000;
const ACCOUNT_DELETION_MESSAGE = 'Account deletion is in progress';
const ASSISTANT_RUN_FAILURE = 'Assistant run failed';
/** The message the Assistants error handlers answer with a bare `res.end()`. */
const RUN_CANCELLED = 'Run cancelled';

export interface AssistantRunParams {
  userId: string;
  endpoint?: string;
  assistantId?: string;
}

export interface AssistantRunDeps {
  manager: GenerationJobManagerClass;
  /** Reads the account-deletion marker: false once the owner is being erased or is gone. */
  isPrincipalActive: (userId: string) => Promise<boolean>;
  /** Overrides how long settlement waits for the response to close. */
  responseCloseGraceMs?: number;
}

/** The slice of the response that settlement, admission failures and stopped runs need. */
export interface AssistantRunResponse {
  closed?: boolean;
  destroyed?: boolean;
  end: () => unknown;
  once: (event: 'close', listener: () => void) => unknown;
  off: (event: 'close', listener: () => void) => unknown;
  status: (code: number) => { json: (body: unknown) => unknown };
}

/** The provider client call that stops a run. */
export interface AssistantsRunClient {
  beta: {
    threads: {
      runs: {
        cancel: (runId: string, params: { thread_id: string }) => Promise<unknown>;
      };
    };
  };
}

export interface AssistantRunIds {
  thread_id: string;
  run_id: string;
}

/**
 * What a controller sees of its run: a signal that fires when the run is stopped from outside,
 * and the means to keep detached work inside the account-deletion drain.
 */
export interface AssistantRunHandle {
  /** Fires when account deletion, delete-all or shutdown stops the run. */
  readonly signal: AbortSignal;
  readonly stopped: boolean;
  /** Throws the cancellation the error handlers answer with a bare `res.end()`, once stopped. */
  throwIfStopped: () => void;
  /** Cancels the provider run when this run is stopped, at once if it already was. */
  cancelOnStop: (openai: AssistantsRunClient, ids: AssistantRunIds) => void;
  /**
   * Keeps `work` inside the drain: settlement waits for it, including for work it tracks in turn.
   * A failure is logged and stays the caller's to handle. Work started after settlement is
   * outside the drain.
   */
  track: <T>(work: Promise<T>) => Promise<T>;
  /**
   * Wraps a callback the response fires on its own, such as `close`. It does nothing for a
   * stopped run or one that already settled, and otherwise settlement waits for it.
   */
  guard: <A extends unknown[]>(
    handler: (...args: A) => Promise<void>,
  ) => (...args: A) => Promise<void>;
  /** Wraps an error handler: a stopped run has nothing to recover, so it only ends the response. */
  guardErrors: <E>(
    res: Pick<AssistantRunResponse, 'end'>,
    handler: (error: E) => Promise<unknown>,
  ) => (error: E) => Promise<unknown>;
}

export interface AssistantRunRequest {
  user?: { id?: string };
  body?: unknown;
  assistantRun?: AssistantRunHandle;
}

/** The run a route enrolled for this request, or an unmanaged one when it was not enrolled. */
export function getAssistantRun(req: AssistantRunRequest): AssistantRunHandle {
  return req.assistantRun ?? unmanagedAssistantRun();
}

/** A run with nothing to drain, for controllers invoked outside {@link withAssistantRun}. */
export function unmanagedAssistantRun(): AssistantRunHandle {
  const { signal } = new AbortController();
  return {
    signal,
    stopped: false,
    throwIfStopped: () => undefined,
    cancelOnStop: () => undefined,
    track: (work) => work,
    guard: (handler) => handler,
    guardErrors: (_res, handler) => handler,
  };
}

export class AssistantRun implements AssistantRunHandle {
  readonly signal: AbortSignal;
  private settling = false;
  private readonly tracked: Promise<void>[] = [];

  constructor(
    private readonly execution: AgentExecutionEnrollment,
    private readonly responseCloseGraceMs: number = RESPONSE_CLOSE_GRACE_MS,
  ) {
    this.signal = execution.signal;
  }

  get stopped(): boolean {
    return this.signal.aborted;
  }

  onStop(cancel: () => unknown): void {
    const run = (): void => {
      void Promise.resolve()
        .then(() => cancel())
        .catch((error: unknown) => {
          logger.error(
            '[AssistantRun] Failed to cancel a stopped run',
            getSafeErrorMetadata(error),
          );
        });
    };
    if (this.signal.aborted) {
      run();
      return;
    }
    this.signal.addEventListener('abort', run, { once: true });
  }

  throwIfStopped(): void {
    if (this.signal.aborted) {
      throw new Error(RUN_CANCELLED);
    }
  }

  cancelOnStop(openai: AssistantsRunClient, { thread_id, run_id }: AssistantRunIds): void {
    this.onStop(() => openai.beta.threads.runs.cancel(run_id, { thread_id }));
  }

  track<T>(work: Promise<T>): Promise<T> {
    if (this.settling) {
      logger.warn('[AssistantRun] Work started after the run settled is outside the drain');
      return work;
    }
    this.tracked.push(
      work.then(
        () => undefined,
        (error: unknown) => {
          logger.warn('[AssistantRun] Tracked work failed', getSafeErrorMetadata(error));
        },
      ),
    );
    return work;
  }

  guard<A extends unknown[]>(
    handler: (...args: A) => Promise<void>,
  ): (...args: A) => Promise<void> {
    return async (...args: A): Promise<void> => {
      if (this.signal.aborted || this.settling) {
        return;
      }
      await this.track(handler(...args));
    };
  }

  guardErrors<E>(
    res: Pick<AssistantRunResponse, 'end'>,
    handler: (error: E) => Promise<unknown>,
  ): (error: E) => Promise<unknown> {
    return async (error: E): Promise<unknown> => {
      if (this.signal.aborted) {
        res.end();
        return;
      }
      return handler(error);
    };
  }

  /**
   * Ends the run once the response closed and everything tracked has landed, which is what lets
   * account erasure proceed. Tracked work can start and track more work, so it drains until none
   * is left before the run is marked settled. Failures are logged: the drain fails closed on its
   * own.
   */
  async settle(res: AssistantRunResponse, error?: unknown): Promise<void> {
    await untilClosed(res, this.responseCloseGraceMs);
    while (this.tracked.length > 0) {
      await Promise.all(this.tracked.splice(0));
    }
    this.settling = true;
    try {
      await this.execution.settle(error);
    } catch (settleError) {
      logger.error('[AssistantRun] Failed to settle the run', getSafeErrorMetadata(settleError));
    }
  }
}

function untilClosed(res: AssistantRunResponse, graceMs: number): Promise<void> {
  if (res.closed === true || res.destroyed === true) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      res.off('close', done);
      resolve();
    };
    const timer = setTimeout(done, graceMs);
    res.once('close', done);
  });
}

/**
 * Registers an Assistants turn with the account cleanup barrier, so `stopUserGenerations` can see
 * it, and refuses the turn once the owner's deletion began. Every turn gets its own job id: a
 * second turn in the same conversation must not replace the first.
 *
 * The job names no conversation on purpose. Deleting one conversation removes the provider thread
 * before it drains generations, and cancelling a run needs that thread, so only the owner-wide
 * drains (account deletion, delete-all) reach these runs.
 */
export async function enrollAssistantRun(
  params: AssistantRunParams,
  deps: AssistantRunDeps,
): Promise<AssistantRun> {
  const { userId, endpoint, assistantId } = params;
  const { manager, isPrincipalActive, responseCloseGraceMs } = deps;
  const job = await manager
    .createJob(randomUUID(), userId, undefined, {
      admissionCheck: isPrincipalActive,
      initialMetadata: { endpoint: endpoint ?? 'assistants', model: assistantId },
    })
    .catch((error: unknown) => {
      if (error instanceof GenerationAdmissionDeniedError) {
        throw new AgentExecutionAdmissionError(
          ACCOUNT_DELETION_MESSAGE,
          'ACCOUNT_DELETION_IN_PROGRESS',
        );
      }
      throw error;
    });
  const execution = new AgentExecutionEnrollment(manager, job, ASSISTANT_RUN_FAILURE);
  try {
    await execution.beginProviderExecution();
  } catch (error) {
    await execution.settle(error).catch((settleError: unknown) => {
      logger.error(
        '[AssistantRun] Failed to release a refused run',
        getSafeErrorMetadata(settleError),
      );
    });
    throw error;
  }
  return new AssistantRun(execution, responseCloseGraceMs);
}

function describeChatRequest(req: AssistantRunRequest): Omit<AssistantRunParams, 'userId'> {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
  return { endpoint: text(body.endpoint), assistantId: text(body.assistant_id) };
}

/** Answers an admission failure the way the account guard does, or reports it was not one. */
function refuse(res: AssistantRunResponse, error: unknown): boolean {
  if (
    error instanceof AgentExecutionAdmissionError ||
    error instanceof GenerationAdmissionUnavailableError
  ) {
    res.status(error.status).json({ message: error.message, code: error.code });
    return true;
  }
  return false;
}

/**
 * Runs an Assistants controller as an enrolled run. The account-deletion drain waits for the
 * controller and everything it tracked, and stops the run through its signal. The controller
 * finds its run on `req.assistantRun`.
 */
export function withAssistantRun<Req extends AssistantRunRequest, Res extends AssistantRunResponse>(
  controller: (req: Req, res: Res) => Promise<unknown>,
  deps: AssistantRunDeps,
): (req: Req, res: Res) => Promise<void> {
  return async (req, res) => {
    const userId = req.user?.id;
    if (!userId) {
      throw new Error('An Assistants run needs an authenticated user');
    }
    let run: AssistantRun;
    try {
      run = await enrollAssistantRun({ userId, ...describeChatRequest(req) }, deps);
    } catch (error) {
      if (refuse(res, error)) {
        return;
      }
      throw error;
    }
    req.assistantRun = run;
    let failure: unknown;
    try {
      await controller(req, res);
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      await run.settle(res, failure);
    }
  };
}
