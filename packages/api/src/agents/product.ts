import type { ChatServerFact } from 'librechat-data-provider';
import type { ServerRequest } from '~/types';
import { trackRequestProductFact } from '~/tracking/request';
import { isOwnedAbortError } from '~/utils/errors';

export type ProductTrackingRequest = Pick<
  ServerRequest,
  'productTracker' | 'productTracking' | 'productTrackingContext'
>;
type ResponseFact = Extract<ChatServerFact, { name: 'librechat.chat.response.finished' }>;
export type ExecutionContext = Partial<
  Pick<ResponseFact, 'runId' | 'conversationId' | 'agentId' | 'model' | 'provider' | 'parentRunId'>
>;

/** Uses the request-owned callback. Tracking failures never change an execution result. */
function emit(req: ProductTrackingRequest | undefined, fact: ChatServerFact): void {
  if (req) trackRequestProductFact(req, fact);
}

/** Reports only a settled invocation. Paused runs and disconnected browsers do not finish it. */
export function observeProductRun<
  T extends {
    processStream: (...args: never[]) => Promise<unknown>;
    resume?: (...args: never[]) => Promise<unknown>;
    getInterrupt: () => unknown;
    getHaltReason: () => string | undefined;
  },
>(
  run: T,
  req: ProductTrackingRequest | undefined,
  context: ExecutionContext & { runId: string },
  signal: AbortSignal,
): T {
  if (req?.productTracking?.enabled !== true || req.productTracker == null) return run;
  let startedAt: number | undefined;
  let finished = false;
  let invocationDepth = 0;
  const wrap =
    (original: (...args: never[]) => Promise<unknown>) =>
    async (...args: never[]) => {
      const outermost = invocationDepth++ === 0;
      startedAt ??= performance.now();
      const finish = (outcome: 'completed' | 'incomplete' | 'failed' | 'cancelled') => {
        if (!outermost || finished) return;
        finished = true;
        emit(req, {
          name: 'librechat.chat.response.finished',
          feature: 'chat',
          ...context,
          outcome,
          durationMs: performance.now() - startedAt!,
        });
      };
      try {
        const result = await original(...args);
        if (!run.getInterrupt()) {
          let outcome: 'completed' | 'incomplete' | 'cancelled' = 'completed';
          if (run.getHaltReason()) outcome = 'incomplete';
          if (signal.aborted) outcome = 'cancelled';
          finish(outcome);
        }
        return result;
      } catch (error) {
        finish(isOwnedAbortError(error, signal) ? 'cancelled' : 'failed');
        throw error;
      } finally {
        invocationDepth--;
      }
    };
  run.processStream = wrap(run.processStream.bind(run));
  if (run.resume) run.resume = wrap(run.resume.bind(run));
  return run;
}

/** Setup failure ends this accepted generation before any agent or model starts. */
export async function observeProductRunSetup<T>(
  req: ProductTrackingRequest | undefined,
  context: ExecutionContext & { runId: string },
  signal: AbortSignal,
  create: () => Promise<T>,
): Promise<T> {
  const startedAt = performance.now();
  try {
    return await create();
  } catch (error) {
    emit(req, {
      name: 'librechat.chat.response.finished',
      feature: 'chat',
      ...context,
      outcome: isOwnedAbortError(error, signal) ? 'cancelled' : 'failed',
      durationMs: performance.now() - startedAt,
    });
    throw error;
  }
}
