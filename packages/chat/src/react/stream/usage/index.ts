import { useRef, useMemo } from 'react';
import { getDefaultStore } from 'jotai';
import type { UsageHandlers } from './handlers';
import { createUsageCounters, createUsageHandlers } from './handlers';

export type { UsageHandlers };

/**
 * Stable writers for the per-conversation token usage atoms, driven by SSE events. All state
 * lives in the counters ref and the atoms, so the returned handlers never re-render the caller.
 */
export function useUsageHandler(): UsageHandlers {
  const countersRef = useRef(createUsageCounters());
  return useMemo(() => createUsageHandlers(getDefaultStore(), countersRef.current), []);
}
