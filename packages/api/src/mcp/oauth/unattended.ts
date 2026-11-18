import type { OAuthStartHandler } from '../types';

/**
 * Expected when a server needs sign-in and the caller has no person who can follow the prompt.
 * Shares its code with the schedule outcome for the same condition.
 */
export class OAuthPromptUnattendedError extends Error {
  readonly code = 'mcp_reauth_required';
  constructor() {
    super('MCP sign-in is required and cannot be completed from an API request.');
    this.name = 'OAuthPromptUnattendedError';
  }
}

export interface UnattendedOAuthGuard {
  /** The caller's own signal, also aborted with the typed error once it has to leave. */
  signal: AbortSignal;
  /** Stands in for the caller's prompt handler: refuses the publication and leaves. */
  oauthStart: OAuthStartHandler;
  /** Ends the caller's wait with {@link OAuthPromptUnattendedError}. Safe to call repeatedly. */
  leave: () => void;
}

/**
 * For a caller nobody can sign in for. A silent token refresh still runs to completion. The
 * first sign-in prompt, from the caller's own flow or from a recovery it is waiting on, ends
 * that caller's wait and is never published to it. Other waiters keep a shared recovery alive.
 */
export function guardUnattendedOAuth(
  signal?: AbortSignal,
  onSignInRequired?: () => void,
): UnattendedOAuthGuard {
  const controller = new AbortController();
  const error = new OAuthPromptUnattendedError();
  const leave = () => {
    if (controller.signal.aborted) return;
    onSignInRequired?.();
    controller.abort(error);
  };
  return {
    signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
    leave,
    oauthStart: async () => {
      leave();
      throw error;
    },
  };
}
