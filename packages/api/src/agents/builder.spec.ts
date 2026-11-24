import {
  Permissions,
  PermissionBits,
  PermissionTypes,
  AgentCapabilities,
} from 'librechat-data-provider';
import type { AppConfig, IRole, IUser } from '@librechat/data-schemas';
import type { AgentBuilderDeps } from './builder';
import type { ServerRequest } from '~/types';
import {
  buildAgentBuilderTool,
  registerAgentBuilderTools,
  getAgentBuilderToolDefinitions,
} from './builder';
import { buildToolApprovalHooks } from './hitl/hooks';

const marker = AgentCapabilities.agent_builder;
const target = {
  _id: 'oid-1',
  id: 'agent_target',
  name: 'Target',
  description: 'd',
  instructions: 'secret instructions',
  provider: 'openAI',
  model: 'gpt-4o',
  tools: ['web_search'],
};

function makeReq(toolApprovalEnabled = true): ServerRequest {
  return {
    user: { id: 'user-1', role: 'USER' } as IUser,
    config: {
      endpoints: {
        agents: { capabilities: [marker], toolApproval: { enabled: toolApprovalEnabled } },
      },
    } as AppConfig,
  } as ServerRequest;
}

function makeDeps(canView: boolean, canEdit: boolean): AgentBuilderDeps {
  const role = {
    permissions: {
      [PermissionTypes.AGENTS]: { [Permissions.USE]: true, [Permissions.CREATE]: true },
    },
  } as IRole;
  return {
    getRoleByName: jest.fn().mockResolvedValue(role),
    getAgent: jest.fn().mockResolvedValue(target),
    findAccessibleResources: jest.fn().mockResolvedValue([]),
    getListAgentsByAccess: jest.fn(),
    checkPermission: jest.fn(async ({ requiredPermission }) =>
      requiredPermission === PermissionBits.VIEW ? canView : canEdit,
    ),
    createAgent: jest.fn(),
    updateAgent: jest.fn(async () => ({ status: 200, body: { id: target.id, name: 'New' } })),
  };
}

const agent = { tools: [marker] };

describe('agent builder definitions', () => {
  it('offers writes only with approval and applies marker callers to read tools only', () => {
    expect(getAgentBuilderToolDefinitions(false).map((d) => d.name)).toEqual([
      'list_agents',
      'get_agent',
    ]);
    const { toolDefinitions } = registerAgentBuilderTools({
      approvalEnabled: true,
      toolOptions: { [marker]: { allowed_callers: ['code_execution'] } },
    });
    const callers = Object.fromEntries(toolDefinitions.map((d) => [d.name, d.allowed_callers]));
    expect(callers).toEqual({
      list_agents: ['code_execution'],
      get_agent: ['code_execution'],
      create_agent: undefined,
      update_agent: undefined,
    });
  });
});

describe('agent builder approval', () => {
  it('asks for every write when the capability is enabled', async () => {
    const appConfig = makeReq().config;
    const hooks = buildToolApprovalHooks({ appConfig });
    expect(hooks).toHaveLength(1);
    expect(new RegExp(hooks[0].matcher!).test('update_agent')).toBe(true);
    expect(new RegExp(hooks[0].matcher!).test('get_agent')).toBe(false);
    const output = await hooks[0].hook(
      { toolName: 'create_agent' } as Parameters<(typeof hooks)[0]['hook']>[0],
      new AbortController().signal,
    );
    expect(output).toMatchObject({ decision: 'ask' });
    expect(buildToolApprovalHooks({})).toHaveLength(0);
  });

  it('refuses to build write tools when tool approval is off', async () => {
    const built = await buildAgentBuilderTool({
      toolName: 'create_agent',
      req: makeReq(false),
      agent,
      deps: makeDeps(true, true),
    });
    expect(built).toBeNull();
  });
});

describe('agent builder ACL', () => {
  it('does not update an agent without EDIT', async () => {
    const deps = makeDeps(true, false);
    const built = await buildAgentBuilderTool({
      toolName: 'update_agent',
      req: makeReq(),
      agent,
      deps,
    });
    const result = await built!.invoke({ id: target.id, name: 'New' });
    expect(result).toMatch(/^Error 404/);
    expect(deps.updateAgent).not.toHaveBeenCalled();
  });

  it('updates through the browser handler with EDIT', async () => {
    const deps = makeDeps(true, true);
    const built = await buildAgentBuilderTool({
      toolName: 'update_agent',
      req: makeReq(),
      agent,
      deps,
    });
    const result = await built!.invoke({ id: target.id, name: 'New' });
    expect(JSON.parse(result)).toEqual({ id: target.id, name: 'New' });
    const [subRequest] = (deps.updateAgent as jest.Mock).mock.calls[0];
    expect(subRequest.params).toEqual({ id: target.id });
    expect(subRequest.body).toEqual({ name: 'New' });
    expect(subRequest.user.id).toBe('user-1');
  });

  it('filters list_agents by an escaped name or description search', async () => {
    const deps = makeDeps(true, true);
    (deps.findAccessibleResources as jest.Mock).mockResolvedValue([]);
    (deps.getListAgentsByAccess as jest.Mock).mockResolvedValue({
      data: [],
      has_more: false,
      after: null,
    });
    const built = await buildAgentBuilderTool({
      toolName: 'list_agents',
      req: makeReq(),
      agent,
      deps,
    });
    await built!.invoke({ search: 'a.b' });
    const [{ otherParams }] = (deps.getListAgentsByAccess as jest.Mock).mock.calls[0];
    expect(otherParams).toEqual({ $or: [{ name: /a\.b/i }, { description: /a\.b/i }] });
  });

  it('hides instructions and tools from VIEW-only readers', async () => {
    const built = await buildAgentBuilderTool({
      toolName: 'get_agent',
      req: makeReq(),
      agent,
      deps: makeDeps(true, false),
    });
    const result = JSON.parse(await built!.invoke({ id: target.id }));
    expect(result).toEqual({
      id: target.id,
      name: 'Target',
      description: 'd',
      provider: 'openAI',
      model: 'gpt-4o',
    });
  });

  it('is not built for an agent without the marker', async () => {
    const built = await buildAgentBuilderTool({
      toolName: 'get_agent',
      req: makeReq(),
      agent: { tools: [] },
      deps: makeDeps(true, true),
    });
    expect(built).toBeNull();
  });
});
