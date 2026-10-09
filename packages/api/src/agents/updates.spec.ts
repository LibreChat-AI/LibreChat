import { Types } from 'mongoose';
import {
  PermissionBits,
  Permissions,
  PermissionTypes,
  ResourceType,
} from 'librechat-data-provider';
import type { IRole, IUser } from '@librechat/data-schemas';
import type { Request, Response } from 'express';
import type { AgentManagementUpdateDeps } from './updates';
import { createAgentManagementUpdateHandler } from './updates';

jest.mock('@librechat/data-schemas', () => {
  const actual = jest.requireActual('@librechat/data-schemas');
  return {
    ...actual,
    logger: { warn: jest.fn(), error: jest.fn() },
  };
});

const user = {
  id: new Types.ObjectId().toString(),
  tenantId: 'tenant-a',
  role: 'USER',
} as IUser;
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
};
const updatedAgent = {
  ...existingAgent,
  name: 'Updated Agent',
  version: 2,
  versions: [{}, {}],
  updatedAt: new Date('2026-09-03T11:00:00.000Z'),
};

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

function makeDeps(overrides: Partial<AgentManagementUpdateDeps> = {}): AgentManagementUpdateDeps {
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
    updateAgent: jest.fn(async (_req: Request, res: Response) => res.json(updatedAgent)),
    ...overrides,
  };
}

describe('Agent Management update handler', () => {
  it('delegates a partial update and returns the management projection', async () => {
    const deps = makeDeps();
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
    expect(deps.updateAgent).toHaveBeenCalledWith(request, expect.anything());
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
    const deps = makeDeps();
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
    const deps = makeDeps({
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
    const deps = makeDeps();
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
    const deps = makeDeps({ getAgentWithVersionCount: jest.fn().mockResolvedValue(null) });
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
    const deps = makeDeps({ checkPermission: jest.fn().mockResolvedValue(false) });
    const response = makeResponse();

    await createAgentManagementUpdateHandler(deps)(makeRequest(), response);

    expect(response.status).toHaveBeenCalledWith(403);
    expect(deps.updateAgent).not.toHaveBeenCalled();
  });

  it('preserves the existing manage-agents capability bypass', async () => {
    const deps = makeDeps({
      hasCapability: jest.fn().mockResolvedValue(true),
      checkPermission: jest.fn().mockResolvedValue(false),
    });
    const response = makeResponse();

    await createAgentManagementUpdateHandler(deps)(makeRequest(), response);

    expect(deps.checkPermission).not.toHaveBeenCalled();
    expect(deps.updateAgent).toHaveBeenCalled();
  });

  it('maps shared update conflicts to the stable management error contract', async () => {
    const deps = makeDeps({
      updateAgent: jest.fn(async (_req: Request, res: Response) =>
        res.status(409).json({ error: 'version detail' }),
      ),
    });
    const response = makeResponse();

    await createAgentManagementUpdateHandler(deps)(makeRequest(), response);

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith({
      error: { code: 'invalid_request', message: 'Invalid request' },
    });
  });

  it('does not expose errors thrown by the shared update flow', async () => {
    const deps = makeDeps({
      updateAgent: jest.fn().mockRejectedValue(new Error('database connection secret')),
    });
    const response = makeResponse();

    await createAgentManagementUpdateHandler(deps)(makeRequest(), response);

    expect(response.status).toHaveBeenCalledWith(500);
    expect(response.json).toHaveBeenCalledWith({
      error: { code: 'internal_error', message: 'Internal server error' },
    });
  });
});
