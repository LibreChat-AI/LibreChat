import { atom } from 'jotai';
import { atomFamily } from 'jotai/utils';

export {
  getReasoningStateKey,
  pendingQuotesByConvoId,
  pendingManualSkillsByConvoId,
  clearPendingComposerContext,
  pendingReasoningOverrideFamily,
  clearPendingReasoningOverrides,
} from '@librechat/chat/react';

/** Landing-page lift is composer-owned UI state, scoped to its split pane. */
export const composerLiftFamily = atomFamily((_index: number) => atom(0));
