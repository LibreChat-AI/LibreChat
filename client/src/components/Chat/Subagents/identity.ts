import type { SubagentIdentity } from 'librechat-data-provider';

export function resolveSubagentAgentId(
  progress: Partial<SubagentIdentity> | null | undefined,
  persisted: SubagentIdentity | undefined,
): string | undefined {
  if (progress?.subagentKind === 'graph') return undefined;
  if (progress?.subagentAgentId) return progress.subagentAgentId;
  return persisted?.subagentKind === 'agent' ? persisted.subagentAgentId : undefined;
}
