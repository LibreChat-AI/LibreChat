import { useCallback } from 'react';
import type { GraphTokenResponse } from 'librechat-data-provider';
import { useGraphTokenQuery, useGetStartupConfig } from '~/data-provider';
import { useAuthContext } from '~/hooks/AuthContext';

interface UseSharePointTokenProps {
  enabled?: boolean;
  purpose: 'Pick' | 'Download';
}

interface UseSharePointTokenReturn {
  isLoading: boolean;
  error: any;
  getToken: () => Promise<GraphTokenResponse | undefined>;
}

export default function useSharePointToken({
  enabled = true,
  purpose,
}: UseSharePointTokenProps): UseSharePointTokenReturn {
  const { user } = useAuthContext();
  const { data: startupConfig } = useGetStartupConfig();

  const sharePointBaseUrl = startupConfig?.sharePointBaseUrl;
  const sharePointPickerGraphScope = startupConfig?.sharePointPickerGraphScope;
  const sharePointPickerSharePointScope = startupConfig?.sharePointPickerSharePointScope;

  const isEntraIdUser = user?.provider === 'openid';
  const graphScopes =
    purpose === 'Pick' ? sharePointPickerSharePointScope : sharePointPickerGraphScope;
  const { isLoading, error, refetch } = useGraphTokenQuery({
    scopes: graphScopes,
    enabled: enabled && isEntraIdUser && !!sharePointBaseUrl,
  });

  /**
   * The token is requested when it is about to be used and never read back from the query's cache:
   * it dies an hour after the server issues it, long before a page that stays open is reloaded.
   * The server keeps its own exchange until it is close to expiring, so the call is cheap.
   * A failed request resolves to `undefined`, not to the cached token, which may be the dead one.
   */
  const getToken = useCallback(async () => {
    try {
      const { data } = await refetch({ throwOnError: true, cancelRefetch: false });
      return data;
    } catch {
      return undefined;
    }
  }, [refetch]);

  return {
    isLoading,
    error,
    getToken,
  };
}
