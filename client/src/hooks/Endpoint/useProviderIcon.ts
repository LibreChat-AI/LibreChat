import { useMemo } from 'react';
import { resolveProviderIcon } from '@librechat/chat';
import type { ProviderIconParams, ProviderIconResolution } from '@librechat/chat';

export { resolveProviderIcon };
export type { ProviderIconParams, ProviderIconResolution };

/** Memoized form of {@link resolveProviderIcon}, for use outside render callbacks. */
export function useProviderIcon({
  endpoint,
  endpointsConfig,
  iconURL,
}: ProviderIconParams): ProviderIconResolution {
  return useMemo(
    () => resolveProviderIcon({ endpoint, endpointsConfig, iconURL }),
    [endpoint, endpointsConfig, iconURL],
  );
}
