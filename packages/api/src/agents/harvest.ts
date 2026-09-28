import { logger } from '@librechat/data-schemas';
import type { PreparedCodeOutputEntry } from '~/files/code/preflight';
import type { GenerationSettledWaitOptions } from '../stream/settled';
import type { CodeExecutionContext } from './execution';
import type { ServerRequest } from '~/types';

/**
 * Leading sub-second retries cover the common case of a fast background task
 * settling moments before the dispatch turn finalizes its message row — an
 * immediate follow-up turn should find the attachments already anchored.
 * The long tail covers dispatch turns that keep running for minutes.
 */
const BACKGROUND_PATCH_RETRY_DELAYS_MS = [
  250, 500, 1_000, 2_000, 5_000, 10_000, 20_000, 30_000, 60_000, 120_000, 180_000, 240_000, 300_000,
];
/** Bounded final attempts after the dispatch epoch has finished or disappeared.
 * Live terminal persistence is waited for explicitly, not inferred from this delay. */
const SETTLED_PATCH_RETRY_DELAYS_MS = [1_000, 5_000, 15_000, 30_000];
interface HarvestFileRef {
  id: string;
  name: string;
  storage_session_id?: string;
  inherited?: boolean;
}

interface HarvestArtifact {
  session_id?: string;
  files?: HarvestFileRef[];
}

export interface ProcessedCodeOutput {
  file?: { file_id: string } & Record<string, unknown>;
  finalize?: () => Promise<unknown>;
  previewRevision?: number;
}

export interface BackgroundToolResultState {
  taskId: string;
  toolName: string;
  /** Cancelled executions retain the pre-existing durable `error` state so
   * older replicas can still claim them during a rolling deploy. */
  status: 'completed' | 'error';
  cancelled?: true;
  settledAt: Date;
  /** This exact task owns a pre-registered automatic continuation delivery. */
  completionWakeup?: true;
  /** Independent receipts retain task-local delivery ownership. */
  completionReceipt?: true;
  resultClaim?: {
    kind: 'manual' | 'wakeup';
    claimId: string;
    claimedAt: Date;
    generationId?: string;
  };
}

export interface CodeHarvestDeps {
  /** Generation identity captured by the host at dispatch, not at harvest time. */
  generationCreatedAt?: number;
  /** The stream owning that epoch; nested child conversations must observe their own. */
  generationStreamId?: string | null;
  req: ServerRequest;
  /** Data-schemas method: idempotent tool-call part patch + attachment append. */
  updateToolCallResult: (params: {
    userId: string;
    messageId: string;
    conversationId: string;
    toolCallId: string;
    stepId?: string;
    agentId?: string;
    output?: string;
    attachments?: unknown[];
    markBackgrounded?: boolean;
    backgroundTask?: BackgroundToolResultState;
  }) => Promise<{ matched: boolean; unfinished: boolean }>;
  /** Host preflight: inspects the entire generated-file batch before any write. */
  preflightCodeOutputBatch: (params: {
    req: ServerRequest;
    artifact: HarvestArtifact;
    codeExecutionContext?: CodeExecutionContext;
  }) => Promise<PreparedCodeOutputEntry[]>;
  /** Host file service: downloads and persists one code output file. */
  processCodeOutput: (params: {
    req: ServerRequest;
    id: string;
    name: string;
    messageId: string;
    toolCallId: string;
    conversationId: string;
    agentId?: string;
    session_id?: string;
    freshClaimAfter?: number;
    codeApiBaseUrl?: string;
    executionProfile?: CodeExecutionContext['executionProfile'];
    executionRouteKey?: string;
    bridgeWorkerId?: string;
    preparedBuffer?: Buffer;
    downloadFallback?: boolean;
  }) => Promise<ProcessedCodeOutput | null>;
  /** Host file service: runs the deferred office-preview extraction. */
  runPreviewFinalize: (params: {
    finalize?: () => Promise<unknown>;
    fileId: string;
    previewRevision?: number;
  }) => void;
  /** Waits for the dispatch epoch, including terminal persistence. Read outages
   * remain retryable; replacement ends the wait without following a successor. */
  waitForGenerationSettled?: (
    conversationId: string,
    options?: GenerationSettledWaitOptions,
  ) => Promise<boolean>;
}

export interface CodeHarvestParams {
  toolName: string;
  toolCallId: string;
  stepId?: string;
  messageId?: string;
  conversationId?: string;
  /** Dispatching agent — scopes the part patch when provider tool-call ids
   *  repeat across agents in one response message. */
  agentId?: string;
  /** When the background task was DISPATCHED — the ordering anchor for the
   *  stale-output guard. A slow task settling after a newer run wrote the
   *  same filename must not overwrite it, so harvest wall-clock is wrong. */
  dispatchedAt?: number;
  output?: string;
  artifact?: unknown;
  codeExecutionContext?: CodeExecutionContext;
  attachments?: unknown[];
  reapply?: boolean;
  backgroundTask?: BackgroundToolResultState;
  /** Re-reads local claim ownership on every retry so a same-generation
   * manual poll cannot be overwritten by a later automatic continuation. */
  resolveBackgroundTask?: () => BackgroundToolResultState;
  /** Called once generated files are stored, before the row patch, which can
   * wait for the dispatch turn to end: a poll in that turn needs them now. */
  onFilesPersisted?: (attachments: unknown[]) => void;
}

export type CodeHarvestHandler = (
  params: CodeHarvestParams,
) => Promise<{ attachments: unknown[]; deliveryReady?: boolean } | null>;

type BackgroundResultRowParams = {
  userId: string;
  messageId: string;
  conversationId: string;
  toolCallId: string;
  stepId?: string;
  agentId?: string;
  output?: string;
  attachments?: unknown[];
  backgroundTask?: BackgroundToolResultState;
  resolveBackgroundTask?: () => BackgroundToolResultState;
};

/** Resolves `true` once `interrupt` fires, or `false` after `ms`; never both. */
function sleepUnlessInterrupted(ms: number, interrupt?: Promise<void>): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    void interrupt?.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/** `false` once `interrupt` cut the schedule short, so the caller can retry at once. */
async function anchorBackgroundToolResultRow(
  updateToolCallResult: CodeHarvestDeps['updateToolCallResult'],
  params: BackgroundResultRowParams,
  retryDelaysMs: readonly number[],
  interrupt?: Promise<void>,
): Promise<boolean> {
  const { resolveBackgroundTask, ...persistedParams } = params;
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt++) {
    const currentBackgroundTask = resolveBackgroundTask?.() ?? persistedParams.backgroundTask;
    const result = await updateToolCallResult({
      ...persistedParams,
      ...(currentBackgroundTask == null ? {} : { backgroundTask: currentBackgroundTask }),
      markBackgrounded: true,
    });
    if (result.matched && !result.unfinished) {
      return true;
    }
    if (attempt === retryDelaysMs.length) {
      break;
    }
    if (await sleepUnlessInterrupted(retryDelaysMs[attempt], interrupt)) {
      return false;
    }
  }
  return false;
}

/**
 * Patches the result onto the dispatch turn's row, which is absent or unfinished
 * while that turn streams. The patch is retried on a schedule, but the turn
 * settling is what actually makes the row patchable, so a settle observed
 * mid-schedule retries at once instead of at the next scheduled step. A turn that
 * outlives the schedule is waited for rather than given up. Only a positive
 * settle cuts the schedule short: an unknown generation state keeps the schedule.
 */
async function persistBackgroundToolResultRow(
  updateToolCallResult: CodeHarvestDeps['updateToolCallResult'],
  params: BackgroundResultRowParams,
  waitForGenerationSettled?: CodeHarvestDeps['waitForGenerationSettled'],
  generationCreatedAt?: number,
): Promise<boolean> {
  if (waitForGenerationSettled == null) {
    return anchorBackgroundToolResultRow(
      updateToolCallResult,
      params,
      BACKGROUND_PATCH_RETRY_DELAYS_MS,
    );
  }
  const listening = new AbortController();
  const settlement = waitForGenerationSettled(params.conversationId, {
    signal: listening.signal,
    ...(generationCreatedAt == null ? {} : { generationCreatedAt }),
  }).catch((error: unknown) => {
    logger.warn(
      `[background] Failed waiting for the dispatch turn of message ${params.messageId} to settle:`,
      error,
    );
    return false;
  });
  const settledTurn = new Promise<void>((resolve) => {
    void settlement.then((settled) => {
      if (settled) resolve();
    });
  });
  try {
    const anchored = await anchorBackgroundToolResultRow(
      updateToolCallResult,
      params,
      BACKGROUND_PATCH_RETRY_DELAYS_MS,
      settledTurn,
    );
    if (anchored) {
      return true;
    }
    await settlement;
    return anchorBackgroundToolResultRow(
      updateToolCallResult,
      params,
      SETTLED_PATCH_RETRY_DELAYS_MS,
    );
  } finally {
    listening.abort();
  }
}

/** Persists an ordinary detached tool result without invoking code-artifact processing. */
export function createBackgroundToolResultHandler(
  deps: Pick<CodeHarvestDeps, 'req' | 'updateToolCallResult'>,
): (params: Omit<CodeHarvestParams, 'artifact' | 'codeExecutionContext'>) => Promise<boolean> {
  return async ({
    toolCallId,
    stepId,
    messageId,
    conversationId,
    agentId,
    output,
    attachments,
    backgroundTask,
    resolveBackgroundTask,
  }) => {
    const userId = deps.req.user?.id;
    if (!userId || !messageId || !conversationId || backgroundTask == null) {
      return false;
    }
    return persistBackgroundToolResultRow(deps.updateToolCallResult, {
      userId,
      messageId,
      conversationId,
      toolCallId,
      stepId,
      agentId,
      output,
      attachments,
      backgroundTask,
      resolveBackgroundTask,
    });
  };
}

/**
 * Handles a backgrounded code-execution result once the detached call settles:
 * persists generated files (same `processCodeOutput` path as the foreground
 * callback, anchored to the ORIGINAL messageId/toolCallId), then patches the
 * dispatch turn's tool-call part output and appends the attachments to that
 * message row — so the backgrounded call reads like a foreground one on reload
 * and in later model turns, and next-turn file priming picks the outputs up.
 *
 * The dispatch turn may still be streaming when a fast task settles (its
 * response message is only saved at turn end), so the row patch retries on a
 * backoff schedule before giving up; files are already persisted either way,
 * and the poll turn still delivers content/attachments live. With
 * `reapply: true` it only re-applies the (idempotent) row patch using the
 * provided attachments — no file processing — to heal a full-row save that
 * reverted the anchor.
 */
export function createBackgroundCodeResultHandler(deps: CodeHarvestDeps): CodeHarvestHandler {
  const {
    req,
    updateToolCallResult,
    preflightCodeOutputBatch,
    processCodeOutput,
    runPreviewFinalize,
    waitForGenerationSettled,
    generationCreatedAt,
    generationStreamId,
  } = deps;
  return async ({
    toolCallId,
    stepId,
    messageId,
    conversationId,
    agentId,
    dispatchedAt,
    output,
    artifact,
    codeExecutionContext,
    attachments: knownAttachments,
    reapply,
    backgroundTask,
    resolveBackgroundTask,
    onFilesPersisted,
  }) => {
    const userId = req.user?.id;
    if (!userId || !messageId || !conversationId) {
      return null;
    }

    if (reapply === true) {
      const currentBackgroundTask = resolveBackgroundTask?.() ?? backgroundTask;
      const reapplied = await updateToolCallResult({
        userId,
        messageId,
        conversationId,
        toolCallId,
        stepId,
        agentId,
        output,
        attachments: knownAttachments ?? [],
        /** The heal path must re-stamp the marker too: the full-row save it
         *  repairs reverted the whole patched part, marker included. */
        markBackgrounded: true,
        ...(currentBackgroundTask != null ? { backgroundTask: currentBackgroundTask } : {}),
      });
      if (!reapplied.matched) {
        logger.debug(
          `[background] Re-anchor found no row for message ${messageId} (tool call ${toolCallId}).`,
        );
      }
      return { attachments: knownAttachments ?? [] };
    }

    const attachments: unknown[] = [];
    /** Ordering guard: a filename claim whose row was really written after
     *  this task was DISPATCHED belongs to a newer run — the harvest must
     *  not overwrite it with stale bytes, no matter how late it settles. */
    const freshClaimAfter = dispatchedAt ?? Date.now();
    const codeArtifact = (artifact ?? {}) as HarvestArtifact;
    const preparedEntries = await preflightCodeOutputBatch({
      req,
      artifact: codeArtifact,
      codeExecutionContext,
    });
    for (const { file, sessionId, preparedBuffer, downloadFallback } of preparedEntries) {
      try {
        const result = await processCodeOutput({
          req,
          id: file.id,
          name: file.name,
          messageId,
          toolCallId,
          conversationId,
          /** Rides the attachment so the client can route it to the right
           *  card when provider ids repeat across agents. */
          agentId,
          session_id: sessionId,
          freshClaimAfter,
          codeApiBaseUrl: codeExecutionContext?.baseUrl,
          executionProfile: codeExecutionContext?.executionProfile,
          executionRouteKey: codeExecutionContext?.executionRouteKey,
          bridgeWorkerId: codeExecutionContext?.bridgeWorkerId,
          preparedBuffer,
          downloadFallback,
        });
        if (result?.file) {
          const anchoredFile = stepId == null ? result.file : { ...result.file, stepId };
          attachments.push(anchoredFile);
          /** No live stream at completion time; the client's preview polling
           *  (or the poll turn's re-emit) surfaces the finalized preview. */
          runPreviewFinalize({
            finalize: result.finalize,
            fileId: result.file.file_id,
            previewRevision: result.previewRevision,
          });
        }
      } catch (error) {
        logger.error('[background] Error processing code output file:', error);
      }
    }

    onFilesPersisted?.(attachments);
    const deliveryReady = await persistBackgroundToolResultRow(
      updateToolCallResult,
      {
        userId,
        messageId,
        conversationId,
        toolCallId,
        stepId,
        agentId,
        output,
        attachments,
        ...(backgroundTask != null ? { backgroundTask } : {}),
        ...(resolveBackgroundTask != null ? { resolveBackgroundTask } : {}),
      },
      waitForGenerationSettled,
      generationStreamId == null || generationStreamId === conversationId
        ? generationCreatedAt
        : undefined,
    );
    if (!deliveryReady) {
      logger.warn(
        `[background] Could not anchor code result onto message ${messageId} (tool call ${toolCallId}); ` +
          'the dispatch turn ended without saving that tool call. Poll delivery still returns the result.',
      );
    }
    return { attachments, ...(backgroundTask != null ? { deliveryReady } : {}) };
  };
}
