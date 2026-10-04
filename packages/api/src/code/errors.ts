import { ErrorTypes, isCodeWorkspaceSelectionErrorReason } from 'librechat-data-provider';
import type { CodeWorkspaceSelectionErrorReason } from 'librechat-data-provider';

function codeWorkspaceSelectionErrorMessage(reason: CodeWorkspaceSelectionErrorReason): string {
  switch (reason) {
    case 'required':
      return 'Choose an attached workspace before using this agent.';
    case 'invalid':
      return 'The selected attached workspace is invalid.';
    case 'worker_unavailable':
      return 'The attached code environment is unavailable. Reconnect the machine and try again.';
    case 'unsupported':
      return 'The attached code environment does not advertise selectable workspaces. Update the LibreChat Code worker and try again.';
    case 'missing':
      return 'The selected workspace is no longer registered on this machine. Restore the previous registration or start a new conversation.';
    case 'locked':
      return 'This conversation already has a different code environment decision.';
  }
}

export class CodeWorkspaceSelectionError extends Error {
  readonly code: ErrorTypes.CODE_WORKSPACE_UNAVAILABLE = ErrorTypes.CODE_WORKSPACE_UNAVAILABLE;
  readonly status: number = 409;
  readonly statusCode: number = 409;

  constructor(public readonly reason: CodeWorkspaceSelectionErrorReason) {
    super(codeWorkspaceSelectionErrorMessage(reason));
    this.name = 'CodeWorkspaceSelectionError';
  }
}

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
