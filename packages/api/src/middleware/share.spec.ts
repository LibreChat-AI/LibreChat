jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: {
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

import { Permissions, PermissionTypes, PrincipalType, ResourceType } from 'librechat-data-provider';
import type { NextFunction, Response } from 'express';
import type { IRole } from '@librechat/data-schemas';
import type { ServerRequest } from '~/types/http';
import type { SharePolicyDeps } from './share';
import { createSharePolicyMiddleware } from './share';

type ShareTestRequest = ServerRequest & {
  params: {
    resourceType?: string;
  };
  body: ServerRequest['body'] & {
    public?: boolean;
    updated?: Array<{
      type?: string;
    }>;
  };
};

const createResponse = (): Response => {
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
  } as Partial<Response>;

  return res as Response;
};

const createRequest = (overrides: Partial<ShareTestRequest> = {}): ShareTestRequest =>
  ({
    user: { id: 'user123', role: 'USER' },
    params: { resourceType: ResourceType.SKILL },
    body: {},
    ...overrides,
  }) as ShareTestRequest;

const createRole = (permissions: IRole['permissions']): IRole =>
  ({
    permissions,
  }) as IRole;

describe('createSharePolicyMiddleware', () => {
  let getRoleByName: jest.MockedFunction<SharePolicyDeps['getRoleByName']>;
  let hasCapability: jest.MockedFunction<SharePolicyDeps['hasCapability']>;
  let next: jest.MockedFunction<NextFunction>;

  beforeEach(() => {
    getRoleByName = jest.fn();
    hasCapability = jest.fn().mockResolvedValue(false);
    next = jest.fn();
  });

  it('skips public sharing checks when public is not true', async () => {
    const { checkSharePublicAccess } = createSharePolicyMiddleware({
      getRoleByName,
      hasCapability,
    });
    const req = createRequest({ body: { public: false } });
    const res = createResponse();

    await checkSharePublicAccess(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
    expect(getRoleByName).not.toHaveBeenCalled();
  });

  it('blocks non-public skill sharing when role SKILLS.SHARE is disabled', async () => {
    const { checkShareAccess } = createSharePolicyMiddleware({
      getRoleByName,
      hasCapability,
    });
    getRoleByName.mockResolvedValue(
      createRole({
        [PermissionTypes.SKILLS]: {
          [Permissions.SHARE]: false,
          [Permissions.SHARE_PUBLIC]: false,
        },
      }),
    );
    const req = createRequest();
    const res = createResponse();

    await checkShareAccess(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Forbidden',
      message: `You do not have permission to share ${ResourceType.SKILL} resources`,
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('allows non-public skill sharing when role SKILLS.SHARE is enabled', async () => {
    const { checkShareAccess } = createSharePolicyMiddleware({
      getRoleByName,
      hasCapability,
    });
    getRoleByName.mockResolvedValue(
      createRole({
        [PermissionTypes.SKILLS]: {
          [Permissions.SHARE]: true,
          [Permissions.SHARE_PUBLIC]: false,
        },
      }),
    );
    const req = createRequest();
    const res = createResponse();

    await checkShareAccess(req, res, next);

    expect(hasCapability).toHaveBeenCalledWith(
      { id: 'user123', role: 'USER', tenantId: undefined },
      'manage:skills',
    );
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('preserves resource management capability bypass for skills', async () => {
    const { checkShareAccess } = createSharePolicyMiddleware({
      getRoleByName,
      hasCapability,
    });
    hasCapability.mockResolvedValue(true);
    const req = createRequest();
    const res = createResponse();

    await checkShareAccess(req, res, next);

    expect(hasCapability).toHaveBeenCalledWith(
      { id: 'user123', role: 'USER', tenantId: undefined },
      'manage:skills',
    );
    expect(getRoleByName).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('still requires SHARE_PUBLIC when public sharing is enabled', async () => {
    const { checkSharePublicAccess } = createSharePolicyMiddleware({
      getRoleByName,
      hasCapability,
    });
    getRoleByName.mockResolvedValue(
      createRole({
        [PermissionTypes.SKILLS]: {
          [Permissions.SHARE]: true,
          [Permissions.SHARE_PUBLIC]: false,
        },
      }),
    );
    const req = createRequest({ body: { public: true } });
    const res = createResponse();

    await checkSharePublicAccess(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Forbidden',
      message: `You do not have permission to share ${ResourceType.SKILL} resources publicly`,
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('requires SHARE_PUBLIC when PUBLIC is granted through updated principals', async () => {
    const { checkSharePublicAccess } = createSharePolicyMiddleware({
      getRoleByName,
      hasCapability,
    });
    getRoleByName.mockResolvedValue(
      createRole({
        [PermissionTypes.SHARED_LINKS]: {
          [Permissions.SHARE]: true,
          [Permissions.SHARE_PUBLIC]: false,
        },
      }),
    );
    const req = createRequest({
      params: { resourceType: ResourceType.SHARED_LINK },
      body: {
        updated: [
          {
            type: PrincipalType.PUBLIC,
          },
        ],
      },
    });
    const res = createResponse();

    await checkSharePublicAccess(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Forbidden',
      message: `You do not have permission to share ${ResourceType.SHARED_LINK} resources publicly`,
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('reuses the role permission lookup for public sharing checks', async () => {
    const { checkShareAccess, checkSharePublicAccess } = createSharePolicyMiddleware({
      getRoleByName,
      hasCapability,
    });
    getRoleByName.mockResolvedValue(
      createRole({
        [PermissionTypes.SKILLS]: {
          [Permissions.SHARE]: true,
          [Permissions.SHARE_PUBLIC]: true,
        },
      }),
    );
    const req = createRequest({ body: { public: true } });
    const res = createResponse();

    await checkShareAccess(req, res, next);
    await checkSharePublicAccess(req, res, next);

    expect(getRoleByName).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledTimes(2);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('returns 401 when user is not authenticated', async () => {
    const { checkShareAccess } = createSharePolicyMiddleware({
      getRoleByName,
      hasCapability,
    });
    const req = createRequest({ user: undefined });
    const res = createResponse();

    await checkShareAccess(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Unauthorized',
      message: 'Authentication required',
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 400 for unsupported resource type', async () => {
    const { checkShareAccess } = createSharePolicyMiddleware({
      getRoleByName,
      hasCapability,
    });
    const req = createRequest({ params: { resourceType: 'unsupported' } });
    const res = createResponse();

    await checkShareAccess(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Bad Request',
      message: 'Unsupported resource type for sharing: unsupported',
    });
  });

  it('returns 403 when role has no permissions object', async () => {
    const { checkShareAccess } = createSharePolicyMiddleware({
      getRoleByName,
      hasCapability,
    });
    const role = createRole({});
    Object.defineProperty(role, 'permissions', { value: null });
    getRoleByName.mockResolvedValue(role);
    const req = createRequest();
    const res = createResponse();

    await checkShareAccess(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 500 when role lookup fails', async () => {
    const { checkShareAccess } = createSharePolicyMiddleware({
      getRoleByName,
      hasCapability,
    });
    getRoleByName.mockRejectedValue(new Error('Database error'));
    const req = createRequest();
    const res = createResponse();

    await checkShareAccess(req, res, next);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Internal Server Error',
      message: 'Failed to check sharing permissions',
    });
  });
});
