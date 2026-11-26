import mongoose, { Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createMethods, createModels } from '@librechat/data-schemas';
import {
  ErrorTypes,
  Permissions,
  ResourceType,
  PermissionBits,
  PermissionTypes,
  InstructionsPromptErrorCode,
} from 'librechat-data-provider';
import type { AppConfig, IRole, IUser } from '@librechat/data-schemas';
import type { Request, Response } from 'express';
import type {
  UpdatedAgent,
  UpdatableAgent,
  UpdateAgentDeps,
  UpdateAgentResult,
  UpdateAgentContext,
  AgentUpdateHandlerDeps,
  AgentManagementUpdateDeps,
} from './updates';
import type { AuthorizedAgent } from './access';
import {
  updateAgent,
  toUpdatableAgent,
  createAgentUpdateHandler,
  updateAgentErrorResponse,
  createAgentManagementUpdateHandler,
} from './updates';
import { authorizeAgent, createAgentAccessMiddleware } from './access';

jest.mock('@librechat/data-schemas', () => {
  const actual = jest.requireActual('@librechat/data-schemas');
  return {
    ...actual,
    logger: { warn: jest.fn(), error: jest.fn(), debug: jest.fn(), info: jest.fn() },
  };
});

type Methods = ReturnType<typeof createMethods>;

let mongod: MongoMemoryServer;
let methods: Methods;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  createModels(mongoose);
  methods = createMethods(mongoose);
  await mongoose.connect(mongod.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

afterEach(async () => {
  await mongoose.models.Agent.deleteMany({});
});

const ownerId = new Types.ObjectId().toString();
const owner = { id: ownerId, role: 'USER', tenantId: 'tenant-a' };

async function saveAgent(fields: Record<string, unknown> = {}): Promise<UpdatableAgent> {
  const stored = await methods.createAgent({
    id: `agent_${new Types.ObjectId().toString()}`,
    name: 'Saved Agent',
    provider: 'openAI',
    model: 'gpt-5',
    author: new Types.ObjectId(ownerId),
    tools: [],
    ...fields,
  });
  return toUpdatableAgent(stored) as UpdatableAgent;
}

/** The full-document loader the side-panel PATCH route authorizes with. */
const loadFullAgent = (id: string) => methods.getAgent({ id }, {}).then(toUpdatableAgent);

async function authorize(
  agentId: string,
  getAgent: (id: string) => Promise<UpdatableAgent | null> = loadFullAgent,
): Promise<AuthorizedAgent<'EDIT', UpdatableAgent>> {
  const result = await authorizeAgent(
    { user: owner, agentId, required: 'EDIT' },
    { getAgent, hasCapability: async () => false, checkPermission: async () => true },
  );
  if (!result.ok) {
    throw new Error(`expected an authorization, got ${result.error.code}`);
  }
  return result.value;
}

function makeDeps(overrides: Partial<UpdateAgentDeps> = {}): UpdateAgentDeps {
  return {
    updateAgent: jest.fn((search, updateData, options) =>
      methods.updateAgent(search, updateData, options).then(toUpdatableAgent),
    ),
    getFiles: (filter, sort, select) =>
      methods.getFiles(
        filter,
        sort as Parameters<Methods['getFiles']>[1],
        select as Parameters<Methods['getFiles']>[2],
      ),
    pruneToolResourceFileIds: jest.fn().mockResolvedValue(0),
    replaceSubagentGraphAgentId: (subagents) => subagents,
    classifyAgentReferences: async (agentIds) => {
      const found = await methods.getAgents({ id: { $in: agentIds } });
      const foundIds = new Set(found.map((agent) => agent.id));
      return { missing: agentIds.filter((id) => !foundIds.has(id)), unauthorized: [] };
    },
    checkSubagentReferences: jest.fn().mockResolvedValue(null),
    instructionsPromptAccess: {
      validateLinkWrite: jest.fn().mockResolvedValue({ ok: true }),
      presentForEditor: jest.fn(async ({ agent }) => agent),
    },
    getCachedTools: jest.fn().mockResolvedValue({ web_search: true }),
    resolveConfigServers: jest.fn().mockResolvedValue(undefined),
    canUseMCPServers: jest.fn().mockResolvedValue(true),
    filterAuthorizedTools: jest.fn(async ({ tools }) => tools),
    attachOwnerContacts: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeContext(
  deps: UpdateAgentDeps = makeDeps(),
  config?: Partial<AppConfig>,
): UpdateAgentContext {
  return { user: owner, config: config as AppConfig | undefined, deps };
}

function expectRefusal(result: UpdateAgentResult) {
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error('expected a refusal');
  }
  return { error: result.error, response: updateAgentErrorResponse(result.error) };
}

const storedName = async (id: string) => (await methods.getAgent({ id }))?.name;

describe('updateAgent service', () => {
  it('saves the update on the authorized agent with one agent read', async () => {
    const saved = await saveAgent();
    const getAgentSpy = jest.spyOn(methods, 'getAgent');
    const getAgentWithVersionCountSpy = jest.spyOn(methods, 'getAgentWithVersionCount');
    const authorized = await authorize(saved.id);
    const deps = makeDeps();

    const result = await updateAgent(authorized, { name: 'Renamed' }, makeContext(deps));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({ id: saved.id, name: 'Renamed', author: ownerId });
    expect(result.value.version).toBe(2);
    expect(getAgentSpy).toHaveBeenCalledTimes(1);
    expect(getAgentWithVersionCountSpy).not.toHaveBeenCalled();
    expect(deps.updateAgent).toHaveBeenCalledWith(
      { id: saved.id },
      expect.objectContaining({ name: 'Renamed' }),
      { updatingUserId: ownerId, expectedMCPAccess: { names: [], updatedAt: saved.updatedAt } },
    );
    expect(deps.attachOwnerContacts).toHaveBeenCalledWith([result.value]);
    expect(deps.instructionsPromptAccess.presentForEditor).toHaveBeenCalledWith({
      user: owner,
      agent: result.value,
    });
    await expect(storedName(saved.id)).resolves.toBe('Renamed');
    getAgentSpy.mockRestore();
    getAgentWithVersionCountSpy.mockRestore();
  });

  it('hides the author from an editor who does not own the agent', async () => {
    const saved = await saveAgent({ author: new Types.ObjectId() });
    const result = await updateAgent(
      await authorize(saved.id),
      { description: 'Shared edit' },
      makeContext(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.author).toBeUndefined();
    expect(result.value.description).toBe('Shared edit');
  });

  it('returns the authorized agent without a write when the update is empty', async () => {
    const saved = await saveAgent();
    const deps = makeDeps();

    const result = await updateAgent(await authorize(saved.id), {}, makeContext(deps));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(deps.updateAgent).not.toHaveBeenCalled();
    expect(result.value).toMatchObject({ id: saved.id, name: 'Saved Agent', version: 1 });
  });

  it('reports the loaded version count when the loader omits the version history', async () => {
    const saved = await saveAgent();
    const authorized = await authorize(saved.id, (id) =>
      methods.getAgentWithVersionCount({ id }).then(toUpdatableAgent),
    );

    const result = await updateAgent(authorized, {}, makeContext());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.version).toBe(1);
    expect(result.value.versions).toBeUndefined();
  });

  it('returns invalid_request with the schema issues for a malformed payload', async () => {
    const saved = await saveAgent();
    const { error, response } = expectRefusal(
      await updateAgent(await authorize(saved.id), { tools: 'web_search' }, makeContext()),
    );

    expect(error.code).toBe('invalid_request');
    expect(response).toEqual({
      status: 400,
      body: { error: 'Invalid request data', details: expect.any(Array) },
    });
    await expect(storedName(saved.id)).resolves.toBe('Saved Agent');
  });

  it('returns code_environment_choices_exceeded above the configured machine limit', async () => {
    const saved = await saveAgent();
    const { error, response } = expectRefusal(
      await updateAgent(
        await authorize(saved.id),
        { name: 'Renamed', code_environment_ids: ['one', 'two'] },
        makeContext(makeDeps(), {
          endpoints: { agents: { statefulCodeSessions: { maxEnvironmentChoices: 1 } } },
        } as Partial<AppConfig>),
      ),
    );

    expect(error).toEqual({ code: 'code_environment_choices_exceeded', details: { maximum: 1 } });
    expect(response.status).toBe(400);
    await expect(storedName(saved.id)).resolves.toBe('Saved Agent');
  });

  it('returns the code-environment code when the deployment refuses the session scope', async () => {
    const saved = await saveAgent();
    const { error, response } = expectRefusal(
      await updateAgent(
        await authorize(saved.id),
        { stateful_code_sessions: true, stateful_code_environment: 'conversation' },
        makeContext(makeDeps(), {
          endpoints: { agents: { statefulCodeSessions: { allowedEnvironments: ['user'] } } },
        } as Partial<AppConfig>),
      ),
    );

    expect(error).toEqual({
      code: 'code_environment_not_allowed',
      details: { environment: 'conversation' },
    });
    expect(response.status).toBe(403);
  });

  it('returns content_filter_block for filtered instructions before saving', async () => {
    const saved = await saveAgent();
    const deps = makeDeps();
    const { error, response } = expectRefusal(
      await updateAgent(
        await authorize(saved.id),
        { instructions: 'Use sk-private-token for requests' },
        makeContext(deps, {
          filters: { agentInstructions: { pii: { starterPatterns: ['sk_prefix'] } } },
        } as Partial<AppConfig>),
      ),
    );

    expect(error.code).toBe('content_filter_block');
    expect(response).toEqual({
      status: 400,
      body: expect.objectContaining({ error: 'content_filter_block', field: 'instructions' }),
    });
    expect(deps.updateAgent).not.toHaveBeenCalled();
  });

  it('returns edge_agents_missing and edge_agents_forbidden with the route bodies', async () => {
    const saved = await saveAgent();
    const hidden = await saveAgent({ author: new Types.ObjectId() });
    const forbiddenDeps = makeDeps({
      classifyAgentReferences: async (agentIds) => ({
        missing: [],
        unauthorized: agentIds.filter((id) => id === hidden.id),
      }),
    });

    const missing = expectRefusal(
      await updateAgent(
        await authorize(saved.id),
        { edges: [{ from: saved.id, to: 'agent_missing', edgeType: 'handoff' }] },
        makeContext(),
      ),
    );
    const forbidden = expectRefusal(
      await updateAgent(
        await authorize(saved.id),
        { edges: [{ from: '', to: hidden.id, edgeType: 'handoff' }] },
        makeContext(forbiddenDeps),
      ),
    );

    expect(missing.error).toEqual({
      code: 'edge_agents_missing',
      details: { agent_ids: ['agent_missing'] },
    });
    expect(missing.response).toEqual({
      status: 400,
      body: {
        error: 'One or more agents referenced in edges do not exist',
        agent_ids: ['agent_missing'],
      },
    });
    expect(forbidden.error).toEqual({
      code: 'edge_agents_forbidden',
      details: { agent_ids: [hidden.id] },
    });
    expect(forbidden.response).toEqual({
      status: 403,
      body: {
        error: 'You do not have access to one or more agents referenced in edges',
        agent_ids: [hidden.id],
      },
    });
  });

  it('returns subagent codes without allowing any missing reference', async () => {
    const saved = await saveAgent();
    const checkSubagentReferences = jest
      .fn()
      .mockResolvedValueOnce({ missing: ['agent_gone'], unauthorized: [] })
      .mockResolvedValueOnce({ missing: [], unauthorized: ['agent_private'] });
    const deps = makeDeps({ checkSubagentReferences });
    const authorized = await authorize(saved.id);

    const missing = expectRefusal(await updateAgent(authorized, {}, makeContext(deps)));
    const forbidden = expectRefusal(await updateAgent(authorized, {}, makeContext(deps)));

    expect(missing.error.code).toBe('subagent_agents_missing');
    expect(missing.response.status).toBe(400);
    expect(forbidden.error.code).toBe('subagent_agents_forbidden');
    expect(forbidden.response).toEqual({
      status: 403,
      body: {
        error: 'You do not have access to one or more agents referenced in subagents',
        agent_ids: ['agent_private'],
      },
    });
    expect([...(checkSubagentReferences.mock.calls[0][1] as Set<string>)]).toEqual([]);
  });

  it('returns instructions_prompt_rejected with the linked-prompt response', async () => {
    const saved = await saveAgent();
    const deps = makeDeps({
      instructionsPromptAccess: {
        validateLinkWrite: jest.fn().mockResolvedValue({
          ok: false,
          status: 403,
          code: InstructionsPromptErrorCode.FORBIDDEN,
        }),
        presentForEditor: jest.fn(async ({ agent }) => agent),
      },
    });

    const { error, response } = expectRefusal(
      await updateAgent(
        await authorize(saved.id),
        {
          instructionsPrompt: {
            source: 'native',
            groupId: new Types.ObjectId().toString(),
            selection: { type: 'production' },
          },
        },
        makeContext(deps),
      ),
    );

    expect(error.code).toBe('instructions_prompt_rejected');
    expect(response).toEqual({
      status: 403,
      body: {
        error: 'You do not have access to the selected prompt.',
        code: InstructionsPromptErrorCode.FORBIDDEN,
      },
    });
    expect(deps.updateAgent).not.toHaveBeenCalled();
  });

  it('keeps saved MCP tools on another user’s agent when the editor lacks MCP access', async () => {
    const tool = 'lookup_mcp_pay';
    const saved = await saveAgent({
      author: new Types.ObjectId(),
      tools: [tool],
      mcpServerNames: ['pay'],
    });
    const deps = makeDeps({ canUseMCPServers: jest.fn().mockResolvedValue(false) });

    const result = await updateAgent(
      await authorize(saved.id),
      { tools: ['web_search'] },
      makeContext(deps),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.tools).toEqual(['web_search', tool]);
    expect(result.value.mcpServerNames).toEqual(['pay']);
    expect(deps.filterAuthorizedTools).not.toHaveBeenCalled();
  });

  it('throws persistence failures instead of returning a refusal', async () => {
    const saved = await saveAgent();
    const deps = makeDeps({ updateAgent: jest.fn().mockRejectedValue(new Error('db down')) });

    await expect(
      updateAgent(await authorize(saved.id), { name: 'Renamed' }, makeContext(deps)),
    ).rejects.toThrow('db down');
  });

  it('accepts only an EDIT authorization', async () => {
    const saved = await saveAgent();
    const viewOnly = await authorizeAgent(
      { user: owner, agentId: saved.id, required: 'VIEW' },
      {
        getAgent: loadFullAgent,
        hasCapability: async () => false,
        checkPermission: async () => true,
      },
    );
    if (!viewOnly.ok) {
      throw new Error('expected a VIEW authorization');
    }
    const forged = { agent: saved as UpdatableAgent };

    // @ts-expect-error A VIEW authorization does not satisfy AuthorizedAgent<'EDIT'>.
    const viewCall = () => updateAgent(viewOnly.value, {}, makeContext());
    // @ts-expect-error A plain `{ agent }` object is not an authorization.
    const forgedCall = () => updateAgent(forged, {}, makeContext());
    expect(viewCall).toEqual(expect.any(Function));
    expect(forgedCall).toEqual(expect.any(Function));
  });
});

const user = {
  id: new Types.ObjectId().toString(),
  tenantId: 'tenant-a',
  role: 'USER',
} as IUser & { role: string };
const objectId = new Types.ObjectId();
const existingAgent = {
  _id: objectId,
  id: 'agent-existing',
  name: 'Existing Agent',
  description: 'Keep this description',
  provider: 'openAI',
  model: 'gpt-5',
  version: 1,
  createdAt: new Date('2026-09-03T10:00:00.000Z'),
  updatedAt: new Date('2026-09-03T10:00:00.000Z'),
} as unknown as UpdatableAgent;
const updatedAgent = {
  ...existingAgent,
  name: 'Updated Agent',
  version: 2,
  versions: [{}, {}],
  updatedAt: new Date('2026-09-03T11:00:00.000Z'),
} as unknown as UpdatedAgent;

function updated(agent: UpdatedAgent = updatedAgent): UpdateAgentResult {
  return { ok: true, value: agent };
}

function makeRequest(overrides: Partial<Request> = {}): Request {
  return {
    user,
    params: { id: existingAgent.id },
    body: { name: updatedAgent.name },
    ...overrides,
  } as Request;
}

function makeResponse(): Response {
  const response = {} as Response;
  response.status = jest.fn(() => response);
  response.json = jest.fn(() => response);
  return response;
}

function makeManagementDeps(
  overrides: Partial<AgentManagementUpdateDeps> = {},
): AgentManagementUpdateDeps {
  return {
    getRoleByName: jest.fn().mockResolvedValue({
      permissions: {
        [PermissionTypes.AGENTS]: {
          [Permissions.USE]: true,
          [Permissions.CREATE]: true,
        },
      },
    } as IRole),
    getAgentWithVersionCount: jest.fn().mockResolvedValue(existingAgent),
    checkPermission: jest.fn().mockResolvedValue(true),
    hasCapability: jest.fn().mockResolvedValue(false),
    updateAgent: jest.fn().mockResolvedValue(updated()),
    ...overrides,
  };
}

describe('Agent Management update handler', () => {
  it('returns success for an unrelated update without truncating legacy oversized options', async () => {
    const tool_options = { ['q' + '_mcp_z'.repeat(4000)]: { approval_mode: 'ask' as const } };
    const stored = { ...existingAgent, tool_options } as unknown as UpdatedAgent;
    const deps = makeManagementDeps({
      getAgentWithVersionCount: jest.fn().mockResolvedValue(stored),
      updateAgent: jest.fn(async (_req, _authorized, input) => {
        stored.name = (input as { name: string }).name;
        return updated(stored);
      }),
    });
    const response = makeResponse();
    await createAgentManagementUpdateHandler(deps)(makeRequest(), response);
    expect(stored.name).toBe(updatedAgent.name);
    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ name: updatedAgent.name, tool_options }),
    );
    expect(stored.tool_options).toEqual(tool_options);
  });

  it('delegates a partial update and returns the management projection', async () => {
    const deps = makeManagementDeps();
    const request = makeRequest();
    const response = makeResponse();

    await createAgentManagementUpdateHandler(deps)(request, response);

    expect(deps.getAgentWithVersionCount).toHaveBeenCalledWith({
      id: existingAgent.id,
      tenantId: user.tenantId,
    });
    expect(deps.checkPermission).toHaveBeenCalledWith({
      userId: user.id,
      role: user.role,
      resourceType: ResourceType.AGENT,
      resourceId: objectId,
      requiredPermission: PermissionBits.EDIT,
    });
    expect(deps.updateAgent).toHaveBeenCalledWith(
      request,
      expect.objectContaining({ agent: existingAgent }),
      { name: 'Updated Agent' },
    );
    expect(request.body).toEqual({ name: 'Updated Agent' });
    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({
        id: existingAgent.id,
        name: 'Updated Agent',
        description: existingAgent.description,
        provider: existingAgent.provider,
        model: existingAgent.model,
        version: 2,
        createdAt: '2026-09-03T10:00:00.000Z',
        updatedAt: '2026-09-03T11:00:00.000Z',
      }),
    );
  });

  it('rejects caller-supplied ownership and tenant fields before updating', async () => {
    const deps = makeManagementDeps();
    const response = makeResponse();

    await createAgentManagementUpdateHandler(deps)(
      makeRequest({ body: { name: 'Updated Agent', tenantId: 'tenant-b', author: user.id } }),
      response,
    );

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ code: 'invalid_request' }) }),
    );
    expect(deps.updateAgent).not.toHaveBeenCalled();
  });

  it('requires the same AGENTS USE and CREATE permissions as browser updates', async () => {
    const deps = makeManagementDeps({
      getRoleByName: jest.fn().mockResolvedValue({
        permissions: {
          [PermissionTypes.AGENTS]: {
            [Permissions.USE]: true,
            [Permissions.CREATE]: false,
          },
        },
      } as never),
    });
    const response = makeResponse();

    await createAgentManagementUpdateHandler(deps)(makeRequest(), response);

    expect(response.status).toHaveBeenCalledWith(403);
    expect(deps.getAgentWithVersionCount).not.toHaveBeenCalled();
    expect(deps.updateAgent).not.toHaveBeenCalled();
  });

  it('fails closed without a tenant-bound authenticated user', async () => {
    const deps = makeManagementDeps();
    const response = makeResponse();

    await createAgentManagementUpdateHandler(deps)(
      makeRequest({ user: { ...user, tenantId: undefined } as IUser }),
      response,
    );

    expect(response.status).toHaveBeenCalledWith(403);
    expect(deps.getRoleByName).not.toHaveBeenCalled();
    expect(deps.updateAgent).not.toHaveBeenCalled();
  });

  it('does not disclose an Agent outside the authenticated tenant', async () => {
    const deps = makeManagementDeps({
      getAgentWithVersionCount: jest.fn().mockResolvedValue(null),
    });
    const response = makeResponse();

    await createAgentManagementUpdateHandler(deps)(makeRequest(), response);

    expect(response.status).toHaveBeenCalledWith(404);
    expect(response.json).toHaveBeenCalledWith({
      error: { code: 'not_found', message: 'Agent not found' },
    });
    expect(deps.checkPermission).not.toHaveBeenCalled();
    expect(deps.updateAgent).not.toHaveBeenCalled();
  });

  it('requires EDIT permission on the tenant-scoped Agent', async () => {
    const deps = makeManagementDeps({ checkPermission: jest.fn().mockResolvedValue(false) });
    const response = makeResponse();

    await createAgentManagementUpdateHandler(deps)(makeRequest(), response);

    expect(response.status).toHaveBeenCalledWith(403);
    expect(deps.updateAgent).not.toHaveBeenCalled();
  });

  it('preserves the existing manage-agents capability bypass', async () => {
    const deps = makeManagementDeps({
      hasCapability: jest.fn().mockResolvedValue(true),
      checkPermission: jest.fn().mockResolvedValue(false),
    });
    const response = makeResponse();

    await createAgentManagementUpdateHandler(deps)(makeRequest(), response);

    expect(deps.checkPermission).not.toHaveBeenCalled();
    expect(deps.updateAgent).toHaveBeenCalled();
  });

  it.each([
    [{ code: 'invalid_request' as const, details: [] }, 400, 'invalid_request'],
    [
      { code: 'edge_agents_forbidden' as const, details: { agent_ids: ['a'] } },
      403,
      'permission_denied',
    ],
    [
      { code: 'subagent_agents_missing' as const, details: { agent_ids: ['a'] } },
      400,
      'invalid_request',
    ],
  ])('maps the %o refusal to the management error contract', async (error, status, code) => {
    const deps = makeManagementDeps({
      updateAgent: jest.fn().mockResolvedValue({ ok: false, error }),
    });
    const response = makeResponse();

    await createAgentManagementUpdateHandler(deps)(makeRequest(), response);

    expect(response.status).toHaveBeenCalledWith(status);
    expect(response.json).toHaveBeenCalledWith({ error: expect.objectContaining({ code }) });
  });

  it('maps shared update conflicts to the stable management error contract', async () => {
    const deps = makeManagementDeps({
      updateAgent: jest
        .fn()
        .mockRejectedValue(Object.assign(new Error('version detail'), { statusCode: 409 })),
    });
    const response = makeResponse();

    await createAgentManagementUpdateHandler(deps)(makeRequest(), response);

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith({
      error: { code: 'invalid_request', message: 'Invalid request' },
    });
  });

  it('does not expose errors thrown by the shared update flow', async () => {
    const deps = makeManagementDeps({
      updateAgent: jest.fn().mockRejectedValue(new Error('database connection secret')),
    });
    const response = makeResponse();

    await createAgentManagementUpdateHandler(deps)(makeRequest(), response);

    expect(response.status).toHaveBeenCalledWith(500);
    expect(response.json).toHaveBeenCalledWith({
      error: { code: 'internal_error', message: 'Internal server error' },
    });
  });

  it('reads the agent once and saves through the update service', async () => {
    const saved = await saveAgent({ tenantId: user.tenantId });
    const getAgentSpy = jest.spyOn(methods, 'getAgent');
    const getAgentWithVersionCountSpy = jest.spyOn(methods, 'getAgentWithVersionCount');
    const deps = makeManagementDeps({
      getAgentWithVersionCount: (search) =>
        methods.getAgentWithVersionCount(search).then(toUpdatableAgent),
      updateAgent: (_req, authorized, input) =>
        updateAgent(authorized, input, { user, deps: makeDeps() }),
    });
    const response = makeResponse();

    await createAgentManagementUpdateHandler(deps)(
      makeRequest({ params: { id: saved.id }, body: { name: 'Managed Rename' } }),
      response,
    );

    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ id: saved.id, name: 'Managed Rename', version: 2 }),
    );
    expect(getAgentWithVersionCountSpy).toHaveBeenCalledTimes(1);
    expect(getAgentSpy).not.toHaveBeenCalled();
    await expect(storedName(saved.id)).resolves.toBe('Managed Rename');
    getAgentSpy.mockRestore();
    getAgentWithVersionCountSpy.mockRestore();
  });
});

it.each([false, true])(
  'updates project the saved graph enablement choice after commit: %s',
  async (graphsEnabled) => {
    const subagents = {
      enabled: false,
      graphsEnabled,
      shareFiles: true,
      allowSelf: false,
      agent_ids: [],
      graphs: [
        {
          type: 'review',
          name: 'Review',
          description: 'Review work',
          agent_ids: ['member'],
          edges: [],
          entry_agent_id: 'member',
          result_agent_id: 'member',
        },
      ],
    };
    const deps = makeManagementDeps({
      updateAgent: jest
        .fn()
        .mockResolvedValue(updated({ ...updatedAgent, subagents } as unknown as UpdatedAgent)),
    });
    const request = makeRequest({ body: { subagents } });
    const response = makeResponse();
    await createAgentManagementUpdateHandler(deps)(request, response);
    expect(deps.updateAgent).toHaveBeenCalledTimes(1);
    expect(request.body.subagents).toEqual(subagents);
    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.status).not.toHaveBeenCalledWith(500);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ id: existingAgent.id, subagents }),
    );
  },
);

describe('side-panel update handler', () => {
  async function runPanel(
    agentId: string,
    body: unknown,
    deps: AgentUpdateHandlerDeps = {
      updateAgent: (_req, authorized, input) => updateAgent(authorized, input, makeContext()),
    },
  ) {
    const getAgent = jest.fn(loadFullAgent);
    const middleware = createAgentAccessMiddleware(
      { requiredPermission: PermissionBits.EDIT },
      { getAgent, hasCapability: async () => false, checkPermission: async () => true },
    );
    const req = { params: { id: agentId }, user: owner, body } as unknown as Request;
    const res = makeResponse();
    await middleware(req as never, res, () => createAgentUpdateHandler(deps)(req, res));
    return { res, getAgent };
  }

  it('saves the agent the middleware loaded, with one read', async () => {
    const saved = await saveAgent();
    const { res, getAgent } = await runPanel(saved.id, { name: 'Renamed' });

    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ id: saved.id, name: 'Renamed', version: 2 }),
    );
    expect(getAgent).toHaveBeenCalledTimes(1);
  });

  it('sends the mapped body for a refusal', async () => {
    const saved = await saveAgent();
    const { res } = await runPanel(saved.id, { edges: [{ from: saved.id, to: 'agent_gone' }] });

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: 'One or more agents referenced in edges do not exist',
      agent_ids: ['agent_gone'],
    });
  });

  it('sends 404 when no EDIT authorization reached the handler', async () => {
    const res = makeResponse();
    const deps = { updateAgent: jest.fn() };

    await createAgentUpdateHandler(deps)(
      { params: { id: 'agent_x' }, body: {} } as unknown as Request,
      res,
    );

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Not Found',
      message: 'agent not found',
      type: ErrorTypes.AGENT_NOT_FOUND,
    });
    expect(deps.updateAgent).not.toHaveBeenCalled();
  });

  it('sends the approved conflict message when the agent changes before the write', async () => {
    const saved = await saveAgent();
    const deps = makeDeps({
      updateAgent: async (search, updateData, options) => {
        await mongoose.models.Agent.deleteOne({ id: saved.id });
        return methods.updateAgent(search, updateData, options).then(toUpdatableAgent);
      },
    });
    const { res } = await runPanel(
      saved.id,
      { name: 'Renamed' },
      {
        updateAgent: (_req, authorized, input) => updateAgent(authorized, input, makeContext(deps)),
      },
    );

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Agent changed during Action update; reload and try again',
    });
  });

  it('keeps thrown diagnostics out of the response', async () => {
    const saved = await saveAgent();
    const secret = 'mongodb://admin:hunter2@db.internal/agents { $where: "tenant" }';
    const thrown = Object.assign(new Error(`write failed: ${secret}`), {
      statusCode: 409,
      details: { query: secret },
    });
    const { res } = await runPanel(
      saved.id,
      { name: 'Renamed' },
      {
        updateAgent: jest.fn().mockRejectedValue(thrown),
      },
    );

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'Failed to update agent' });
    expect(JSON.stringify((res.json as jest.Mock).mock.calls)).not.toContain('hunter2');
  });
});

/** Compile-time guard: the update contract exposes no Mongoose `Document` members. */
type UpdateContractHasDocumentMembers = 'save' extends keyof UpdatableAgent | keyof UpdatedAgent
  ? true
  : false;
const updateContractHasDocumentMembers: UpdateContractHasDocumentMembers = false;

describe('toUpdatableAgent', () => {
  it('keeps the JSON body of a stored agent, version history included', async () => {
    const saved = await saveAgent({ instructions: 'Keep the order' });
    await methods.updateAgent({ id: saved.id }, { name: 'Second' }, { updatingUserId: ownerId });
    const stored = await methods.getAgent({ id: saved.id }, {});
    if (!stored) {
      throw new Error('expected the stored agent');
    }

    const record = toUpdatableAgent(stored);

    expect(updateContractHasDocumentMembers).toBe(false);
    expect(record?._id).toBe(stored._id.toString());
    expect(record?.author).toBe(ownerId);
    expect(record?.versions).toHaveLength(2);
    expect(JSON.stringify(record)).toBe(JSON.stringify(stored));
    expect(toUpdatableAgent(null)).toBeNull();
  });
});
