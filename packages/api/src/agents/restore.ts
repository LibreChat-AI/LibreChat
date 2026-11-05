import { Constants, isActionTool, splitMCPToolKey } from 'librechat-data-provider';

export interface RestoredMCPServerNamesParams {
  /** Tools the restore will persist, already authorized for the requesting user. */
  tools: readonly string[];
  /** Server names resolved while authorizing the restored tools. */
  resolvedServerNames: Iterable<string>;
  /** The agent's index before the restore; never the snapshot's, which is unverified. */
  priorNames: readonly string[];
}

const isMCPToolKey = (tool: unknown): tool is string =>
  typeof tool === 'string' && tool.includes(Constants.mcp_delimiter) && !isActionTool(tool);

/**
 * Builds the `mcpServerNames` index for a version restore from authorized sources only:
 * names resolved while authorizing the restored tools, plus the agent's pre-restore names
 * that a retained tool still resolves to.
 *
 * Returns `undefined` when MCP tools survive but none of them resolves to a known name
 * (e.g. the registry was unavailable for a legacy agent with no stored index), so the data
 * layer derives the index instead of pinning it empty.
 */
export function resolveRestoredMCPServerNames({
  tools,
  resolvedServerNames,
  priorNames,
}: RestoredMCPServerNamesParams): string[] | undefined {
  const names = new Set(resolvedServerNames);
  const priorNameSet = new Set(priorNames);
  let retainsMCPTools = false;

  for (const tool of tools) {
    if (!isMCPToolKey(tool)) {
      continue;
    }
    retainsMCPTools = true;
    if (priorNameSet.size === 0) {
      continue;
    }
    const [, serverName] = splitMCPToolKey(tool, priorNames);
    if (serverName && priorNameSet.has(serverName)) {
      names.add(serverName);
    }
  }

  if (names.size === 0 && retainsMCPTools) {
    return undefined;
  }
  return Array.from(names);
}
