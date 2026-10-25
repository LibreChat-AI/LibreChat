import { Constants } from 'librechat-data-provider';
import type {
  CodeApprovalMode,
  EventSubmission,
  CodeEnvironmentMode,
} from 'librechat-data-provider';

export { withSubmittedCodeDecision, hasSameCodeDecision } from '@librechat/chat';

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

/**
 * The mode a submission carries: the conversation's pick when current policy offers it, else the
 * gated fallback. A turn sent without attached workspaces has no target for a stronger mode to
 * govern, so it carries `ask` even when the composer resolved the decision only at send time.
 */
export function resolveSubmittedCodeApprovalMode({
  requested,
  modes,
  fallback,
  codeEnvironmentMode,
}: {
  requested?: CodeApprovalMode;
  modes: readonly CodeApprovalMode[];
  fallback?: CodeApprovalMode;
  codeEnvironmentMode?: CodeEnvironmentMode;
}): CodeApprovalMode | undefined {
  if (fallback == null) return undefined;
  if (codeEnvironmentMode === 'without_attached') return 'ask';
  return requested != null && modes.includes(requested) ? requested : fallback;
}
