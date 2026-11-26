import { QueryKeys } from 'librechat-data-provider';
import type { QueryClient } from '@tanstack/react-query';

export function invalidateAssistantDetails(
  queryClient: QueryClient,
  endpoint: string,
  assistantId: string,
): void {
  void queryClient.invalidateQueries({
    queryKey: [QueryKeys.assistant, endpoint, assistantId],
  });
}
