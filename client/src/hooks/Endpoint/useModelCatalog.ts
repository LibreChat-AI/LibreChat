import { useQueryClient } from '@tanstack/react-query';
import { useGetModelsQuery } from 'librechat-data-provider/react-query';
import { getModelCatalog } from '~/utils/availability';

/** Subscribe to discovery without treating its static initial list as a fetched catalog. */
export default function useModelCatalog(config?: Parameters<typeof useGetModelsQuery>[0]) {
  const queryClient = useQueryClient();
  const query = useGetModelsQuery(config);
  return { ...query, data: getModelCatalog(queryClient) };
}
