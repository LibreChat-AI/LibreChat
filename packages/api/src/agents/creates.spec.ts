import { Types } from 'mongoose';
import { Permissions, PermissionTypes } from 'librechat-data-provider';
import type { IRole, IUser } from '@librechat/data-schemas';
import type { Request, Response } from 'express';
import type { AgentManagementCreateDeps } from './creates';
import { createAgentManagementCreateHandler } from './creates';

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
const validBody = {
  name: 'Managed Agent',
  provider: 'openAI',
  model: 'gpt-5',
};
const createdAgent = {
  _id: new Types.ObjectId(),
  id: 'agent-created',
  author: new Types.ObjectId(user.id),
  tenantId: user.tenantId,
  name: validBody.name,
  provider: validBody.provider,
  model: validBody.model,
  versions: [{}],
  createdAt: new Date('2026-09-03T10:00:00.000Z'),
  updatedAt: new Date('2026-09-03T10:00:00.000Z'),
};

function makeRequest(overrides: Partial<Request> = {}): Request {
  return { user, body: validBody, ...overrides } as Request;
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

function makeDeps(overrides: Partial<AgentManagementCreateDeps> = {}): AgentManagementCreateDeps {
  return {
    getRoleByName: jest.fn().mockResolvedValue({
      permissions: {
        [PermissionTypes.AGENTS]: {
          [Permissions.USE]: true,
          [Permissions.CREATE]: true,
        },
      },
    } as unknown as IRole),
    createAgent: jest.fn(async (_req: Request, res: Response) =>
      res.status(201).json(createdAgent),
    ),
    ...overrides,
  };
}

describe('Agent Management create handler', () => {
  it('delegates creation with the authenticated user and returns the management projection', async () => {
    const deps = makeDeps();
    const request = makeRequest();
    const response = makeResponse();

    await createAgentManagementCreateHandler(deps)(request, response);

    expect(deps.createAgent).toHaveBeenCalledWith(request, expect.anything());
    expect(request.user).toBe(user);
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
    const deps = makeDeps();
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
    const deps = makeDeps();
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

    await createAgentManagementCreateHandler(deps)(makeRequest(), response);

    expect(response.status).toHaveBeenCalledWith(403);
    expect(deps.createAgent).not.toHaveBeenCalled();
  });

  it('fails closed without a tenant-bound authenticated user', async () => {
    const deps = makeDeps();
    const response = makeResponse();

    await createAgentManagementCreateHandler(deps)(
      makeRequest({ user: { ...user, tenantId: undefined } as IUser }),
      response,
    );

    expect(response.status).toHaveBeenCalledWith(403);
    expect(deps.getRoleByName).not.toHaveBeenCalled();
    expect(deps.createAgent).not.toHaveBeenCalled();
  });

  it('maps policy failures from the shared creation flow to the management error contract', async () => {
    const deps = makeDeps({
      createAgent: jest.fn(async (_req: Request, res: Response) =>
        res.status(403).json({ error: 'policy detail' }),
      ),
    });
    const response = makeResponse();

    await createAgentManagementCreateHandler(deps)(makeRequest(), response);

    expect(response.status).toHaveBeenCalledWith(403);
    expect(response.json).toHaveBeenCalledWith({
      error: { code: 'permission_denied', message: 'Permission denied' },
    });
  });

  it('does not expose errors thrown by the shared creation flow', async () => {
    const deps = makeDeps({
      createAgent: jest.fn().mockRejectedValue(new Error('database connection secret')),
    });
    const response = makeResponse();

    await createAgentManagementCreateHandler(deps)(makeRequest(), response);

    expect(response.status).toHaveBeenCalledWith(500);
    expect(response.json).toHaveBeenCalledWith({
      error: { code: 'internal_error', message: 'Internal server error' },
    });
  });
});
