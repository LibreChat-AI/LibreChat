import { atomFamily } from 'jotai/utils';
import { atom, useAtomValue } from 'jotai';
import { Constants } from 'librechat-data-provider';
import type { Agents } from 'librechat-data-provider';

/**
 * The server-owned pending action for one conversation.
 *
 * Kept outside message rendering so the composer and timeline can project the
 * same action without making mounted cards the source of truth. This state is
 * memory-only: reload hydration comes from the stream status endpoint.
 */
export const pendingApprovalActionFamily = atomFamily((_conversationId: string) =>
  atom<Agents.PendingAction | null>(null),
);

/** Whether the composer's review panel is expanded for one conversation. */
export const approvalPanelOpenFamily = atomFamily((_conversationId: string) => atom(false));

/**
 * True while the composer's review panel is open on this tool-approval action.
 * The panel then owns the decisions and the batch submit, and it overlays the
 * tail of the thread where the live approval card sits, so the thread card
 * steps back to a record of the request until the panel is collapsed.
 * Without a conversation there is no composer, so nothing is presented there.
 */
export function useComposerPresentsApproval(
  conversationId: string | null | undefined,
  actionId: string,
): boolean {
  const key = conversationId ?? Constants.NEW_CONVO;
  const pendingAction = useAtomValue(pendingApprovalActionFamily(key));
  const open = useAtomValue(approvalPanelOpenFamily(key));
  return (
    conversationId != null &&
    open &&
    pendingAction?.actionId === actionId &&
    pendingAction.payload.type === 'tool_approval'
  );
}
