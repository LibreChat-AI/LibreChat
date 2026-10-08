import { Types } from 'mongoose';
import { Permissions, PermissionTypes } from 'librechat-data-provider';
import type { IRole, IUser } from '@librechat/data-schemas';
import type { Request, Response } from 'express';
import {
  getMemoryAgentIdParam,
  getAgentMemoryPartitionAccess,
  createAgentMemoryPartitionMiddleware,
} from './authorization';

const user = { id: new Types.ObjectId().toString(), role: 'USER' } as IUser;
const agent = { _id: new Types.ObjectId() };

function createRequest(): Request {
  return {} as Request;
}

function createRole(canUseAgents: boolean): IRole {
  return {
    permissions: {
      [PermissionTypes.AGENTS]: {
        [Permissions.USE]: canUseAgents,
      },
    },
  } as IRole;
}

function createDependencies({
  canUseAgents = true,
  canManageAgents = false,
  canViewAgent = true,
} = {}) {
  return {
    getAgent: jest.fn().mockResolvedValue(agent),
    getRoleByName: jest.fn().mockResolvedValue(createRole(canUseAgents)),
    hasCapability: jest.fn().mockResolvedValue(canManageAgents),
    checkPermission: jest.fn().mockResolvedValue(canViewAgent),
  };
}

function createResponse(): Response {
  const response = {} as Response;
  response.status = jest.fn(() => response);
  response.json = jest.fn(() => response);
  return response;
}

describe('getAgentMemoryPartitionAccess', () => {
  it('normalizes only non-empty string partition IDs', () => {
    expect(getMemoryAgentIdParam(' agent-1 ')).toBe('agent-1');
    expect(getMemoryAgentIdParam('   ')).toBeUndefined();
    expect(getMemoryAgentIdParam(['agent-1'])).toBeUndefined();
  });

  it('starts independent agent, capability, and role reads concurrently', async () => {
    let resolveAgent!: (value: typeof agent) => void;
    const agentPromise = new Promise<typeof agent>((resolve) => {
      resolveAgent = resolve;
    });
    const dependencies = createDependencies();
    dependencies.getAgent.mockReturnValue(agentPromise);

    const accessPromise = getAgentMemoryPartitionAccess({
      req: createRequest(),
      user,
      agentId: 'agent-1',
      ...dependencies,
    });

    expect(dependencies.getAgent).toHaveBeenCalledTimes(1);
    expect(dependencies.getAgent).toHaveBeenCalledWith({ id: 'agent-1' }, { _id: 1 });
    expect(dependencies.hasCapability).toHaveBeenCalledTimes(1);
    expect(dependencies.getRoleByName).toHaveBeenCalledTimes(1);

    resolveAgent(agent);
    await expect(accessPromise).resolves.toBe('allowed');
  });

  it('denies access when the role cannot use agents', async () => {
    const dependencies = createDependencies({ canUseAgents: false });

    await expect(
      getAgentMemoryPartitionAccess({
        req: createRequest(),
        user,
        agentId: 'agent-1',
        ...dependencies,
      }),
    ).resolves.toBe('denied');
    expect(dependencies.checkPermission).not.toHaveBeenCalled();
  });

  it('allows agent managers without consulting the resource ACL', async () => {
    const dependencies = createDependencies({ canManageAgents: true, canViewAgent: false });

    await expect(
      getAgentMemoryPartitionAccess({
        req: createRequest(),
        user,
        agentId: 'agent-1',
        ...dependencies,
      }),
    ).resolves.toBe('allowed');
    expect(dependencies.checkPermission).not.toHaveBeenCalled();
  });

  it('uses the agent VIEW ACL for non-managers', async () => {
    const dependencies = createDependencies({ canViewAgent: false });

    await expect(
      getAgentMemoryPartitionAccess({
        req: createRequest(),
        user,
        agentId: 'agent-1',
        ...dependencies,
      }),
    ).resolves.toBe('denied');
    expect(dependencies.checkPermission).toHaveBeenCalledWith(
      expect.objectContaining({ resourceId: agent._id }),
    );
  });

  it('reports a missing agent without consulting its resource ACL', async () => {
    const dependencies = createDependencies();
    dependencies.getAgent.mockResolvedValue(null);

    await expect(
      getAgentMemoryPartitionAccess({
        req: createRequest(),
        user,
        agentId: 'missing-agent',
        ...dependencies,
      }),
    ).resolves.toBe('not_found');
    expect(dependencies.checkPermission).not.toHaveBeenCalled();
  });

  it('does not disclose missing agents when the role cannot use agents', async () => {
    const dependencies = createDependencies({ canUseAgents: false });
    dependencies.getAgent.mockResolvedValue(null);

    await expect(
      getAgentMemoryPartitionAccess({
        req: createRequest(),
        user,
        agentId: 'missing-agent',
        ...dependencies,
      }),
    ).resolves.toBe('denied');
    expect(dependencies.checkPermission).not.toHaveBeenCalled();
  });

  it('allows deletion middleware to clean up a missing agent partition', async () => {
    const dependencies = createDependencies({ canUseAgents: false });
    dependencies.getAgent.mockResolvedValue(null);
    const middleware = createAgentMemoryPartitionMiddleware({
      source: 'query',
      allowMissingAgent: true,
      ...dependencies,
    });
    const request = { user, query: { agentId: 'missing-agent' } } as unknown as Request;
    const response = createResponse();
    const next = jest.fn();

    await middleware(request, response, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(response.status).not.toHaveBeenCalled();
  });

  it('returns forbidden before mutation middleware proceeds when agent use is disabled', async () => {
    const dependencies = createDependencies({ canUseAgents: false });
    const middleware = createAgentMemoryPartitionMiddleware({
      source: 'body',
      ...dependencies,
    });
    const request = { user, body: { agentId: 'agent-1' } } as unknown as Request;
    const response = createResponse();
    const next = jest.fn();

    await middleware(request, response, next);

    expect(next).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(403);
    expect(response.json).toHaveBeenCalledWith({ error: 'Agent access denied.' });
  });
});
