import { getConfigDefaults } from 'librechat-data-provider';
import type { TConversation, TStartupConfig } from 'librechat-data-provider';
import useGetSender from '~/hooks/Conversations/useGetSender';
import { useGetStartupConfig } from '~/data-provider';

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
 *  from another spec on the same model is told apart. Resolved only while the setting hides authors. */
export function useSelectedSender(conversation: TConversation | null): string | undefined {
  const hideSelectedAuthor = useHideSelectedAuthor();
  const getSender = useGetSender();
  return hideSelectedAuthor && conversation != null ? getSender(conversation) : undefined;
}
