import { Constants, ContentTypes } from 'librechat-data-provider';
import type {
  TMessage,
  TPendingSteer,
  TSteerAppliedEvent,
  TMessageContentParts,
} from 'librechat-data-provider';
import type { QueuedMessage, QueuedMessageOrigin } from '~/store/families';

type SteerPart = Extract<TMessageContentParts, { type: ContentTypes.STEER }>;

/** Returns the steer content part when `part` is one, else undefined. */
export function getSteerPart(part: TMessageContentParts | undefined): SteerPart | undefined {
  return part?.type === ContentTypes.STEER ? (part as SteerPart) : undefined;
}

/** Server/client ids embedded in applied steer parts, whether passed a raw
 * content array or message objects. Used during reconnect to retire a failed
 * optimistic chip whose POST ACK was lost before the steer applied offline. */
export function collectAppliedSteerIds(values: unknown[] | undefined): string[] {
  if (!values) {
    return [];
  }
  const ids = new Set<string>();
  for (const value of values) {
    if (value == null || typeof value !== 'object') {
      continue;
    }
    const object = value as {
      type?: unknown;
      steerId?: unknown;
      clientSteerId?: unknown;
      content?: unknown;
    };
    const parts = Array.isArray(object.content) ? object.content : [object];
    for (const part of parts) {
      if (part == null || typeof part !== 'object') {
        continue;
      }
      const candidate = part as {
        type?: unknown;
        steerId?: unknown;
        clientSteerId?: unknown;
      };
      if (candidate.type !== ContentTypes.STEER) {
        continue;
      }
      if (typeof candidate.steerId === 'string') {
        ids.add(candidate.steerId);
      }
      if (typeof candidate.clientSteerId === 'string') {
        ids.add(candidate.clientSteerId);
      }
    }
  }
  return [...ids];
}

/** Ids of applied steer parts that carry NO quotes, same traversal as
 * `collectAppliedSteerIds`. Paired with a quote-bearing local chip, such a
 * part proves a pre-quotes server injected the words bare — the chip's
 * excerpts must be re-staged before the settle removes their only copy. */
export function collectQuotelessAppliedSteerIds(values: unknown[] | undefined): Set<string> {
  if (!values) {
    return new Set();
  }
  const ids = new Set<string>();
  for (const value of values) {
    if (value == null || typeof value !== 'object') {
      continue;
    }
    const object = value as { content?: unknown };
    const parts = Array.isArray(object.content) ? object.content : [value];
    for (const part of parts) {
      if (part == null || typeof part !== 'object') {
        continue;
      }
      const candidate = part as {
        type?: unknown;
        steerId?: unknown;
        clientSteerId?: unknown;
        quotes?: unknown;
      };
      if (candidate.type !== ContentTypes.STEER) {
        continue;
      }
      if (Array.isArray(candidate.quotes) && candidate.quotes.length > 0) {
        continue;
      }
      if (typeof candidate.steerId === 'string') {
        ids.add(candidate.steerId);
      }
      if (typeof candidate.clientSteerId === 'string') {
        ids.add(candidate.clientSteerId);
      }
    }
  }
  return ids;
}

/** Max excerpts staged at once; mirrors the backend `QUOTE_MAX_COUNT` cap so
 *  every displayed chip actually reaches the model on the next send. */
export const MAX_QUOTE_COUNT = 10;

/** Dedupe-appends re-staged excerpts onto the composer's pending-quote chips,
 * returning `prev` untouched when nothing new lands (Recoil referential
 * stability). The dedupe also makes the multiple restore triggers — ACK echo,
 * applied event, reconnect settle — idempotent for the same excerpts. Capped
 * at `MAX_QUOTE_COUNT` with the already-staged chips winning: a restored tail
 * that cannot ride the next send is dropped explicitly rather than displayed
 * as a chip the submission would silently discard. */
export function mergeRestagedQuotes(prev: string[], quotes: string[]): string[] {
  const room = MAX_QUOTE_COUNT - prev.length;
  if (room <= 0) {
    return prev;
  }
  const fresh = quotes.filter((quote) => !prev.includes(quote)).slice(0, room);
  return fresh.length > 0 ? [...prev, ...fresh] : prev;
}

/** Excerpts to re-stage when applied steer parts settle their chips: the
 * quotes carried by each chip whose applied part has none — proof a
 * pre-quotes server injected the words bare, leaving the chip as the only
 * copy of the user's excerpts. */
export function collectDroppedSteerQuotes(
  values: unknown[] | undefined,
  chips: readonly Pick<TPendingSteer, 'steerId' | 'clientSteerId' | 'quotes'>[],
): string[] {
  const quoteless = collectQuotelessAppliedSteerIds(values);
  if (quoteless.size === 0) {
    return [];
  }
  return chips.flatMap((steer) =>
    (steer.quotes?.length ?? 0) > 0 &&
    (quoteless.has(steer.steerId) ||
      (steer.clientSteerId != null && quoteless.has(steer.clientSteerId)))
      ? (steer.quotes ?? [])
      : [],
  );
}

/**
 * Places an injected steer part at its absolute content index on the target
 * response message. The server reserved that slot (subsequent SDK events were
 * emitted with already-shifted indices), so the write never collides with
 * streamed parts — the array is written by index, holes included, exactly like
 * the streaming content handler.
 *
 * Pure with a referential-stability contract shared with `applyPendingAction`:
 * returns the SAME message reference when the part is already present
 * (duplicate event replay), a new message otherwise.
 */
export function applySteerPart(message: TMessage, event: TSteerAppliedEvent): TMessage {
  const { index, part } = event;
  if (typeof index !== 'number' || index < 0 || part == null) {
    return message;
  }
  const content = Array.isArray(message.content) ? message.content : [];
  const existing = getSteerPart(content[index] as TMessageContentParts | undefined);
  if (existing != null && existing.steerId === part.steerId) {
    if (existing.files?.length && !part.files?.length) {
      const nextContent = [...content] as TMessageContentParts[];
      nextContent[index] = part as TMessageContentParts;
      return { ...message, content: nextContent };
    }
    return message;
  }
  const nextContent = [...content] as TMessageContentParts[];
  nextContent[index] = part as TMessageContentParts;
  return { ...message, content: nextContent };
}

/**
 * Conversation key for the run-end queue signal. An early-aborted FIRST turn
 * has no server-side conversation (the client restores /c/new), so keying the
 * signal by the optimistic stream id would park queued follow-ups under an id
 * the user never sees again — key under NEW_CONVO (and drop the migration
 * flag) so `useQueueDrain` leaves the queue on the new-chat composer.
 */
export function resolveRunEndTarget(params: {
  conversationId: string;
  earlyAbort: boolean;
  startedAsNewConvo: boolean;
}): { conversationId: string; startedAsNewConvo: boolean } {
  const { conversationId, earlyAbort, startedAsNewConvo } = params;
  if (earlyAbort && startedAsNewConvo) {
    return { conversationId: String(Constants.NEW_CONVO), startedAsNewConvo: false };
  }
  return { conversationId, startedAsNewConvo };
}

/**
 * Targets for consuming an abort HTTP response's leftover steers. The server
 * echoes the RESOLVED job id (`aborted`), which is authoritative when the
 * client still holds the `new` placeholder on a just-started first turn.
 * Chips and the interrupt-drain signal land where the mounted composer's
 * queue/drain machinery looks: a `new`-held turn hasn't navigated, so they
 * stay keyed under NEW_CONVO (same rule as `resolveRunEndTarget`'s early-abort
 * case), while the parked-copy claim uses the resolved id the server keyed
 * the parked steers under.
 */
export function resolveAbortSteerTarget(params: { conversationId: string; resolvedId?: string }): {
  chipConvoId: string;
  claimConvoId: string;
} {
  const { conversationId, resolvedId } = params;
  const claimConvoId = resolvedId ?? conversationId;
  const chipConvoId =
    conversationId === String(Constants.NEW_CONVO) ? conversationId : claimConvoId;
  return { chipConvoId, claimConvoId };
}

/** Bounds the per-conversation applied-steer id set. A late 202 ACK can land
 * after the run's final event, so the set is capped rather than cleared.
 * Modern steers contribute both a server and client correlation id; retain
 * two ids for every one of the server's 100 durable receipt slots. */
const APPLIED_STEER_IDS_CAP = 200;

/**
 * Appends steer ids to an applied-id set, deduped and capped. Returns the
 * same array when nothing new lands so Recoil writers keep referential
 * stability.
 */
export function appendAppliedSteerIds(prev: string[], steerIds: string[]): string[] {
  const fresh = steerIds.filter((id) => !prev.includes(id));
  if (fresh.length === 0) {
    return prev;
  }
  return [...prev, ...fresh].slice(-APPLIED_STEER_IDS_CAP);
}

export type SteerCarriedContext = { quotes?: string[]; manualSkills?: string[] };

/** Quotes ride the steer POST (the server merges them into the injected
 *  turn) but chips, reseeds, and queued conversions still carry them locally
 *  so a steer that never injects restores with its excerpts intact. Skill
 *  picks are client-only — they configure a NEW turn's run, so only the
 *  restore paths carry them. */
export function carriedSteerContext(source?: SteerCarriedContext): SteerCarriedContext {
  const quotes = source?.quotes;
  const manualSkills = source?.manualSkills;
  return {
    ...(quotes && quotes.length > 0 && { quotes }),
    ...(manualSkills && manualSkills.length > 0 && { manualSkills }),
  };
}

/** Restore a temporarily removed queue item using surviving original
 * neighbours first, then the queue's durable priority/time ordering. */
export function insertQueuedOrigin(
  queue: QueuedMessage[],
  origin: QueuedMessageOrigin,
  expectedPredecessorCreatedAt?: number,
): QueuedMessage[] {
  const rebasePredecessor = (item: QueuedMessage): QueuedMessage => {
    if (expectedPredecessorCreatedAt === undefined) {
      return item;
    }
    return item.expectedPredecessorCreatedAt === expectedPredecessorCreatedAt
      ? item
      : { ...item, expectedPredecessorCreatedAt };
  };

  const existingIndex = queue.findIndex((queued) => queued.id === origin.item.id);
  if (existingIndex >= 0) {
    const rebased = rebasePredecessor(queue[existingIndex]);
    if (rebased === queue[existingIndex]) {
      return queue;
    }
    const next = [...queue];
    next[existingIndex] = rebased;
    return next;
  }
  const restoredItem = rebasePredecessor(origin.item);
  let index = -1;
  for (const id of origin.afterIds) {
    index = queue.findIndex((queued) => queued.id === id);
    if (index >= 0) {
      break;
    }
  }
  if (index < 0) {
    for (let i = origin.beforeIds.length - 1; i >= 0; i -= 1) {
      const beforeIndex = queue.findIndex((queued) => queued.id === origin.beforeIds[i]);
      if (beforeIndex >= 0) {
        index = beforeIndex + 1;
        break;
      }
    }
  }
  if (index < 0) {
    index = queue.findIndex((queued) => {
      const itemPriority = Number(restoredItem.priority === true);
      const queuedPriority = Number(queued.priority === true);
      return (
        itemPriority > queuedPriority ||
        (itemPriority === queuedPriority && restoredItem.createdAt < queued.createdAt)
      );
    });
    if (index < 0) {
      index = queue.length;
    }
  }
  return [...queue.slice(0, index), restoredItem, ...queue.slice(index)];
}

/** Merges steer lists into one id-deduped conversion batch (first wins). */
export function dedupeSteersById(...lists: Array<TPendingSteer[] | undefined>): TPendingSteer[] {
  const seen = new Set<string>();
  const merged: TPendingSteer[] = [];
  for (const list of lists) {
    for (const steer of list ?? []) {
      if (seen.has(steer.steerId)) {
        continue;
      }
      seen.add(steer.steerId);
      merged.push(steer);
    }
  }
  return merged;
}

/**
 * Resolves the assistant row a server event addresses by `responseMessageId`.
 *
 * The server stamps steer and activity-label events with the response id it
 * pre-allocated at job creation, but the pane renders under `${userMessageId}_`
 * until the FIRST run step renames the row — the `created` event carries only
 * the user message. An event injected before any step (an interrupt before the
 * model has said a word lands its steer at content index 0) therefore names a
 * row that does not exist locally yet, and would otherwise be retried until the
 * frame budget ran out and then dropped from the live view while the persisted
 * message kept it.
 *
 * `fallbackMessageIds` are the pane's OWN placeholder identities, supplied by
 * the caller from its submission in priority order. They are an explicit
 * identity, never a guess by position: a regenerate targets an older branch
 * while the visible history still ends at a later assistant, so the last
 * assistant row is never taken when the event carries an id — a miss returns
 * -1 and the caller retries next frame, same rationale as
 * `findPendingActionMessageIndex`. The rename copies the placeholder's content
 * forward, so a part placed here rides into the renamed row. Without an id the
 * best-effort last assistant row is used.
 */
export function findResponseMessageIndex(
  messages: TMessage[],
  responseMessageId: string | null | undefined,
  fallbackMessageIds: readonly (string | null | undefined)[] = [],
): number {
  const isAssistant = (message: TMessage | undefined) => message?.isCreatedByUser === false;
  if (!responseMessageId) {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (isAssistant(messages[i])) {
        return i;
      }
    }
    return -1;
  }
  const placeholderIds = fallbackMessageIds.filter((id): id is string => Boolean(id));
  let placeholder = -1;
  let placeholderRank = placeholderIds.length;
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (!isAssistant(message)) {
      continue;
    }
    if (message.messageId === responseMessageId) {
      return i;
    }
    const rank = placeholderIds.indexOf(message.messageId);
    if (rank >= 0 && rank < placeholderRank) {
      placeholder = i;
      placeholderRank = rank;
    }
  }
  return placeholder;
}

/** Resolves the assistant row an applied steer targets; see `findResponseMessageIndex`. */
export function findSteerMessageIndex(
  messages: TMessage[],
  event: TSteerAppliedEvent,
  fallbackMessageIds: readonly (string | null | undefined)[] = [],
): number {
  return findResponseMessageIndex(messages, event.responseMessageId, fallbackMessageIds);
}
