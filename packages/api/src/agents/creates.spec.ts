import mongoose, { Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { logger, createModels, createMethods, SystemCapabilities } from '@librechat/data-schemas';
import {
  Permissions,
  ResourceType,
  AccessRoleIds,
  PrincipalType,
  PermissionBits,
  PermissionTypes,
  InstructionsPromptErrorCode,
} from 'librechat-data-provider';
import type { AgentInstructionsPrompt } from 'librechat-data-provider';
import type { AppConfig, IRole, IUser } from '@librechat/data-schemas';
import type { Request, Response } from 'express';
import type {
  CreateAgentDeps,
  CreatedAgent,
  CreateAgentResult,
  CreateAgentContext,
  AgentManagementCreateDeps,
} from './creates';
import type { InstructionsPromptAccess } from './instructions/access';
import {
  createAgent,
  toCreatedAgent,
  sendAgentRefusal,
  createAgentErrorResponse,
  createAgentPanelCreateHandler,
  getAgentReferenceErrorResponse,
  createAgentManagementCreateHandler,
} from './creates';
import { assertModelBoundContent } from '~/middleware/modelBoundContent';
import { createInstructionsPromptAccess } from './instructions/access';
import { generateCapabilityCheck } from '~/middleware/capabilities';
import { checkAccess } from '~/middleware/access';
import { createPromptService } from '~/prompts';

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
  await methods.initializeRoles();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

afterEach(async () => {
  await Promise.all([
    mongoose.models.Agent.deleteMany({}),
    mongoose.models.AclEntry.deleteMany({}),
    mongoose.models.Prompt.deleteMany({}),
    mongoose.models.PromptGroup.deleteMany({}),
  ]);
});

const userId = new Types.ObjectId().toString();
const user = { id: userId, role: 'USER', tenantId: 'tenant-a' };
const validInput = { name: 'Created Agent', provider: 'openAI', model: 'gpt-5' };

const countAgents = () => mongoose.models.Agent.countDocuments();

/**
 * The binding of `api/server/services/Agents/instructionsPrompt.js`, built from the same
 * factories over the memory database. `getResourcePermissionsMap` composes the two
 * database methods `PermissionService.getResourcePermissionsMap` runs.
 */
function createInstructionsPromptAccessForTest(): InstructionsPromptAccess {
  const { hasCapability } = generateCapabilityCheck({
    getUserPrincipals: methods.getUserPrincipals,
    hasCapabilityForPrincipals: methods.hasCapabilityForPrincipals,
  });
  return createInstructionsPromptAccess({
    getResourcePermissionsMap: async ({ userId, role, resourceType, resourceIds }) =>
      methods.getEffectivePermissionsForResources(
        await methods.getUserPrincipals({ userId, role }),
        resourceType,
        resourceIds,
      ),
    canManagePrompts: (accessUser) => hasCapability(accessUser, SystemCapabilities.MANAGE_PROMPTS),
    promptService: createPromptService({
      db: methods,
      grantPermission: jest.fn().mockResolvedValue(undefined),
      getAppConfig: jest.fn(),
    }),
    assertAgentInstructionsContent: ({ instructions, filters }) =>
      assertModelBoundContent({ filters, agents: [{ instructions }] }),
    canUsePrompts: (accessUser) =>
      checkAccess({
        user: accessUser as IUser,
        permissionType: PermissionTypes.PROMPTS,
        permissions: [Permissions.USE],
        getRoleByName: methods.getRoleByName,
      }),
    logger,
  });
}

/**
 * The linked-prompt check is the real access module over the memory database. File
 * pruning, agent-reference classification, the subagent check and tool authorization are
 * stand-ins: their implementations live in `api/server/controllers/agents/v1.js`, which a
 * `packages/api` test cannot import. `v1.spec.js` runs their refusals through
 * `createAgentForRequest`, the production binding of this service.
 */
function makeDeps(overrides: Partial<CreateAgentDeps> = {}): CreateAgentDeps {
  return {
    createAgent: (agentData) => methods.createAgent(agentData).then(toCreatedAgent),
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
    instructionsPromptAccess: createInstructionsPromptAccessForTest(),
    getCachedTools: jest.fn().mockResolvedValue({ web_search: true }),
    resolveConfigServers: jest.fn().mockResolvedValue(undefined),
    filterAuthorizedTools: jest.fn(async ({ tools, availableTools }) =>
      tools.filter((tool) => availableTools[tool] != null),
    ),
    grantPermission: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeContext(
  deps: CreateAgentDeps = makeDeps(),
  config?: Partial<AppConfig>,
): CreateAgentContext {
  return { user, config: config as AppConfig | undefined, deps };
}

function expectRefusal(result: CreateAgentResult) {
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error('expected a refusal');
  }
  return { error: result.error, response: createAgentErrorResponse(result.error) };
}

describe('createAgent service', () => {
  it('saves the agent as the user with authorized tools and grants both owner roles', async () => {
    const deps = makeDeps();

    const result = await createAgent(
      { ...validInput, tools: ['web_search', 'unknown_tool'] },
      makeContext(deps),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.id).toMatch(/^agent_/);
    expect(result.value._id).toEqual(expect.any(String));
    expect(result.value.author).toBe(userId);
    expect(result.value.tools).toEqual(['web_search']);
    const saved = await methods.getAgent({ id: result.value.id });
    expect(saved?.tools).toEqual(['web_search']);
    expect(deps.grantPermission).toHaveBeenCalledTimes(2);
    expect(deps.grantPermission).toHaveBeenCalledWith(
      expect.objectContaining({
        principalId: userId,
        resourceType: ResourceType.AGENT,
        resourceId: result.value._id,
        accessRoleId: AccessRoleIds.AGENT_OWNER,
      }),
    );
    expect(deps.grantPermission).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceType: ResourceType.REMOTE_AGENT,
        accessRoleId: AccessRoleIds.REMOTE_AGENT_OWNER,
      }),
    );
  });

  it('keeps the saved agent when an owner grant fails', async () => {
    const deps = makeDeps({ grantPermission: jest.fn().mockRejectedValue(new Error('acl down')) });

    const result = await createAgent(validInput, makeContext(deps));

    expect(result.ok).toBe(true);
    await expect(countAgents()).resolves.toBe(1);
  });

  it('returns invalid_request with the schema issues for a malformed payload', async () => {
    const { error, response } = expectRefusal(
      await createAgent({ name: 'No provider' }, makeContext()),
    );

    expect(error.code).toBe('invalid_request');
    expect(response).toEqual({
      status: 400,
      body: { error: 'Invalid request data', details: expect.any(Array) },
    });
    await expect(countAgents()).resolves.toBe(0);
  });

  it('returns the code-environment code when the deployment refuses the session scope', async () => {
    const { error, response } = expectRefusal(
      await createAgent(
        { ...validInput, stateful_code_sessions: true, stateful_code_environment: 'conversation' },
        makeContext(makeDeps(), {
          endpoints: {
            agents: { statefulCodeSessions: { allowedEnvironments: ['user'] } },
          },
        } as Partial<AppConfig>),
      ),
    );

    expect(error).toEqual({
      code: 'code_environment_not_allowed',
      details: { environment: 'conversation' },
    });
    expect(response.status).toBe(403);
    await expect(countAgents()).resolves.toBe(0);
  });

  it('returns content_filter_block for filtered instructions before saving', async () => {
    const { error, response } = expectRefusal(
      await createAgent(
        { ...validInput, instructions: 'Use sk-private-token for requests' },
        makeContext(makeDeps(), {
          filters: { agentInstructions: { pii: { starterPatterns: ['sk_prefix'] } } },
        } as Partial<AppConfig>),
      ),
    );

    expect(error.code).toBe('content_filter_block');
    expect(response).toEqual({
      status: 400,
      body: expect.objectContaining({
        error: 'content_filter_block',
        source: 'agent_instruction',
        field: 'instructions',
      }),
    });
    await expect(countAgents()).resolves.toBe(0);
  });

  it('returns edge_agents_missing for an edge to an agent that does not exist', async () => {
    const { error, response } = expectRefusal(
      await createAgent(
        { ...validInput, edges: [{ from: '', to: 'agent_missing', edgeType: 'handoff' }] },
        makeContext(),
      ),
    );

    expect(error).toEqual({
      code: 'edge_agents_missing',
      details: { agent_ids: ['agent_missing'] },
    });
    expect(response).toEqual({
      status: 400,
      body: {
        error: 'One or more agents referenced in edges do not exist',
        agent_ids: ['agent_missing'],
      },
    });
    await expect(countAgents()).resolves.toBe(0);
  });

  it('returns edge_agents_forbidden for an edge to an agent the user cannot view', async () => {
    const hidden = await methods.createAgent({
      id: 'agent_hidden',
      name: 'Hidden',
      provider: 'openAI',
      model: 'gpt-5',
      author: new Types.ObjectId(),
    });
    const deps = makeDeps({
      classifyAgentReferences: async (agentIds) => ({
        missing: [],
        unauthorized: agentIds.filter((id) => id === hidden.id),
      }),
    });

    const { error, response } = expectRefusal(
      await createAgent(
        { ...validInput, edges: [{ from: '', to: hidden.id, edgeType: 'handoff' }] },
        makeContext(deps),
      ),
    );

    expect(error).toEqual({ code: 'edge_agents_forbidden', details: { agent_ids: [hidden.id] } });
    expect(response.status).toBe(403);
    await expect(countAgents()).resolves.toBe(1);
  });

  it('returns subagent codes and allows the new agent id as a missing reference', async () => {
    const checkSubagentReferences = jest
      .fn()
      .mockResolvedValueOnce({ missing: ['agent_gone'], unauthorized: [] })
      .mockResolvedValueOnce({ missing: [], unauthorized: ['agent_private'] });
    const deps = makeDeps({ checkSubagentReferences });

    const missing = expectRefusal(await createAgent(validInput, makeContext(deps)));
    const forbidden = expectRefusal(await createAgent(validInput, makeContext(deps)));

    expect(missing.error.code).toBe('subagent_agents_missing');
    expect(missing.response).toEqual({
      status: 400,
      body: {
        error: 'One or more agents referenced in subagents do not exist',
        agent_ids: ['agent_gone'],
      },
    });
    expect(forbidden.error.code).toBe('subagent_agents_forbidden');
    expect(forbidden.response.status).toBe(403);
    const allowedMissingIds = checkSubagentReferences.mock.calls[0][1] as Set<string>;
    expect([...allowedMissingIds]).toEqual([expect.stringMatching(/^agent_/)]);
    await expect(countAgents()).resolves.toBe(0);
  });

  describe('linked instructions prompt', () => {
    const createPromptGroup = async () => {
      const { group } = await methods.createPromptGroup({
        prompt: { prompt: 'You are a helpful assistant.', type: 'text' },
        group: { name: 'Linked Group' },
        author: new Types.ObjectId().toString(),
        authorName: 'Group Owner',
      });
      return String(group._id);
    };

    const linkTo = (groupId: string): AgentInstructionsPrompt => ({
      source: 'native',
      groupId,
      selection: { type: 'production' },
    });

    it('returns instructions_prompt_rejected for a prompt group the user cannot view', async () => {
      const groupId = await createPromptGroup();
      const deps = makeDeps();
      const validateLinkWrite = jest.spyOn(deps.instructionsPromptAccess, 'validateLinkWrite');

      const { error, response } = expectRefusal(
        await createAgent(
          { ...validInput, instructionsPrompt: linkTo(groupId) },
          makeContext(deps),
        ),
      );

      expect(validateLinkWrite).toHaveBeenCalledWith(
        expect.objectContaining({ user, previous: null, next: linkTo(groupId) }),
      );
      expect(error.code).toBe('instructions_prompt_rejected');
      expect(response).toEqual({
        status: 403,
        body: {
          error: 'You do not have access to the selected prompt.',
          code: InstructionsPromptErrorCode.FORBIDDEN,
        },
      });
      await expect(countAgents()).resolves.toBe(0);
    });

    it('returns instructions_prompt_rejected when the role lacks PROMPTS USE', async () => {
      const groupId = await createPromptGroup();
      await methods.grantPermission(
        PrincipalType.USER,
        new Types.ObjectId(userId),
        ResourceType.PROMPTGROUP,
        groupId,
        PermissionBits.VIEW,
      );
      await methods.updateAccessPermissions('USER', {
        [PermissionTypes.PROMPTS]: { [Permissions.USE]: false },
      });

      try {
        const { response } = expectRefusal(
          await createAgent({ ...validInput, instructionsPrompt: linkTo(groupId) }, makeContext()),
        );
        expect(response.status).toBe(403);
      } finally {
        await methods.updateAccessPermissions('USER', {
          [PermissionTypes.PROMPTS]: { [Permissions.USE]: true },
        });
      }
      await expect(countAgents()).resolves.toBe(0);
    });

    it('saves the link to a prompt group the user can view', async () => {
      const groupId = await createPromptGroup();
      await methods.grantPermission(
        PrincipalType.USER,
        new Types.ObjectId(userId),
        ResourceType.PROMPTGROUP,
        groupId,
        PermissionBits.VIEW,
      );

      const result = await createAgent(
        { ...validInput, instructionsPrompt: linkTo(groupId) },
        makeContext(),
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const saved = await methods.getAgent({ id: result.value.id });
      expect(saved?.instructionsPrompt).toEqual(linkTo(groupId));
    });
  });

  it('throws persistence failures instead of returning a refusal', async () => {
    const deps = makeDeps({ createAgent: jest.fn().mockRejectedValue(new Error('db down')) });

    await expect(createAgent(validInput, makeContext(deps))).rejects.toThrow('db down');
    expect(deps.grantPermission).not.toHaveBeenCalled();
  });
});

const managementUser = {
  id: new Types.ObjectId().toString(),
  tenantId: 'tenant-a',
  role: 'USER',
} as IUser;
const validBody = {
  name: 'Managed Agent',
  provider: 'openAI',
  model: 'gpt-5',
};
const createdAgent = {
  _id: new Types.ObjectId().toString(),
  id: 'agent-created',
  author: managementUser.id,
  tenantId: managementUser.tenantId,
  name: validBody.name,
  provider: validBody.provider,
  model: validBody.model,
  versions: [{}],
  createdAt: new Date('2026-09-03T10:00:00.000Z'),
  updatedAt: new Date('2026-09-03T10:00:00.000Z'),
} as unknown as CreatedAgent;

function makeRequest(overrides: Partial<Request> = {}): Request {
  return { user: managementUser, body: validBody, ...overrides } as Request;
}

function makeResponse(): Response {
  const response = {
    status: jest.fn(),
    json: jest.fn(),
  };
  response.status.mockReturnValue(response);
  response.json.mockReturnValue(response);
  return response as unknown as Response;
}

function created(agent: CreatedAgent = createdAgent): CreateAgentResult {
  return { ok: true, value: agent };
}

function makeManagementDeps(
  overrides: Partial<AgentManagementCreateDeps> = {},
): AgentManagementCreateDeps {
  return {
    getRoleByName: jest.fn().mockResolvedValue({
      permissions: {
        [PermissionTypes.AGENTS]: {
          [Permissions.USE]: true,
          [Permissions.CREATE]: true,
        },
      },
    } as unknown as IRole),
    createAgent: jest.fn().mockResolvedValue(created()),
    ...overrides,
  };
}

describe('Agent Management create handler', () => {
  it('runs the creation service with the parsed body and returns the management projection', async () => {
    const deps = makeManagementDeps();
    const request = makeRequest();
    const response = makeResponse();

    await createAgentManagementCreateHandler(deps)(request, response);

    expect(deps.createAgent).toHaveBeenCalledWith(request, { ...validBody, tools: [] });
    expect(request.user).toBe(managementUser);
    expect(response.status).toHaveBeenCalledWith(201);
    expect(response.json).toHaveBeenCalledWith({
      id: 'agent-created',
      name: 'Managed Agent',
      provider: 'openAI',
      model: 'gpt-5',
      version: 1,
      createdAt: '2026-09-03T10:00:00.000Z',
      updatedAt: '2026-09-03T10:00:00.000Z',
    });
  });

  it('rejects caller-supplied ownership fields before creation', async () => {
    const deps = makeManagementDeps();
    const response = makeResponse();

    await createAgentManagementCreateHandler(deps)(
      makeRequest({ body: { ...validBody, author: new Types.ObjectId().toString() } }),
      response,
    );

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ code: 'invalid_request' }) }),
    );
    expect(deps.createAgent).not.toHaveBeenCalled();
  });

  it('rejects a null model as invalid input before persistence', async () => {
    const deps = makeManagementDeps();
    const response = makeResponse();

    await createAgentManagementCreateHandler(deps)(
      makeRequest({ body: { ...validBody, model: null } }),
      response,
    );

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ code: 'invalid_request' }) }),
    );
    expect(deps.createAgent).not.toHaveBeenCalled();
  });

  it('requires the same AGENTS USE and CREATE permissions as browser creation', async () => {
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

    await createAgentManagementCreateHandler(deps)(makeRequest(), response);

    expect(response.status).toHaveBeenCalledWith(403);
    expect(deps.createAgent).not.toHaveBeenCalled();
  });

  it('fails closed without a tenant-bound authenticated user', async () => {
    const deps = makeManagementDeps();
    const response = makeResponse();

    await createAgentManagementCreateHandler(deps)(
      makeRequest({ user: { ...managementUser, tenantId: undefined } as IUser }),
      response,
    );

    expect(response.status).toHaveBeenCalledWith(403);
    expect(deps.getRoleByName).not.toHaveBeenCalled();
    expect(deps.createAgent).not.toHaveBeenCalled();
  });

  it.each([
    [{ code: 'edge_agents_forbidden', details: { agent_ids: ['a'] } }, 403, 'permission_denied'],
    [{ code: 'edge_agents_missing', details: { agent_ids: ['a'] } }, 400, 'invalid_request'],
    [{ code: 'code_workspace_environment_required' }, 400, 'invalid_request'],
    [
      {
        code: 'instructions_prompt_rejected',
        details: {
          status: 500,
          body: { error: 'x', code: InstructionsPromptErrorCode.VALIDATION_FAILED },
        },
      },
      500,
      'internal_error',
    ],
  ] as const)(
    'maps service refusal %j to the management error contract',
    async (error, status, code) => {
      const deps = makeManagementDeps({
        createAgent: jest.fn().mockResolvedValue({ ok: false, error }),
      });
      const response = makeResponse();

      await createAgentManagementCreateHandler(deps)(makeRequest(), response);

      expect(response.status).toHaveBeenCalledWith(status);
      expect(response.json).toHaveBeenCalledWith({
        error: expect.objectContaining({ code }),
      });
      expect(response.json).not.toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.objectContaining({ details: expect.anything() }) }),
      );
    },
  );

  it('maps a thrown conflict to invalid_request', async () => {
    const conflict = Object.assign(new Error('environment is being deleted'), { statusCode: 409 });
    const deps = makeManagementDeps({ createAgent: jest.fn().mockRejectedValue(conflict) });
    const response = makeResponse();

    await createAgentManagementCreateHandler(deps)(makeRequest(), response);

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith({
      error: expect.objectContaining({ code: 'invalid_request' }),
    });
  });

  it('does not expose errors thrown by the creation service', async () => {
    const deps = makeManagementDeps({
      createAgent: jest.fn().mockRejectedValue(new Error('database connection secret')),
    });
    const response = makeResponse();

    await createAgentManagementCreateHandler(deps)(makeRequest(), response);

    expect(response.status).toHaveBeenCalledWith(500);
    expect(response.json).toHaveBeenCalledWith({
      error: { code: 'internal_error', message: 'Internal server error' },
    });
  });

  it.each([false, true])(
    'creation projects a saved independent graph flag without returning 500: %s',
    async (graphsEnabled) => {
      const subagents = {
        enabled: false,
        graphsEnabled,
        allowSelf: false,
        shareFiles: true,
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
        createAgent: jest
          .fn()
          .mockResolvedValue(created({ ...createdAgent, subagents } as unknown as CreatedAgent)),
      });
      const request = makeRequest({ body: { ...validBody, subagents } });
      const response = makeResponse();
      await createAgentManagementCreateHandler(deps)(request, response);
      expect(deps.createAgent).toHaveBeenCalledWith(
        request,
        expect.objectContaining({ subagents }),
      );
      expect(response.status).toHaveBeenCalledWith(201);
      expect(response.status).not.toHaveBeenCalledWith(500);
      expect(response.json).toHaveBeenCalledWith(
        expect.objectContaining({ id: createdAgent.id, subagents }),
      );
    },
  );
});

describe('side-panel create handler', () => {
  const run = async (createAgentForRequest: jest.Mock) => {
    const request = makeRequest({ body: { name: 'Panel Agent' } });
    const response = makeResponse();
    await createAgentPanelCreateHandler({ createAgent: createAgentForRequest })(request, response);
    return { request, response };
  };

  it('sends 201 with the created agent', async () => {
    const createAgentForRequest = jest.fn().mockResolvedValue(created());
    const { request, response } = await run(createAgentForRequest);

    expect(createAgentForRequest).toHaveBeenCalledWith(request, { name: 'Panel Agent' });
    expect(response.status).toHaveBeenCalledWith(201);
    expect(response.json).toHaveBeenCalledWith(createdAgent);
  });

  it('sends the mapped status and body for a refusal', async () => {
    const { response } = await run(
      jest.fn().mockResolvedValue({
        ok: false,
        error: { code: 'edge_agents_forbidden', details: { agent_ids: ['agent_x'] } },
      }),
    );

    expect(response.status).toHaveBeenCalledWith(403);
    expect(response.json).toHaveBeenCalledWith({
      error: 'You do not have access to one or more agents referenced in edges',
      agent_ids: ['agent_x'],
    });
  });

  it('sends an approved conflict as 409 with its own message', async () => {
    const conflict = Object.assign(new Error('Code environment is being removed: env-a'), {
      name: 'CodeEnvironmentReferenceError',
      statusCode: 409,
    });
    const { response } = await run(jest.fn().mockRejectedValue(conflict));

    expect(response.status).toHaveBeenCalledWith(409);
    expect(response.json).toHaveBeenCalledWith({
      error: 'Code environment is being removed: env-a',
    });
  });

  it.each([
    ['an unexpected error', {}],
    ['an unapproved 409', { statusCode: 409 }],
  ])('sends %s as a generic 500 without its diagnostics', async (_label, fields) => {
    const diagnostics =
      'connection to mongodb://admin:secret@db.internal:27017 failed on { author: "u1" }';
    const { response } = await run(
      jest.fn().mockRejectedValue(Object.assign(new Error(diagnostics), fields)),
    );

    expect(response.status).toHaveBeenCalledWith(500);
    expect(response.json).toHaveBeenCalledWith({ error: 'Failed to create agent' });
    expect(JSON.stringify((response.json as jest.Mock).mock.calls)).not.toContain('mongodb');
  });
});

describe('sendAgentRefusal', () => {
  it('sends nothing and returns false for a passed check', () => {
    const response = makeResponse();

    expect(sendAgentRefusal(response, { ok: true })).toBe(false);
    expect(response.status).not.toHaveBeenCalled();
  });

  it('sends the mapped response and returns true for a refusal', () => {
    const response = makeResponse();

    expect(
      sendAgentRefusal(response, {
        ok: false,
        error: { code: 'code_environment_choices_unauthorized' },
      }),
    ).toBe(true);
    expect(response.status).toHaveBeenCalledWith(403);
  });
});

describe('getAgentReferenceErrorResponse', () => {
  it('returns null when no check ran or every reference resolves', () => {
    expect(getAgentReferenceErrorResponse('subagent', null)).toBeNull();
    expect(
      getAgentReferenceErrorResponse('subagent', { missing: [], unauthorized: [] }),
    ).toBeNull();
  });

  it('reports missing references before inaccessible ones', () => {
    expect(
      getAgentReferenceErrorResponse('subagent', {
        missing: ['agent_a'],
        unauthorized: ['agent_b'],
      }),
    ).toEqual({
      status: 400,
      body: {
        error: 'One or more agents referenced in subagents do not exist',
        agent_ids: ['agent_a'],
      },
    });
  });
});

/** Compile-time guard: the creation contract exposes no Mongoose `Document` members. */
type CreatedAgentHasDocumentMembers = 'save' extends keyof CreatedAgent ? true : false;
const createdAgentHasDocumentMembers: CreatedAgentHasDocumentMembers = false;

describe('toCreatedAgent', () => {
  it('turns stored ids into the strings they serialize as and keeps the JSON body', () => {
    const stored = {
      _id: new Types.ObjectId(),
      id: 'agent_stored',
      author: new Types.ObjectId(),
      createdAt: new Date('2026-09-03T10:00:00.000Z'),
    };

    const record = toCreatedAgent(stored);

    expect(createdAgentHasDocumentMembers).toBe(false);
    expect(record._id).toBe(stored._id.toString());
    expect(record.author).toBe(stored.author.toString());
    expect(JSON.stringify(record)).toBe(JSON.stringify(stored));
  });
});
