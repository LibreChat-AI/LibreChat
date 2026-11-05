import { Constants, ResourceType, PermissionBits } from 'librechat-data-provider';
import type { RestoredToolsAuthorization, RestoredServerConfig } from './restore';
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
  const dbConfig = (serverName: string): RestoredServerConfig => ({
    source: 'user',
    dbId: `server-${serverName}`,
  });
  const noPermissions = (): Promise<Map<string, number>> => Promise.resolve(new Map());

  /** Approves every tool, routing each MCP tool through the restore gate. */
  const authorizeThroughGate =
    (configFor: (serverName: string) => RestoredServerConfig = dbConfig) =>
    async ({
      tools,
      resolvedServerNames,
      admitMCPTool,
    }: RestoredToolsAuthorization): Promise<string[]> => {
      const approved: string[] = [];
      for (const tool of tools) {
        if (!tool.includes(Constants.mcp_delimiter)) {
          approved.push(tool);
          continue;
        }
        const serverName = tool.split(Constants.mcp_delimiter).pop() as string;
        if (await admitMCPTool(tool, serverName, configFor(serverName))) {
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
      versionTools: undefined,
      authorizeTools,
      listAgentIdsForServer: jest.fn(),
      getPermissions: jest.fn(),
    });
    expect(plan).toEqual({ expectedUpdatedAt: updatedAt });
    expect(authorizeTools).not.toHaveBeenCalled();
  });

  it('restores an explicit empty set when the snapshot array holds no valid tools', async () => {
    const plan = await authorizeAgentRestore({
      agent: { _id: agentId, tools: [mcpTool('docs')], mcpServerNames: ['docs'], updatedAt },
      versionTools: [42, null, { name: 'tool' }],
      authorizeTools: jest.fn(),
      listAgentIdsForServer: jest.fn(),
      getPermissions: jest.fn(),
    });
    expect(plan).toEqual({ expectedUpdatedAt: updatedAt, tools: [], mcpServerNames: [] });
  });

  it('passes the current tools as existing, not the restored ones', async () => {
    const authorizeTools = jest.fn().mockResolvedValue(['web_search']);
    await authorizeAgentRestore({
      agent: { _id: agentId, tools: ['web_search'], updatedAt },
      versionTools: ['web_search', mcpTool('docs')],
      authorizeTools,
      listAgentIdsForServer: jest.fn(),
      getPermissions: jest.fn(),
    });
    expect(authorizeTools).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: ['web_search', mcpTool('docs')],
        existingTools: ['web_search'],
      }),
    );
  });

  it('rejects a new tool whose only grant is the target agent', async () => {
    const plan = await authorizeAgentRestore({
      agent: { _id: agentId, tools: [], mcpServerNames: ['docs'], updatedAt },
      versionTools: [mcpTool('docs')],
      authorizeTools: authorizeThroughGate(),
      listAgentIdsForServer: jest.fn().mockResolvedValue([agentId]),
      getPermissions: noPermissions,
    });
    expect(plan.tools).toEqual([]);
    expect(plan.mcpServerNames).toEqual([]);
  });

  it('admits a new tool the user reaches through another viewable agent', async () => {
    const getPermissions = jest.fn(async (resourceType: ResourceType) =>
      resourceType === ResourceType.AGENT
        ? new Map([[otherAgentId, PermissionBits.VIEW]])
        : new Map<string, number>(),
    );
    const plan = await authorizeAgentRestore({
      agent: { _id: agentId, tools: [], updatedAt },
      versionTools: [mcpTool('docs')],
      authorizeTools: authorizeThroughGate(),
      listAgentIdsForServer: jest.fn().mockResolvedValue([agentId, otherAgentId]),
      getPermissions,
    });
    expect(getPermissions).toHaveBeenCalledWith(ResourceType.AGENT, [otherAgentId]);
    expect(plan.tools).toEqual([mcpTool('docs')]);
    expect(plan.mcpServerNames).toEqual(['docs']);
  });

  it('admits a new tool on a live direct server grant', async () => {
    const plan = await authorizeAgentRestore({
      agent: { _id: agentId, tools: [], updatedAt },
      versionTools: [mcpTool('docs')],
      authorizeTools: authorizeThroughGate(),
      listAgentIdsForServer: jest.fn().mockResolvedValue([]),
      getPermissions: async (resourceType) =>
        resourceType === ResourceType.MCPSERVER
          ? new Map([['server-docs', PermissionBits.VIEW]])
          : new Map(),
    });
    expect(plan.tools).toEqual([mcpTool('docs')]);
  });

  it('rejects a new tool when no live grant remains, whatever the registry cached', async () => {
    const plan = await authorizeAgentRestore({
      agent: { _id: agentId, tools: [], updatedAt },
      versionTools: [mcpTool('docs')],
      authorizeTools: authorizeThroughGate(),
      listAgentIdsForServer: jest.fn().mockResolvedValue([otherAgentId]),
      getPermissions: noPermissions,
    });
    expect(plan.tools).toEqual([]);
  });

  it('admits another tool from a server the agent still uses, without a lookup', async () => {
    const listAgentIdsForServer = jest.fn();
    const fetchTool = `fetch${Constants.mcp_delimiter}docs`;
    const plan = await authorizeAgentRestore({
      agent: { _id: agentId, tools: [mcpTool('docs')], mcpServerNames: ['docs'], updatedAt },
      versionTools: [mcpTool('docs'), fetchTool],
      authorizeTools: authorizeThroughGate(),
      listAgentIdsForServer,
      getPermissions: noPermissions,
    });
    expect(listAgentIdsForServer).not.toHaveBeenCalled();
    expect(plan.tools).toEqual([mcpTool('docs'), fetchTool]);
    expect(plan.mcpServerNames).toEqual(['docs']);
  });

  it('does not treat a stale index entry as a server the agent still uses', async () => {
    const plan = await authorizeAgentRestore({
      agent: { _id: agentId, tools: ['web_search'], mcpServerNames: ['docs'], updatedAt },
      versionTools: [mcpTool('docs')],
      authorizeTools: authorizeThroughGate(),
      listAgentIdsForServer: jest.fn().mockResolvedValue([agentId]),
      getPermissions: noPermissions,
    });
    expect(plan.tools).toEqual([]);
  });

  it('looks up each server once however many of its tools are restored', async () => {
    const listAgentIdsForServer = jest.fn().mockResolvedValue([otherAgentId]);
    const getPermissions = jest.fn(async (resourceType: ResourceType) =>
      resourceType === ResourceType.AGENT
        ? new Map([[otherAgentId, PermissionBits.VIEW]])
        : new Map<string, number>(),
    );
    await authorizeAgentRestore({
      agent: { _id: agentId, tools: [], updatedAt },
      versionTools: [
        mcpTool('docs'),
        `fetch${Constants.mcp_delimiter}docs`,
        `list${Constants.mcp_delimiter}docs`,
      ],
      authorizeTools: authorizeThroughGate(),
      listAgentIdsForServer,
      getPermissions,
    });
    expect(listAgentIdsForServer).toHaveBeenCalledTimes(1);
    expect(getPermissions).toHaveBeenCalledTimes(2);
  });

  it('admits operator-managed servers without a database lookup', async () => {
    const listAgentIdsForServer = jest.fn();
    const plan = await authorizeAgentRestore({
      agent: { _id: agentId, tools: [], updatedAt },
      versionTools: [mcpTool('yamlServer')],
      authorizeTools: authorizeThroughGate(() => ({ source: 'yaml' })),
      listAgentIdsForServer,
      getPermissions: noPermissions,
    });
    expect(listAgentIdsForServer).not.toHaveBeenCalled();
    expect(plan.tools).toEqual([mcpTool('yamlServer')]);
  });

  it('rechecks a legacy cached DB config that carries a dbId but no source', async () => {
    const listAgentIdsForServer = jest.fn().mockResolvedValue([]);
    const plan = await authorizeAgentRestore({
      agent: { _id: agentId, tools: [], updatedAt },
      versionTools: [mcpTool('docs')],
      authorizeTools: authorizeThroughGate(() => ({ dbId: 'server-docs' })),
      listAgentIdsForServer,
      getPermissions: noPermissions,
    });
    expect(listAgentIdsForServer).toHaveBeenCalledWith('docs');
    expect(plan.tools).toEqual([]);
  });

  it('rechecks a tool the agent holds without an index entry for its server', async () => {
    const listAgentIdsForServer = jest.fn().mockResolvedValue([agentId]);
    const plan = await authorizeAgentRestore({
      agent: { _id: agentId, tools: [mcpTool('docs')], mcpServerNames: [], updatedAt },
      versionTools: [mcpTool('docs')],
      authorizeTools: authorizeThroughGate(),
      listAgentIdsForServer,
      getPermissions: noPermissions,
    });
    expect(listAgentIdsForServer).toHaveBeenCalledWith('docs');
    expect(plan.tools).toEqual([]);
    expect(plan.mcpServerNames).toEqual([]);
  });

  it('keeps an indexed tool the agent already has without a further lookup', async () => {
    const listAgentIdsForServer = jest.fn();
    const plan = await authorizeAgentRestore({
      agent: { _id: agentId, tools: [mcpTool('docs')], mcpServerNames: ['docs'], updatedAt },
      versionTools: [mcpTool('docs')],
      authorizeTools: authorizeThroughGate(),
      listAgentIdsForServer,
      getPermissions: noPermissions,
    });
    expect(listAgentIdsForServer).not.toHaveBeenCalled();
    expect(plan.tools).toEqual([mcpTool('docs')]);
    expect(plan.mcpServerNames).toEqual(['docs']);
  });
});
