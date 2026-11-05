import type { TConversation } from 'librechat-data-provider';
import { isConversationModelAvailable } from '~/utils/availability';
import useModelCatalog from '~/hooks/Endpoint/useModelCatalog';
import { useGetEndpointsQuery } from '~/data-provider';

export default function useModelAvailability(
  conversation?: TConversation | null,
  addedConversation?: TConversation | null,
) {
  const query = useModelCatalog();
  const { data: endpoints } = useGetEndpointsQuery();
  const models = query.data;
  const ready = models != null;
  const available = (selection?: TConversation | null) =>
    isConversationModelAvailable({
      conversation: selection,
      models,
      endpoints,
    });
  const canSubmit =
    available(conversation) && (addedConversation == null || available(addedConversation));
  return {
    ready,
    canSubmit,
    showSelectionHint: endpoints != null && !canSubmit,
    hasModels:
      !ready ||
      Object.entries(models ?? {}).some(
        ([endpoint, list]) => !!endpoints?.[endpoint] && (list?.length ?? 0) > 0,
      ),
  };
}
