import { useParams } from 'react-router-dom';
import { Constants } from 'librechat-data-provider';
import { useGetStartupConfig } from '~/data-provider';
import { useChatContext } from '~/Providers';

/**
 * Whether the model/endpoint selector should be locked for the current
 * (primary) conversation: once a conversation has started (or is mid-
 * generation), switching the model/endpoint would silently forward its
 * history to a different provider. Disabled by default; only active when
 * `interface.lockModelPerConversation` is configured.
 */
export default function useIsModelLocked(): boolean {
  const { conversationId: routeConversationId } = useParams();
  const { isSubmitting } = useChatContext();
  const { data: startupConfig } = useGetStartupConfig();

  const lockEnabled = startupConfig?.interface?.lockModelPerConversation ?? false;
  const isNewChat = routeConversationId == null || routeConversationId === Constants.NEW_CONVO;

  return lockEnabled && (!isNewChat || isSubmitting);
}
