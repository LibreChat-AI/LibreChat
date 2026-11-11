/**
 * Responses the remote agent API answers. Their reader is an API client holding a key or an
 * OIDC bearer, never LibreChat's signed-in browser, so nothing written to them can ask a person
 * to act.
 */
const remoteResponses = new WeakSet<object>();

/** Called once, where the remote agent API has authenticated its caller. */
export function markRemoteAgentResponse(res: object): void {
  remoteResponses.add(res);
}

export function isRemoteAgentResponse(res: object | null | undefined): boolean {
  return res != null && remoteResponses.has(res);
}
