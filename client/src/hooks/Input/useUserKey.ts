import { useMemo, useCallback } from 'react';
import { EModelEndpoint } from 'librechat-data-provider';
import { useUserKeyQuery, useUpdateUserKeysMutation } from 'librechat-data-provider/react-query';
import { useGetEndpointsQuery } from '~/data-provider';

const useUserKey = (endpoint: string, options?: { keyName?: string; enabled?: boolean }) => {
  const { data: endpointsConfig } = useGetEndpointsQuery();
  const config = endpointsConfig?.[endpoint ?? ''];

  const { azure } = config ?? {};
  const keyName = options?.keyName ?? (azure ? EModelEndpoint.azureOpenAI : endpoint);

  const updateKey = useUpdateUserKeysMutation();
  const checkUserKey = useUserKeyQuery(keyName, {
    enabled: options?.enabled,
    ...(options ? { refetchOnMount: 'always' as const } : {}),
  });

  const getExpiry = useCallback(() => {
    return checkUserKey.data?.expiresAt || undefined;
  }, [checkUserKey.data]);

  const checkExpiry = useCallback(() => {
    const expiresAt = getExpiry();
    if (expiresAt === 'never') return true;
    if (!expiresAt) return false;
    const expiresAtTime = new Date(expiresAt).getTime();
    return Number.isFinite(expiresAtTime) && expiresAtTime > Date.now();
  }, [getExpiry]);

  const saveUserKey = useCallback(
    (userKey: string, expiresAt: number | null) => {
      const dateStr = expiresAt ? new Date(expiresAt).toISOString() : '';
      return updateKey.mutateAsync({
        name: keyName,
        value: userKey,
        expiresAt: dateStr,
      });
    },
    [updateKey, keyName],
  );

  return useMemo(
    () => ({
      getExpiry,
      checkExpiry,
      saveUserKey,
      keyName,
      isSaving: updateKey.isLoading,
      isLoading: checkUserKey.isInitialLoading,
      isFetching: checkUserKey.isFetching,
      isError: checkUserKey.isError,
      refetch: checkUserKey.refetch,
    }),
    [
      getExpiry,
      checkExpiry,
      saveUserKey,
      keyName,
      updateKey.isLoading,
      checkUserKey.isInitialLoading,
      checkUserKey.isFetching,
      checkUserKey.isError,
      checkUserKey.refetch,
    ],
  );
};

export default useUserKey;
