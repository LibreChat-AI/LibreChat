import { ErrorTypes, isCodeWorkspaceSelectionErrorReason } from 'librechat-data-provider';
import type { CodeWorkspaceSelectionErrorReason } from 'librechat-data-provider';

interface CodeWorkspaceErrorLike {
  code?: string;
  reason?: string;
}

interface CodeWorkspaceSelectionErrorDetails {
  reason?: CodeWorkspaceSelectionErrorReason;
}

export function getCodeWorkspaceSelectionErrorDetails(
  error?: CodeWorkspaceErrorLike | null,
): CodeWorkspaceSelectionErrorDetails {
  if (
    error?.code !== ErrorTypes.CODE_WORKSPACE_UNAVAILABLE ||
    !isCodeWorkspaceSelectionErrorReason(error.reason)
  ) {
    return {};
  }
  return { reason: error.reason };
}

/**
 * A rejected decision must remain retryable. Publishing the generation error
 * is safe, but persisting a first-turn conversation without a validated
 * decision would turn the retry into a locked legacy conversation.
 */
export function shouldPersistCodeWorkspaceInitializationError({
  streamStarted,
  isNewConversation,
  failureCode,
  hasValidatedDecision,
}: {
  streamStarted: boolean;
  isNewConversation: boolean;
  failureCode?: string;
  hasValidatedDecision: boolean;
}): boolean {
  if (!streamStarted) {
    return false;
  }
  return !(
    isNewConversation &&
    failureCode === ErrorTypes.CODE_WORKSPACE_UNAVAILABLE &&
    !hasValidatedDecision
  );
}
