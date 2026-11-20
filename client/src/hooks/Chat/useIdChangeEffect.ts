import { useEffect, useRef } from 'react';
import { useChatSettings } from '~/Providers/ChatSettingsContext';
import { logger } from '~/utils';

/**
 * Hook to reset visible artifacts when the conversation ID changes
 * @param conversationId - The current conversation ID
 */
export default function useIdChangeEffect(conversationId: string) {
  const lastConvoId = useRef<string | null>(null);
  const { resetVisibleArtifacts } = useChatSettings();

  useEffect(() => {
    if (conversationId !== lastConvoId.current) {
      logger.log('conversation', 'Conversation ID change');
      resetVisibleArtifacts();
    }
    lastConvoId.current = conversationId;
  }, [conversationId, resetVisibleArtifacts]);
}
