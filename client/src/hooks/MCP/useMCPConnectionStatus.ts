import { useMCPConnectionStatusQuery } from '~/data-provider/Tools/queries';

export function useMCPConnectionStatus({ enabled }: { enabled?: boolean } = {}) {
  const { data } = useMCPConnectionStatusQuery({
    enabled,
  });

  return {
    connectionStatus: data?.connectionStatus,
    readStartedAt: data?.readStartedAt,
  };
}
