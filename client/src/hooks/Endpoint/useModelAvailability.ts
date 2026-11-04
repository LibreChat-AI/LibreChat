import { useGetModelsQuery } from 'librechat-data-provider/react-query';
import type { TConversation } from 'librechat-data-provider';
import { isConversationModelAvailable } from '~/utils/availability';
import { useGetEndpointsQuery } from '~/data-provider';

export default function useModelAvailability(
  conversation?: TConversation | null,
  addedConversation?: TConversation | null,
) {
  const query = useGetModelsQuery();
  const { data: endpoints } = useGetEndpointsQuery();
  const ready = query.isFetched && query.isSuccess;
  const models = ready ? query.data : undefined;
  const available = (selection?: TConversation | null) =>
    isConversationModelAvailable({
      conversation: selection,
      models,
      endpoints,
    });
  return {
    ready,
    canSubmit:
      available(conversation) && (addedConversation == null || available(addedConversation)),
    hasModels:
      !ready ||
      Object.entries(models ?? {}).some(
        ([endpoint, list]) => !!endpoints?.[endpoint] && (list?.length ?? 0) > 0,
      ),
  };
}
