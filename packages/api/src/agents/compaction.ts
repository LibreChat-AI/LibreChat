import { ContentTypes, ErrorTypes } from 'librechat-data-provider';
import {
  COMPACTION_SEMANTIC_INDEX_PROJECTION_VERSION,
  MAX_COMPACTION_SEMANTIC_INDEX_ENTRIES,
  MAX_COMPACTION_SEMANTIC_INDEX_IDENTITY_LENGTH,
  MAX_COMPACTION_SEMANTIC_INDEX_SOURCE_CONTENT_INDEX,
  MAX_COMPACTION_SEMANTIC_INDEX_TEXT_LENGTH,
  isCompactionSemanticIndexProjection,
} from '@librechat/data-schemas';
import type {
  CompactionSemanticIndex,
  CompactionSemanticIndexEntry,
  CompactionSemanticIndexSnapshot,
} from '@librechat/agents';
import type {
  ICompactionSemanticIndexProjection,
  TCompactionSemanticIndexEntry,
} from '@librechat/data-schemas';
import type { SummaryContentPart, TMessageContentParts } from 'librechat-data-provider';
import type { IAgentEventActorSummary } from '@librechat/data-schemas';
import { createAgentEventActorSummary } from './compatibility';

/** Text of a summary content part, in any persisted shape — `content` blocks
 *  today, a string `content` or a bare `text` on rows written before them.
 *  Empty for anything else. */
export function getSummaryPartText(part: TMessageContentParts | null | undefined): string {
  if (part?.type !== ContentTypes.SUMMARY) {
    return '';
  }
  /** Widened on purpose: rows written before summary `content` blocks hold a
   *  string `content` or a bare `text`, neither of which the part type models. */
  const content: unknown = part.content;
  if (typeof content === 'string') {
    return content.trim();
  }
  if (Array.isArray(content)) {
    let text = '';
    for (const block of content) {
      if (block != null && typeof block === 'object' && 'text' in block) {
        text += typeof block.text === 'string' ? block.text : '';
      }
    }
    return text.trim();
  }
  return 'text' in part && typeof part.text === 'string' ? part.text.trim() : '';
}

/**
 * A summary that can stand for the history it covers: it carries text, and its
 * round both finished and did not error. A round that failed or was cut off
 * keeps whatever deltas it streamed, so its text is a truncated prefix of the
 * history it was summarizing rather than a checkpoint for it — the same test
 * `isCompactedLeaf` applies when deciding whether a compaction can be retried.
 *
 * `failed` has only been stamped since the server began recording errored
 * rounds, so the flags alone cannot vouch for older rows. The aggregator gives
 * the structural answer: deltas stream `content` blocks into the part, and only
 * a completed round replaces it with the final block, which is the only writer
 * of `boundary`. A `content`-block summary without one therefore never
 * finished, however it was stored. Rows in the bare-`text` shape predate that
 * aggregator and are left to the flags.
 */
export function isUsableSummaryPart(part: unknown): part is SummaryContentPart {
  if (part == null || typeof part !== 'object' || !('type' in part)) {
    return false;
  }
  if (part.type !== ContentTypes.SUMMARY) {
    return false;
  }
  /** Narrowed by the discriminant above: this is the summary union member. */
  const summary = part as SummaryContentPart;
  if (summary.failed === true || summary.summarizing === true) {
    return false;
  }
  if (Array.isArray(summary.content) && summary.boundary == null) {
    return false;
  }
  return getSummaryPartText(summary).length > 0;
}

/**
 * The summary a message offers as the conversation's checkpoint: the last
 * usable one in its content (last-summary-wins). Null when the message carries
 * none — an empty or failed summary leaves the history it hangs off in place.
 */
export function findCheckpointSummaryPart(content: unknown): SummaryContentPart | null {
  if (!Array.isArray(content)) {
    return null;
  }
  let checkpoint: SummaryContentPart | null = null;
  for (const part of content) {
    if (isUsableSummaryPart(part)) {
      checkpoint = part;
    }
  }
  return checkpoint;
}

/** The fields a history row offers when it may be a summary checkpoint. */
export interface CheckpointCandidate {
  content?: unknown;
  summary?: string | null;
  summaryTokenCount?: number | null;
  tokenCount?: number | null;
}

/**
 * The row a history read stops at, as it enters the prompt, or null when the
 * row is no checkpoint and the read continues past it. A content-block summary
 * keeps the row from that summary on: a response that summarized mid-run keeps
 * producing after it, and the SDK formatter (`applySummaryBoundary`) promotes
 * the summary and keeps the parts that follow, exactly as it does when the full
 * history is sent. A sliced row drops its stored token count, which still covers
 * the parts before the summary, so the prompt is charged for what it sends. A
 * legacy `summary` field replaces the whole row.
 */
export function resolveCheckpointMessage<T extends CheckpointCandidate>(
  message: T,
): (T & { role?: 'system' }) | null {
  const summaryPart = findCheckpointSummaryPart(message.content);
  if (summaryPart != null && Array.isArray(message.content)) {
    const summaryIndex = message.content.lastIndexOf(summaryPart);
    return summaryIndex === 0
      ? message
      : { ...message, content: message.content.slice(summaryIndex), tokenCount: undefined };
  }
  if (!message.summary) {
    return null;
  }
  return {
    ...message,
    role: 'system',
    content: [{ type: ContentTypes.TEXT, text: message.summary }],
    tokenCount: message.summaryTokenCount ?? message.tokenCount,
  };
}

/**
 * The summary a warm event-actor continuation carries forward: the last usable
 * one in the run's content parts, stamped as actor state. A failed or
 * unfinished round's partial deltas would otherwise be persisted as actor state
 * and handed to the next run as its `initialSummary`, which skips durable
 * history entirely. A missing or invalid token count is recorded as zero.
 */
export function getLatestEventActorSummary(
  contentParts: unknown,
): IAgentEventActorSummary | undefined {
  if (!Array.isArray(contentParts)) {
    return undefined;
  }
  for (let index = contentParts.length - 1; index >= 0; index -= 1) {
    const part: unknown = contentParts[index];
    if (!isUsableSummaryPart(part)) {
      continue;
    }
    const tokenCount = part.tokenCount;
    return createAgentEventActorSummary({
      text: getSummaryPartText(part),
      tokenCount:
        typeof tokenCount === 'number' && Number.isFinite(tokenCount) && tokenCount >= 0
          ? tokenCount
          : 0,
    });
  }
  return undefined;
}

/** The typed failure a manual compaction reports when it produced no summary. */
const COMPACTION_FAILED_ERROR = JSON.stringify({ type: ErrorTypes.COMPACTION_FAILED });

/**
 * The content a failed manual compaction persists: the typed failure, marked as
 * the compaction's own outcome. A turn saved from a thrown failure has no
 * content of its own, so without this the row is indistinguishable from an
 * answer to the message it hangs off and keeps that message's rerun controls.
 */
function compactionFailureContent(
  errorText: string = COMPACTION_FAILED_ERROR,
): TMessageContentParts[] {
  return [{ type: ContentTypes.ERROR, error: errorText, initiatedBy: 'user' }];
}

/**
 * The content fields a failed turn is persisted with. A manual compaction owns
 * its identity through content, so its row carries the marked failure; every
 * other failed turn contributes nothing and keeps its text-only shape. Callers
 * spread the result rather than deciding which turns are compactions.
 */
export function resolveFailedTurnContent(
  requestBody: { compact?: boolean } | null | undefined,
  errorText: string,
): { content?: TMessageContentParts[] } {
  if (requestBody?.compact !== true) {
    return {};
  }
  return { content: compactionFailureContent(errorText) };
}

/**
 * The content an aborted compaction persists: the run's stream-aggregated
 * parts, carrying the marker that keeps the turn identifiable as a compaction.
 * The abort path owns a cancelled run's row (a stopped turn is unfinished, not
 * failed) and nothing else on that path knows the request was a compaction, so
 * without this the row reads as an answer to the message it hangs off and keeps
 * that message's rerun controls: on a branch ending in a user message,
 * Regenerate would answer the user turn behind the compaction instead of
 * redoing it.
 *
 * A terminal abort (Stop) settles the turn, so it applies the completed run's
 * outcome rules: a usable summary is marked as the outcome; a partial one
 * keeps its text but is marked `failed`, or its label would present the
 * truncated prefix as a finished checkpoint; a placeholder that never streamed
 * text goes, leaving the typed failure as the row's outcome. A non-terminal
 * snapshot (`synthesizeFailure: false`, the disconnect save the run may still
 * complete and overwrite) marks what is there and rewrites nothing else.
 * Content from a turn that was not a compaction is returned unchanged, and
 * the parts are never edited in place: the aggregated parts belong to the
 * still-live run on the disconnect path, so every stamped part is a copy.
 */
export function markAbortedCompactionContent(
  contentParts: TMessageContentParts[],
  isCompaction: boolean,
  { synthesizeFailure = true }: { synthesizeFailure?: boolean } = {},
): TMessageContentParts[] {
  if (!isCompaction) {
    return contentParts;
  }
  const marked: TMessageContentParts[] = [];
  let hasOutcome = false;
  let removedUnfinishedRound = false;
  for (const part of contentParts) {
    if (part == null) {
      marked.push(part);
      continue;
    }
    if (part.type === ContentTypes.ERROR) {
      marked.push({ ...part, initiatedBy: 'user' as const });
      hasOutcome = true;
      removedUnfinishedRound = false;
      continue;
    }
    if (part.type !== ContentTypes.SUMMARY) {
      marked.push(part);
      continue;
    }
    /** The usability predicate's false side narrows the part's type away, so
     *  the reference is taken before it runs. */
    const summary = part;
    if (isUsableSummaryPart(part)) {
      marked.push({ ...summary, initiatedBy: 'user' as const });
      hasOutcome = true;
      removedUnfinishedRound = false;
      continue;
    }
    if (!synthesizeFailure) {
      marked.push({ ...summary, initiatedBy: 'user' as const });
      continue;
    }
    if (isSummaryPartWithText(summary)) {
      marked.push({ ...summary, initiatedBy: 'user' as const, failed: true });
      hasOutcome = true;
      removedUnfinishedRound = false;
      continue;
    }
    /** A later outcome supersedes this placeholder's round; the flag is
     *  cleared whenever an outcome follows, so only a round opened after the
     *  latest outcome synthesizes the failure. */
    removedUnfinishedRound = true;
  }
  /** An earlier round's checkpoint is not this round's outcome: a round the
   *  run opened but never finished still records the typed failure beside it,
   *  or the stopped turn reads as the successful compaction the checkpoint
   *  describes. */
  if ((!hasOutcome || removedUnfinishedRound) && synthesizeFailure) {
    marked.push(...compactionFailureContent());
  }
  return marked;
}

/** Whether a job record's durable final event is a reconciliation frame: the
 *  conservative substitute published when the terminal row write failed, so
 *  no message row backs the terminal claim. */
function hasDurableReconcileFrame(finalEvent: unknown): boolean {
  if (typeof finalEvent !== 'string' || finalEvent.length === 0) {
    return false;
  }
  try {
    const parsed = JSON.parse(finalEvent) as { reconcile?: unknown } | null;
    return parsed?.reconcile === true;
  } catch {
    return false;
  }
}

/** Whether a job record has reached a status whose path owns the turn's final
 *  row (completion, error, or abort): the disconnect snapshot must not be
 *  written over it, or the settled row reopens as an unfinished response.
 *  Only a same-epoch record is trusted, and only one whose terminal write
 *  actually landed. */
export function isSettledJobRecord(
  jobRecord:
    | {
        createdAt?: number;
        status?: string;
        terminalPersistencePending?: boolean;
        finalEvent?: string;
      }
    | null
    | undefined,
  jobCreatedAt?: number,
): boolean {
  if (jobRecord == null || (jobCreatedAt != null && jobRecord.createdAt !== jobCreatedAt)) {
    return false;
  }
  if (jobRecord.terminalPersistencePending === true) {
    /** The terminal claim precedes its row write: the status alone does not
     *  prove the row is durable, and the snapshot is still the fallback if
     *  that write fails. */
    return false;
  }
  if (hasDurableReconcileFrame(jobRecord.finalEvent)) {
    /** The terminal write failed and a reconciliation frame was published in
     *  its place: nothing was persisted for the turn, so the streamed
     *  snapshot remains its only row. */
    return false;
  }
  return (
    jobRecord.status === 'complete' ||
    jobRecord.status === 'error' ||
    jobRecord.status === 'aborted'
  );
}

/** How a disconnect may persist this turn's snapshot. */
export type DisconnectSnapshotMode =
  /** The run is still live: the snapshot keeps the live shape. */
  | 'live'
  /** The terminal write failed and settled for a reconciliation frame: the
   *  snapshot is the turn's only row, so it persists with the terminal
   *  outcome and envelope. */
  | 'terminal'
  /** A settled terminal row exists: the snapshot is withheld so it cannot
   *  reopen the settled turn. */
  | 'skip';

/**
 * How the last-subscriber disconnect may persist this turn's snapshot. A
 * compaction whose settling path (completion, error, abort) durably owns the
 * final row must not have it reopened as an unfinished snapshot; a compaction
 * whose terminal write settled for a reconciliation frame has no row at all,
 * so its snapshot is promoted to the terminal row; ordinary turns keep
 * writing their fallback row exactly as before, because their terminal row
 * write may still fail.
 */
export function resolveDisconnectSnapshotMode(
  isCompaction: boolean,
  jobRecord:
    | {
        createdAt?: number;
        status?: string;
        terminalPersistencePending?: boolean;
        finalEvent?: string;
      }
    | null
    | undefined,
  jobCreatedAt?: number,
): DisconnectSnapshotMode {
  if (!isCompaction) {
    return 'live';
  }
  if (isSettledJobRecord(jobRecord, jobCreatedAt)) {
    return 'skip';
  }
  return hasDurableReconcileFrame(jobRecord?.finalEvent) ? 'terminal' : 'live';
}

/** How the abort route persists a stopped turn's prerequisite rows. */
export type AbortAnchorDecision = 'persist' | 'skip-anchor' | 'skip-turn';

/**
 * Decides how a stopped turn's persistence treats its user row, reading the
 * anchor through the caller's database reader. A compaction's `userMessage`
 * is the branch leaf projected for identity only: when the leaf is persisted,
 * the projection must never be upserted over it (an ordinary prerequisite
 * write would erase a user leaf's text or turn an assistant leaf into an
 * empty user row), so only the aborted response is written. When the leaf is
 * NOT persisted, Stop won the race before the branch loaded and there is
 * nothing to anchor the response onto, so nothing is written at all; a read
 * that fails says the same thing, without throwing past the caller's
 * remaining cleanup. Ordinary turns keep the prerequisite write.
 */
export async function resolveAbortedTurnAnchorDecision(
  jobData:
    | {
        compact?: boolean;
        conversationId?: string;
        userMessage?: { messageId?: string } | null;
      }
    | null
    | undefined,
  {
    messageExists,
  }: { messageExists: (messageId: string, conversationId?: string) => Promise<boolean> },
): Promise<AbortAnchorDecision> {
  if (jobData?.compact !== true) {
    return 'persist';
  }
  /** A compaction with no anchor id has nothing to hang its response on. */
  const anchorId = jobData.userMessage?.messageId;
  if (anchorId == null || anchorId.length === 0) {
    return 'skip-turn';
  }
  try {
    const anchorExists = await messageExists(anchorId, jobData.conversationId);
    return anchorExists ? 'skip-anchor' : 'skip-turn';
  } catch {
    return 'skip-turn';
  }
}

/** The abort route's persistence plan for a stopped turn: which rows to write
 *  and whether the normal FINAL must be withheld (the manager publishes a
 *  reconciliation frame instead, so the client is never pointed at a response
 *  that was deliberately never persisted). */
export interface AbortedTurnPersistencePlan {
  writeUserRow: boolean;
  writeResponseRow: boolean;
  /** An ordinary stopped reply stays `unfinished` so it can be continued; a
   *  stopped compaction is settled, since nothing continues it and a live
   *  envelope would keep restored sessions reading it as still running. */
  responseUnfinished: boolean;
  withholdFinal: boolean;
  withholdReason?: string;
}

export function planAbortedTurnPersistence(
  anchorDecision: AbortAnchorDecision,
  shouldPersistAbortedTurn: boolean,
): AbortedTurnPersistencePlan {
  const active = shouldPersistAbortedTurn && anchorDecision !== 'skip-turn';
  /** Withholding the FINAL only matters when a row would otherwise have been
   *  written: an abort with no persistable content and no created event
   *  publishes an early-abort FINAL of its own, and nothing was withheld. */
  const withhold = shouldPersistAbortedTurn && anchorDecision === 'skip-turn';
  return {
    writeUserRow: active && anchorDecision === 'persist',
    writeResponseRow: active,
    responseUnfinished: anchorDecision === 'persist',
    withholdFinal: withhold,
    ...(withhold && {
      withholdReason: 'Compaction anchor unavailable; abort turn withheld',
    }),
  };
}

/**
 * The abort route's whole persistence decision for a stopped turn: reads the
 * compaction anchor through the caller's message reader (id-only), plans the
 * rows, and returns the failures the route must report so the manager
 * publishes a reconciliation frame instead of a normal FINAL.
 */
export async function resolveAbortedTurnPersistence(
  jobData: Parameters<typeof resolveAbortedTurnAnchorDecision>[0],
  shouldPersistAbortedTurn: boolean,
  {
    userId,
    getMessages,
  }: {
    userId?: string;
    getMessages: (
      filter: { user?: string; messageId: string; conversationId?: string },
      projection?: string,
    ) => Promise<unknown[]>;
  },
): Promise<AbortedTurnPersistencePlan & { persistenceErrors: Error[] }> {
  /** No row to write means no anchor to verify: the read is skipped, so an
   *  outage cannot turn an early abort's own FINAL into a reconciliation. */
  if (!shouldPersistAbortedTurn) {
    return { ...planAbortedTurnPersistence('persist', false), persistenceErrors: [] };
  }
  /** A failed read still resolves to skip-turn, so cleanup runs; the failure
   *  itself is reported beside the withheld turn, keeping an outage
   *  distinguishable from an absent anchor at the caller's error boundary. */
  let readError: Error | undefined;
  const anchorDecision = await resolveAbortedTurnAnchorDecision(jobData, {
    messageExists: async (messageId, conversationId) => {
      try {
        return (await getMessages({ user: userId, messageId, conversationId }, '_id')).length > 0;
      } catch (error) {
        readError = error instanceof Error ? error : new Error(String(error));
        throw error;
      }
    },
  });
  const plan = planAbortedTurnPersistence(anchorDecision, shouldPersistAbortedTurn);
  const persistenceErrors: Error[] = [];
  if (readError != null) {
    persistenceErrors.push(readError);
  }
  if (plan.withholdFinal && plan.withholdReason) {
    persistenceErrors.push(new Error(plan.withholdReason));
  }
  return { ...plan, persistenceErrors };
}

/** A message row as the failed-turn settlement reads it: identity for the
 *  anchor-shaped check, content and envelope for the live row it finalizes. */
export type ReadableMessageRow = {
  messageId: string;
  content?: unknown;
  unfinished?: boolean;
};

/** How a failed generation's fresh error row proceeds after its existing rows
 * are settled. */
export type ErrorTurnSettlement =
  /** An existing row covers the turn; the caller skips the error row. */
  | { covered: true }
  /** The error row is written under `errorRowMessageId`: the error id
   * itself, or the live response id when the anchor-shaped collision makes
   * the error id unusable for it. */
  | { covered: false; errorRowMessageId: string };

/**
 * Settles the rows a failed generation already persisted before its error row
 * is written, through the caller's injected reads and write.
 *
 * The error id can normalize back to the compaction anchor itself when the
 * anchor ends in `_`: a match there never receives the error row, and the
 * failed run settles its own distinct live response row instead. When no live
 * row exists either, the error row is still written, redirected to the live
 * response id so it can never overwrite the anchor. Ordinary turns keep their
 * existing behavior: a found partial row is preserved as it stands and blocks
 * the error row.
 */
export async function settleExistingRowsBeforeErrorTurn(
  requestBody: { compact?: boolean } | null | undefined,
  {
    userId,
    conversationId,
    errorMessageId,
    liveResponseMessageId,
    getMessages,
    saveFinalizedTurn,
    announceSettledTurn,
  }: {
    userId: string;
    conversationId: string;
    errorMessageId: string;
    liveResponseMessageId?: string | null;
    getMessages: (
      filter: { user: string; messageId: string; conversationId: string },
      projection?: string,
    ) => Promise<ReadableMessageRow[]>;
    saveFinalizedTurn: (message: Record<string, unknown>) => Promise<unknown>;
    /** Announces a row this settlement finalized, as the error row's own
     *  path does, so other devices learn the persisted turn ended. */
    announceSettledTurn?: (messageId: string) => Promise<unknown>;
  },
): Promise<ErrorTurnSettlement> {
  const isCompaction = requestBody?.compact === true;
  const settleLiveRow = async (): Promise<boolean> => {
    if (liveResponseMessageId == null || liveResponseMessageId === errorMessageId) {
      return false;
    }
    /** Full documents only where the compaction finalization needs the
     *  content; ordinary failures keep the id-only projection. */
    const partial = await getMessages(
      { user: userId, messageId: liveResponseMessageId, conversationId },
      isCompaction ? undefined : '_id',
    );
    if (partial.length === 0) {
      return false;
    }
    const finalized = await persistFinalizedCompactionTurn(partial[0], requestBody, {
      messageId: liveResponseMessageId,
      conversationId,
      saveMessage: saveFinalizedTurn,
    });
    if (finalized) {
      await announceSettledTurn?.(liveResponseMessageId);
    }
    return true;
  };
  const existing = await getMessages(
    { user: userId, messageId: errorMessageId, conversationId },
    '_id',
  );
  if (existing.length > 0) {
    if (!isCompaction) {
      return { covered: true };
    }
    if (await settleLiveRow()) {
      return { covered: true };
    }
    /** The match is the anchor itself: the error row goes to the failed
     *  run's own response id when one exists, and is withheld entirely when
     *  none does (a failure before the id was allocated), because writing it
     *  under the error id would overwrite the anchor. */
    if (liveResponseMessageId != null && liveResponseMessageId !== errorMessageId) {
      return { covered: false, errorRowMessageId: liveResponseMessageId };
    }
    return { covered: true };
  }
  if (await settleLiveRow()) {
    return { covered: true };
  }
  return { covered: false, errorRowMessageId: errorMessageId };
}

/**
 * Finalizes a failed compaction's already-persisted partial row, with the
 * write injected so the operation runs against whatever persistence the
 * caller owns. The row settles with the terminal envelope the error path
 * writes (an errored, finished turn): with the snapshot's `unfinished` flag
 * left in place, restored sessions and downstream readers would keep
 * classifying the failed turn as an incomplete response. Returns whether a
 * write happened.
 */
export async function persistFinalizedCompactionTurn(
  partialRow: { content?: unknown } | null | undefined,
  requestBody: { compact?: boolean } | null | undefined,
  {
    messageId,
    conversationId,
    saveMessage,
  }: {
    messageId: string;
    conversationId: string;
    saveMessage: (message: Record<string, unknown>) => Promise<unknown>;
  },
): Promise<boolean> {
  const finalized = resolveFinalizedCompactionTurn(partialRow, requestBody);
  if (!finalized.write) {
    return false;
  }
  const saved = await saveMessage({
    messageId,
    conversationId,
    unfinished: false,
    error: true,
    ...(finalized.content != null && { content: finalized.content }),
  });
  if (saved == null) {
    /** The same contract the surrounding failed-turn persistence holds: a
     *  falsy save is a failure to settle, not a settled row. */
    throw new Error('Failed compaction turn could not be finalized');
  }
  return true;
}

/** What a failed compaction does with its already-persisted partial row. */
export type FinalizedCompactionTurn =
  /** Not the failed run's row, or one holding nothing but a completed
   *  checkpoint on a row that was already settled. */
  | { write: false }
  /** The terminal marking is applied to the parts (a legacy or snapshot row
   *  may carry failure parts that never got the identity marker) and the row
   *  settles with the terminal envelope. */
  | { write: true; content: TMessageContentParts[] };

/**
 * The disconnect save is marker-only because the run is still live when it
 * fires, so when the run then fails that snapshot is the row that stays: a
 * partial summary is marked failed beside its text, a snapshot with no
 * summary or error part gets the typed failure, and a snapshot whose parts
 * already carry the failure has the terminal marking reapplied (idempotent
 * for marked parts, stamping legacy parts that predate the marker) beside
 * its settled envelope. A completed checkpoint is preserved as content, but a
 * snapshot still flagged `unfinished` settles its envelope even then, or the
 * restored conversation keeps treating the terminal job as live; a row that
 * was already settled is left alone. Rows of turns that were not compactions
 * are never written.
 */
export function resolveFinalizedCompactionTurn(
  partialRow: { content?: unknown; unfinished?: boolean } | null | undefined,
  requestBody: { compact?: boolean } | null | undefined,
): FinalizedCompactionTurn {
  if (requestBody?.compact !== true) {
    return { write: false };
  }
  /** A settled row belongs to the path that settled it, whatever its
   *  parts hold: a late failure must not rewrite or re-announce it. */
  if (partialRow?.unfinished === false) {
    return { write: false };
  }
  const content = Array.isArray(partialRow?.content)
    ? (partialRow.content as TMessageContentParts[])
    : [];
  /** Every part is inspected: a row can hold an earlier round's terminal
   *  outcome beside a later unfinished summary, and that summary still needs
   *  its failure marked. */
  let sawFailure = false;
  let sawCheckpoint = false;
  let unfinishedSummary = false;
  for (const part of content) {
    if (part?.type === ContentTypes.SUMMARY) {
      if (part.failed === true) {
        sawFailure = true;
      } else if (isUsableSummaryPart(part)) {
        sawCheckpoint = true;
      } else {
        unfinishedSummary = true;
      }
    } else if (part?.type === ContentTypes.ERROR) {
      sawFailure = true;
    }
  }
  if (unfinishedSummary || sawFailure) {
    return { write: true, content: markAbortedCompactionContent(content, true) };
  }
  if (sawCheckpoint) {
    return partialRow?.unfinished === true
      ? { write: true, content: markAbortedCompactionContent(content, true) }
      : { write: false };
  }
  return { write: true, content: markAbortedCompactionContent(content, true) };
}

/**
 * Stamps `initiatedBy: 'user'` on the part that carries a manual compaction's
 * outcome, which is the turn's only record of having been one: the run emits no
 * text of its own, and a compaction hangs off whatever leaf the branch ends
 * with, so a reader cannot infer it from the turn's shape or its parent.
 *
 * Every outcome is marked. A run that produced a summary marks it; a run that
 * recorded why it could not (an error part, e.g. a skipped compaction) marks
 * that instead; a run that produced neither records the typed failure here, so
 * it persists and streams like any other failed compaction rather than as an
 * empty assistant message. A cancelled run keeps failing as a typed error: the
 * turn stopped early rather than failing, and the abort path owns it.
 */
export function markCompactionOutcome(
  contentParts: TMessageContentParts[],
  { aborted = false }: { aborted?: boolean } = {},
): void {
  const summary = contentParts.find(isUsableSummaryPart);
  if (summary != null) {
    summary.initiatedBy = 'user';
    return;
  }
  let markedFailure = false;
  for (const part of contentParts) {
    if (part?.type === ContentTypes.ERROR) {
      part.initiatedBy = 'user';
      markedFailure = true;
    }
  }
  if (markedFailure) {
    return;
  }
  if (aborted) {
    throw Object.assign(new Error(COMPACTION_FAILED_ERROR), { code: 'COMPACTION_FAILED' });
  }
  /** A failed round keeps whatever deltas it streamed, and a summary part with
   *  text is the history boundary for everything downstream. Persisting a
   *  truncated one would stand in for the history it failed to summarize, so
   *  the unusable summary goes and the typed failure is the turn's whole
   *  outcome. */
  for (let index = contentParts.length - 1; index >= 0; index -= 1) {
    if (contentParts[index]?.type === ContentTypes.SUMMARY) {
      contentParts.splice(index, 1);
    }
  }
  contentParts.push(...compactionFailureContent());
}

function isSummaryPartWithText(part: unknown): boolean {
  if (part == null || typeof part !== 'object' || !('type' in part)) {
    return false;
  }
  if (part.type !== ContentTypes.SUMMARY) {
    return false;
  }
  /** Narrowed by the discriminant above: this is the summary union member. */
  const summary = part as SummaryContentPart;
  return getSummaryPartText(summary).length > 0;
}

/** The content of one message with every unusable summary part removed, or the
 *  same array when there was nothing to remove. */
function withoutUnusableSummaryParts(content: unknown[]): unknown[] {
  const filtered = content.filter(
    (part) => isUsableSummaryPart(part) || !isSummaryPartWithText(part),
  );
  return filtered.length === content.length ? content : filtered;
}

/**
 * Points one model-facing message at content free of the summary parts that
 * cannot bound history, and reports whether anything went. The SDK's summary
 * scan takes the last summary part carrying text as the conversation's history
 * boundary and drops every message before it, reading neither `failed` nor
 * `summarizing`: a round that errored or was cut off keeps the deltas it
 * streamed, so leaving that part in would replace the history it never
 * finished summarizing with the prefix it produced. An empty summary is left
 * alone — it bounds nothing, and the renderer owns how it appears.
 *
 * The message gets a NEW content array rather than a spliced one, because a
 * formatted prompt copy shares its content array with the stored message it
 * came from: splicing would reindex the persisted row's parts under every
 * reader that holds it. This belongs on a prompt copy before its token count
 * is taken, so the count, the prompt total an admission check reads, and any
 * later per-index adjustment all describe what the model actually receives.
 */
export function dropUnusableSummaryParts(message: { content?: unknown }): boolean {
  const content = message?.content;
  if (!Array.isArray(content)) {
    return false;
  }
  const filtered = withoutUnusableSummaryParts(content);
  if (filtered === content) {
    return false;
  }
  message.content = filtered;
  return true;
}

/**
 * The same rule for a payload whose messages the caller may not touch:
 * returns a payload of messages carrying no unusable summary part, leaving the
 * input and its messages untouched and returning the same reference when
 * nothing needed dropping. Message positions are preserved, so an index-keyed
 * token map stays aligned.
 */
export function stripUnusableSummaryParts<T extends { content?: unknown }>(payload: T[]): T[] {
  if (!Array.isArray(payload)) {
    return payload;
  }
  let changed = false;
  const result = payload.map((message) => {
    const content = message?.content;
    if (!Array.isArray(content)) {
      return message;
    }
    const filtered = withoutUnusableSummaryParts(content);
    if (filtered === content) {
      return message;
    }
    changed = true;
    return { ...message, content: filtered };
  });
  return changed ? result : payload;
}

function snapshotEntry(
  entry: CompactionSemanticIndexEntry,
): TCompactionSemanticIndexEntry | undefined {
  const { type, sourceMessageId, sourceContentIndex, revision, status, text, redacted } = entry;
  if (
    typeof sourceMessageId !== 'string' ||
    sourceMessageId.length === 0 ||
    sourceMessageId.length > MAX_COMPACTION_SEMANTIC_INDEX_IDENTITY_LENGTH ||
    !Number.isSafeInteger(sourceContentIndex) ||
    sourceContentIndex < 0 ||
    sourceContentIndex > MAX_COMPACTION_SEMANTIC_INDEX_SOURCE_CONTENT_INDEX ||
    !Number.isSafeInteger(revision) ||
    revision < 0 ||
    (status !== 'committed' && status !== 'pending') ||
    typeof text !== 'string' ||
    (redacted !== undefined && typeof redacted !== 'boolean')
  ) {
    return undefined;
  }
  const oversized = text.length > MAX_COMPACTION_SEMANTIC_INDEX_TEXT_LENGTH;
  const snapshotRedacted = redacted === true || oversized;
  const snapshotText = status === 'pending' || snapshotRedacted ? '' : text;
  const common = {
    sourceMessageId,
    sourceContentIndex,
    revision,
    status,
    text: snapshotText,
    ...(redacted !== undefined || oversized ? { redacted: snapshotRedacted } : {}),
  };
  if (type === 'activity_phase') {
    return { type, ...common };
  }
  if (type === 'reasoning_label') {
    const reasoningStepId = entry.reasoningStepId;
    if (
      typeof reasoningStepId !== 'string' ||
      reasoningStepId.length === 0 ||
      reasoningStepId.length > MAX_COMPACTION_SEMANTIC_INDEX_IDENTITY_LENGTH
    ) {
      return undefined;
    }
    return { type, reasoningStepId, ...common };
  }
  const toolCallId = entry.toolCallId;
  if (
    typeof toolCallId !== 'string' ||
    toolCallId.length === 0 ||
    toolCallId.length > MAX_COMPACTION_SEMANTIC_INDEX_IDENTITY_LENGTH
  ) {
    return undefined;
  }
  return { type, toolCallId, ...common };
}

function isCompactionSemanticIndexSnapshot(
  input: CompactionSemanticIndex | CompactionSemanticIndexSnapshot,
): input is CompactionSemanticIndexSnapshot {
  return !Array.isArray(input);
}

export function createCompactionSemanticIndexProjection(
  input: CompactionSemanticIndex | CompactionSemanticIndexSnapshot | undefined,
): ICompactionSemanticIndexProjection | undefined {
  if (input == null) {
    return undefined;
  }
  const isSnapshot = isCompactionSemanticIndexSnapshot(input);
  const index = isSnapshot ? input.entries : input;
  const providedEntryCount = isSnapshot ? input.providedEntryCount : input.length;
  if (
    !Array.isArray(index) ||
    index.length === 0 ||
    index.length > MAX_COMPACTION_SEMANTIC_INDEX_ENTRIES ||
    providedEntryCount == null ||
    !Number.isSafeInteger(providedEntryCount) ||
    providedEntryCount < index.length
  ) {
    return undefined;
  }
  const entries: TCompactionSemanticIndexEntry[] = [];
  for (const entry of index) {
    const snapshot = snapshotEntry(entry);
    if (snapshot == null) {
      return undefined;
    }
    entries.push(snapshot);
  }
  return {
    version: COMPACTION_SEMANTIC_INDEX_PROJECTION_VERSION,
    entries,
    providedEntryCount,
  };
}

export function restoreCompactionSemanticIndexSnapshot(
  projection: ICompactionSemanticIndexProjection | null | undefined,
): CompactionSemanticIndexSnapshot | undefined {
  if (!isCompactionSemanticIndexProjection(projection)) {
    return undefined;
  }
  const entries: CompactionSemanticIndexEntry[] = [];
  for (const entry of projection.entries) {
    const snapshot = snapshotEntry(entry);
    if (snapshot == null) {
      return undefined;
    }
    entries.push(Object.freeze(snapshot));
  }
  return Object.freeze({
    entries: Object.freeze(entries),
    providedEntryCount: projection.providedEntryCount ?? entries.length,
  });
}

export function restoreCompactionSemanticIndex(
  projection: ICompactionSemanticIndexProjection | null | undefined,
): CompactionSemanticIndex | undefined {
  return restoreCompactionSemanticIndexSnapshot(projection)?.entries;
}
