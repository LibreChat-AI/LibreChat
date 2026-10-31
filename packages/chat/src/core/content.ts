import {
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

/**
 * Drops the client-only `streamedIndex` stamps from a content array. An
 * edited resubmission retains the settled prefix and appends the rerun's
 * parts at the prefix LENGTH; a stamp at or above that length would collide
 * with an appended part's key, so the retained prefix reverts to physical
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

const getPartTextValue = (value?: string | { value?: string }): string =>
  (typeof value === 'string' ? value : value?.value) ?? '';

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
    return (part[ContentTypes.TOOL_CALL] as Agents.ToolCall | undefined) == null;
  }
  return false;
};

const getPartToolCall = (part: TMessageContentParts): Agents.ToolCall | undefined =>
  part.type === ContentTypes.TOOL_CALL
    ? (part[ContentTypes.TOOL_CALL] as Agents.ToolCall | undefined)
    : undefined;

/** One side extending the other is the same part observed at two moments
 * (a flushed tail or a server-side trim), while divergent content is a
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
 * verbatim re-keys every index-derived React identity at the final event:
 * the settled message remounts wholesale, entrance animations replay, and the
 * thread visibly jumps. The stamp (`streamedIndex`) lets renderers keep the
 * streamed key while all coordinate logic uses the compacted positions the
 * server persisted.
 *
 * Pairing is all-or-nothing: a partially stamped array could collide a
 * streamed key with a compacted fallback key. When any final part has no
 * streamed counterpart (server-enriched content), or any substantial streamed
 * part has no final counterpart (a filtered run that dropped intermediate
 * outputs, where in-order pairing could hand a retained part an omitted
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
       *  compaction; never let it steal the match from the filled streamed
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
   *  (`hide_sequential_outputs`), so every pairing above is suspect: an
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
