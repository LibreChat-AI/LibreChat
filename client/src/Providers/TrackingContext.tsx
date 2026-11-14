import { createContext, useContext, useMemo } from 'react';
import { noopProductTracker, safelyTrack } from 'librechat-data-provider';
import type { BrowserProductFact, ProductTracker } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import { useGetStartupConfig } from '~/data-provider';

const TrackingContext = createContext<ProductTracker<BrowserProductFact>>(noopProductTracker);

/** The host supplies browser tracking. Without a host adapter, nothing is collected. */
export function TrackingProvider({
  track,
  children,
}: {
  track: ProductTracker<BrowserProductFact>;
  children: ReactNode;
}) {
  const { data: startup } = useGetStartupConfig();
  const enabled = startup?.productTracking?.enabled === true;
  const safeTrack = useMemo(
    () => (enabled ? (fact: BrowserProductFact) => safelyTrack(track, fact) : noopProductTracker),
    [enabled, track],
  );
  return <TrackingContext.Provider value={safeTrack}>{children}</TrackingContext.Provider>;
}

export function useProductTracking() {
  return useContext(TrackingContext);
}
