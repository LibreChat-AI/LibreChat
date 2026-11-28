import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createModels, createMethods } from '@librechat/data-schemas';
import {
  ErrorTypes,
  PermissionBits,
  PrincipalModel,
  PrincipalType,
  ResourceType,
  SystemRoles,
} from 'librechat-data-provider';
import type { AllMethods, IAgent, IUser } from '@librechat/data-schemas';
import type { NextFunction, Response } from 'express';
import type { Types } from 'mongoose';
import type {
  AgentAccessError,
  AgentAccessRequest,
  AuthorizedAgent,
  AuthorizeAgentDeps,
} from './access';
import {
  authorizeAgent,
  createAgentAccessMiddleware,
  getRequestAgentAuthorization,
} from './access';
import { generateCapabilityCheck } from '~/middleware/capabilities';
import { AccessControlService } from '~/acl/accessControlService';

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: { error: jest.fn(), warn: jest.fn(), debug: jest.fn(), info: jest.fn() },
}));

type AgentRecord = IAgent & { _id: Types.ObjectId };

let mongoServer: MongoMemoryServer;
let methods: AllMethods;
let deps: AuthorizeAgentDeps<AgentRecord, IUser>;

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
    getAgent: async (agentId) => (await methods.getAgent({ id: agentId })) as AgentRecord | null,
    hasCapability: (user, capability) =>
      hasCapability({ id: user.id, role: user.role ?? '', tenantId: user.tenantId }, capability),
    checkPermission: (params) => acl.checkPermission(params),
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

async function createUser(role: string = SystemRoles.USER): Promise<IUser> {
  const user = await mongoose.models.User.create({
    name: 'User',
    email: `${new mongoose.Types.ObjectId().toString()}@test.com`,
    password: 'password123',
    provider: 'local',
    role,
  });
  return { ...user.toObject(), id: user._id.toString() } as IUser;
}

async function createAgentFor(author: IUser): Promise<AgentRecord> {
  return (await methods.createAgent({
    id: `agent_${new mongoose.Types.ObjectId().toString()}`,
    name: 'Agent',
    provider: 'openai',
    model: 'gpt-4o',
    author: author._id,
  })) as AgentRecord;
}

async function grant(user: IUser, agent: AgentRecord, permBits: number) {
  await mongoose.models.AclEntry.create({
    principalType: PrincipalType.USER,
    principalId: user._id,
    principalModel: PrincipalModel.USER,
    resourceType: ResourceType.AGENT,
    resourceId: agent._id,
    permBits,
    grantedBy: user._id,
  });
}

describe('authorizeAgent', () => {
  it('returns the loaded agent when the ACL grants the required level', async () => {
    const user = await createUser();
    const agent = await createAgentFor(user);
    await grant(user, agent, PermissionBits.VIEW | PermissionBits.EDIT);

    const result = await authorizeAgent({ user, agentId: agent.id, required: 'EDIT' }, deps);

    expect(result.ok).toBe(true);
    expect(result.ok && result.value.agent.id).toBe(agent.id);
    expect(result.ok && result.value.agent._id.toString()).toBe(agent._id.toString());
  });

  it('grants VIEW but forbids EDIT for a VIEW-only share', async () => {
    const owner = await createUser();
    const viewer = await createUser();
    const agent = await createAgentFor(owner);
    await grant(viewer, agent, PermissionBits.VIEW);

    const view = await authorizeAgent({ user: viewer, agentId: agent.id, required: 'VIEW' }, deps);
    const edit = await authorizeAgent({ user: viewer, agentId: agent.id, required: 'EDIT' }, deps);

    expect(view.ok).toBe(true);
    expect(edit).toEqual({ ok: false, error: { code: 'forbidden' } });
  });

  it('requires every listed level', async () => {
    const owner = await createUser();
    const viewer = await createUser();
    const agent = await createAgentFor(owner);
    await grant(viewer, agent, PermissionBits.VIEW);

    const result = await authorizeAgent(
      { user: viewer, agentId: agent.id, required: ['VIEW', 'EDIT'] },
      deps,
    );

    expect(result).toEqual({ ok: false, error: { code: 'forbidden' } });
  });

  it('forbids a user without an ACL entry on an existing agent', async () => {
    const owner = await createUser();
    const stranger = await createUser();
    const agent = await createAgentFor(owner);

    const result = await authorizeAgent(
      { user: stranger, agentId: agent.id, required: 'VIEW' },
      deps,
    );

    expect(result).toEqual({ ok: false, error: { code: 'forbidden' } });
  });

  it('returns not_found for a missing agent, before any ACL check', async () => {
    const user = await createUser();
    const checkPermission = jest.fn(deps.checkPermission);

    const result = await authorizeAgent(
      { user, agentId: 'agent_missing', required: 'VIEW' },
      { ...deps, checkPermission },
    );

    expect(result).toEqual({ ok: false, error: { code: 'not_found', canManageAll: false } });
    expect(checkPermission).not.toHaveBeenCalled();
  });

  it('returns not_found for a missing agent even with the manage-agents capability', async () => {
    const admin = await createUser(SystemRoles.ADMIN);

    const result = await authorizeAgent(
      { user: admin, agentId: 'agent_missing', required: 'EDIT' },
      deps,
    );

    expect(result).toEqual({ ok: false, error: { code: 'not_found', canManageAll: true } });
  });

  it('grants every level through the admin manage-agents capability without an ACL check', async () => {
    const owner = await createUser();
    const admin = await createUser(SystemRoles.ADMIN);
    const agent = await createAgentFor(owner);
    const checkPermission = jest.fn(deps.checkPermission);

    for (const required of ['VIEW', 'EDIT', 'DELETE', 'SHARE'] as const) {
      const result = await authorizeAgent(
        { user: admin, agentId: agent.id, required },
        { ...deps, checkPermission },
      );
      expect(result.ok && result.value.agent.id).toBe(agent.id);
    }
    expect(checkPermission).not.toHaveBeenCalled();
  });

  it('falls back to the ACL when the capability lookup fails', async () => {
    const owner = await createUser();
    const viewer = await createUser();
    const agent = await createAgentFor(owner);
    await grant(viewer, agent, PermissionBits.VIEW);
    const failing = { ...deps, hasCapability: () => Promise.reject(new Error('lookup failed')) };

    const view = await authorizeAgent(
      { user: viewer, agentId: agent.id, required: 'VIEW' },
      failing,
    );
    const edit = await authorizeAgent(
      { user: viewer, agentId: agent.id, required: 'EDIT' },
      failing,
    );

    expect(view.ok).toBe(true);
    expect(edit).toEqual({ ok: false, error: { code: 'forbidden' } });
  });

  it('authorizes a single-tenant user, who has no tenantId', async () => {
    const user = await createUser();
    const agent = await createAgentFor(user);
    await grant(user, agent, PermissionBits.EDIT);

    expect(user.tenantId).toBeUndefined();
    const result = await authorizeAgent({ user, agentId: agent.id, required: 'EDIT' }, deps);

    expect(result.ok).toBe(true);
  });

  it('throws when the agent load fails', async () => {
    const user = await createUser();
    const outage = {
      ...deps,
      getAgent: (): Promise<AgentRecord | null> => Promise.reject(new Error('db down')),
    };

    await expect(
      authorizeAgent({ user, agentId: 'agent_any', required: 'VIEW' }, outage),
    ).rejects.toThrow('db down');
  });

  it('brands the result by level', async () => {
    const user = await createUser();
    const agent = await createAgentFor(user);
    await grant(user, agent, PermissionBits.VIEW | PermissionBits.EDIT);
    const acceptsEdit = (authorized: AuthorizedAgent<'EDIT', AgentRecord>) => authorized.agent.id;

    const view = await authorizeAgent({ user, agentId: agent.id, required: 'VIEW' }, deps);
    const both = await authorizeAgent(
      { user, agentId: agent.id, required: ['VIEW', 'EDIT'] },
      deps,
    );
    if (!view.ok || !both.ok) {
      throw new Error('expected both authorizations to succeed');
    }

    // @ts-expect-error A plain object is not an authorization.
    expect(() => acceptsEdit({ agent })).not.toThrow();
    // @ts-expect-error A VIEW authorization does not satisfy EDIT.
    expect(acceptsEdit(view.value)).toBe(agent.id);
    expect(acceptsEdit(both.value)).toBe(agent.id);
  });

  it('reports the manage-agents capability only on not_found', () => {
    const notFound: AgentAccessError = { code: 'not_found', canManageAll: true };
    // @ts-expect-error A forbidden failure does not carry canManageAll.
    const forbidden: AgentAccessError = { code: 'forbidden', canManageAll: true };
    expect(notFound.code).toBe('not_found');
    expect(forbidden.code).toBe('forbidden');
  });
});

describe('createAgentAccessMiddleware', () => {
  function makeResponse() {
    const res = { status: jest.fn(), json: jest.fn() };
    res.status.mockReturnValue(res);
    return res as typeof res & Response;
  }

  it('rejects permission bits that are not agent levels', () => {
    expect(() => createAgentAccessMiddleware({ requiredPermission: 16 }, deps)).toThrow(
      'canAccessAgentResource: requiredPermission must combine VIEW, EDIT, DELETE or SHARE bits',
    );
  });

  it('records the agent on the request for an admin', async () => {
    const owner = await createUser();
    const admin = await createUser(SystemRoles.ADMIN);
    const agent = await createAgentFor(owner);
    const middleware = createAgentAccessMiddleware(
      { requiredPermission: PermissionBits.EDIT, resourceIdParam: 'agent_id' },
      deps,
    );
    const req = {
      params: { agent_id: agent.id },
      user: admin,
    } as unknown as AgentAccessRequest<AgentRecord>;
    const res = makeResponse();
    const next: NextFunction = jest.fn();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
    expect(req.resourceAccess?.resourceInfo.id).toBe(agent.id);
  });

  it('loads through getAgentWithVersions when the route asks for versions', async () => {
    const owner = await createUser();
    const agent = await createAgentFor(owner);
    await grant(owner, agent, PermissionBits.VIEW | PermissionBits.EDIT);
    const getAgent = jest.fn(deps.getAgent);
    const getAgentWithVersions = jest.fn(deps.getAgent);
    const middleware = createAgentAccessMiddleware(
      { requiredPermission: PermissionBits.EDIT, includeVersions: true },
      { ...deps, getAgent, getAgentWithVersions },
    );
    const req = {
      params: { id: agent.id },
      user: owner,
    } as unknown as AgentAccessRequest<AgentRecord>;
    const next = jest.fn();

    await middleware(req, makeResponse(), next);

    expect(next).toHaveBeenCalled();
    expect(getAgentWithVersions).toHaveBeenCalledWith(agent.id);
    expect(getAgent).not.toHaveBeenCalled();
    expect(() =>
      createAgentAccessMiddleware(
        { requiredPermission: PermissionBits.EDIT, includeVersions: true },
        deps,
      ),
    ).toThrow('includeVersions requires getAgentWithVersions');
  });

  it('exposes the authorization it granted, for the levels it checked', async () => {
    const owner = await createUser();
    const agent = await createAgentFor(owner);
    await grant(owner, agent, PermissionBits.VIEW | PermissionBits.EDIT);
    const getAgent = jest.fn(deps.getAgent);
    const middleware = createAgentAccessMiddleware(
      { requiredPermission: PermissionBits.EDIT },
      { ...deps, getAgent },
    );
    const req = {
      params: { id: agent.id },
      user: owner,
    } as unknown as AgentAccessRequest<AgentRecord>;

    expect(getRequestAgentAuthorization(req, 'EDIT')).toBeNull();
    await middleware(req, makeResponse(), jest.fn());

    const authorized = getRequestAgentAuthorization<'EDIT', AgentRecord>(req, 'EDIT');
    expect(authorized?.agent.id).toBe(agent.id);
    expect(authorized?.agent).toBe(req.resourceAccess?.resourceInfo);
    expect(getRequestAgentAuthorization(req, 'VIEW')).toBeNull();
    expect(getRequestAgentAuthorization(req, ['EDIT', 'DELETE'])).toBeNull();
    expect(getRequestAgentAuthorization({}, 'EDIT')).toBeNull();
    expect(getAgent).toHaveBeenCalledTimes(1);
  });

  it('passes a manage-agents user on a missing agent to the route handler', async () => {
    const admin = await createUser(SystemRoles.ADMIN);
    const middleware = createAgentAccessMiddleware({ requiredPermission: 1 }, deps);
    const req = {
      params: { id: 'agent_missing' },
      user: admin,
    } as unknown as AgentAccessRequest<AgentRecord>;
    const res = makeResponse();
    const next: NextFunction = jest.fn();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
    expect(req.resourceAccess).toBeUndefined();
    expect(getRequestAgentAuthorization(req, 'VIEW')).toBeNull();
  });

  it('sends the existing 404 body for a missing agent without the capability', async () => {
    const user = await createUser();
    const middleware = createAgentAccessMiddleware({ requiredPermission: 1 }, deps);
    const req = {
      params: { id: 'agent_missing' },
      user,
    } as unknown as AgentAccessRequest<AgentRecord>;
    const res = makeResponse();
    const next: NextFunction = jest.fn();

    await middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Not Found',
      message: 'agent not found',
      type: ErrorTypes.AGENT_NOT_FOUND,
    });
  });

  it('sends the existing 403 body when the ACL denies access', async () => {
    const owner = await createUser();
    const stranger = await createUser();
    const agent = await createAgentFor(owner);
    const middleware = createAgentAccessMiddleware({ requiredPermission: 1 }, deps);
    const req = {
      params: { id: agent.id },
      user: stranger,
    } as unknown as AgentAccessRequest<AgentRecord>;
    const res = makeResponse();

    await middleware(req, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Forbidden',
      message: 'Insufficient permissions to access this agent',
      type: ErrorTypes.AGENT_ACCESS,
    });
  });

  it('sends a generic 500 without the error text when the agent load fails', async () => {
    const user = await createUser();
    const middleware = createAgentAccessMiddleware(
      { requiredPermission: 1 },
      {
        ...deps,
        getAgent: (): Promise<AgentRecord | null> =>
          Promise.reject(new Error('secret connection string')),
      },
    );
    const req = { params: { id: 'agent_any' }, user } as unknown as AgentAccessRequest<AgentRecord>;
    const res = makeResponse();

    await middleware(req, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Internal Server Error',
      message: 'Failed to check resource access permissions',
    });
  });

  it('sends the generic 500 to a manage-agents user when the agent load fails', async () => {
    const admin = await createUser(SystemRoles.ADMIN);
    const middleware = createAgentAccessMiddleware(
      { requiredPermission: 1 },
      {
        ...deps,
        getAgent: (): Promise<AgentRecord | null> =>
          Promise.reject(new Error('secret connection string')),
      },
    );
    const req = {
      params: { id: 'agent_any' },
      user: admin,
    } as unknown as AgentAccessRequest<AgentRecord>;
    const res = makeResponse();
    const next: NextFunction = jest.fn();

    await middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Internal Server Error',
      message: 'Failed to check resource access permissions',
    });
  });
});
