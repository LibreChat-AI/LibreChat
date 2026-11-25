import { Request, Response, NextFunction } from 'express';
import {
  Permissions,
  PermissionTypes,
  EModelEndpoint,
  EndpointURLs,
} from 'librechat-data-provider';
import type { IRole, IUser } from '@librechat/data-schemas';
import {
  checkAccess,
  checkAccessWithRequestCache,
  generateCheckAccess,
  skipAgentCheck,
} from './access';

// Mock logger
jest.mock('@librechat/data-schemas', () => ({
  logger: {
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

describe('access middleware', () => {
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let mockNext: jest.MockedFunction<NextFunction>;
  let mockGetRoleByName: jest.Mock;

  beforeEach(() => {
    mockReq = {
      user: {
        id: 'user123',
        role: 'user',
        email: 'test@example.com',
        emailVerified: true,
        provider: 'local',
      } as IUser,
      body: {},
      originalUrl: '/api/test',
      method: 'POST',
    } as Partial<Request>;

    mockRes = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };

    mockNext = jest.fn() as jest.MockedFunction<NextFunction>;
    mockGetRoleByName = jest.fn();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('skipAgentCheck', () => {
    it('should return false when req is undefined', () => {
      expect(skipAgentCheck(undefined)).toBe(false);
    });

    it('should return false when req.body.endpoint is not present', () => {
      expect(skipAgentCheck(mockReq as Request)).toBe(false);
    });

    it('should return false when method is not POST', () => {
      mockReq.method = 'GET';
      mockReq.body = { endpoint: 'gpt-4' };
      expect(skipAgentCheck(mockReq as Request)).toBe(false);
    });

    it('should return false when URL does not include agents endpoint', () => {
      mockReq.body = { endpoint: 'gpt-4' };
      mockReq.originalUrl = '/api/messages';
      expect(skipAgentCheck(mockReq as Request)).toBe(false);
    });

    it('should return true when not an agents endpoint but URL includes agents', () => {
      mockReq.body = { endpoint: 'gpt-4' };
      mockReq.originalUrl = EndpointURLs[EModelEndpoint.agents];
      expect(skipAgentCheck(mockReq as Request)).toBe(true);
    });

    it('should return false when is an agents endpoint', () => {
      mockReq.body = { endpoint: EModelEndpoint.agents };
      mockReq.originalUrl = EndpointURLs[EModelEndpoint.agents];
      expect(skipAgentCheck(mockReq as Request)).toBe(false);
    });
  });

  describe('checkAccess', () => {
    const defaultParams = {
      user: {
        id: 'user123',
        role: 'user',
        email: 'test@example.com',
        emailVerified: true,
        provider: 'local',
      } as IUser,
      permissionType: PermissionTypes.AGENTS,
      permissions: [Permissions.USE],
      getRoleByName: jest.fn(),
    };

    it('should return true when skipCheck function returns true', async () => {
      const skipCheck = jest.fn().mockReturnValue(true);
      const result = await checkAccess({
        ...defaultParams,
        req: mockReq as Request,
        skipCheck,
      });
      expect(result).toBe(true);
      expect(skipCheck).toHaveBeenCalledWith(mockReq);
    });

    it('should return false when user is not provided', async () => {
      const result = await checkAccess({
        ...defaultParams,
        user: null as unknown as IUser,
      });
      expect(result).toBe(false);
    });

    it('should return false when user has no role', async () => {
      const result = await checkAccess({
        ...defaultParams,
        user: {
          id: 'user123',
          email: 'test@example.com',
          emailVerified: true,
          provider: 'local',
        } as IUser,
      });
      expect(result).toBe(false);
    });

    it('should return true when user has required permissions', async () => {
      const mockRole = {
        name: 'user',
        permissions: {
          [PermissionTypes.AGENTS]: {
            [Permissions.USE]: true,
          },
        },
      } as unknown as IRole;

      defaultParams.getRoleByName.mockResolvedValue(mockRole);

      const result = await checkAccess(defaultParams);
      expect(result).toBe(true);
      expect(defaultParams.getRoleByName).toHaveBeenCalledWith('user');
    });

    it('should return false when user lacks required permissions', async () => {
      const mockRole = {
        name: 'user',
        permissions: {
          [PermissionTypes.AGENTS]: {
            [Permissions.USE]: false,
          },
        },
      } as unknown as IRole;

      defaultParams.getRoleByName.mockResolvedValue(mockRole);

      const result = await checkAccess(defaultParams);
      expect(result).toBe(false);
    });

    it('should check multiple permissions with AND logic', async () => {
      const mockRole = {
        name: 'user',
        permissions: {
          [PermissionTypes.AGENTS]: {
            [Permissions.USE]: true,
            [Permissions.CREATE]: true,
          },
        },
      } as unknown as IRole;

      defaultParams.getRoleByName.mockResolvedValue(mockRole);

      const result = await checkAccess({
        ...defaultParams,
        permissions: [Permissions.USE, Permissions.CREATE],
      });
      expect(result).toBe(true);
    });

    it('should return false when user has only some of the required permissions', async () => {
      const mockRole = {
        name: 'user',
        permissions: {
          [PermissionTypes.AGENTS]: {
            [Permissions.USE]: true,
            [Permissions.CREATE]: false,
          },
        },
      } as unknown as IRole;

      defaultParams.getRoleByName.mockResolvedValue(mockRole);

      const result = await checkAccess({
        ...defaultParams,
        permissions: [Permissions.USE, Permissions.CREATE],
      });
      expect(result).toBe(false);
    });

    it('should check bodyProps when permission is not directly granted', async () => {
      const mockRole = {
        name: 'user',
        permissions: {
          [PermissionTypes.AGENTS]: {
            [Permissions.USE]: true,
            [Permissions.SHARE]: false,
          },
        },
      } as unknown as IRole;

      defaultParams.getRoleByName.mockResolvedValue(mockRole);

      const checkObject = { id: 'agent123' };

      const result = await checkAccess({
        ...defaultParams,
        permissions: [Permissions.USE, Permissions.SHARE],
        bodyProps: { [Permissions.SHARE]: ['id'] } as Record<Permissions, string[]>,
        checkObject,
      });
      expect(result).toBe(true);
    });

    it('should return false when bodyProps requirements are not met', async () => {
      const mockRole = {
        name: 'user',
        permissions: {
          [PermissionTypes.AGENTS]: {
            [Permissions.SHARE]: false,
          },
        },
      } as unknown as IRole;

      defaultParams.getRoleByName.mockResolvedValue(mockRole);

      const checkObject = {};

      const result = await checkAccess({
        ...defaultParams,
        permissions: [Permissions.SHARE],
        bodyProps: {} as Record<Permissions, string[]>,
        checkObject,
      });
      expect(result).toBe(false);
    });

    it('should handle role without permissions object', async () => {
      const mockRole = {
        name: 'user',
      } as unknown as IRole;

      defaultParams.getRoleByName.mockResolvedValue(mockRole);

      const result = await checkAccess(defaultParams);
      expect(result).toBe(false);
    });

    it('should handle getRoleByName returning null', async () => {
      defaultParams.getRoleByName.mockResolvedValue(null);

      const result = await checkAccess(defaultParams);
      expect(result).toBe(false);
    });
  });

  describe('checkAccessWithRequestCache', () => {
    const defaultParams = {
      user: {
        id: 'user123',
        role: 'user',
        email: 'test@example.com',
        emailVerified: true,
        provider: 'local',
      } as IUser,
      permissionType: PermissionTypes.MCP_SERVERS,
      permissions: [Permissions.USE],
      getRoleByName: jest.fn(),
    };

    const allowedRole = {
      name: 'user',
      permissions: {
        [PermissionTypes.MCP_SERVERS]: {
          [Permissions.USE]: true,
          [Permissions.CREATE]: true,
        },
      },
    } as unknown as IRole;

    it('should memoize permission checks for the same request', async () => {
      defaultParams.getRoleByName.mockResolvedValue(allowedRole);

      const params = {
        ...defaultParams,
        req: mockReq as Request,
      };

      await expect(checkAccessWithRequestCache(params)).resolves.toBe(true);
      await expect(checkAccessWithRequestCache(params)).resolves.toBe(true);

      expect(defaultParams.getRoleByName).toHaveBeenCalledTimes(1);
    });

    it('should share an in-flight permission check for the same request', async () => {
      defaultParams.getRoleByName.mockResolvedValue(allowedRole);

      const params = {
        ...defaultParams,
        req: mockReq as Request,
      };

      await expect(
        Promise.all([checkAccessWithRequestCache(params), checkAccessWithRequestCache(params)]),
      ).resolves.toEqual([true, true]);

      expect(defaultParams.getRoleByName).toHaveBeenCalledTimes(1);
    });

    it('should isolate memoized checks between requests', async () => {
      defaultParams.getRoleByName.mockResolvedValue(allowedRole);

      await expect(
        checkAccessWithRequestCache({
          ...defaultParams,
          req: mockReq as Request,
        }),
      ).resolves.toBe(true);
      await expect(
        checkAccessWithRequestCache({
          ...defaultParams,
          req: { ...mockReq } as Request,
        }),
      ).resolves.toBe(true);

      expect(defaultParams.getRoleByName).toHaveBeenCalledTimes(2);
    });

    it('should use separate cache entries for different permissions', async () => {
      defaultParams.getRoleByName.mockResolvedValue(allowedRole);

      await expect(
        checkAccessWithRequestCache({
          ...defaultParams,
          req: mockReq as Request,
          permissions: [Permissions.USE],
        }),
      ).resolves.toBe(true);
      await expect(
        checkAccessWithRequestCache({
          ...defaultParams,
          req: mockReq as Request,
          permissions: [Permissions.CREATE],
        }),
      ).resolves.toBe(true);

      expect(defaultParams.getRoleByName).toHaveBeenCalledTimes(1);
    });

    it('should reuse a synchronous role lookup across different permission types', async () => {
      const role = {
        name: 'user',
        permissions: {
          [PermissionTypes.MEMORIES]: { [Permissions.USE]: true },
          [PermissionTypes.AGENTS]: { [Permissions.USE]: true },
        },
      } as unknown as IRole;
      defaultParams.getRoleByName.mockReturnValue(role);
      const req = mockReq as Request;

      await expect(
        checkAccess({
          ...defaultParams,
          req,
          permissionType: PermissionTypes.MEMORIES,
        }),
      ).resolves.toBe(true);
      await expect(
        checkAccess({
          ...defaultParams,
          req,
          permissionType: PermissionTypes.AGENTS,
        }),
      ).resolves.toBe(true);

      expect(defaultParams.getRoleByName).toHaveBeenCalledTimes(1);
    });
  });

  describe('generateCheckAccess', () => {
    it('should create middleware that allows access when user has permissions', async () => {
      const mockRole = {
        name: 'user',
        permissions: {
          [PermissionTypes.MEMORIES]: {
            [Permissions.USE]: true,
            [Permissions.READ]: true,
          },
        },
      } as unknown as IRole;

      mockGetRoleByName.mockResolvedValue(mockRole);

      const middleware = generateCheckAccess({
        permissionType: PermissionTypes.MEMORIES,
        permissions: [Permissions.USE, Permissions.READ],
        getRoleByName: mockGetRoleByName,
      });

      await middleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(mockRes.status).not.toHaveBeenCalled();
    });

    it('should create middleware that denies access when user lacks permissions', async () => {
      const mockRole = {
        name: 'user',
        permissions: {
          [PermissionTypes.MEMORIES]: {
            [Permissions.USE]: false,
          },
        },
      } as unknown as IRole;

      mockGetRoleByName.mockResolvedValue(mockRole);

      const middleware = generateCheckAccess({
        permissionType: PermissionTypes.MEMORIES,
        permissions: [Permissions.USE],
        getRoleByName: mockGetRoleByName,
      });

      await middleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).not.toHaveBeenCalled();
      expect(mockRes.status).toHaveBeenCalledWith(403);
      expect(mockRes.json).toHaveBeenCalledWith({ message: 'Forbidden: Insufficient permissions' });
    });

    it('should handle bodyProps in middleware', async () => {
      const mockRole = {
        name: 'user',
        permissions: {
          [PermissionTypes.AGENTS]: {
            [Permissions.USE]: true,
            [Permissions.CREATE]: true,
            [Permissions.SHARE]: false,
          },
        },
      } as unknown as IRole;

      mockGetRoleByName.mockResolvedValue(mockRole);
      mockReq.body = { id: 'agent123' };

      const middleware = generateCheckAccess({
        permissionType: PermissionTypes.AGENTS,
        permissions: [Permissions.USE, Permissions.CREATE, Permissions.SHARE],
        bodyProps: { [Permissions.SHARE]: ['id'] } as Record<Permissions, string[]>,
        getRoleByName: mockGetRoleByName,
      });

      await middleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(mockRes.status).not.toHaveBeenCalled();
    });

    it('should use skipCheck function when provided', async () => {
      const skipCheck = jest.fn().mockReturnValue(true);

      const middleware = generateCheckAccess({
        permissionType: PermissionTypes.AGENTS,
        permissions: [Permissions.USE],
        skipCheck,
        getRoleByName: mockGetRoleByName,
      });

      await middleware(mockReq as Request, mockRes as Response, mockNext);

      expect(skipCheck).toHaveBeenCalledWith(mockReq);
      expect(mockNext).toHaveBeenCalled();
      expect(mockGetRoleByName).not.toHaveBeenCalled();
    });

    it('should handle errors and return 500 status', async () => {
      const error = new Error('Database error');
      mockGetRoleByName.mockRejectedValue(error);

      const middleware = generateCheckAccess({
        permissionType: PermissionTypes.AGENTS,
        permissions: [Permissions.USE],
        getRoleByName: mockGetRoleByName,
      });

      await middleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(500);
      expect(mockRes.json).toHaveBeenCalledWith({
        message: 'Server error: Database error',
      });
    });

    it('should handle non-Error objects in catch block', async () => {
      mockGetRoleByName.mockRejectedValue('String error');

      const middleware = generateCheckAccess({
        permissionType: PermissionTypes.AGENTS,
        permissions: [Permissions.USE],
        getRoleByName: mockGetRoleByName,
      });

      await middleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(500);
      expect(mockRes.json).toHaveBeenCalledWith({
        message: 'Server error: Unknown error',
      });
    });
  });

  describe('Real-world usage patterns', () => {
    it('should handle memory access patterns', async () => {
      const mockRole = {
        name: 'user',
        permissions: {
          [PermissionTypes.MEMORIES]: {
            [Permissions.USE]: true,
            [Permissions.CREATE]: true,
            [Permissions.UPDATE]: true,
            [Permissions.READ]: true,
            [Permissions.OPT_OUT]: true,
          },
        },
      } as unknown as IRole;

      mockGetRoleByName.mockResolvedValue(mockRole);

      // Test memory read access
      const checkMemoryRead = generateCheckAccess({
        permissionType: PermissionTypes.MEMORIES,
        permissions: [Permissions.USE, Permissions.READ],
        getRoleByName: mockGetRoleByName,
      });

      await checkMemoryRead(mockReq as Request, mockRes as Response, mockNext);
      expect(mockNext).toHaveBeenCalled();

      // Test memory create access
      mockNext.mockClear();
      const checkMemoryCreate = generateCheckAccess({
        permissionType: PermissionTypes.MEMORIES,
        permissions: [Permissions.USE, Permissions.CREATE],
        getRoleByName: mockGetRoleByName,
      });

      await checkMemoryCreate(mockReq as Request, mockRes as Response, mockNext);
      expect(mockNext).toHaveBeenCalled();
    });

    it('should handle agent access patterns with skipCheck', async () => {
      const mockRole = {
        name: 'user',
        permissions: {
          [PermissionTypes.AGENTS]: {
            [Permissions.USE]: true,
          },
        },
      } as unknown as IRole;

      mockGetRoleByName.mockResolvedValue(mockRole);
      mockReq.body = { endpoint: 'gpt-4' };
      mockReq.originalUrl = EndpointURLs[EModelEndpoint.agents];

      const checkAgentAccess = generateCheckAccess({
        permissionType: PermissionTypes.AGENTS,
        permissions: [Permissions.USE],
        skipCheck: skipAgentCheck,
        getRoleByName: mockGetRoleByName,
      });

      await checkAgentAccess(mockReq as Request, mockRes as Response, mockNext);

      // Should skip check because endpoint is not agents
      expect(mockNext).toHaveBeenCalled();
      expect(mockGetRoleByName).not.toHaveBeenCalled();
    });

    it('should handle prompt access patterns', async () => {
      const mockRole = {
        name: 'user',
        permissions: {
          [PermissionTypes.PROMPTS]: {
            [Permissions.USE]: true,
            [Permissions.CREATE]: true,
            [Permissions.SHARE]: false,
          },
        },
      } as unknown as IRole;

      mockGetRoleByName.mockResolvedValue(mockRole);

      const checkPromptAccess = generateCheckAccess({
        permissionType: PermissionTypes.PROMPTS,
        permissions: [Permissions.USE],
        getRoleByName: mockGetRoleByName,
      });

      await checkPromptAccess(mockReq as Request, mockRes as Response, mockNext);
      expect(mockNext).toHaveBeenCalled();
    });

    it('should handle bookmark access patterns', async () => {
      const mockRole = {
        name: 'user',
        permissions: {
          [PermissionTypes.BOOKMARKS]: {
            [Permissions.USE]: true,
          },
        },
      } as unknown as IRole;

      mockGetRoleByName.mockResolvedValue(mockRole);

      const checkBookmarkAccess = generateCheckAccess({
        permissionType: PermissionTypes.BOOKMARKS,
        permissions: [Permissions.USE],
        getRoleByName: mockGetRoleByName,
      });

      await checkBookmarkAccess(mockReq as Request, mockRes as Response, mockNext);
      expect(mockNext).toHaveBeenCalled();
    });

    it('should handle tool access patterns', async () => {
      const mockRole = {
        name: 'user',
        permissions: {
          [PermissionTypes.RUN_CODE]: {
            [Permissions.USE]: true,
          },
        },
      } as unknown as IRole;

      mockGetRoleByName.mockResolvedValue(mockRole);

      const result = await checkAccess({
        user: mockReq.user as IUser,
        permissionType: PermissionTypes.RUN_CODE,
        permissions: [Permissions.USE],
        getRoleByName: mockGetRoleByName,
      });

      expect(result).toBe(true);
    });
  });
});
