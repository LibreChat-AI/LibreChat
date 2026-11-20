import { useRef, useMemo } from 'react';
import { getDefaultStore } from 'jotai';
import type { ResumableUsage } from '../../../core/resumable/host';
import type { UsageHandlers } from './handlers';
import { createUsageCounters, createUsageHandlers } from './handlers';
import { countTrailingOutputChars } from '../../../core';

export type { UsageHandlers };

/**
 * Stable writers for the per-conversation token usage atoms, driven by SSE events. All state
 * lives in the counters ref and the atoms, so the returned handlers never re-render the caller.
 */
export function useUsageHandler(): UsageHandlers {
  const countersRef = useRef(createUsageCounters());
  return useMemo(() => createUsageHandlers(getDefaultStore(), countersRef.current), []);
}

/**
 * The usage writers as whatever applies a stream's frames calls them: main chat's stream
 * session, and a core `Chat`'s event applier. One mapping, so both keep the same usage state
 * for the same frames.
 */
export function toResumableUsage(handlers: UsageHandlers): ResumableUsage {
  return {
    bindResponse: handlers.bindResponse,
    nameResponse: handlers.nameResponse,
    contextHandler: handlers.contextHandler,
    usageHandler: handlers.usageHandler,
    tapStream: handlers.tapStream,
    tapContent: handlers.tapContent,
    finalizeUsage: handlers.finalizeUsage,
    backfillUsage: handlers.backfillUsage,
    seedLiveFromContent: (content, submission) =>
      handlers.seedLive(countTrailingOutputChars(content), submission),
    resetLive: handlers.resetLive,
  };
}
