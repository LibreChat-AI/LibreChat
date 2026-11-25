import type { SubagentIdentity } from 'librechat-data-provider';

/**
 * The saved agent behind a child, from live progress, then its persisted
 * identity. Types are aliases, not proof of a saved-agent identity.
 */
export function resolveSubagentAgentId(
  progress: Partial<SubagentIdentity> | null | undefined,
  persisted: SubagentIdentity | undefined,
): string | undefined {
  if (progress?.subagentKind === 'graph') return undefined;
  if (progress?.subagentAgentId) return progress.subagentAgentId;
  if (persisted != null) {
    return persisted.subagentKind === 'agent' ? persisted.subagentAgentId : undefined;
  }
  return undefined;
}

/**
 * The saved agent a child that has not started yet will run as. Until the child reports its
 * identity there is only the requested type, and the server names each configured child agent
 * by its id, so a type that is a key of the caller's agents map names that agent. Any other
 * type (`self`, a graph alias, a half-written value) resolves to nothing; once the child
 * reports, its own identity replaces this.
 */
export function resolvePendingSubagentAgentId(
  subagentType: string | undefined,
  agentsMap: Record<string, unknown> | undefined,
): string | undefined {
  if (!subagentType || agentsMap?.[subagentType] == null) return undefined;
  return subagentType;
}
