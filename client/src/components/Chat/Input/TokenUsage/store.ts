import { createStorageAtom } from '~/store/jotai-utils';

/** Sticky preference: does the context popover open with the breakdown showing?
 *  The gauge alone is the default; a user who wants the detail sets it once. */
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
