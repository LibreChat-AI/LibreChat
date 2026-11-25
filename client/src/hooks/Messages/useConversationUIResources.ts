import { useMemo } from 'react';
import { useAtomValue } from 'jotai';
import { Tools } from 'librechat-data-provider';
import type { TAttachment, UIResource } from 'librechat-data-provider';
import { conversationAttachmentsFamily } from '~/hooks/SSE/atoms';
import { useOptionalMessagesOperations } from '~/Providers';

/**
 * Hook to collect all UI resources in a conversation, indexed by resource ID.
 * This enables cross-turn resource references in the conversation.
 * Works in both main app (using React Query cache) and share view (using context messages).
 *
 * @param conversationId - The ID of the conversation to collect resources from
 * @returns A Map of resource IDs to UIResource objects
 */
export function useConversationUIResources(
  conversationId: string | undefined,
): Map<string, UIResource> {
  const { getMessages } = useOptionalMessagesOperations();

  const conversationAttachmentsMap = useAtomValue(conversationAttachmentsFamily(conversationId));

  return useMemo(() => {
    const map = new Map<string, UIResource>();

    const collectResources = (attachments?: TAttachment[]) => {
      attachments
        ?.filter((attachment) => attachment?.type === Tools.ui_resources)
        .forEach((attachment) => {
          const resources = attachment?.[Tools.ui_resources];
          if (Array.isArray(resources)) {
            resources.forEach((resource) => {
              if (resource?.resourceId) {
                map.set(resource.resourceId, resource);
              }
            });
          }
        });
    };

    // Collect from messages (works in both main app and share view)
    getMessages()?.forEach((message) => {
      collectResources(message.attachments);
    });

    // Collect from in-flight messages (Recoil state during streaming - only when we have a conversationId)
    if (conversationId) {
      Object.values(conversationAttachmentsMap).forEach(collectResources);
    }

    return map;
  }, [conversationId, getMessages, conversationAttachmentsMap]);
}
