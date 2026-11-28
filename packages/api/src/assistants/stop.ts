import { logger } from '@librechat/data-schemas';
import { RunStatus, Time, isUUID } from 'librechat-data-provider';
import type { Response } from 'express';
import type { FinalEvent, ServerRequest } from '~/types';
import type { RecoveryLock, RunClaim } from './recovery';
import { getTransactionsConfig } from '~/app/config';
import { claimRunRecovery } from './recovery';
import { sendEvent } from '~/utils/events';

/** How long a stopped run stays marked `cancelled` in its conversation's abort entry. */
const STOP_MARK_TTL = Time.THREE_MINUTES;
/** How long the chat controllers keep a run's abort entry, which a stop that gives the run back
 *  writes again. */
const RUN_ENTRY_TTL = Time.TEN_MINUTES;

/** What a stop reads of the run it cancelled, to bill it. */
interface StoppedRun {
  model?: string | null;
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
}

/** The provider calls a stop makes. */
export interface StopRunClient {
  beta: {
    threads: {
      runs: {
        cancel: (runId: string, params: { thread_id: string }) => Promise<unknown>;
        retrieve: (runId: string, params: { thread_id: string }) => Promise<StoppedRun>;
      };
    };
  };
}

export interface StopRunDeps {
  /** The abort-key cache, whose entry for a conversation names its current run. */
  cache: {
    get: (key: string) => Promise<unknown>;
    set: (key: string, value: string, ttl?: number) => Promise<unknown>;
  };
  lock: RecoveryLock;
  getConvo: (userId: string, conversationId: string) => Promise<FinalEvent['conversation']>;
  initializeClient: (params: {
    req: ServerRequest;
    res: Response;
  }) => Promise<{ openai: StopRunClient }>;
  recordUsage: (
    params: NonNullable<StoppedRun['usage']> & {
      model?: string | null;
      user: string;
      conversationId: string;
      transactions: ReturnType<typeof getTransactionsConfig>;
    },
  ) => Promise<unknown>;
  checkMessageGaps: (params: {
    openai: StopRunClient;
    run_id: string;
    endpoint?: string;
    thread_id: string;
    conversationId: string;
    latestMessageId?: string;
  }) => Promise<FinalEvent['runMessages']>;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : '';
}

/**
 * Gives back a run the stop did not cancel: the conversation's abort entry names the run again,
 * unless something replaced the stop's mark meanwhile, and the run's claim is released, so a later
 * stop or the run's own request can still stop it. The check and the write are two cache calls,
 * like the stop's own read and mark: the cache offers no compare-and-set, so the next run's entry
 * is only overwritten if it lands between them, which needs this run to have ended already.
 */
async function giveBack(
  cache: StopRunDeps['cache'],
  { key, entry, claim }: { key: string; entry: string; claim: RunClaim },
): Promise<void> {
  try {
    if ((await cache.get(key)) === RunStatus.CANCELLED) {
      await cache.set(key, entry, RUN_ENTRY_TTL);
    }
  } finally {
    await claim.release();
  }
}

/**
 * Stops the Assistants run a conversation's abort entry names, for the stop route: claims the
 * run's recovery, marks the entry `cancelled`, cancels the run, bills it and reads it back as the
 * final event. A run whose own request already claimed its recovery is answered with 204. When the
 * provider does not cancel the run, the stop gives the run back and fails, without billing it or
 * reading it back: a run the stop did not stop is not the stop's to recover.
 */
export async function stopRun(req: ServerRequest, res: Response, deps: StopRunDeps): Promise<void> {
  res.setHeader('Content-Type', 'application/json');
  const userId = String(req.user?.id);
  const { abortKey, endpoint } = req.body as { abortKey?: string; endpoint?: string };
  const [conversationId, latestMessageId] = String(abortKey).split(':');
  const conversation = await deps.getConvo(userId, conversationId);

  if (typeof conversation?.model === 'string' && conversation.model) {
    req.body = req.body ?? {};
    req.body.model = conversation.model;
  }

  if (!isUUID.safeParse(conversationId).success) {
    logger.error('[abortRun] Invalid conversationId', { conversationId });
    res.status(400).send({ message: 'Invalid conversationId' });
    return;
  }

  const cacheKey = `${userId}:${conversationId}`;
  const runValues = await deps.cache.get(cacheKey);
  if (!runValues) {
    logger.warn('[abortRun] Run not found in cache', { cacheKey });
    res.status(204).send({ message: 'Run not found' });
    return;
  }
  const [thread_id, run_id] = String(runValues).split(':');

  if (!run_id) {
    logger.warn("[abortRun] Couldn't find run for cancel request", { thread_id });
    res.status(204).send({ message: 'Run not found' });
    return;
  } else if (run_id === 'cancelled') {
    logger.warn('[abortRun] Run already cancelled', { thread_id });
    res.status(204).send({ message: 'Run already cancelled' });
    return;
  }

  const { openai } = await deps.initializeClient({ req, res });

  const claim = await claimRunRecovery(deps.lock, run_id);
  if (!claim) {
    logger.warn('[abortRun] Run already stopped or recovered', { thread_id });
    res.status(204).send({ message: 'Run already cancelled' });
    return;
  }

  try {
    await deps.cache.set(cacheKey, RunStatus.CANCELLED, STOP_MARK_TTL);
    const cancelledRun = await openai.beta.threads.runs.cancel(run_id, { thread_id });
    logger.debug('[abortRun] Cancelled run:', cancelledRun);
  } catch (error) {
    logger.error('[abortRun] Error cancelling run', error);
    const message = messageOf(error);
    if (message.includes(RunStatus.CANCELLED) || message.includes(RunStatus.CANCELLING)) {
      res.end();
      return;
    }
    await giveBack(deps.cache, { key: cacheKey, entry: String(runValues), claim });
    throw new Error('[abortRun] The run was not cancelled', { cause: error });
  }

  try {
    const run = await openai.beta.threads.runs.retrieve(run_id, { thread_id });
    await deps.recordUsage({
      ...run.usage,
      model: run.model,
      user: userId,
      conversationId,
      transactions: getTransactionsConfig(req.config),
    });
  } catch (error) {
    logger.error('[abortRun] Error fetching or processing run', error);
  }

  const runMessages = await deps.checkMessageGaps({
    openai,
    run_id,
    endpoint,
    thread_id,
    conversationId,
    latestMessageId,
  });

  const finalEvent: FinalEvent = { final: true, conversation, runMessages };

  if (res.headersSent) {
    sendEvent(res, finalEvent);
    return;
  }

  res.json(finalEvent);
}
