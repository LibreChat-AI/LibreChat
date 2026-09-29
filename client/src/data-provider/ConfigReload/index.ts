export { useModelCatalogRefresh } from './queries';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { dataService, MutationKeys, QueryKeys } from 'librechat-data-provider';
import type { TConfigReloadResult } from 'librechat-data-provider';
import type { UseMutationResult } from '@tanstack/react-query';

export function useConfigReloadAccessQuery(userId?: string) {
  return useQuery([QueryKeys.configReloadAccess, userId], dataService.getConfigReloadAccess, {
    enabled: !!userId,
    retry: false,
    staleTime: 1_000,
  });
}

export function useReloadCustomConfigMutation(): UseMutationResult<
  TConfigReloadResult,
  unknown,
  void
> {
  const queryClient = useQueryClient();
  return useMutation(() => dataService.reloadCustomConfig(), {
    mutationKey: [MutationKeys.reloadCustomConfig],
    onSuccess: (result) => {
      if (result.scope !== 'unchanged') {
        void queryClient.invalidateQueries([QueryKeys.models]);
        void queryClient.invalidateQueries([QueryKeys.configRevision]);
      }
    },
  });
}
