import type { SubagentIdentity, SubagentUpdateEvent } from 'librechat-data-provider';

/** Retain execution identity beside the existing bounded child-content buffer. */
export function captureSubagentIdentity(
  target: { subagentIdentity?: SubagentIdentity },
  event: SubagentUpdateEvent,
): void {
  if (event.subagentKind !== 'agent' && event.subagentKind !== 'graph') return;
  if (!event.subagentAgentId) return;
  if (
    target.subagentIdentity?.subagentKind === event.subagentKind &&
    target.subagentIdentity.subagentAgentId === event.subagentAgentId
  )
    return;
  target.subagentIdentity = {
    subagentKind: event.subagentKind,
    subagentAgentId: event.subagentAgentId,
  };
}
