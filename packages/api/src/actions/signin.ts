/**
 * Expected when an action needs its owner to sign in and nobody can follow the prompt, as on
 * a remote agent API run that answers an API client.
 */
export class ActionSignInUnattendedError extends Error {
  readonly code = 'action_reauth_required';
  constructor() {
    super('Action sign-in is required and cannot be completed from an API request.');
    this.name = 'ActionSignInUnattendedError';
  }
}

/** Called before an action asks its owner to sign in. Stored tokens and refreshes never reach it. */
export function assertActionSignInAttended(unattended?: boolean): void {
  if (unattended) throw new ActionSignInUnattendedError();
}
