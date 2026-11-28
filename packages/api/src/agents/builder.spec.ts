import { AgentCapabilities, EModelEndpoint } from 'librechat-data-provider';
import type { LCTool, LCToolRegistry } from '@librechat/agents';
import type { AppConfig } from '@librechat/data-schemas';
import type { Request, Response } from 'express';
import type { AgentBuilderHandler, AgentBuilderRoutes } from './builder';
import {
  createAgentBuilderTool,
  registerAgentBuilderTools,
  isAgentBuilderWriteEnabled,
  requireAgentBuilderApproval,
} from './builder';
import { applyToolCallers } from './callers';

const config = (toolApproval?: { enabled: boolean }) =>
  ({
    endpoints: {
      [EModelEndpoint.agents]: {
        capabilities: [AgentCapabilities.agent_builder],
        ...(toolApproval ? { toolApproval } : {}),
      },
    },
  }) as unknown as AppConfig;

const deny: AgentBuilderHandler = (_req, res) => res.status(403).json({ error: 'Forbidden' });
const pass: AgentBuilderHandler = (_req, _res, next) => next();
const reply =
  (status: number, body: unknown): AgentBuilderHandler =>
  (_req, res) =>
    res.status(status).json(body);

describe('applyToolCallers', () => {
  it('applies marker and name callers to system tools, leaving MCP and orchestration tools alone', () => {
    const defs: LCTool[] = [
      { name: 'set_memory' },
      { name: 'get_agent', allowed_callers: ['direct'] },
      { name: 'search_mcp_srv' },
      { name: 'tool_search' },
    ];
    const toolRegistry: LCToolRegistry = new Map(defs.map((def) => [def.name, { ...def }]));
    toolRegistry.set('search_mcp_srv', { name: 'search_mcp_srv', toolType: 'mcp' });

    const result = applyToolCallers({
      toolDefinitions: defs,
      toolRegistry,
      toolOptions: {
        memory: { allowed_callers: ['code_execution'] },
        get_agent: { allowed_callers: ['direct', 'code_execution'] },
        search_mcp_srv: { allowed_callers: ['code_execution'] },
        tool_search: { allowed_callers: ['code_execution'] },
      },
      capabilityToolNames: new Map([['memory', ['set_memory']]]),
    });

    const callersOf = (name: string) => toolRegistry.get(name)?.allowed_callers;
    expect(callersOf('set_memory')).toEqual(['code_execution']);
    expect(callersOf('get_agent')).toEqual(['direct', 'code_execution']);
    expect(callersOf('search_mcp_srv')).toBeUndefined();
    expect(callersOf('tool_search')).toBeUndefined();
    expect(result.toolDefinitions[0]).toBe(toolRegistry.get('set_memory'));
    expect(result.hasProgrammaticTools).toBe(true);
  });
});

describe('agent builder writes', () => {
  it('exist only with tool approval on, and always ask', () => {
    expect(isAgentBuilderWriteEnabled(config())).toBe(false);
    expect(isAgentBuilderWriteEnabled(config({ enabled: true }))).toBe(true);

    const reads = registerAgentBuilderTools({ includeWrites: false, programmatic: true });
    expect(reads.toolNames).toEqual(['list_agents', 'get_agent']);
    expect(
      reads.toolDefinitions.every((def) => def.allowed_callers?.[0] === 'code_execution'),
    ).toBe(true);

    const req = { config: config() } as unknown as Request;
    const routes = {} as AgentBuilderRoutes;
    expect(createAgentBuilderTool({ name: 'update_agent', req, routes })).toBeNull();

    expect(requireAgentBuilderApproval(undefined)).toBeUndefined();
    const policy = requireAgentBuilderApproval({
      enabled: true,
      mode: 'bypass',
      allow: ['*'],
    });
    expect(policy?.ask).toEqual(['create_agent', 'update_agent']);
  });
});

describe('agent builder ACL', () => {
  const req = { config: config({ enabled: true }), user: { id: 'u1' } } as unknown as Request;

  it('refuses an update the route ACL denies without reaching the handler', async () => {
    const handler = jest.fn(reply(200, { id: 'a1' }));
    const routes = { update: [pass, deny, handler] } as unknown as AgentBuilderRoutes;
    const updateTool = createAgentBuilderTool({ name: 'update_agent', req, routes });

    const output = await updateTool?.invoke({ id: 'a1', patch: { name: 'x' } });

    expect(JSON.parse(output as string)).toEqual({ error: 'permission_denied' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('returns basic info when the user can view but not edit', async () => {
    const seen: unknown[] = [];
    const routes = {
      getExpanded: [deny],
      get: [
        (scoped: Request, res: Response) => {
          seen.push(scoped.params.id, (scoped as Request & { user: unknown }).user);
          return res.status(200).json({ _id: 'oid', id: 'a1', name: 'Basic' });
        },
      ],
    } as unknown as AgentBuilderRoutes;
    const getTool = createAgentBuilderTool({ name: 'get_agent', req, routes });

    const output = await getTool?.invoke({ id: 'a1' });

    expect(JSON.parse(output as string)).toEqual({ id: 'a1', name: 'Basic' });
    expect(seen).toEqual(['a1', { id: 'u1' }]);
  });
});
