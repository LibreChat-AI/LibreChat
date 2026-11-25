import { useCallback } from 'react';
import { isAssistantsEndpoint } from 'librechat-data-provider';
import type { AssistantsEndpoint, TConversation, TPreset } from 'librechat-data-provider';
import { mapAssistants, logger, specDisplayFieldReset } from '~/utils';
import useDefaultConvo from '~/hooks/Conversations/useDefaultConvo';
import { useChatContext } from '~/Providers/ChatContext';
import useAssistantListMap from './useAssistantListMap';

export default function useSelectAssistant(endpoint: AssistantsEndpoint) {
  const getDefaultConversation = useDefaultConvo();
  const { conversation, newConversation } = useChatContext();
  const assistantMap = useAssistantListMap((res) => mapAssistants(res.data));

  const onSelect = useCallback(
    (value: string) => {
      const assistant = assistantMap[endpoint]?.[value];
      if (!assistant) {
        return;
      }
      const template: Partial<TPreset | TConversation> = {
        endpoint,
        assistant_id: assistant.id,
        model: assistant.model,
        conversationId: 'new',
        ...specDisplayFieldReset,
      };

      logger.log('conversation', 'Updating conversation with assistant', assistant);
      if (isAssistantsEndpoint(conversation?.endpoint)) {
        const currentConvo = getDefaultConversation({
          conversation: { ...(conversation ?? {}), ...specDisplayFieldReset },
          preset: template,
        });
        newConversation({
          template: currentConvo,
          preset: template as Partial<TPreset>,
        });
        return;
      }

      newConversation({
        template: { ...(template as Partial<TConversation>) },
        preset: template as Partial<TPreset>,
      });
    },
    [endpoint, assistantMap, conversation, getDefaultConversation, newConversation],
  );

  return { onSelect };
}
