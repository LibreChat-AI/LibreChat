import { dataService, QueryKeys } from 'librechat-data-provider';
import type { TNearAIAttestationParams, TNearAIAttestationResponse } from 'librechat-data-provider';
import type { QueryClient, QueryFunctionContext } from '@tanstack/react-query';
import { reportStaleTime } from './reports';

function gatewayReport(data?: TNearAIAttestationResponse): boolean {
  return (
    data?.enabled === true &&
    !!data.reports?.length &&
    data.reports.every((report) => report.scope === 'gateway')
  );
}

function reportKey(params: Pick<TNearAIAttestationParams, 'endpoint' | 'model'>) {
  return [QueryKeys.nearaiAttestation, params.endpoint, params.model, 'reports'];
}

export function reportQueryOptions(
  client: QueryClient,
  params: Pick<TNearAIAttestationParams, 'endpoint' | 'model' | 'scope'>,
) {
  const queryKey = reportKey(params);
  const full = client.getQueryState<TNearAIAttestationResponse>(queryKey);
  // Metadata normalizes External/Chutes reports to Gateway scope on the server.
  const gateway = params.scope === 'gateway' && !gatewayReport(full?.data);
  const key = gateway ? [...queryKey, 'gateway'] : queryKey;
  const cached = gateway ? client.getQueryState<TNearAIAttestationResponse>(key) : full;
  const staleTime = reportStaleTime(cached?.data, cached?.status, cached?.dataUpdatedAt);
  // A failed refresh may never have reached the server; retry with fresh evidence.
  const force = cached?.status === 'error' || (cached?.data?.enabled === true && staleTime === 0);
  return {
    queryKey: key,
    queryFn: async ({ signal }: QueryFunctionContext): Promise<TNearAIAttestationResponse> => {
      if (gateway && !force && client.isFetching({ queryKey, exact: true })) {
        // If the shared request fails, fall back to an independent Gateway check.
        const fullOptions = reportQueryOptions(client, {
          endpoint: params.endpoint,
          model: params.model,
        });
        const reports = await client.fetchQuery(fullOptions).catch(() => undefined);
        signal?.throwIfAborted();
        if (reports && gatewayReport(reports)) return reports;
      }
      return dataService.getNearAIAttestation(
        {
          ...params,
          reports: true,
          ...(force && { force: true }),
        },
        signal,
      );
    },
    staleTime,
    cacheTime: 10 * 60 * 1000,
    retry: false,
    refetchOnWindowFocus: false,
  };
}

export function prefetchReport(
  client: QueryClient,
  params: Pick<TNearAIAttestationParams, 'endpoint' | 'model' | 'scope'>,
): Promise<void> | undefined {
  const options = reportQueryOptions(client, params);
  const cached = client.getQueryState<TNearAIAttestationResponse>(options.queryKey);
  // Failed checks are retried by the user, not by message updates or background warmup.
  if (
    cached?.status === 'error' ||
    cached?.isInvalidated ||
    (cached?.data && options.staleTime === 0) ||
    client.isMutating({ mutationKey: reportKey(params), exact: true })
  ) {
    return;
  }
  return client.prefetchQuery(options);
}
