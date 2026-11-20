import { EToolResources } from 'librechat-data-provider';
import type { AgentToolResources, CodeEnvRef } from 'librechat-data-provider';

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

/** Resource lists whose files resource priming files under the agent and leaves in place. */
const AGENT_FILE_RESOURCES = [
  EToolResources.execute_code,
  EToolResources.file_search,
  EToolResources.image_edit,
] as const;

/**
 * The files an agent's own resource lists name, as tool loading sees them. Resource priming
 * files an upload of any of them under the agent, so a later stage that only receives the
 * resources can reach the same answer. Context files are absent: their list is consumed
 * before tools load, and without it such a file is filed under the requesting user.
 */
export function getAgentResourceFileIds(
  resources: AgentToolResources | null | undefined,
  known?: ReadonlySet<string>,
): Set<string> {
  const ids = new Set<string>(known);
  for (const resource of AGENT_FILE_RESOURCES) {
    for (const id of resources?.[resource]?.file_ids ?? []) {
      ids.add(id);
    }
  }
  return ids;
}
