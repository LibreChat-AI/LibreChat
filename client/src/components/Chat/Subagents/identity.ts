import type { SubagentIdentity } from 'librechat-data-provider';

/**
 * The saved agent behind a child, from live progress, then its persisted
 * identity, then — for invocations that carry no identity at all — an agent id
 * used as its type. A graph child is never read as an agent, by either source.
 */
export function resolveSubagentAgentId(
  progress: Partial<SubagentIdentity> | null | undefined,
  persisted: SubagentIdentity | undefined,
  subagentType?: string | null,
): string | undefined {
  if (progress?.subagentKind === 'graph') return undefined;
  if (progress?.subagentAgentId) return progress.subagentAgentId;
  if (persisted != null) {
    return persisted.subagentKind === 'agent' ? persisted.subagentAgentId : undefined;
  }
  return subagentType?.startsWith('agent_') === true ? subagentType : undefined;
}
