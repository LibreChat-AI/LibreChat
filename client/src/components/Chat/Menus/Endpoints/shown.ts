import { getConfigDefaults, getEndpointField } from 'librechat-data-provider';
import type { TConversation, TStartupConfig } from 'librechat-data-provider';
import { useGetStartupConfig, useGetEndpointsQuery } from '~/data-provider';
import useGetSender from '~/hooks/Conversations/useGetSender';

const defaultInterface = getConfigDefaults().interface;

/** The selector has nothing to offer when model selection is off and no model specs exist. */
export function isModelSelectorShown(startupConfig?: TStartupConfig | null): boolean {
  const interfaceConfig = startupConfig?.interface ?? defaultInterface;
  const modelSpecs = startupConfig?.modelSpecs?.list ?? [];
  return interfaceConfig.modelSelect !== false || modelSpecs.length > 0;
}

/** `interface.messageAuthor`: a response need not repeat the author a shown selector names. */
export function useHideSelectedAuthor(): boolean {
  const { data: startupConfig } = useGetStartupConfig();
  return (
    startupConfig?.interface?.messageAuthor === 'whenDifferent' &&
    isModelSelectorShown(startupConfig)
  );
}

/** The sender a response sent under the conversation's selection is written with, so a response
 *  from another spec on the same model is told apart. The server names it from the endpoint type
 *  the endpoints config gives and never reads the deprecated `chatGptLabel`, so this does the same.
 *  Resolved only while the setting hides authors. */
export function useSelectedSender(conversation: TConversation | null): string | undefined {
  const hideSelectedAuthor = useHideSelectedAuthor();
  const { data: endpointsConfig } = useGetEndpointsQuery();
  const getSender = useGetSender();
  if (!hideSelectedAuthor || conversation == null) {
    return undefined;
  }
  return getSender({
    ...conversation,
    chatGptLabel: undefined,
    endpointType: getEndpointField(endpointsConfig, conversation.endpoint, 'type'),
  });
}
