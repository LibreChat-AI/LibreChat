import { Constants } from 'librechat-data-provider';
import { resolveRestoredMCPServerNames } from './restore';

const mcpTool = (serverName: string): string => `search${Constants.mcp_delimiter}${serverName}`;

describe('resolveRestoredMCPServerNames', () => {
  it('keeps names resolved during authorization', () => {
    expect(
      resolveRestoredMCPServerNames({
        tools: [mcpTool('docs')],
        resolvedServerNames: new Set(['docs']),
        priorNames: [],
      }),
    ).toEqual(['docs']);
  });

  it('carries a prior name forward only while a retained tool resolves to it', () => {
    expect(
      resolveRestoredMCPServerNames({
        tools: [mcpTool('docs'), 'web_search'],
        resolvedServerNames: [],
        priorNames: ['docs', 'detached'],
      }),
    ).toEqual(['docs']);
  });

  it('returns an empty index when no MCP tool is restored', () => {
    expect(
      resolveRestoredMCPServerNames({
        tools: ['web_search'],
        resolvedServerNames: [],
        priorNames: ['docs'],
      }),
    ).toEqual([]);
  });

  it('leaves the index to the data layer when retained MCP tools resolve to no known name', () => {
    expect(
      resolveRestoredMCPServerNames({
        tools: [mcpTool('legacy')],
        resolvedServerNames: [],
        priorNames: [],
      }),
    ).toBeUndefined();
  });

  it('ignores action tools that contain the MCP delimiter', () => {
    const actionTool = `sync${Constants.mcp_delimiter}state_action_api---example---com`;
    expect(
      resolveRestoredMCPServerNames({
        tools: [actionTool],
        resolvedServerNames: [],
        priorNames: [],
      }),
    ).toEqual([]);
  });
});
