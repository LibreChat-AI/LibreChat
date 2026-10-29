import { isAgentsEndpoint } from 'librechat-data-provider';
import type { TConversation, TStartupConfig } from 'librechat-data-provider';

/**
 * A saved conversation may outlive a model spec's provider. Match a visible
 * spec's current route before showing or sending the conversation again.
 * Hidden specs deliberately stay on their stored route: deployments use them
 * to keep older conversations working while a successor spec rolls out.
 */
export function reconcileModelSpecConversation(
  conversation: TConversation,
  startupConfig?: TStartupConfig,
): TConversation {
  const spec = startupConfig?.modelSpecs?.list?.find((item) => item.name === conversation.spec);
  const preset = spec?.preset;
  if (
    !preset?.endpoint ||
    preset.endpoint === conversation.endpoint ||
    isAgentsEndpoint(preset.endpoint) ||
    isAgentsEndpoint(conversation.endpoint)
  ) {
    return conversation;
  }

  return {
    ...conversation,
    endpoint: preset.endpoint as TConversation['endpoint'],
    model: preset.model ?? conversation.model,
    endpointType: preset.endpointType ?? undefined,
  };
}
