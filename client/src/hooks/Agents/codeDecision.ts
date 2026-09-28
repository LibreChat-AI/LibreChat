import { Constants } from 'librechat-data-provider';
import type {
  CodeEnvironmentMode,
  EventSubmission,
  CodeWorkspaceSelection,
  TConversation,
} from 'librechat-data-provider';

function sameSelections(
  left?: CodeWorkspaceSelection[],
  right?: CodeWorkspaceSelection[],
): boolean {
  if (!left?.length || !right?.length) return !left?.length && !right?.length;
  if (left.length !== right.length) return false;
  const key = ({ environmentId, workspaceId }: CodeWorkspaceSelection) =>
    JSON.stringify([environmentId, workspaceId]);
  const held = new Set(left.map(key));
  return right.every((selection) => held.has(key(selection)));
}

/**
 * Folds the decision a submitted run establishes into the conversation that run belongs to. The
 * server seals this pair for the rest of the chat, so the conversation has to carry it from the
 * moment it is sent: a chat that becomes saved mid-run would otherwise hold no decision while the
 * stored one is already sealed, and the composer would re-derive an agent default or a remembered
 * preference that the sealed decision refuses — reporting "choose a workspace", with Send
 * disabled, for a workspace the run is already using. Returns the same conversation when it
 * already holds the decision, so an unchanged send never re-renders the composer.
 */
export function withSubmittedCodeDecision(
  conversation: TConversation | null,
  submitted: {
    codeEnvironmentMode?: CodeEnvironmentMode;
    codeWorkspaces?: CodeWorkspaceSelection[];
  },
): TConversation | null {
  const { codeWorkspaces } = submitted;
  // Older replicas accept selections without a mode. Preserve that submitted selection locally
  // too, or the first saved-chat event drops an implicit default back to "Choose workspace".
  const codeEnvironmentMode =
    submitted.codeEnvironmentMode ?? ((codeWorkspaces?.length ?? 0) > 0 ? 'attached' : undefined);
  if (conversation == null || codeEnvironmentMode == null) return conversation;
  if (
    conversation.codeEnvironmentMode === codeEnvironmentMode &&
    sameSelections(conversation.codeWorkspaces, codeWorkspaces)
  ) {
    return conversation;
  }
  return { ...conversation, codeEnvironmentMode, codeWorkspaces };
}

/** Compare the pair, including absence: a failed first send may leave no persisted decision. */
export function hasSameCodeDecision(
  left: Pick<TConversation, 'codeEnvironmentMode' | 'codeWorkspaces'>,
  right: Pick<TConversation, 'codeEnvironmentMode' | 'codeWorkspaces'>,
): boolean {
  return (
    (left.codeEnvironmentMode ?? (left.codeWorkspaces?.length ? 'attached' : undefined)) ===
      (right.codeEnvironmentMode ?? (right.codeWorkspaces?.length ? 'attached' : undefined)) &&
    sameSelections(left.codeWorkspaces, right.codeWorkspaces)
  );
}

/** The submission snapshot may still be `new` after creation/streaming assigned a durable id. */
export function getFailedCodeDecisionRequest(submission: EventSubmission, resolvedId?: string) {
  const conversationId = [
    resolvedId,
    submission.userMessage?.conversationId,
    submission.initialResponse?.conversationId,
    submission.conversation?.conversationId,
  ].find(
    (id): id is string =>
      typeof id === 'string' &&
      id.length > 0 &&
      id !== Constants.NEW_CONVO &&
      id !== Constants.PENDING_CONVO &&
      !id.startsWith('_'),
  );
  const codeEnvironmentMode =
    submission.codeEnvironmentMode ??
    ((submission.codeWorkspaces?.length ?? 0) > 0 ? 'attached' : undefined);
  if (conversationId == null || codeEnvironmentMode == null) return undefined;
  return {
    conversationId,
    attempted: {
      codeEnvironmentMode,
      codeWorkspaces: submission.codeWorkspaces,
    },
  };
}
