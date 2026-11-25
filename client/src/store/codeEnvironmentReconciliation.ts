import { atom } from 'jotai';
import type { TConversation } from 'librechat-data-provider';

export type CodeEnvironmentReconciliationRequest = {
  conversationId: string;
  attempted: Pick<TConversation, 'codeEnvironmentMode' | 'codeWorkspaces'>;
};

export type CodeEnvironmentReconciliation = {
  request: CodeEnvironmentReconciliationRequest;
  status: 'pending' | 'error';
  /** A late completion must not clear a newer reconciliation for the same chat. */
  token: symbol;
};

/** An unconfirmed decision outlives the mutation observer, resets and navigation. It is cleared
 * only after authoritative reconciliation succeeds, or when a full reload discards local state. */
export const codeEnvironmentReconciliationsAtom = atom<
  ReadonlyMap<string, CodeEnvironmentReconciliation>
>(new Map());
