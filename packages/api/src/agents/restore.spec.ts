import { Constants, PermissionBits } from 'librechat-data-provider';
import type { RestoredToolsAuthorization } from './restore';
import { authorizeAgentRestore, resolveRestoredMCPServerNames } from './restore';

const mcpTool = (serverName: string): string => `search${Constants.mcp_delimiter}${serverName}`;

describe('resolveRestoredMCPServerNames', () => {
  it('keeps names resolved during authorization', () => {
    expect(
      resolveRestoredMCPServerNames({
        tools: [mcpTool('docs')],
        existingTools: [],
        resolvedServerNames: new Set(['docs']),
        priorNames: [],
      }),
    ).toEqual(['docs']);
  });

  it('carries a prior name forward only while a tool the agent already had resolves to it', () => {
    expect(
      resolveRestoredMCPServerNames({
        tools: [mcpTool('docs'), 'web_search'],
        existingTools: [mcpTool('docs')],
        resolvedServerNames: [],
        priorNames: ['docs', 'detached'],
      }),
    ).toEqual(['docs']);
  });

  it('matches a prior raw name through its normalized tool-key form', () => {
    const tool = mcpTool('Connector__Company');
    expect(
      resolveRestoredMCPServerNames({
        tools: [tool],
        existingTools: [tool],
        resolvedServerNames: [],
        priorNames: ['Connector: Company'],
      }),
    ).toEqual(['Connector: Company']);
  });

  it('does not let a newly restored tool claim a prior name', () => {
    expect(
      resolveRestoredMCPServerNames({
        tools: [mcpTool('docs'), mcpTool('kept')],
        existingTools: [mcpTool('kept')],
        resolvedServerNames: ['kept'],
        priorNames: ['docs', 'kept'],
      }),
    ).toEqual(['kept']);
  });

  it('returns an empty index when no MCP tool is restored', () => {
    expect(
      resolveRestoredMCPServerNames({
        tools: ['web_search'],
        existingTools: [mcpTool('docs')],
        resolvedServerNames: [],
        priorNames: ['docs'],
      }),
    ).toEqual([]);
  });

  it('keeps the pre-restore index rather than deriving names when nothing resolves', () => {
    expect(
      resolveRestoredMCPServerNames({
        tools: [mcpTool('legacy')],
        existingTools: [mcpTool('legacy')],
        resolvedServerNames: [],
        priorNames: ['other'],
      }),
    ).toEqual(['other']);
  });

  it('ignores action tools that contain the MCP delimiter', () => {
    const actionTool = `sync${Constants.mcp_delimiter}state_action_api---example---com`;
    expect(
      resolveRestoredMCPServerNames({
        tools: [actionTool],
        existingTools: [],
        resolvedServerNames: [],
        priorNames: [],
      }),
    ).toEqual([]);
  });
});

describe('authorizeAgentRestore', () => {
  const agentId = 'agent-object-id';
  const otherAgentId = 'other-agent-object-id';
  const updatedAt = new Date('2026-11-05T00:00:00Z');

  /** Approves every tool, routing each MCP tool through the agent-scoped gate. */
  const authorizeThroughGate = async ({
    tools,
    resolvedServerNames,
    admitAgentScopedTool,
  }: RestoredToolsAuthorization): Promise<string[]> => {
    const approved: string[] = [];
    for (const tool of tools) {
      if (!tool.includes(Constants.mcp_delimiter)) {
        approved.push(tool);
        continue;
      }
      const serverName = tool.split(Constants.mcp_delimiter).pop() as string;
      if (await admitAgentScopedTool(tool, serverName)) {
        resolvedServerNames.add(serverName);
        approved.push(tool);
      }
    }
    return approved;
  };

  it('pins the restore to the revision it read and skips authorization with no tools', async () => {
    const authorizeTools = jest.fn();
    const plan = await authorizeAgentRestore({
      agent: { _id: agentId, tools: [], updatedAt },
      versionTools: [],
      authorizeTools,
      listAgentIdsForServer: jest.fn(),
      getAgentPermissions: jest.fn(),
    });
    expect(plan).toEqual({ expectedUpdatedAt: updatedAt });
    expect(authorizeTools).not.toHaveBeenCalled();
  });

  it('passes the current tools as existing, not the restored ones', async () => {
    const authorizeTools = jest.fn().mockResolvedValue(['web_search']);
    await authorizeAgentRestore({
      agent: { _id: agentId, tools: ['web_search'], updatedAt },
      versionTools: ['web_search', mcpTool('docs')],
      authorizeTools,
      listAgentIdsForServer: jest.fn(),
      getAgentPermissions: jest.fn(),
    });
    expect(authorizeTools).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: ['web_search', mcpTool('docs')],
        existingTools: ['web_search'],
      }),
    );
  });

  it('rejects a new tool whose only agent-scoped grant is the target agent', async () => {
    const plan = await authorizeAgentRestore({
      agent: { _id: agentId, tools: [], mcpServerNames: ['docs'], updatedAt },
      versionTools: [mcpTool('docs')],
      authorizeTools: authorizeThroughGate,
      listAgentIdsForServer: jest.fn().mockResolvedValue([agentId]),
      getAgentPermissions: jest.fn(),
    });
    expect(plan.tools).toEqual([]);
    expect(plan.mcpServerNames).toEqual([]);
  });

  it('admits a new tool the user reaches through another viewable agent', async () => {
    const getAgentPermissions = jest
      .fn()
      .mockResolvedValue(new Map([[otherAgentId, PermissionBits.VIEW]]));
    const plan = await authorizeAgentRestore({
      agent: { _id: agentId, tools: [], updatedAt },
      versionTools: [mcpTool('docs')],
      authorizeTools: authorizeThroughGate,
      listAgentIdsForServer: jest.fn().mockResolvedValue([agentId, otherAgentId]),
      getAgentPermissions,
    });
    expect(getAgentPermissions).toHaveBeenCalledWith([otherAgentId]);
    expect(plan.tools).toEqual([mcpTool('docs')]);
    expect(plan.mcpServerNames).toEqual(['docs']);
  });

  it('rejects a new tool when the other agents referencing the server are not viewable', async () => {
    const plan = await authorizeAgentRestore({
      agent: { _id: agentId, tools: [], updatedAt },
      versionTools: [mcpTool('docs')],
      authorizeTools: authorizeThroughGate,
      listAgentIdsForServer: jest.fn().mockResolvedValue([otherAgentId]),
      getAgentPermissions: jest.fn().mockResolvedValue(new Map()),
    });
    expect(plan.tools).toEqual([]);
  });

  it('keeps a tool the agent already has without a further lookup', async () => {
    const listAgentIdsForServer = jest.fn();
    const plan = await authorizeAgentRestore({
      agent: { _id: agentId, tools: [mcpTool('docs')], mcpServerNames: ['docs'], updatedAt },
      versionTools: [mcpTool('docs')],
      authorizeTools: authorizeThroughGate,
      listAgentIdsForServer,
      getAgentPermissions: jest.fn(),
    });
    expect(listAgentIdsForServer).not.toHaveBeenCalled();
    expect(plan.tools).toEqual([mcpTool('docs')]);
    expect(plan.mcpServerNames).toEqual(['docs']);
  });

  it('restores the current tools when the snapshot has none recorded', async () => {
    const authorizeTools = jest.fn().mockResolvedValue(['web_search']);
    await authorizeAgentRestore({
      agent: { _id: agentId, tools: ['web_search'], updatedAt },
      versionTools: undefined,
      authorizeTools,
      listAgentIdsForServer: jest.fn(),
      getAgentPermissions: jest.fn(),
    });
    expect(authorizeTools).toHaveBeenCalledWith(expect.objectContaining({ tools: ['web_search'] }));
  });
});
