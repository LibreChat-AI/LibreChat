import {
  QueryKeys,
  Constants,
  buildTree,
  ContentTypes,
  isEphemeralAgentId,
  getEphemeralSender,
  appendAgentIdSuffix,
  encodeEphemeralAgentId,
} from 'librechat-data-provider';
import type {
  Agents,
  TMessage,
  TConversation,
  TEndpointsConfig,
  TMessageContentParts,
} from 'librechat-data-provider';
import type { QueryClient } from '@tanstack/react-query';
import type { LocalizeFunction, TMessageProps } from '~/common';

export const TEXT_KEY_DIVIDER = '|||';
export const STREAM_START_FAILED_METADATA_KEY = 'streamStartFailed';

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
  const collectBranchParents = (
    siblings: TMessage[] | undefined,
    parentMessageId: string | null | undefined,
  ) => {
    if (!siblings?.length) {
      return;
    }

    if (siblings.length > 1) {
      parentIds.add(parentMessageId ?? null);
    }

    for (const message of siblings) {
      collectBranchParents(message.children, message.messageId);
    }
  };

  collectBranchParents(messagesTree, rootSiblingKey);
  return Array.from(parentIds);
};

/**
 * True when a resumed run's user-message slot is a compaction ANCHOR rather than
 * a turn the run created.
 *
 * A compaction submits no user turn: the slot names the LEAF it summarizes up
 * to, which the server projects as identity only (`projectCompactionAnchor` —
 * id, conversation, empty text, and no parent). Every other run publishes the
 * turn it created, parent included (`getPreliminaryUserMessage`), so the absent
 * parent is what separates the two.
 *
 * The anchor's author cannot separate them: Compact runs on whatever leaf the
 * branch ends with and `canCompact` does not restrict its author, so the anchor
 * is an assistant answer on one branch and a user message on the next (see
 * `isUserInitiatedCompaction`). Testing for a non-user row recognized only the
 * first kind and left the second rewritten on every re-attach.
 */
export const isCompactionAnchorProjection = (
  userMessage?: {
    messageId?: string;
    parentMessageId?: string | null;
    text?: string | null;
  } | null,
): boolean =>
  userMessage?.messageId != null &&
  userMessage.messageId !== '' &&
  userMessage.parentMessageId == null &&
  (userMessage.text == null || userMessage.text === '');

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
  const findTargetPath = (
    siblings: TMessage[] | undefined,
    parentMessageId: string | null | undefined,
  ): boolean => {
    if (!siblings?.length) {
      return false;
    }

    for (let index = 0; index < siblings.length; index++) {
      const message = siblings[index];
      if (!message) {
        continue;
      }

      const isTarget = message.messageId === targetMessageId;
      const childHasTarget = findTargetPath(message.children, message.messageId);
      if (isTarget || childHasTarget) {
        if (siblings.length > 1) {
          branchIndexes.unshift({
            parentMessageId,
            siblingIdx: siblings.length - index - 1,
          });
        }
        return true;
      }
    }

    return false;
  };

  findTargetPath(messagesTree, rootSiblingKey);
  return branchIndexes;
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

/**
 * Drops the client-only `streamedIndex` stamps from a content array. An
 * edited resubmission retains the settled prefix and appends the rerun's
 * parts at the prefix LENGTH — a stamp at or above that length would collide
 * with an appended part's key — so the retained prefix reverts to physical
 * identity for the rerun. Returns the input untouched when nothing is
 * stamped.
 */
export function stripStreamedIndexStamps(content: TMessageContentParts[]): TMessageContentParts[];
export function stripStreamedIndexStamps(content: TMessage['content']): TMessage['content'];
export function stripStreamedIndexStamps(content: TMessage['content']): TMessage['content'] {
  if (!content?.length) {
    return content;
  }
  let changed = false;
  const next = content.map((part) => {
    if (part == null || part.streamedIndex === undefined) {
      return part;
    }
    changed = true;
    const { streamedIndex: _streamedIndex, ...rest } = part;
    return rest as TMessageContentParts;
  });
  return changed ? next : content;
}

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

export const hasStreamStartFailed = (message?: Pick<TMessage, 'metadata'> | null): boolean =>
  message?.metadata?.[STREAM_START_FAILED_METADATA_KEY] === true;

export const markStreamStartFailedMetadata = (
  metadata?: TMessage['metadata'],
): TMessage['metadata'] => ({
  ...(metadata ?? {}),
  [STREAM_START_FAILED_METADATA_KEY]: true,
});

const getLatestContentForKey = (message: TMessage): string => {
  const formatText = (str: string, index: number): string => {
    if (str.length === 0) {
      return '0';
    }
    const length = str.length;
    const lastChars = str.slice(-16);
    return `${length}${TEXT_KEY_DIVIDER}${lastChars}${TEXT_KEY_DIVIDER}${index}`;
  };

  if (message.text) {
    return formatText(message.text, -1);
  }

  if (!message.content || message.content.length === 0) {
    return '';
  }

  for (let i = message.content.length - 1; i >= 0; i--) {
    const part = message.content[i] as TMessageContentParts | undefined;
    if (!part?.type) {
      continue;
    }

    const type = part.type;
    let text = '';

    // Handle THINK type - extract think content
    if (type === ContentTypes.THINK && 'think' in part) {
      text = typeof part.think === 'string' ? part.think : (part.think?.value ?? '');
    }
    // Handle TEXT type
    else if (type === ContentTypes.TEXT && 'text' in part) {
      text = typeof part.text === 'string' ? part.text : (part.text?.value ?? '');
    }
    // Handle ERROR type
    else if (type === ContentTypes.ERROR && 'error' in part) {
      text = String(part.error || 'err').slice(0, 30);
    }
    // Handle TOOL_CALL - use simple marker with type
    else if (type === ContentTypes.TOOL_CALL && 'tool_call' in part) {
      const tcType = part.tool_call?.type || 'x';
      const tcName = String(part.tool_call?.['name'] || 'unknown').slice(0, 20);
      const tcArgs = String(part.tool_call?.['args'] || 'none').slice(0, 20);
      const tcOutput = String(part.tool_call?.['output'] || 'none').slice(0, 20);
      text = `tc_${tcType}_${tcName}_${tcArgs}_${tcOutput}`;
    }
    // Handle IMAGE_FILE - use simple marker with file_id suffix
    else if (type === ContentTypes.IMAGE_FILE && 'image_file' in part) {
      const fileId = part.image_file?.file_id || 'x';
      text = `if_${fileId.slice(-8)}`;
    }
    // Handle IMAGE_URL - use simple marker
    else if (type === ContentTypes.IMAGE_URL) {
      text = 'iu';
    }
    // Handle AGENT_UPDATE - use simple marker with agentId suffix
    else if (type === ContentTypes.AGENT_UPDATE && 'agent_update' in part) {
      const agentId = String(part.agent_update?.agentId || 'x').slice(0, 30);
      text = `au_${agentId}`;
    } else {
      text = type;
    }

    if (text.length > 0) {
      return formatText(text, i);
    }
  }

  return '';
};

export const getTextKey = (message?: TMessage | null, convoId?: string | null) => {
  if (!message) {
    return '';
  }
  const contentKey = getLatestContentForKey(message);
  return `${(message.messageId as string | null) ?? ''}${TEXT_KEY_DIVIDER}${contentKey}${TEXT_KEY_DIVIDER}${message.conversationId ?? convoId}`;
};

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

/** Returns the locale only when it is a syntactically valid BCP-47 tag, else undefined. */
const resolveLocale = (locale?: string): string | undefined => {
  if (!locale) {
    return undefined;
  }
  try {
    Intl.DateTimeFormat.supportedLocalesOf(locale);
    return locale;
  } catch {
    return undefined;
  }
};

const formatRelativeTime = (from: Date, to: Date, locale?: string): string => {
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
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
    absolute: new Intl.DateTimeFormat(safeLocale, {
      dateStyle: 'medium',
      timeStyle: 'short',
      hour12,
    }).format(date),
    isRecent: Math.abs(now.getTime() - date.getTime()) < RECENT_THRESHOLD_MS,
  };
};

/**
 * Creates initial content parts for dual message display with agent-based grouping.
 * Sets up primary and added agent content parts with agentId for column rendering.
 *
 * @param primaryConvo - The primary conversation configuration
 * @param addedConvo - The added conversation configuration
 * @param endpointsConfig - Endpoints configuration for getting model display labels
 * @param modelSpecs - Model specs list for getting spec labels
 * @returns Array of content parts with agentId for side-by-side rendering
 */
export const createDualMessageContent = (
  primaryConvo: TConversation,
  addedConvo: TConversation,
  endpointsConfig?: TEndpointsConfig,
  modelSpecs?: { name: string; label?: string }[],
): TMessageContentParts[] => {
  // For real agents (agent_id starts with "agent_"), use agent_id directly
  // Otherwise create ephemeral ID from endpoint/model
  let primaryAgentId: string;
  if (primaryConvo.agent_id && !isEphemeralAgentId(primaryConvo.agent_id)) {
    primaryAgentId = primaryConvo.agent_id;
  } else {
    const primaryEndpoint = primaryConvo.endpoint;
    const primaryModel = primaryConvo.model ?? '';
    // Look up model spec for label fallback
    const primarySpec =
      primaryConvo.spec != null && primaryConvo.spec !== ''
        ? modelSpecs?.find((s) => s.name === primaryConvo.spec)
        : undefined;
    const primarySender = getEphemeralSender({
      modelLabel: primaryConvo.modelLabel,
      specLabel: primarySpec?.label,
      modelDisplayLabel: primaryEndpoint
        ? endpointsConfig?.[primaryEndpoint]?.modelDisplayLabel
        : undefined,
    });
    primaryAgentId = encodeEphemeralAgentId({
      endpoint: primaryEndpoint ?? '',
      model: primaryModel,
      sender: primarySender,
    });
  }

  // Both agents run in parallel, so they share the same groupId
  const parallelGroupId = 1;

  // Use empty type - these are just placeholders to establish agentId/groupId
  // The actual type will be set when real content arrives from the server
  const primaryContent = {
    type: '' as const,
    agentId: primaryAgentId,
    groupId: parallelGroupId,
  };

  // For added agent, use agent_id if it's a real agent (starts with "agent_")
  // Otherwise create ephemeral ID with index suffix
  // Always append index suffix for added agent to distinguish from primary (even if same agent_id)
  let addedAgentId: string;
  if (addedConvo.agent_id && !isEphemeralAgentId(addedConvo.agent_id)) {
    // Append suffix to distinguish from primary agent (matches ephemeral format)
    addedAgentId = appendAgentIdSuffix(addedConvo.agent_id, 1);
  } else {
    const addedEndpoint = addedConvo.endpoint;
    const addedModel = addedConvo.model ?? '';
    // Look up model spec for label fallback
    const addedSpec =
      addedConvo.spec != null && addedConvo.spec !== ''
        ? modelSpecs?.find((s) => s.name === addedConvo.spec)
        : undefined;
    const addedSender = getEphemeralSender({
      modelLabel: addedConvo.modelLabel,
      specLabel: addedSpec?.label,
      modelDisplayLabel: addedEndpoint
        ? endpointsConfig?.[addedEndpoint]?.modelDisplayLabel
        : undefined,
    });
    addedAgentId = encodeEphemeralAgentId({
      endpoint: addedEndpoint ?? '',
      model: addedModel,
      sender: addedSender,
      index: 1,
    });
  }

  // Use empty type - placeholder to establish agentId/groupId
  const addedContent = {
    type: '' as const,
    agentId: addedAgentId,
    groupId: parallelGroupId,
  };

  // Cast through unknown since these are placeholder objects with empty type
  // that will be replaced by real content with proper types from the server
  return [primaryContent, addedContent] as unknown as TMessageContentParts[];
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
    prevMsg.error === nextMsg.error &&
    prevMsg.unfinished === nextMsg.unfinished &&
    /** Read by the row: `useGenerationsByLatest` gates the Continue button on it and
     *  `ContentRender` renders the tool-call-limit notice from it. */
    prevMsg.finish_reason === nextMsg.finish_reason &&
    prevMsg.createdAt === nextMsg.createdAt &&
    prevMsg.depth === nextMsg.depth &&
    prevMsg.isCreatedByUser === nextMsg.isCreatedByUser &&
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
