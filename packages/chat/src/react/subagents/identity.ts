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
