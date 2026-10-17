import { useRef, useMemo } from 'react';
import { getDefaultStore } from 'jotai';
import type { UsageHandlers } from '~/hooks/SSE/usage/handlers';
import { createUsageCounters, createUsageHandlers } from '~/hooks/SSE/usage/handlers';

export type { UsageHandlers };

/**
 * Stable writers for the per-conversation token usage atoms, driven by SSE events. All state
 * lives in the counters ref and the atoms, so the returned handlers never re-render the caller.
 */
export default function useUsageHandler(): UsageHandlers {
  const countersRef = useRef(createUsageCounters());
  return useMemo(() => createUsageHandlers(getDefaultStore(), countersRef.current), []);
}
