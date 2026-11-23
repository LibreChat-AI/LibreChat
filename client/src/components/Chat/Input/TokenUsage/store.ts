import { createStorageAtom } from '~/store/jotai-utils';

/** Remember whether cumulative token totals are expanded below the context legend. */
export const contextBreakdownExpandedAtom = createStorageAtom<boolean>(
  'contextBreakdownExpanded',
  false,
);

export {
  overheadKey,
  liveTokensFamily,
  getModelOverhead,
  markUsageFolded,
  setModelOverhead,
  totalUsageFamily,
  calibrationFamily,
  clearUsageFolded,
  hydrateSnapshots,
  removeUsageAtoms,
  branchTotalsFamily,
  pendingUsageFamily,
  migrateUsageFolded,
  subagentUsageFamily,
  contextSnapshotFamily,
  snapshotsByAnchorFamily,
  pendingSubagentUsageFamily,
  activeUsageResponseIdFamily,
} from '@librechat/chat/react';
export type { ContextSnapshot, UsageTotals } from '@librechat/chat';
export { EMPTY_USAGE_TOTALS } from '@librechat/chat';
