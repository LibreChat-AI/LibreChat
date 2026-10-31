import {
  parseConvo,
  EModelEndpoint,
  isAgentsEndpoint,
  isEphemeralAgentId,
  isAssistantsEndpoint,
} from 'librechat-data-provider';
import type { TConversation, TPreset, EndpointSchemaKey } from 'librechat-data-provider';
import { clearModelForNonEphemeralAgent } from './endpoints';
import { getLocalStorageItems } from './localStorage';

const buildDefaultConvo = ({
  models,
  conversation,
  endpoint = null,
  lastConversationSetup,
  defaultParamsEndpoint,
}: {
  models?: string[];
  conversation: TConversation;
  endpoint?: EModelEndpoint | null;
  lastConversationSetup: Partial<TConversation | TPreset> | null;
  defaultParamsEndpoint?: string | null;
}): TConversation => {
  const { lastSelectedModel, lastSelectedTools } = getLocalStorageItems();
  const endpointType = lastConversationSetup?.endpointType ?? conversation.endpointType;

  if (!endpoint) {
    return {
      ...conversation,
      endpointType,
      endpoint,
    };
  }

  // A model belongs to its endpoint, whether restored, supplied, or discovered.
  const presetMatches =
    lastConversationSetup?.endpoint == null || lastConversationSetup.endpoint === endpoint;
  const conversationMatches = conversation.endpoint == null || conversation.endpoint === endpoint;
  const model =
    (presetMatches ? lastConversationSetup?.model : undefined) ??
    (conversationMatches ? conversation.model : undefined) ??
    (isAssistantsEndpoint(endpoint) ? undefined : lastSelectedModel?.[endpoint]);
  const possibleModels = model ? [model] : models;

  const convo = parseConvo({
    endpoint: endpoint as EndpointSchemaKey,
    endpointType: endpointType as EndpointSchemaKey,
    conversation: presetMatches
      ? lastConversationSetup
      : { ...lastConversationSetup, model: undefined },
    possibleValues: possibleModels ? { models: possibleModels } : undefined,
    defaultParamsEndpoint,
  });

  if (!model && models == null && convo) {
    convo.model = undefined;
  }

  const defaultConvo = {
    ...conversation,
    ...convo,
    endpointType,
    endpoint,
  };

  // Ensures assistant_id is always defined
  const assistantId = convo?.assistant_id ?? conversation?.assistant_id ?? '';
  const defaultAssistantId = lastConversationSetup?.assistant_id ?? '';
  if (isAssistantsEndpoint(endpoint) && !defaultAssistantId && assistantId) {
    defaultConvo.assistant_id = assistantId;
  }

  // Ensures agent_id is always defined
  const agentId = convo?.agent_id ?? '';
  const defaultAgentId = lastConversationSetup?.agent_id ?? '';
  if (
    isAgentsEndpoint(endpoint) &&
    agentId &&
    (!defaultAgentId || isEphemeralAgentId(defaultAgentId))
  ) {
    defaultConvo.agent_id = agentId;
  }

  // Clear model for non-ephemeral agents - agents use their configured model internally
  clearModelForNonEphemeralAgent(defaultConvo);

  defaultConvo.tools = lastConversationSetup?.tools ?? lastSelectedTools ?? defaultConvo.tools;

  return defaultConvo;
};

export default buildDefaultConvo;
