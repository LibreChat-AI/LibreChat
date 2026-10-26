import { QueryKeys, Constants, buildTree, ContentTypes } from 'librechat-data-provider';
import {
  hasStreamStartFailed,
  stripStreamedIndexStamps,
  createDualMessageContent,
  STREAM_START_FAILED_METADATA_KEY,
} from '@librechat/chat';
import type { Agents, TMessage, TMessageContentParts } from 'librechat-data-provider';
import type { QueryClient } from '@tanstack/react-query';
import type { LocalizeFunction, TMessageProps } from '~/common';

export {
  hasStreamStartFailed,
  stripStreamedIndexStamps,
  createDualMessageContent,
  STREAM_START_FAILED_METADATA_KEY,
};
export const TEXT_KEY_DIVIDER = '|||';

/** A locally submitted user row is not canonical until the server acknowledges it. */
export function isUnacknowledgedUserMessage(message: TMessage): boolean {
  return (
    message.isCreatedByUser === true &&
    message.clientTimestamp != null &&
    message.createdAt == null &&
    !message.privacyRevision
  );
}

type SiblingIndexLookup = (parentMessageId: string | null | undefined) => number;

export type BranchSiblingIndex = {
  parentMessageId: string | null | undefined;
  siblingIdx: number;
};

export const selectActiveBranchTail = (
  messages: TMessage[] | null | undefined,
  rootSiblingKey: string | null | undefined,
  getSiblingIndex: SiblingIndexLookup = () => 0,
): TMessage | null => {
  const messagesTree = buildTree({ messages: messages ?? null });
  if (!messagesTree?.length) {
    return null;
  }

  let siblings = messagesTree;
  let parentMessageId = rootSiblingKey;
  let tail: TMessage | null = null;

  while (siblings.length > 0) {
    const siblingIdx = getSiblingIndex(parentMessageId);
    const normalizedSiblingIdx = siblingIdx >= 0 && siblingIdx < siblings.length ? siblingIdx : 0;
    const activeSiblingIndex = siblings.length - normalizedSiblingIdx - 1;
    const message = siblings[activeSiblingIndex] ?? siblings[siblings.length - 1];
    if (!message) {
      return tail;
    }

    tail = message;
    parentMessageId = message.messageId;
    siblings = message.children ?? [];
  }

  return tail;
};

export const getMessageBranchSiblingParentIds = (
  messages: TMessage[] | null | undefined,
  rootSiblingKey: string | null | undefined,
): (string | null)[] => {
  const messagesTree = buildTree({ messages: messages ?? null });
  if (!messagesTree?.length) {
    return [];
  }

  const parentIds = new Set<string | null>();
  const stack = [{ siblings: messagesTree, parentMessageId: rootSiblingKey, index: 0 }];
  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    if (frame.index === 0 && frame.siblings.length > 1) {
      parentIds.add(frame.parentMessageId ?? null);
    }
    const message = frame.siblings[frame.index++];
    if (!message) {
      stack.pop();
      continue;
    }
    if (message.children?.length) {
      stack.push({ siblings: message.children, parentMessageId: message.messageId, index: 0 });
    }
  }
  return Array.from(parentIds);
};

export const getBranchSiblingIndexesForTarget = (
  messages: TMessage[] | null | undefined,
  targetMessageId: string | null | undefined,
  rootSiblingKey: string | null | undefined,
): BranchSiblingIndex[] => {
  if (!targetMessageId) {
    return [];
  }

  const messagesTree = buildTree({ messages: messages ?? null });
  if (!messagesTree?.length) {
    return [];
  }

  const branchIndexes: BranchSiblingIndex[] = [];
  const stack = [
    { siblings: messagesTree, parentMessageId: rootSiblingKey, index: 0, branchCount: 0 },
  ];
  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    const index = frame.index++;
    const message = frame.siblings[index];
    if (!message) {
      stack.pop();
      continue;
    }
    branchIndexes.length = frame.branchCount;
    if (frame.siblings.length > 1) {
      branchIndexes.push({
        parentMessageId: frame.parentMessageId,
        siblingIdx: frame.siblings.length - index - 1,
      });
    }
    if (message.messageId === targetMessageId) {
      return branchIndexes;
    }
    if (message.children?.length) {
      stack.push({
        siblings: message.children,
        parentMessageId: message.messageId,
        index: 0,
        branchCount: branchIndexes.length,
      });
    }
  }
  return [];
};

export const getLatestText = (message?: TMessage | null, includeIndex?: boolean): string => {
  if (!message) {
    return '';
  }
  if (message.text) {
    return message.text;
  }
  if (message.content && message.content.length > 0) {
    for (let i = message.content.length - 1; i >= 0; i--) {
      const part = message.content[i] as TMessageContentParts | undefined;
      if (part && part.type !== ContentTypes.TEXT) {
        continue;
      }

      const text = (typeof part?.text === 'string' ? part.text : part?.text?.value) ?? '';
      if (text.length > 0) {
        if (includeIndex === true) {
          return `${text}-${i}`;
        } else {
          return text;
        }
      } else {
        continue;
      }
    }
  }
  return '';
};

export const getAllContentText = (message?: TMessage | null): string => {
  if (!message) {
    return '';
  }

  if (message.text) {
    return message.text;
  }

  if (message.content && message.content.length > 0) {
    return message.content
      .filter((part) => part != null && part.type === ContentTypes.TEXT)
      .map((part) => {
        if (!('text' in part)) return '';
        const text = part.text;
        if (typeof text === 'string') return text;
        return text?.value || '';
      })
      .filter((text) => text.length > 0)
      .join('\n');
  }

  return '';
};

const getPartTextValue = (value?: string | { value?: string }): string =>
  (typeof value === 'string' ? value : value?.value) ?? '';

const getPartToolCall = (part: TMessageContentParts): Agents.ToolCall | undefined =>
  part.type === ContentTypes.TOOL_CALL
    ? (part[ContentTypes.TOOL_CALL] as Agents.ToolCall | undefined)
    : undefined;

/** Slots the persistence compaction leaves nothing behind for: the
 * dual-message `type: ''` placeholders, text/think parts that never received a
 * delta, and tool calls missing their `tool_call` payload. */
export const isEmptyContentPart = (part: TMessageContentParts): boolean => {
  if (!part.type) {
    return true;
  }
  if (part.type === ContentTypes.TEXT) {
    return getPartTextValue(part.text).length === 0;
  }
  if (part.type === ContentTypes.THINK) {
    return getPartTextValue(part.think).length === 0;
  }
  if (part.type === ContentTypes.TOOL_CALL) {
    return getPartToolCall(part) == null;
  }
  return false;
};

/** One side extending the other is the same part observed at two moments —
 * a flushed tail or a server-side trim — while divergent content is a
 * different part that merely shares the type. */
const isMutualPrefix = (streamed: string, final: string): boolean =>
  final.startsWith(streamed) || streamed.startsWith(final);

/** Identity match, not equality: the persisted part may carry richer content
 * (flushed text, tool output) than its streamed counterpart, and updating a
 * kept identity in place is exactly the point. Content still has to agree as
 * an extension of what streamed: a filtered run (`hide_sequential_outputs`)
 * omits intermediate parts from the final array, and a type-only match would
 * hand the retained output an omitted intermediate's identity. */
const isSameStreamedPart = (
  streamed: TMessageContentParts,
  final: TMessageContentParts,
): boolean => {
  if (streamed.type !== final.type) {
    return false;
  }
  if (streamed.type === ContentTypes.TOOL_CALL) {
    const streamedCall = getPartToolCall(streamed);
    const finalCall = getPartToolCall(final);
    if (streamedCall?.id != null && finalCall?.id != null) {
      return streamedCall.id === finalCall.id;
    }
    if (streamedCall?.name != null && finalCall?.name != null) {
      return streamedCall.name === finalCall.name;
    }
    return true;
  }
  if (streamed.type === ContentTypes.TEXT && final.type === ContentTypes.TEXT) {
    if ((streamed.phase ?? null) !== (final.phase ?? null)) {
      return false;
    }
    return isMutualPrefix(getPartTextValue(streamed.text), getPartTextValue(final.text));
  }
  if (streamed.type === ContentTypes.THINK && final.type === ContentTypes.THINK) {
    return isMutualPrefix(getPartTextValue(streamed.think), getPartTextValue(final.think));
  }
  if (streamed.type === ContentTypes.ACTIVITY_LABEL && final.type === ContentTypes.ACTIVITY_LABEL) {
    if ((streamed.activity_label_type ?? null) !== (final.activity_label_type ?? null)) {
      return false;
    }
    return isMutualPrefix(
      getPartTextValue(streamed.activity_label),
      getPartTextValue(final.activity_label),
    );
  }
  return true;
};

/**
 * Stamps each part of a final (persisted, compacted) content array with the
 * index it occupied while it streamed, pairing the two arrays in order.
 *
 * The aggregator writes parts at provider-source indexes, so the streamed
 * array is sparse wherever a step produced nothing; persistence compacts the
 * holes away and every later part shifts down. Adopting the compacted array
 * verbatim re-keys every index-derived React identity at the final event —
 * the settled message remounts wholesale, entrance animations replay, and the
 * thread visibly jumps. The stamp (`streamedIndex`) lets renderers keep the
 * streamed key while all coordinate logic uses the compacted positions the
 * server persisted.
 *
 * Pairing is all-or-nothing: a partially stamped array could collide a
 * streamed key with a compacted fallback key. When any final part has no
 * streamed counterpart (server-enriched content), or any substantial streamed
 * part has no final counterpart (a filtered run that dropped intermediate
 * outputs — where in-order pairing could hand a retained part an omitted
 * part's identity), the final array is returned untouched and the message
 * re-keys as before.
 */
export const preserveStreamedContentIdentity = (
  streamedContent: Array<TMessageContentParts | undefined> | undefined,
  finalContent: TMessage['content'],
): TMessage['content'] => {
  if (!streamedContent?.length || !finalContent?.length) {
    return finalContent;
  }

  let cursor = 0;
  let stamped: TMessageContentParts[] | null = null;
  for (let index = 0; index < finalContent.length; index++) {
    const finalPart = finalContent[index] as TMessageContentParts | undefined;
    if (finalPart == null) {
      return finalContent;
    }
    let matchedIndex = -1;
    let matchedPart: TMessageContentParts | null = null;
    while (cursor < streamedContent.length) {
      const streamedPart = streamedContent[cursor];
      if (streamedPart == null) {
        cursor += 1;
        continue;
      }
      /** An empty streamed slot facing a filled final part was dropped by the
       *  compaction — never let it steal the match from the filled streamed
       *  part behind it (an empty THINK ahead of the real one, say). */
      if (isEmptyContentPart(streamedPart) && !isEmptyContentPart(finalPart)) {
        cursor += 1;
        continue;
      }
      if (isSameStreamedPart(streamedPart, finalPart)) {
        matchedIndex = cursor;
        matchedPart = streamedPart;
        cursor += 1;
      }
      break;
    }
    if (matchedIndex === -1 || matchedPart == null) {
      return finalContent;
    }
    /** A settled message can be re-delivered by a LATER final event (e.g. an
     *  Assistants run resyncing prior turns): both sides arrive compact, but
     *  the current parts already carry stamps from their own settle. Carrying
     *  them forward keeps their keys stable forever, instead of silently
     *  reverting the identity this stamp exists to preserve. */
    const stampIndex = matchedPart.streamedIndex ?? matchedIndex;
    if (stampIndex !== index && stamped == null) {
      stamped = [...finalContent];
    }
    if (stamped != null && stampIndex !== index) {
      stamped[index] = { ...finalPart, streamedIndex: stampIndex };
    }
  }
  /** Leftover substantial streamed parts mean the server REMOVED content
   *  (`hide_sequential_outputs`), so every pairing above is suspect — an
   *  omitted intermediate that happens to prefix the retained output would
   *  have claimed its identity. Only holes and empty slots may remain. */
  for (let rest = cursor; rest < streamedContent.length; rest++) {
    const leftover = streamedContent[rest];
    if (leftover != null && !isEmptyContentPart(leftover)) {
      return finalContent;
    }
  }
  return stamped ?? finalContent;
};

/** Render-identity index for content-part keys: the streamed position stamped
 * by the final handler survives the sparse→compact swap; everything else keys
 * by the live index. Coordinate logic (edit indexes, phase bounds, cursor)
 * must keep using the live index. */
export const getPartKeyIndex = (part: TMessageContentParts | undefined, idx: number): number =>
  part?.streamedIndex ?? idx;

/**
 * Whether a draft message has enough content to submit: non-whitespace
 * text, or at least one attached file. Lets users send a file without
 * having to type a placeholder message alongside it.
 */
export const isSubmittableMessage = (text?: string | null, fileCount = 0): boolean =>
  (text ?? '').trim() !== '' || fileCount > 0;

export const markStreamStartFailedMetadata = (
  metadata?: TMessage['metadata'],
): TMessage['metadata'] => ({
  ...(metadata ?? {}),
  [STREAM_START_FAILED_METADATA_KEY]: true,
});

export const scrollToEnd = (callback?: () => void) => {
  const messagesEndElement = document.getElementById('messages-end');
  if (messagesEndElement) {
    messagesEndElement.scrollIntoView({ behavior: 'instant' });
    if (callback) {
      callback();
    }
  }
};

/**
 * Removes an existing conversation's message query so reopening it starts cold, and resets the
 * NEW_CONVO query to an empty cache for immediate optimistic messages.
 *
 * @param queryClient - The React Query client instance
 * @param conversationId - The conversation ID to clear messages for
 */
export const clearMessagesCache = (
  queryClient: QueryClient,
  conversationId: string | undefined | null,
): void => {
  const convoId = conversationId ?? Constants.NEW_CONVO;

  // An absent existing-conversation cache means its history must load before sending.
  if (convoId !== Constants.NEW_CONVO) {
    queryClient.removeQueries([QueryKeys.messages, convoId], { exact: true });
  }

  queryClient.setQueryData<TMessage[]>([QueryKeys.messages, Constants.NEW_CONVO], []);
};

/**
 * True while the new-chat cache still holds the given conversation's messages: a chat's first
 * turn writes the same array under both keys, so the alias survives until it is reset. The
 * reference check covers the window before the messages carry their conversation ID.
 */
const newConversationCacheAliases = (queryClient: QueryClient, conversationId: string): boolean => {
  const conversationMessages = queryClient.getQueryData<TMessage[]>([
    QueryKeys.messages,
    conversationId,
  ]);
  const newConversationMessages = queryClient.getQueryData<TMessage[]>([
    QueryKeys.messages,
    Constants.NEW_CONVO,
  ]);

  return (
    newConversationMessages != null &&
    (newConversationMessages === conversationMessages ||
      newConversationMessages.some((message) => message.conversationId === conversationId))
  );
};

/** Removes a deleted conversation's message cache and any matching new-chat cache alias. */
export const clearDeletedConversationMessagesCache = (
  queryClient: QueryClient,
  conversationId: string,
): void => {
  const newConversationAliasesDeleted = newConversationCacheAliases(queryClient, conversationId);

  queryClient.removeQueries([QueryKeys.messages, conversationId], { exact: true });

  if (!newConversationAliasesDeleted) {
    return;
  }

  queryClient.setQueryData<TMessage[]>([QueryKeys.messages, Constants.NEW_CONVO], []);
};

/**
 * Drops the new-chat alias of a conversation that was just archived, so returning to a new chat
 * does not keep rendering it. Its own history stays cached: unlike a deleted chat, an archived
 * one can still be reopened from the archive.
 */
export const clearArchivedConversationMessagesCache = (
  queryClient: QueryClient,
  conversationId: string,
): void => {
  if (!newConversationCacheAliases(queryClient, conversationId)) {
    return;
  }

  queryClient.setQueryData<TMessage[]>([QueryKeys.messages, Constants.NEW_CONVO], []);
};

/** Returns a 1-based message number, or null if depth is absent or invalid. */
const getMessageNumber = (message: TMessage): number | null => {
  if (message.depth == null || message.depth < 0) {
    return null;
  }
  return message.depth + 1;
};

export const getMessageAriaLabel = (message: TMessage, localize: LocalizeFunction): string => {
  const number = getMessageNumber(message);
  return number != null
    ? localize('com_endpoint_message_new', { 0: number })
    : localize('com_endpoint_message');
};

/**
 * Provides a screen-reader-only heading prefix distinguishing prompts from responses,
 * with an optional 1-based turn number derived from message depth.
 */
export const getHeaderPrefixForScreenReader = (
  message: TMessage,
  localize: LocalizeFunction,
): string => {
  const number = getMessageNumber(message);
  const suffix = number != null ? ` ${number}` : '';
  return message.isCreatedByUser
    ? `${localize('com_ui_prompt')}${suffix}: `
    : `${localize('com_ui_response')}${suffix}: `;
};

export type MessageTimestamp = {
  /** Localized relative time, e.g. "2 hours ago". */
  relative: string;
  /** Localized absolute date and time, e.g. "Jun 12, 2026, 3:42 PM". */
  absolute: string;
  /** ISO 8601 string for the `<time>` element's `dateTime` attribute. */
  iso: string;
  /**
   * True when the message is recent enough that the relative form ("10 minutes ago")
   * reads better than the absolute date. Past this window the absolute date is clearer.
   */
  isRecent: boolean;
};

/** Below this age the relative form is preferred over the absolute date. */
const RECENT_THRESHOLD_MS = 24 * 60 * 60 * 1000;

/** Returns true when `value` parses to a valid date. */
export const isValidTimestamp = (value?: string | null): value is string => {
  if (!value) {
    return false;
  }
  return !Number.isNaN(new Date(value).getTime());
};

const RELATIVE_TIME_DIVISIONS: { amount: number; unit: Intl.RelativeTimeFormatUnit }[] = [
  { amount: 60, unit: 'second' },
  { amount: 60, unit: 'minute' },
  { amount: 24, unit: 'hour' },
  { amount: 7, unit: 'day' },
  { amount: 4.34524, unit: 'week' },
  { amount: 12, unit: 'month' },
  { amount: Number.POSITIVE_INFINITY, unit: 'year' },
];

/**
 * Intl formatters are expensive to construct and every message row formats its
 * timestamp on each render, so they are built once per locale (and clock format).
 */
const resolvedLocales = new Map<string, string | undefined>();
const relativeFormatters = new Map<string, Intl.RelativeTimeFormat>();
const absoluteFormatters = new Map<string, Intl.DateTimeFormat>();

/** Returns the locale only when it is a syntactically valid BCP-47 tag, else undefined. */
const resolveLocale = (locale?: string): string | undefined => {
  if (!locale) {
    return undefined;
  }
  if (resolvedLocales.has(locale)) {
    return resolvedLocales.get(locale);
  }
  let resolved: string | undefined;
  try {
    Intl.DateTimeFormat.supportedLocalesOf(locale);
    resolved = locale;
  } catch {
    resolved = undefined;
  }
  resolvedLocales.set(locale, resolved);
  return resolved;
};

const getRelativeFormatter = (locale?: string): Intl.RelativeTimeFormat => {
  const key = locale ?? '';
  let formatter = relativeFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
    relativeFormatters.set(key, formatter);
  }
  return formatter;
};

const getAbsoluteFormatter = (locale?: string, hour12?: boolean): Intl.DateTimeFormat => {
  const key = `${locale ?? ''}|${String(hour12)}`;
  let formatter = absoluteFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, {
      dateStyle: 'medium',
      timeStyle: 'short',
      hour12,
    });
    absoluteFormatters.set(key, formatter);
  }
  return formatter;
};

const formatRelativeTime = (from: Date, to: Date, locale?: string): string => {
  const formatter = getRelativeFormatter(locale);
  let duration = (from.getTime() - to.getTime()) / 1000;
  for (const division of RELATIVE_TIME_DIVISIONS) {
    if (Math.abs(duration) < division.amount) {
      return formatter.format(Math.round(duration), division.unit);
    }
    duration /= division.amount;
  }
  return formatter.format(Math.round(duration), 'year');
};

/**
 * Formats a message timestamp into locale-aware relative and absolute strings.
 * Returns null when the value is missing or unparseable, so callers can skip
 * rendering the timestamp entirely.
 */
export const getMessageTimestamp = (
  value?: string | null,
  locale?: string,
  hour12?: boolean,
): MessageTimestamp | null => {
  if (!isValidTimestamp(value)) {
    return null;
  }

  const date = new Date(value);
  const now = new Date(Date.now());
  const safeLocale = resolveLocale(locale);

  return {
    iso: date.toISOString(),
    relative: formatRelativeTime(date, now, safeLocale),
    absolute: getAbsoluteFormatter(safeLocale, hour12).format(date),
    isRecent: Math.abs(now.getTime() - date.getTime()) < RECENT_THRESHOLD_MS,
  };
};

export function areMessageFilesEqual(prevFiles?: TMessage['files'], nextFiles?: TMessage['files']) {
  if (prevFiles === nextFiles) {
    return true;
  }
  const prevLength = prevFiles?.length ?? 0;
  const nextLength = nextFiles?.length ?? 0;
  if (prevLength !== nextLength) {
    return false;
  }
  if (prevLength === 0) {
    return true;
  }
  return prevFiles?.every((file, index) => file === nextFiles?.[index]) ?? true;
}

/**
 * Field-level equality for `message` props: `buildTree` mints a new node object
 * for EVERY message on each streaming update, so memo comparators must diff the
 * fields that drive rendering instead of the object reference.
 */
export function areMessageFieldsEqual(
  prevMsg?: TMessage | null,
  nextMsg?: TMessage | null,
): boolean {
  if (prevMsg === nextMsg) {
    return true;
  }
  if (!prevMsg || !nextMsg) {
    return false;
  }

  return (
    prevMsg.messageId === nextMsg.messageId &&
    prevMsg.text === nextMsg.text &&
    prevMsg.privacyRevision === nextMsg.privacyRevision &&
    prevMsg.error === nextMsg.error &&
    prevMsg.unfinished === nextMsg.unfinished &&
    /** Read by the row: `useGenerationsByLatest` gates the Continue button on it and
     *  `ContentRender` renders the tool-call-limit notice from it. */
    prevMsg.finish_reason === nextMsg.finish_reason &&
    prevMsg.createdAt === nextMsg.createdAt &&
    prevMsg.depth === nextMsg.depth &&
    prevMsg.isCreatedByUser === nextMsg.isCreatedByUser &&
    prevMsg.isUserSubmitted === nextMsg.isUserSubmitted &&
    (prevMsg.children?.length ?? 0) === (nextMsg.children?.length ?? 0) &&
    prevMsg.content === nextMsg.content &&
    prevMsg.model === nextMsg.model &&
    prevMsg.endpoint === nextMsg.endpoint &&
    prevMsg.iconURL === nextMsg.iconURL &&
    prevMsg.feedback?.rating === nextMsg.feedback?.rating &&
    areMessageFilesEqual(prevMsg.files, nextMsg.files) &&
    (prevMsg.attachments?.length ?? 0) === (nextMsg.attachments?.length ?? 0) &&
    (prevMsg.manualSkills?.length ?? 0) === (nextMsg.manualSkills?.length ?? 0) &&
    (prevMsg.alwaysAppliedSkills?.length ?? 0) === (nextMsg.alwaysAppliedSkills?.length ?? 0) &&
    (prevMsg.quotes?.length ?? 0) === (nextMsg.quotes?.length ?? 0)
  );
}

type TailRelationProps = {
  message?: TMessage | null;
  latestMessageId?: string;
  latestMessageDepth?: number;
};

/**
 * True when moving the thread's tail leaves a row's rendering unchanged. Rows read
 * `latestMessageId` and `latestMessageDepth` only by comparing them to their own id
 * and depth, and for whether a tail is known at all, so a submission or a server id
 * hydration re-renders just the rows entering or leaving the tail.
 */
export function isSameTailRelation(prev: TailRelationProps, next: TailRelationProps): boolean {
  return (
    (prev.latestMessageId == null) === (next.latestMessageId == null) &&
    (prev.latestMessageId === prev.message?.messageId) ===
      (next.latestMessageId === next.message?.messageId) &&
    (prev.latestMessageDepth === prev.message?.depth) ===
      (next.latestMessageDepth === next.message?.depth)
  );
}

/**
 * Comparator for the memoized message-row wrappers (Message / MessageContent /
 * MessageParts): identity-compare the scalar props, field-compare the message.
 * The child recursion lives in MultiMessage, so a bailed row never severs the
 * spine walk that delivers streaming updates to descendants.
 */
export function areMessageRowPropsEqual(prev: TMessageProps, next: TMessageProps): boolean {
  return (
    prev.currentEditId === next.currentEditId &&
    prev.setCurrentEditId === next.setCurrentEditId &&
    prev.siblingIdx === next.siblingIdx &&
    prev.siblingCount === next.siblingCount &&
    prev.setSiblingIdx === next.setSiblingIdx &&
    prev.isSearchView === next.isSearchView &&
    prev.conversation === next.conversation &&
    areMessageFieldsEqual(prev.message, next.message)
  );
}
