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
