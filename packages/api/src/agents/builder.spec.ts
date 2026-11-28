import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createModels, createMethods } from '@librechat/data-schemas';
import {
  SystemRoles,
  ResourceType,
  PrincipalType,
  PermissionBits,
  PrincipalModel,
  AgentCapabilities,
} from 'librechat-data-provider';
import type { AllMethods, IAgent, IUser } from '@librechat/data-schemas';
import type { LCTool, LCToolRegistry } from '@librechat/agents';
import type { Types } from 'mongoose';
import type { AgentBuilderAgent, AgentBuilderDeps, AgentBuilderUser } from './builder';
import type { ServerRequest } from '~/types';
import {
  getBuilderAgent,
  listBuilderAgents,
  GET_AGENT_TOOL_NAME,
  LIST_AGENTS_TOOL_NAME,
  buildAgentBuilderTool,
  createAgentBuilderTool,
  resolveAgentBuilderTools,
  registerAgentBuilderTools,
  resolveAgentBuilderLimits,
  createAgentBuilderToolResolver,
} from './builder';
import { generateCapabilityCheck } from '~/middleware/capabilities';
import { AccessControlService } from '~/acl/accessControlService';
import { applyDeferredToolLoading } from './deferral';

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: { error: jest.fn(), warn: jest.fn(), debug: jest.fn(), info: jest.fn() },
}));

type AgentRecord = IAgent & { _id: Types.ObjectId };

let mongoServer: MongoMemoryServer;
let methods: AllMethods;
let deps: AgentBuilderDeps<AgentBuilderUser>;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  createModels(mongoose);
  methods = createMethods(mongoose);
  const acl = new AccessControlService(mongoose);
  const { hasCapability } = generateCapabilityCheck({
    getUserPrincipals: methods.getUserPrincipals,
    hasCapabilityForPrincipals: methods.hasCapabilityForPrincipals,
  });
  deps = {
    getAgent: async (agentId) =>
      (await methods.getAgent({ id: agentId })) as AgentBuilderAgent | null,
    hasCapability: (user, capability) =>
      hasCapability({ id: user.id, role: user.role ?? '', tenantId: user.tenantId }, capability),
    checkPermission: (params) =>
      acl.checkPermission({ ...params, resourceId: params.resourceId as Types.ObjectId }),
    findAccessibleResources: (params) => acl.findAccessibleResources(params),
    getListAgentsByAccess: (params) => methods.getListAgentsByAccess(params),
  };
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});

beforeEach(async () => {
  await mongoose.connection.dropDatabase();
  await methods.seedSystemGrants();
});

async function createUser(role: string = SystemRoles.USER): Promise<AgentBuilderUser> {
  const user = await mongoose.models.User.create({
    name: 'User',
    email: `${new mongoose.Types.ObjectId().toString()}@test.com`,
    password: 'password123',
    provider: 'local',
    role,
  });
  return { id: user._id.toString(), role };
}

async function createAgentFor(
  author: AgentBuilderUser,
  fields: Partial<IAgent> = {},
): Promise<AgentRecord> {
  return (await methods.createAgent({
    id: `agent_${new mongoose.Types.ObjectId().toString()}`,
    name: 'Agent',
    description: 'Helps with things',
    provider: 'openai',
    model: 'gpt-4o',
    instructions: 'Be brief.',
    tools: ['web_search'],
    author: new mongoose.Types.ObjectId(author.id),
    ...fields,
  })) as AgentRecord;
}

async function grant(user: AgentBuilderUser, agent: AgentRecord, permBits: number) {
  await mongoose.models.AclEntry.create({
    principalType: PrincipalType.USER,
    principalId: new mongoose.Types.ObjectId(user.id),
    principalModel: PrincipalModel.USER,
    resourceType: ResourceType.AGENT,
    resourceId: agent._id,
    permBits,
    grantedBy: new mongoose.Types.ObjectId(user.id),
  });
}

const EDIT = PermissionBits.VIEW | PermissionBits.EDIT;

describe('listBuilderAgents', () => {
  it('lists only agents the user can view, with fixed fields', async () => {
    const owner = await createUser();
    const viewer = await createUser();
    const shared = await createAgentFor(owner, { name: 'Shared' });
    await createAgentFor(owner, { name: 'Private' });
    await grant(viewer, shared, PermissionBits.VIEW);

    const result = await listBuilderAgents(viewer, {}, deps);

    expect(result).toEqual({
      ok: true,
      value: { agents: [{ id: shared.id, name: 'Shared', description: 'Helps with things' }] },
    });
  });

  it('matches search against name and description', async () => {
    const user = await createUser();
    const billing = await createAgentFor(user, { name: 'Billing', description: 'Invoices' });
    const support = await createAgentFor(user, { name: 'Helper', description: 'Support desk' });
    await createAgentFor(user, { name: 'Other', description: 'Nothing' });
    await grant(user, billing, EDIT);
    await grant(user, support, EDIT);
    await createAgentFor(user, { name: 'Unshared billing' });

    const byName = await listBuilderAgents(user, { search: 'bill' }, deps);
    const byDescription = await listBuilderAgents(user, { search: 'SUPPORT' }, deps);
    const regexChars = await listBuilderAgents(user, { search: '.*' }, deps);

    expect(byName.ok && byName.value.agents.map((a) => a.id)).toEqual([billing.id]);
    expect(byDescription.ok && byDescription.value.agents.map((a) => a.id)).toEqual([support.id]);
    expect(regexChars.ok && regexChars.value.agents).toEqual([]);
  });

  it('pages with limit and next_cursor', async () => {
    const user = await createUser();
    for (let i = 0; i < 3; i++) {
      await grant(user, await createAgentFor(user, { name: `Agent ${i}` }), EDIT);
    }

    const first = await listBuilderAgents(user, { limit: 2 }, deps);
    expect(first.ok && first.value.agents).toHaveLength(2);
    const cursor = first.ok ? first.value.next_cursor : undefined;
    expect(cursor).toEqual(expect.any(String));

    const second = await listBuilderAgents(user, { limit: 2, cursor }, deps);
    expect(second.ok && second.value.agents).toHaveLength(1);
    expect(second.ok && second.value.next_cursor).toBeUndefined();
  });

  it('uses the configured default page size and caps a larger request at maxLimit', async () => {
    const user = await createUser();
    for (let i = 0; i < 4; i++) {
      await grant(user, await createAgentFor(user, { name: `Agent ${i}` }), EDIT);
    }
    const limits = { defaultLimit: 2, maxLimit: 3 };

    const byDefault = await listBuilderAgents(user, {}, deps, limits);
    expect(byDefault.ok && byDefault.value.agents).toHaveLength(2);
    const capped = await listBuilderAgents(user, { limit: 10 }, deps, limits);
    expect(capped.ok && capped.value.agents).toHaveLength(3);
  });

  it('returns invalid_cursor for a cursor it cannot read', async () => {
    const user = await createUser();
    await grant(user, await createAgentFor(user), EDIT);

    const result = await listBuilderAgents(user, { cursor: 'not-a-cursor' }, deps);

    expect(result).toEqual({ ok: false, error: { code: 'invalid_cursor' } });
  });

  it('lists every agent for a user with the manage-agents capability', async () => {
    const owner = await createUser();
    const admin = await createUser(SystemRoles.ADMIN);
    const agent = await createAgentFor(owner);

    const result = await listBuilderAgents(admin, {}, deps);

    expect(result.ok && result.value.agents.map((a) => a.id)).toEqual([agent.id]);
  });
});

describe('getBuilderAgent', () => {
  it('returns the editor view for EDIT, without heavy fields by default', async () => {
    const user = await createUser();
    const agent = await createAgentFor(user);
    await grant(user, agent, EDIT);

    const result = await getBuilderAgent(user, { id: agent.id }, deps);

    expect(result).toEqual({
      ok: true,
      value: {
        id: agent.id,
        name: 'Agent',
        description: 'Helps with things',
        provider: 'openai',
        model: 'gpt-4o',
        instructions_source: 'inline',
      },
    });
  });

  it('adds instructions and tools only when include names them', async () => {
    const user = await createUser();
    const agent = await createAgentFor(user);
    await grant(user, agent, EDIT);

    const instructions = await getBuilderAgent(
      user,
      { id: agent.id, include: ['instructions'] },
      deps,
    );
    const both = await getBuilderAgent(
      user,
      { id: agent.id, include: ['instructions', 'tools'] },
      deps,
    );

    expect(instructions.ok && instructions.value).toMatchObject({ instructions: 'Be brief.' });
    expect(instructions.ok && 'tools' in instructions.value).toBe(false);
    expect(both.ok && both.value).toMatchObject({
      instructions: 'Be brief.',
      tools: ['web_search'],
    });
  });

  it('returns only the summary for VIEW, whatever include says', async () => {
    const owner = await createUser();
    const viewer = await createUser();
    const agent = await createAgentFor(owner);
    await grant(viewer, agent, PermissionBits.VIEW);

    const result = await getBuilderAgent(
      viewer,
      { id: agent.id, include: ['instructions', 'tools'] },
      deps,
    );

    expect(result).toEqual({
      ok: true,
      value: { id: agent.id, name: 'Agent', description: 'Helps with things' },
    });
  });

  it('marks linked instructions and sends no instruction text', async () => {
    const user = await createUser();
    const agent = await createAgentFor(user, {
      instructions: 'stale inline copy',
      instructionsPrompt: {
        source: 'native',
        groupId: new mongoose.Types.ObjectId().toString(),
        selection: { type: 'production' },
      },
    } as Partial<IAgent>);
    await grant(user, agent, EDIT);

    const result = await getBuilderAgent(user, { id: agent.id, include: ['instructions'] }, deps);

    expect(result.ok && result.value).toMatchObject({ instructions_source: 'linked' });
    expect(result.ok && 'instructions' in result.value).toBe(false);
  });

  it('tells not_found from forbidden', async () => {
    const owner = await createUser();
    const stranger = await createUser();
    const agent = await createAgentFor(owner);

    await expect(getBuilderAgent(stranger, { id: 'agent_missing' }, deps)).resolves.toEqual({
      ok: false,
      error: { code: 'not_found' },
    });
    await expect(getBuilderAgent(stranger, { id: agent.id }, deps)).resolves.toEqual({
      ok: false,
      error: { code: 'forbidden' },
    });
  });

  it('returns the editor view through the manage-agents capability', async () => {
    const owner = await createUser();
    const admin = await createUser(SystemRoles.ADMIN);
    const agent = await createAgentFor(owner);

    const result = await getBuilderAgent(admin, { id: agent.id, include: ['tools'] }, deps);

    expect(result.ok && result.value).toMatchObject({ provider: 'openai', tools: ['web_search'] });
  });

  it('loads the agent once when it falls back from EDIT to VIEW', async () => {
    const owner = await createUser();
    const viewer = await createUser();
    const agent = await createAgentFor(owner);
    await grant(viewer, agent, PermissionBits.VIEW);
    const getAgent = jest.fn(deps.getAgent);

    await getBuilderAgent(viewer, { id: agent.id }, { ...deps, getAgent });

    expect(getAgent).toHaveBeenCalledTimes(1);
  });
});

describe('registerAgentBuilderTools', () => {
  it('registers the read tools as direct-only definitions and reports their names', () => {
    const toolRegistry: LCToolRegistry = new Map();
    const result = registerAgentBuilderTools({ toolRegistry, toolDefinitions: [] });

    expect(result.toolNames).toEqual([LIST_AGENTS_TOOL_NAME, GET_AGENT_TOOL_NAME]);
    expect(result.toolDefinitions.map((def) => def.name)).toEqual(result.toolNames);
    for (const def of result.toolDefinitions) {
      expect(def.allowed_callers).toEqual(['direct']);
      expect(toolRegistry.get(def.name)).toBe(def);
    }
  });

  it('leaves a name that another registration already took', () => {
    const existing: LCTool = { name: LIST_AGENTS_TOOL_NAME, description: 'other' };
    const result = registerAgentBuilderTools({ toolDefinitions: [existing] });

    expect(result.toolDefinitions.filter((def) => def.name === LIST_AGENTS_TOOL_NAME)).toEqual([
      existing,
    ]);
  });
});

describe('resolveAgentBuilderLimits', () => {
  it('keeps the schema defaults when the block is absent', () => {
    expect(resolveAgentBuilderLimits()).toEqual({ defaultLimit: 20, maxLimit: 50 });
    expect(resolveAgentBuilderLimits({})).toEqual({ defaultLimit: 20, maxLimit: 50 });
    expect(resolveAgentBuilderLimits({ list: { maxLimit: 10 } } as never)).toEqual({
      defaultLimit: 10,
      maxLimit: 10,
    });
  });

  it('applies the configured values to the tool schema and its description', () => {
    const config = { list: { defaultLimit: 5, maxLimit: 10 } };
    expect(resolveAgentBuilderLimits(config)).toEqual({ defaultLimit: 5, maxLimit: 10 });

    const { toolDefinitions } = registerAgentBuilderTools({ toolDefinitions: [], config });
    const list = toolDefinitions.find((def) => def.name === LIST_AGENTS_TOOL_NAME);
    const limit = (list?.parameters as { properties: Record<string, Record<string, unknown>> })
      .properties.limit;
    expect(limit.maximum).toBe(10);
    expect(limit.description).toBe('Page size, default 5.');
  });
});

describe('resolveAgentBuilderTools', () => {
  const marker = AgentCapabilities.agent_builder;
  const tools = ['web_search', marker, 'calculator'];

  function resolve({ capability = true, canUse = true }) {
    const checkCapability = jest.fn(() => capability);
    const canUseTool = jest.fn(() => canUse);
    const filter = jest.fn((tool: string) => tool !== 'calculator');
    const result = resolveAgentBuilderTools({ tools, checkCapability, canUseTool, filter });
    return { result, checkCapability, canUseTool, filter };
  }

  it('keeps the marker in order when the capability is on and the role may use it', () => {
    const { result, checkCapability, filter } = resolve({});

    expect(result).toEqual({ tools: ['web_search', marker], agentBuilderEnabled: true });
    expect(checkCapability).toHaveBeenCalledWith(marker);
    expect(filter.mock.calls.map(([tool]) => tool)).toEqual(['web_search', 'calculator']);
  });

  it('drops the marker without a role check when the capability is off', () => {
    const { result, canUseTool } = resolve({ capability: false });

    expect(result).toEqual({ tools: ['web_search'], agentBuilderEnabled: false });
    expect(canUseTool).not.toHaveBeenCalled();
  });

  it('drops the marker when the role may not use it', () => {
    const { result } = resolve({ canUse: false });

    expect(result).toEqual({ tools: ['web_search'], agentBuilderEnabled: false });
  });

  it('checks no capability for an agent without the marker or without tools', () => {
    const checkCapability = jest.fn(() => true);
    const args = { checkCapability, canUseTool: () => true, filter: () => true };

    expect(resolveAgentBuilderTools({ ...args, tools: ['web_search'] })).toEqual({
      tools: ['web_search'],
      agentBuilderEnabled: false,
    });
    expect(resolveAgentBuilderTools({ ...args, tools: undefined })).toEqual({
      tools: undefined,
      agentBuilderEnabled: false,
    });
    expect(checkCapability).not.toHaveBeenCalled();
  });
});

describe('agent_builder deferral', () => {
  function initialize(toolOptions?: Record<string, { defer_loading?: boolean }>) {
    const toolRegistry: LCToolRegistry = new Map();
    const registered = registerAgentBuilderTools({ toolRegistry, toolDefinitions: [] });
    return applyDeferredToolLoading({
      toolDefinitions: registered.toolDefinitions,
      toolRegistry,
      toolOptions,
      capabilityToolNames: new Map([[AgentCapabilities.agent_builder, registered.toolNames]]),
    });
  }

  it('defers the marker tools behind tool_search when the marker opts in', () => {
    const result = initialize({ [AgentCapabilities.agent_builder]: { defer_loading: true } });

    expect(result.hasDeferredTools).toBe(true);
    const byName = new Map(result.toolDefinitions.map((def) => [def.name, def]));
    expect(byName.get(LIST_AGENTS_TOOL_NAME)?.defer_loading).toBe(true);
    expect(byName.get(GET_AGENT_TOOL_NAME)?.defer_loading).toBe(true);
    expect(byName.has('tool_search')).toBe(true);
  });

  it('keeps the marker tools bound without the opt-in', () => {
    const result = initialize(undefined);

    expect(result.hasDeferredTools).toBe(false);
    expect(result.toolDefinitions.some((def) => def.defer_loading === true)).toBe(false);
    expect(result.toolDefinitions.some((def) => def.name === 'tool_search')).toBe(false);
  });
});

describe('agent builder runtime tools', () => {
  it('returns JSON results and only error codes to the model', async () => {
    const owner = await createUser();
    const stranger = await createUser();
    const agent = await createAgentFor(owner);

    const getTool = createAgentBuilderTool({ toolName: GET_AGENT_TOOL_NAME, user: stranger, deps });
    const output = await getTool?.invoke({ id: agent.id });

    expect(JSON.parse(String(output))).toEqual({ error: { code: 'forbidden' } });
  });

  it('maps an outage to unavailable without the error text', async () => {
    const user = await createUser();
    const failing: AgentBuilderDeps = {
      ...deps,
      findAccessibleResources: () => Promise.reject(new Error('mongo at 10.0.0.1 refused')),
    };

    const listTool = createAgentBuilderTool({
      toolName: LIST_AGENTS_TOOL_NAME,
      user,
      deps: failing,
    });
    const output = String(await listTool?.invoke({}));

    expect(JSON.parse(output)).toEqual({ error: { code: 'unavailable' } });
    expect(output).not.toContain('10.0.0.1');
  });

  describe('buildAgentBuilderTool', () => {
    const registry = (): LCToolRegistry => {
      const toolRegistry: LCToolRegistry = new Map();
      registerAgentBuilderTools({ toolRegistry, toolDefinitions: [] });
      return toolRegistry;
    };
    const roleWith = (agents: boolean) => async () =>
      ({ permissions: { AGENTS: { USE: agents } } }) as never;

    async function build(overrides: {
      toolRegistry?: LCToolRegistry;
      capability?: boolean;
      agentsUse?: boolean;
    }) {
      const user = await createUser();
      return buildAgentBuilderTool({
        toolName: LIST_AGENTS_TOOL_NAME,
        req: { user: { ...user, _id: user.id } as unknown as IUser } as ServerRequest,
        toolRegistry: 'toolRegistry' in overrides ? overrides.toolRegistry : registry(),
        capabilityEnabled: async () => overrides.capability ?? true,
        getRoleByName: roleWith(overrides.agentsUse ?? true),
        deps,
      });
    }

    it('builds the tool when it is registered, enabled and allowed', async () => {
      await expect(build({})).resolves.toMatchObject({ name: LIST_AGENTS_TOOL_NAME });
    });

    it('returns null when the run did not register the tool', async () => {
      await expect(build({ toolRegistry: new Map() })).resolves.toBeNull();
    });

    it('returns null when the capability is off', async () => {
      await expect(build({ capability: false })).resolves.toBeNull();
    });

    it('returns null when the role lacks AGENTS USE', async () => {
      await expect(build({ agentsUse: false })).resolves.toBeNull();
    });
  });

  describe('createAgentBuilderToolResolver', () => {
    function createResolver(capability = true) {
      const checkCapability = jest.fn(async () => capability);
      const resolveTool = createAgentBuilderToolResolver({
        getAgent: (filter) => deps.getAgent(filter.id),
        hasCapability: deps.hasCapability,
        checkPermission: deps.checkPermission,
        findAccessibleResources: deps.findAccessibleResources,
        getListAgentsByAccess: deps.getListAgentsByAccess,
        getRoleByName: async () => ({ permissions: { AGENTS: { USE: true } } }) as never,
        checkCapability,
      });
      return { resolveTool, checkCapability };
    }

    async function requestFor(config?: ServerRequest['config']): Promise<ServerRequest> {
      const user = await createUser();
      return { user: { ...user, _id: user.id } as unknown as IUser, config } as ServerRequest;
    }

    const registry = (): LCToolRegistry => {
      const toolRegistry: LCToolRegistry = new Map();
      registerAgentBuilderTools({ toolRegistry, toolDefinitions: [] });
      return toolRegistry;
    };

    it('returns null for a name that is not a builder tool', async () => {
      const { resolveTool } = createResolver();

      expect(resolveTool({ tool: 'web_search', req: await requestFor() })).toBeNull();
    });

    it('builds a builder tool that reads through the injected methods', async () => {
      const { resolveTool, checkCapability } = createResolver();
      const req = await requestFor();
      const owner = { id: req.user?.id ?? '', role: SystemRoles.USER };
      const agent = await createAgentFor(owner);
      await grant(owner, agent, EDIT);

      const factory = resolveTool({ tool: GET_AGENT_TOOL_NAME, req, toolRegistry: registry() });
      const built = await factory?.();
      const output = JSON.parse(String(await built?.invoke({ id: agent.id })));

      expect(checkCapability).toHaveBeenCalledWith(req, AgentCapabilities.agent_builder);
      expect(output).toMatchObject({ id: agent.id, instructions_source: 'inline' });
    });

    it('builds nothing when the capability is off or the request has no user', async () => {
      const { resolveTool } = createResolver(false);
      const factory = resolveTool({
        tool: LIST_AGENTS_TOOL_NAME,
        req: await requestFor(),
        toolRegistry: registry(),
      });
      await expect(factory?.()).resolves.toBeNull();

      const noRequest = createResolver().resolveTool({ tool: LIST_AGENTS_TOOL_NAME });
      await expect(noRequest?.()).resolves.toBeNull();
    });

    it('validates the page size against the request config', async () => {
      const { resolveTool } = createResolver();
      const req = await requestFor({
        endpoints: { agents: { agentBuilder: { list: { defaultLimit: 1, maxLimit: 2 } } } },
      } as ServerRequest['config']);

      const factory = resolveTool({ tool: LIST_AGENTS_TOOL_NAME, req, toolRegistry: registry() });
      const built = await factory?.();

      await expect(built?.invoke({ limit: 3 })).rejects.toThrow();
      await expect(built?.invoke({ limit: 2 })).resolves.toEqual(expect.any(String));
    });
  });
});
