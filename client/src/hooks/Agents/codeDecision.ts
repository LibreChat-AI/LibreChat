import { Constants } from 'librechat-data-provider';
import type { EventSubmission } from 'librechat-data-provider';

export {
  hasSameCodeDecision,
  withSubmittedCodeDecision,
  resolveSubmittedCodeApprovalMode,
} from '@librechat/chat';

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
