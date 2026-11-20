import type { CodeEnvRef } from 'librechat-data-provider';

/**
 * The resource identity a code upload is filed under this turn: an agent's own resource file
 * belongs to the agent, and everything else to the requesting user.
 */
export interface CodeEnvScope {
  kind: 'agent' | 'user';
  id?: string;
}

export function getCodeEnvScope({
  agentScoped,
  agentId,
  userId,
}: {
  agentScoped: boolean;
  agentId?: string;
  userId?: string;
}): CodeEnvScope {
  return agentScoped ? { kind: 'agent', id: agentId } : { kind: 'user', id: userId };
}

/**
 * Whether a sandbox pointer was filed under `scope`. `kind` and `id` are what the Code API
 * derives a storage session key from, so a pointer filed under another agent or user names a
 * session this turn does not run as. Pointers this pipeline does not write, skill files being
 * the case in point, are left to their owner.
 */
export function isCodeRefInScope(
  ref: Pick<CodeEnvRef, 'kind' | 'id'>,
  scope: CodeEnvScope,
): boolean {
  if (ref.kind !== 'agent' && ref.kind !== 'user') {
    return true;
  }
  return ref.kind === scope.kind && ref.id === scope.id;
}
