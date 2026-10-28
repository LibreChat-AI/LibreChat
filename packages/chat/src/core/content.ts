import {
  isEphemeralAgentId,
  getEphemeralSender,
  appendAgentIdSuffix,
  encodeEphemeralAgentId,
} from 'librechat-data-provider';
import type {
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
