import { Types } from 'mongoose';
import {
  EToolResources,
  PermissionBits,
  Permissions,
  PermissionTypes,
  ResourceType,
} from 'librechat-data-provider';
import type { IAgent, IRole, IUser } from '@librechat/data-schemas';
import type { Request, Response } from 'express';
import type { AgentManagementDeleteDeps } from './deletion';
import { cascadeDeleteAgentResources, createAgentManagementDeleteHandler } from './deletion';

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
  provider: 'openAI',
  model: 'gpt-5',
};

function makeRequest(overrides: Partial<Request> = {}): Request {
  return {
    user,
    params: { id: existingAgent.id },
    ...overrides,
  } as Request;
}

function makeResponse(): Response {
  const response = {} as Response;
  response.status = jest.fn(() => response);
  response.json = jest.fn(() => response);
  return response;
}

function makeDeps(overrides: Partial<AgentManagementDeleteDeps> = {}): AgentManagementDeleteDeps {
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
    deleteAgent: jest.fn().mockResolvedValue(existingAgent as IAgent),
    getFiles: jest.fn().mockResolvedValue([]),
    getSharedResourceFileIds: jest.fn().mockResolvedValue([]),
    deleteFiles: jest.fn().mockResolvedValue({ deletedFileIds: [], failedFileIds: [] }),
    ...overrides,
  };
}

describe('Agent Management delete handler', () => {
  it('deletes the tenant-scoped Agent and returns a minimal tombstone', async () => {
    const deps = makeDeps();
    const response = makeResponse();

    await createAgentManagementDeleteHandler(deps)(makeRequest(), response);

    expect(deps.getAgentWithVersionCount).toHaveBeenCalledWith({
      id: existingAgent.id,
      tenantId: user.tenantId,
    });
    expect(deps.checkPermission).toHaveBeenCalledWith({
      userId: user.id,
      role: user.role,
      resourceType: ResourceType.AGENT,
      resourceId: objectId,
      requiredPermission: PermissionBits.DELETE,
    });
    expect(deps.deleteAgent).toHaveBeenCalledWith({
      id: existingAgent.id,
      tenantId: user.tenantId,
    });
    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.json).toHaveBeenCalledWith({ id: existingAgent.id, deleted: true });
  });

  it('requires the same AGENTS USE and CREATE permissions as browser deletion', async () => {
    const deps = makeDeps({
      getRoleByName: jest.fn().mockResolvedValue({
        permissions: {
          [PermissionTypes.AGENTS]: {
            [Permissions.USE]: true,
            [Permissions.CREATE]: false,
          },
        },
      } as IRole),
    });
    const response = makeResponse();

    await createAgentManagementDeleteHandler(deps)(makeRequest(), response);

    expect(response.status).toHaveBeenCalledWith(403);
    expect(deps.getAgentWithVersionCount).not.toHaveBeenCalled();
    expect(deps.deleteAgent).not.toHaveBeenCalled();
  });

  it('fails closed without a tenant-bound authenticated user', async () => {
    const deps = makeDeps();
    const response = makeResponse();

    await createAgentManagementDeleteHandler(deps)(
      makeRequest({ user: { ...user, tenantId: undefined } as IUser }),
      response,
    );

    expect(response.status).toHaveBeenCalledWith(403);
    expect(deps.getRoleByName).not.toHaveBeenCalled();
    expect(deps.deleteAgent).not.toHaveBeenCalled();
  });

  it('does not disclose or delete an Agent outside the authenticated tenant', async () => {
    const deps = makeDeps({ getAgentWithVersionCount: jest.fn().mockResolvedValue(null) });
    const response = makeResponse();

    await createAgentManagementDeleteHandler(deps)(makeRequest(), response);

    expect(response.status).toHaveBeenCalledWith(404);
    expect(deps.checkPermission).not.toHaveBeenCalled();
    expect(deps.deleteAgent).not.toHaveBeenCalled();
  });

  it('requires DELETE permission on the tenant-scoped Agent', async () => {
    const deps = makeDeps({ checkPermission: jest.fn().mockResolvedValue(false) });
    const response = makeResponse();

    await createAgentManagementDeleteHandler(deps)(makeRequest(), response);

    expect(response.status).toHaveBeenCalledWith(403);
    expect(deps.deleteAgent).not.toHaveBeenCalled();
  });

  it('preserves the existing manage-agents capability bypass', async () => {
    const deps = makeDeps({
      hasCapability: jest.fn().mockResolvedValue(true),
      checkPermission: jest.fn().mockResolvedValue(false),
    });
    const response = makeResponse();

    await createAgentManagementDeleteHandler(deps)(makeRequest(), response);

    expect(deps.checkPermission).not.toHaveBeenCalled();
    expect(deps.deleteAgent).toHaveBeenCalled();
  });

  it('returns not found if the Agent disappears before the atomic delete', async () => {
    const deps = makeDeps({ deleteAgent: jest.fn().mockResolvedValue(null) });
    const response = makeResponse();

    await createAgentManagementDeleteHandler(deps)(makeRequest(), response);

    expect(response.status).toHaveBeenCalledWith(404);
    expect(response.json).toHaveBeenCalledWith({
      error: { code: 'not_found', message: 'Agent not found' },
    });
  });

  it('does not expose errors thrown by the shared deletion path', async () => {
    const deps = makeDeps({
      deleteAgent: jest.fn().mockRejectedValue(new Error('database connection secret')),
    });
    const response = makeResponse();

    await createAgentManagementDeleteHandler(deps)(makeRequest(), response);

    expect(response.status).toHaveBeenCalledWith(500);
    expect(response.json).toHaveBeenCalledWith({
      error: { code: 'internal_error', message: 'Internal server error' },
    });
  });

  it('destroys sole-referenced tool-resource files before deleting the Agent', async () => {
    const owned = { file_id: 'owned' };
    const shared = { file_id: 'shared' };
    const order: string[] = [];
    const deps = makeDeps({
      getAgentWithVersionCount: jest.fn().mockResolvedValue({
        ...existingAgent,
        tool_resources: {
          [EToolResources.file_search]: { file_ids: ['owned', 'shared'] },
        },
      }),
      getFiles: jest.fn().mockResolvedValue([owned, shared]),
      getSharedResourceFileIds: jest.fn().mockResolvedValue(['shared']),
      deleteFiles: jest.fn().mockImplementation(async (_req, files) => {
        order.push('files');
        return {
          deletedFileIds: files.map((file: { file_id: string }) => file.file_id),
          failedFileIds: [],
        };
      }),
      deleteAgent: jest.fn().mockImplementation(async () => {
        order.push('agent');
        return existingAgent as IAgent;
      }),
    });
    const response = makeResponse();

    await createAgentManagementDeleteHandler(deps)(makeRequest(), response);

    expect(deps.deleteFiles).toHaveBeenCalledWith(expect.anything(), [owned]);
    expect(order).toEqual(['files', 'agent']);
    expect(response.status).toHaveBeenCalledWith(200);
  });

  it('still deletes the Agent when attached-file cleanup fails', async () => {
    const deps = makeDeps({
      getAgentWithVersionCount: jest.fn().mockResolvedValue({
        ...existingAgent,
        tool_resources: {
          [EToolResources.context]: { file_ids: ['owned'] },
        },
      }),
      getFiles: jest.fn().mockResolvedValue([{ file_id: 'owned' }]),
      deleteFiles: jest.fn().mockRejectedValue(new Error('storage unavailable')),
    });
    const response = makeResponse();

    await createAgentManagementDeleteHandler(deps)(makeRequest(), response);

    expect(deps.deleteAgent).toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(200);
  });
});

describe('cascadeDeleteAgentResources', () => {
  it('deletes the avatar after tool-resource files', async () => {
    const order: string[] = [];
    await cascadeDeleteAgentResources(
      {
        agentObjectId: objectId.toString(),
        tool_resources: { [EToolResources.execute_code]: { file_ids: ['code-file'] } },
        avatar: { filepath: '/avatars/a.png', source: 'local' },
      },
      {
        getFiles: jest.fn().mockResolvedValue([{ file_id: 'code-file' }]),
        getSharedResourceFileIds: jest.fn().mockResolvedValue([]),
        deleteFiles: jest.fn().mockImplementation(async () => {
          order.push('files');
          return { deletedFileIds: ['code-file'], failedFileIds: [] };
        }),
        deleteAvatar: jest.fn().mockImplementation(async () => {
          order.push('avatar');
        }),
      },
    );

    expect(order).toEqual(['files', 'avatar']);
  });
});
