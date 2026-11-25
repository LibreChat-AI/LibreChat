import { isActionTool } from 'librechat-data-provider';

/**
 * Keeps unsaved non-action tool choices while accepting the server's canonical
 * action registrations after an adjacent action create/update mutation.
 */
export function mergeDirtyToolsWithServerActions(
  dirtyTools: readonly string[],
  serverTools: readonly string[],
): string[] {
  const merged = dirtyTools.filter((tool) => !isActionTool(tool));
  const seen = new Set(merged);
  for (const tool of serverTools) {
    if (isActionTool(tool) && !seen.has(tool)) {
      merged.push(tool);
      seen.add(tool);
    }
  }
  return merged;
}
