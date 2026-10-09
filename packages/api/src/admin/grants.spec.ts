import { Types } from 'mongoose';
import { PrincipalType } from 'librechat-data-provider';
import { SystemCapabilities, expandImplications } from '@librechat/data-schemas';
import type { ISystemGrant } from '@librechat/data-schemas';
import type { Response } from 'express';
import type { ServerRequest } from '~/types/http';
import type { AdminGrantsDeps } from './grants';
import { createAdminGrantsHandlers } from './grants';

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

const validObjectId = new Types.ObjectId().toString();

function mockGrant(overrides: Partial<ISystemGrant> = {}): ISystemGrant {
  return {
    _id: new Types.ObjectId(),
    principalType: PrincipalType.ROLE,
    principalId: 'editor',
    capability: SystemCapabilities.READ_USERS,
    grantedAt: new Date(),
    ...overrides,
  } as ISystemGrant;
}

function createReqRes(
  overrides: {
    params?: Record<string, string>;
    query?: Record<string, string>;
    body?: Record<string, unknown>;
    user?: { _id: Types.ObjectId; role: string; tenantId?: string };
  } = {},
) {
  const req = {
    params: overrides.params ?? {},
    query: overrides.query ?? {},
    body: overrides.body ?? {},
    user: overrides.user ?? { _id: new Types.ObjectId(), role: 'admin' },
  } as unknown as ServerRequest;

  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const res = { status, json } as unknown as Response;

  return { req, res, status, json };
}

function createDeps(overrides: Partial<AdminGrantsDeps> = {}): AdminGrantsDeps {
  return {
    listGrants: jest.fn().mockResolvedValue([]),
    countGrants: jest.fn().mockResolvedValue(0),
    getCapabilitiesForPrincipal: jest.fn().mockResolvedValue([]),
    getCapabilitiesForPrincipals: jest.fn().mockResolvedValue([]),
    grantCapability: jest.fn().mockResolvedValue({ grant: mockGrant(), created: true }),
    revokeCapability: jest.fn().mockResolvedValue({ deletedCount: 1 }),
    getUserPrincipals: jest.fn().mockResolvedValue([
      { principalType: PrincipalType.USER, principalId: new Types.ObjectId() },
      { principalType: PrincipalType.ROLE, principalId: 'admin' },
    ]),
    hasCapabilityForPrincipals: jest.fn().mockResolvedValue(true),
    getHeldCapabilities: jest
      .fn()
      .mockResolvedValue(
        new Set([
          SystemCapabilities.READ_ROLES,
          SystemCapabilities.READ_GROUPS,
          SystemCapabilities.READ_USERS,
          SystemCapabilities.MANAGE_ROLES,
          SystemCapabilities.MANAGE_GROUPS,
          SystemCapabilities.MANAGE_USERS,
        ]),
      ),
    getCachedPrincipals: jest.fn().mockReturnValue(undefined),
    ...overrides,
  };
}

describe('createAdminGrantsHandlers', () => {
  describe('listGrants', () => {
    it('returns grants with pagination metadata', async () => {
      const grants = [mockGrant(), mockGrant({ capability: SystemCapabilities.MANAGE_ROLES })];
      const deps = createDeps({
        listGrants: jest.fn().mockResolvedValue(grants),
        countGrants: jest.fn().mockResolvedValue(2),
      });
      const handlers = createAdminGrantsHandlers(deps);
      const { req, res, status, json } = createReqRes();

      await handlers.listGrants(req, res);

      expect(status).toHaveBeenCalledWith(200);
      const response = json.mock.calls[0][0];
      expect(response.grants).toEqual(grants);
      expect(response).toHaveProperty('total', 2);
      expect(response).toHaveProperty('limit');
      expect(response).toHaveProperty('offset');
    });

    it('returns empty array when no grants exist', async () => {
      const deps = createDeps();
      const handlers = createAdminGrantsHandlers(deps);
      const { req, res, status, json } = createReqRes();

      await handlers.listGrants(req, res);

      expect(status).toHaveBeenCalledWith(200);
      const response = json.mock.calls[0][0];
      expect(response.grants).toEqual([]);
      expect(response.total).toBe(0);
    });

    it('passes principalTypes filter based on caller read permissions', async () => {
      const deps = createDeps({
        getHeldCapabilities: jest.fn().mockResolvedValue(new Set([SystemCapabilities.READ_ROLES])),
      });
      const handlers = createAdminGrantsHandlers(deps);
      const { req, res } = createReqRes();

      await handlers.listGrants(req, res);

      expect(deps.listGrants).toHaveBeenCalledWith(
        expect.objectContaining({ principalTypes: [PrincipalType.ROLE] }),
      );
      expect(deps.countGrants).toHaveBeenCalledWith(
        expect.objectContaining({ principalTypes: [PrincipalType.ROLE] }),
      );
    });

    it('returns empty grants when caller has no read permissions', async () => {
      const deps = createDeps({
        getHeldCapabilities: jest.fn().mockResolvedValue(new Set()),
      });
      const handlers = createAdminGrantsHandlers(deps);
      const { req, res, status, json } = createReqRes();

      await handlers.listGrants(req, res);

      expect(status).toHaveBeenCalledWith(200);
      const response = json.mock.calls[0][0];
      expect(response.grants).toEqual([]);
      expect(response.total).toBe(0);
      expect(deps.listGrants).not.toHaveBeenCalled();
      expect(deps.countGrants).not.toHaveBeenCalled();
    });

    it('passes limit and offset from query params', async () => {
      const deps = createDeps();
      const handlers = createAdminGrantsHandlers(deps);
      const { req, res } = createReqRes({ query: { limit: '10', offset: '20' } });

      await handlers.listGrants(req, res);

      expect(deps.listGrants).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 10, offset: 20 }),
      );
    });

    it('passes tenantId to dep calls', async () => {
      const deps = createDeps();
      const handlers = createAdminGrantsHandlers(deps);
      const { req, res } = createReqRes({
        user: { _id: new Types.ObjectId(), role: 'admin', tenantId: 'tenant-1' },
      });

      await handlers.listGrants(req, res);

      expect(deps.getHeldCapabilities).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: 'tenant-1' }),
      );
      expect(deps.listGrants).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: 'tenant-1' }),
      );
    });

    it('returns 401 when user is not authenticated', async () => {
      const deps = createDeps();
      const handlers = createAdminGrantsHandlers(deps);
      const { req, res, status, json } = createReqRes();
      (req as unknown as Record<string, unknown>).user = undefined;

      await handlers.listGrants(req, res);

      expect(status).toHaveBeenCalledWith(401);
      expect(json).toHaveBeenCalledWith({ error: 'Authentication required' });
    });

    it('returns 500 on error', async () => {
      const deps = createDeps({
        listGrants: jest.fn().mockRejectedValue(new Error('db error')),
      });
      const handlers = createAdminGrantsHandlers(deps);
      const { req, res, status, json } = createReqRes();

      await handlers.listGrants(req, res);

      expect(status).toHaveBeenCalledWith(500);
      expect(json).toHaveBeenCalledWith({ error: 'Failed to list grants' });
    });

    it('returns 500 when getHeldCapabilities throws', async () => {
      const deps = createDeps({
        getHeldCapabilities: jest.fn().mockRejectedValue(new Error('db error')),
      });
      const handlers = createAdminGrantsHandlers(deps);
      const { req, res, status, json } = createReqRes();

      await handlers.listGrants(req, res);

      expect(status).toHaveBeenCalledWith(500);
      expect(json).toHaveBeenCalledWith({ error: 'Failed to list grants' });
    });

    it('uses cached principals when available', async () => {
      const cachedPrincipals = [
        { principalType: PrincipalType.USER, principalId: new Types.ObjectId() },
        { principalType: PrincipalType.ROLE, principalId: 'admin' },
      ];
      const deps = createDeps({
        getCachedPrincipals: jest.fn().mockReturnValue(cachedPrincipals),
      });
      const handlers = createAdminGrantsHandlers(deps);
      const { req, res } = createReqRes();

      await handlers.listGrants(req, res);

      expect(deps.getUserPrincipals).not.toHaveBeenCalled();
      expect(deps.getHeldCapabilities).toHaveBeenCalledWith(
        expect.objectContaining({ principals: cachedPrincipals }),
      );
    });
  });

  describe('getEffectiveCapabilities', () => {
    it('uses cached principals when available', async () => {
      const cachedPrincipals = [
        { principalType: PrincipalType.USER, principalId: new Types.ObjectId() },
        { principalType: PrincipalType.ROLE, principalId: 'admin' },
      ];
      const deps = createDeps({
        getCachedPrincipals: jest.fn().mockReturnValue(cachedPrincipals),
      });
      const handlers = createAdminGrantsHandlers(deps);
      const { req, res } = createReqRes();

      await handlers.getEffectiveCapabilities(req, res);

      expect(deps.getUserPrincipals).not.toHaveBeenCalled();
      expect(deps.getCapabilitiesForPrincipals).toHaveBeenCalledWith(
        expect.objectContaining({ principals: cachedPrincipals }),
      );
    });

    it('returns expanded capabilities for the user', async () => {
      const manageRolesGrant = mockGrant({ capability: SystemCapabilities.MANAGE_ROLES });
      const deps = createDeps({
        getCapabilitiesForPrincipals: jest.fn().mockResolvedValue([manageRolesGrant]),
      });
      const handlers = createAdminGrantsHandlers(deps);
      const { req, res, status, json } = createReqRes();

      await handlers.getEffectiveCapabilities(req, res);

      expect(status).toHaveBeenCalledWith(200);
      const response = json.mock.calls[0][0];
      const expected = expandImplications([SystemCapabilities.MANAGE_ROLES]);
      expect(response.capabilities).toEqual(expect.arrayContaining(expected));
      expect(response.capabilities).toContain(SystemCapabilities.READ_ROLES);
    });

    it('returns empty capabilities when user has no grants', async () => {
      const deps = createDeps();
      const handlers = createAdminGrantsHandlers(deps);
      const { req, res, status, json } = createReqRes();

      await handlers.getEffectiveCapabilities(req, res);

      expect(status).toHaveBeenCalledWith(200);
      expect(json).toHaveBeenCalledWith({ capabilities: [] });
    });

    it('queries all principals in a single batch', async () => {
      const userId = new Types.ObjectId();
      const principals = [
        { principalType: PrincipalType.USER, principalId: userId },
        { principalType: PrincipalType.ROLE, principalId: 'editor' },
      ];
      const deps = createDeps({
        getUserPrincipals: jest.fn().mockResolvedValue(principals),
      });
      const handlers = createAdminGrantsHandlers(deps);
      const { req, res } = createReqRes();

      await handlers.getEffectiveCapabilities(req, res);

      expect(deps.getCapabilitiesForPrincipals).toHaveBeenCalledTimes(1);
      expect(deps.getCapabilitiesForPrincipals).toHaveBeenCalledWith(
        expect.objectContaining({
          principals: [
            { principalType: PrincipalType.USER, principalId: userId },
            { principalType: PrincipalType.ROLE, principalId: 'editor' },
          ],
        }),
      );
    });

    it('passes tenantId to getCapabilitiesForPrincipals', async () => {
      const deps = createDeps();
      const handlers = createAdminGrantsHandlers(deps);
      const { req, res } = createReqRes({
        user: { _id: new Types.ObjectId(), role: 'admin', tenantId: 'tenant-1' },
      });

      await handlers.getEffectiveCapabilities(req, res);

      expect(deps.getCapabilitiesForPrincipals).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: 'tenant-1' }),
      );
    });

    it('skips principals without principalId', async () => {
      const principals = [
        { principalType: PrincipalType.PUBLIC },
        { principalType: PrincipalType.ROLE, principalId: 'editor' },
      ];
      const deps = createDeps({
        getUserPrincipals: jest.fn().mockResolvedValue(principals),
      });
      const handlers = createAdminGrantsHandlers(deps);
      const { req, res } = createReqRes();

      await handlers.getEffectiveCapabilities(req, res);

      expect(deps.getCapabilitiesForPrincipals).toHaveBeenCalledWith(
        expect.objectContaining({
          principals: [{ principalType: PrincipalType.ROLE, principalId: 'editor' }],
        }),
      );
    });

    it('returns empty capabilities when all principals lack principalId', async () => {
      const deps = createDeps({
        getUserPrincipals: jest.fn().mockResolvedValue([{ principalType: PrincipalType.PUBLIC }]),
      });
      const handlers = createAdminGrantsHandlers(deps);
      const { req, res, status, json } = createReqRes();

      await handlers.getEffectiveCapabilities(req, res);

      expect(status).toHaveBeenCalledWith(200);
      expect(json).toHaveBeenCalledWith({ capabilities: [] });
      expect(deps.getCapabilitiesForPrincipals).not.toHaveBeenCalled();
    });

    it('deduplicates capabilities across principals', async () => {
      const readUsersGrant = mockGrant({ capability: SystemCapabilities.READ_USERS });
      const deps = createDeps({
        getUserPrincipals: jest.fn().mockResolvedValue([
          { principalType: PrincipalType.USER, principalId: new Types.ObjectId() },
          { principalType: PrincipalType.ROLE, principalId: 'editor' },
        ]),
        getCapabilitiesForPrincipals: jest.fn().mockResolvedValue([readUsersGrant, readUsersGrant]),
      });
      const handlers = createAdminGrantsHandlers(deps);
      const { req, res, status, json } = createReqRes();

      await handlers.getEffectiveCapabilities(req, res);

      expect(status).toHaveBeenCalledWith(200);
      const response = json.mock.calls[0][0];
      const readUsersCount = response.capabilities.filter(
        (c: string) => c === SystemCapabilities.READ_USERS,
      ).length;
      expect(readUsersCount).toBe(1);
    });

    it('deduplicates when user holds both parent and implied capability', async () => {
      const manageGrant = mockGrant({ capability: SystemCapabilities.MANAGE_ROLES });
      const readGrant = mockGrant({ capability: SystemCapabilities.READ_ROLES });
      const deps = createDeps({
        getCapabilitiesForPrincipals: jest.fn().mockResolvedValue([manageGrant, readGrant]),
      });
      const handlers = createAdminGrantsHandlers(deps);
      const { req, res, status, json } = createReqRes();

      await handlers.getEffectiveCapabilities(req, res);

      expect(status).toHaveBeenCalledWith(200);
      const response = json.mock.calls[0][0];
      const readRolesCount = response.capabilities.filter(
        (c: string) => c === SystemCapabilities.READ_ROLES,
      ).length;
      expect(readRolesCount).toBe(1);
    });

    it('returns 401 when user is not authenticated', async () => {
      const deps = createDeps();
      const handlers = createAdminGrantsHandlers(deps);
      const { req, res, status, json } = createReqRes();
      (req as unknown as Record<string, unknown>).user = undefined;

      await handlers.getEffectiveCapabilities(req, res);

      expect(status).toHaveBeenCalledWith(401);
      expect(json).toHaveBeenCalledWith({ error: 'Authentication required' });
    });

    it('returns 500 on unexpected error', async () => {
      const deps = createDeps({
        getUserPrincipals: jest.fn().mockRejectedValue(new Error('db error')),
      });
      const handlers = createAdminGrantsHandlers(deps);
      const { req, res, status, json } = createReqRes();

      await handlers.getEffectiveCapabilities(req, res);

      expect(status).toHaveBeenCalledWith(500);
      expect(json).toHaveBeenCalledWith({ error: 'Failed to get effective capabilities' });
    });

    it('returns 500 when getCapabilitiesForPrincipals throws', async () => {
      const deps = createDeps({
        getCapabilitiesForPrincipals: jest.fn().mockRejectedValue(new Error('db error')),
      });
      const handlers = createAdminGrantsHandlers(deps);
      const { req, res, status, json } = createReqRes();

      await handlers.getEffectiveCapabilities(req, res);

      expect(status).toHaveBeenCalledWith(500);
      expect(json).toHaveBeenCalledWith({ error: 'Failed to get effective capabilities' });
    });
  });

  describe('getPrincipalGrants', () => {
    it('returns grants for a role principal', async () => {
      const grants = [mockGrant()];
      const deps = createDeps({
        getCapabilitiesForPrincipal: jest.fn().mockResolvedValue(grants),
      });
      const handlers = createAdminGrantsHandlers(deps);
      const { req, res, status, json } = createReqRes({
        params: { principalType: PrincipalType.ROLE, principalId: 'editor' },
      });

      await handlers.getPrincipalGrants(req, res);

      expect(deps.getCapabilitiesForPrincipal).toHaveBeenCalledWith(
        expect.objectContaining({
          principalType: PrincipalType.ROLE,
          principalId: 'editor',
        }),
      );
      expect(status).toHaveBeenCalledWith(200);
      expect(json).toHaveBeenCalledWith({ grants });
    });

    it('returns 400 for group principal type', async () => {
      const deps = createDeps();
      const handlers = createAdminGrantsHandlers(deps);
      const { req, res, status, json } = createReqRes({
        params: { principalType: PrincipalType.GROUP, principalId: validObjectId },
      });

      await handlers.getPrincipalGrants(req, res);

      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith({ error: 'Invalid principal type' });
    });

    it('returns 400 for user principal type', async () => {
      const deps = createDeps();
      const handlers = createAdminGrantsHandlers(deps);
      const { req, res, status, json } = createReqRes({
        params: { principalType: PrincipalType.USER, principalId: validObjectId },
      });

      await handlers.getPrincipalGrants(req, res);

      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith({ error: 'Invalid principal type' });
    });

    it('passes tenantId to dep calls', async () => {
      const deps = createDeps({
        getCapabilitiesForPrincipal: jest.fn().mockResolvedValue([]),
      });
      const handlers = createAdminGrantsHandlers(deps);
      const { req, res } = createReqRes({
        params: { principalType: PrincipalType.ROLE, principalId: 'editor' },
        user: { _id: new Types.ObjectId(), role: 'admin', tenantId: 'tenant-1' },
      });

      await handlers.getPrincipalGrants(req, res);

      expect(deps.hasCapabilityForPrincipals).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: 'tenant-1' }),
      );
      expect(deps.getCapabilitiesForPrincipal).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: 'tenant-1' }),
      );
    });

    it('returns 400 for invalid principal type', async () => {
      const deps = createDeps();
      const handlers = createAdminGrantsHandlers(deps);
      const { req, res, status, json } = createReqRes({
        params: { principalType: 'invalid', principalId: 'abc' },
      });

      await handlers.getPrincipalGrants(req, res);

      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith({ error: 'Invalid principal type' });
    });

    it('returns 400 when principalId is missing', async () => {
      const deps = createDeps();
      const handlers = createAdminGrantsHandlers(deps);
      const { req, res, status, json } = createReqRes({
        params: { principalType: PrincipalType.ROLE, principalId: '' },
      });

      await handlers.getPrincipalGrants(req, res);

      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith({ error: 'Principal ID is required' });
    });

    it('accepts string principalId for role type', async () => {
      const deps = createDeps({
        getCapabilitiesForPrincipal: jest.fn().mockResolvedValue([]),
      });
      const handlers = createAdminGrantsHandlers(deps);
      const { req, res, status } = createReqRes({
        params: { principalType: PrincipalType.ROLE, principalId: 'custom-role-name' },
      });

      await handlers.getPrincipalGrants(req, res);

      expect(status).toHaveBeenCalledWith(200);
    });

    it('returns 401 when user is not authenticated', async () => {
      const deps = createDeps();
      const handlers = createAdminGrantsHandlers(deps);
      const { req, res, status, json } = createReqRes({
        params: { principalType: PrincipalType.ROLE, principalId: 'editor' },
      });
      (req as unknown as Record<string, unknown>).user = undefined;

      await handlers.getPrincipalGrants(req, res);

      expect(status).toHaveBeenCalledWith(401);
      expect(json).toHaveBeenCalledWith({ error: 'Authentication required' });
    });

    it('returns 403 when caller lacks READ capability', async () => {
      const deps = createDeps({
        hasCapabilityForPrincipals: jest.fn().mockResolvedValue(false),
      });
      const handlers = createAdminGrantsHandlers(deps);
      const { req, res, status, json } = createReqRes({
        params: { principalType: PrincipalType.ROLE, principalId: 'editor' },
      });

      await handlers.getPrincipalGrants(req, res);

      expect(status).toHaveBeenCalledWith(403);
      expect(json).toHaveBeenCalledWith({ error: 'Insufficient permissions' });
      expect(deps.hasCapabilityForPrincipals).toHaveBeenCalledWith(
        expect.objectContaining({ capability: SystemCapabilities.READ_ROLES }),
      );
    });

    it('returns 500 on unexpected error', async () => {
      const deps = createDeps({
        getCapabilitiesForPrincipal: jest.fn().mockRejectedValue(new Error('db error')),
      });
      const handlers = createAdminGrantsHandlers(deps);
      const { req, res, status, json } = createReqRes({
        params: { principalType: PrincipalType.ROLE, principalId: 'editor' },
      });

      await handlers.getPrincipalGrants(req, res);

      expect(status).toHaveBeenCalledWith(500);
      expect(json).toHaveBeenCalledWith({ error: 'Failed to get grants' });
    });
  });

  describe('assignGrant', () => {
    const validBody = {
      principalType: PrincipalType.ROLE,
      principalId: 'editor',
      capability: SystemCapabilities.READ_USERS,
    };

    it('assigns a grant and returns 201', async () => {
      const grant = mockGrant();
      const deps = createDeps({
        grantCapability: jest.fn().mockResolvedValue({ grant, created: true }),
      });
      const handlers = createAdminGrantsHandlers(deps);
      const { req, res, status, json } = createReqRes({ body: validBody });

      await handlers.assignGrant(req, res);

      expect(deps.grantCapability).toHaveBeenCalledWith(
        expect.objectContaining({
          principalType: PrincipalType.ROLE,
          principalId: 'editor',
          capability: SystemCapabilities.READ_USERS,
        }),
      );
      expect(status).toHaveBeenCalledWith(201);
      expect(json).toHaveBeenCalledWith({ grant });
    });

    it('passes grantedBy from the authenticated user', async () => {
      const userId = new Types.ObjectId();
      const deps = createDeps();
      const handlers = createAdminGrantsHandlers(deps);
      const { req, res } = createReqRes({ body: validBody, user: { _id: userId, role: 'admin' } });

      await handlers.assignGrant(req, res);

      expect(deps.grantCapability).toHaveBeenCalledWith(
        expect.objectContaining({ grantedBy: userId.toString() }),
      );
    });

    it('passes tenantId to all dep calls', async () => {
      const deps = createDeps();
      const handlers = createAdminGrantsHandlers(deps);
      const { req, res } = createReqRes({
        body: validBody,
        user: { _id: new Types.ObjectId(), role: 'admin', tenantId: 'tenant-1' },
      });

      await handlers.assignGrant(req, res);

      expect(deps.getHeldCapabilities).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: 'tenant-1' }),
      );
      expect(deps.grantCapability).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: 'tenant-1' }),
      );
    });

    it('accepts section-level config capabilities', async () => {
      const grant = mockGrant({
        capability: 'manage:configs:endpoints' as ISystemGrant['capability'],
      });
      const deps = createDeps({
        grantCapability: jest.fn().mockResolvedValue({ grant, created: true }),
        getHeldCapabilities: jest
          .fn()
          .mockResolvedValue(
            new Set([SystemCapabilities.MANAGE_ROLES, 'manage:configs:endpoints']),
          ),
      });
      const handlers = createAdminGrantsHandlers(deps);
      const { req, res, status } = createReqRes({
        body: { ...validBody, capability: 'manage:configs:endpoints' },
      });

      await handlers.assignGrant(req, res);

      expect(status).toHaveBeenCalledWith(201);
    });

    it('accepts config assignment capabilities', async () => {
      const grant = mockGrant({ capability: 'assign:configs:group' as ISystemGrant['capability'] });
      const deps = createDeps({
        grantCapability: jest.fn().mockResolvedValue({ grant, created: true }),
        getHeldCapabilities: jest
          .fn()
          .mockResolvedValue(new Set([SystemCapabilities.MANAGE_ROLES, 'assign:configs:group'])),
      });
      const handlers = createAdminGrantsHandlers(deps);
      const { req, res, status } = createReqRes({
        body: { ...validBody, capability: 'assign:configs:group' },
      });

      await handlers.assignGrant(req, res);

      expect(status).toHaveBeenCalledWith(201);
    });

    it('returns 400 for invalid extended capability string', async () => {
      const deps = createDeps();
      const handlers = createAdminGrantsHandlers(deps);
      const { req, res, status, json } = createReqRes({
        body: { ...validBody, capability: 'manage:configs:' },
      });

      await handlers.assignGrant(req, res);

      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith({ error: 'Invalid capability' });
    });

    it('returns 400 for missing principalType', async () => {
      const deps = createDeps();
      const handlers = createAdminGrantsHandlers(deps);
      const { req, res, status, json } = createReqRes({
        body: { principalId: 'editor', capability: SystemCapabilities.READ_USERS },
      });

      await handlers.assignGrant(req, res);

      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith({ error: 'Invalid principal type' });
    });

    it('returns 400 for invalid principalType', async () => {
      const deps = createDeps();
      const handlers = createAdminGrantsHandlers(deps);
      const { req, res, status, json } = createReqRes({
        body: { ...validBody, principalType: 'invalid' },
      });

      await handlers.assignGrant(req, res);

      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith({ error: 'Invalid principal type' });
    });

    it('returns 400 for missing principalId', async () => {
      const deps = createDeps();
      const handlers = createAdminGrantsHandlers(deps);
      const { req, res, status, json } = createReqRes({
        body: { principalType: PrincipalType.ROLE, capability: SystemCapabilities.READ_USERS },
      });

      await handlers.assignGrant(req, res);

      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith({ error: 'Principal ID is required' });
    });

    it('returns 400 for invalid capability', async () => {
      const deps = createDeps();
      const handlers = createAdminGrantsHandlers(deps);
      const { req, res, status, json } = createReqRes({
        body: { ...validBody, capability: 'not:a:real:capability' },
      });

      await handlers.assignGrant(req, res);

      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith({ error: 'Invalid capability' });
    });

    it('returns 400 for group principal type', async () => {
      const deps = createDeps();
      const handlers = createAdminGrantsHandlers(deps);
      const { req, res, status, json } = createReqRes({
        body: {
          principalType: PrincipalType.GROUP,
          principalId: validObjectId,
          capability: SystemCapabilities.READ_USERS,
        },
      });

      await handlers.assignGrant(req, res);

      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith({ error: 'Invalid principal type' });
    });

    it('returns 401 when user is not authenticated', async () => {
      const deps = createDeps();
      const handlers = createAdminGrantsHandlers(deps);
      const { req, res, status, json } = createReqRes({ body: validBody });
      (req as unknown as Record<string, unknown>).user = undefined;

      await handlers.assignGrant(req, res);

      expect(status).toHaveBeenCalledWith(401);
      expect(json).toHaveBeenCalledWith({ error: 'Authentication required' });
      expect(deps.grantCapability).not.toHaveBeenCalled();
    });

    it('returns 403 when caller lacks manage capability', async () => {
      const deps = createDeps({
        getHeldCapabilities: jest.fn().mockResolvedValue(new Set()),
      });
      const handlers = createAdminGrantsHandlers(deps);
      const { req, res, status, json } = createReqRes({ body: validBody });

      await handlers.assignGrant(req, res);

      expect(status).toHaveBeenCalledWith(403);
      expect(json).toHaveBeenCalledWith({ error: 'Insufficient permissions' });
      expect(deps.grantCapability).not.toHaveBeenCalled();
    });

    it('returns 403 when caller lacks the capability being granted', async () => {
      const deps = createDeps({
        getHeldCapabilities: jest
          .fn()
          .mockResolvedValue(new Set([SystemCapabilities.MANAGE_ROLES])),
      });
      const handlers = createAdminGrantsHandlers(deps);
      const { req, res, status, json } = createReqRes({ body: validBody });

      await handlers.assignGrant(req, res);

      expect(status).toHaveBeenCalledWith(403);
      expect(json).toHaveBeenCalledWith({ error: 'Cannot grant a capability you do not possess' });
      expect(deps.grantCapability).not.toHaveBeenCalled();
    });

    it('allows granting an implied capability the caller holds transitively', async () => {
      const deps = createDeps({
        getHeldCapabilities: jest
          .fn()
          .mockResolvedValue(
            new Set([SystemCapabilities.MANAGE_ROLES, SystemCapabilities.READ_ROLES]),
          ),
      });
      const handlers = createAdminGrantsHandlers(deps);
      const { req, res, status } = createReqRes({
        body: {
          principalType: PrincipalType.ROLE,
          principalId: 'editor',
          capability: SystemCapabilities.READ_ROLES,
        },
      });

      await handlers.assignGrant(req, res);

      expect(status).toHaveBeenCalledWith(201);
      expect(deps.getHeldCapabilities).toHaveBeenCalledWith(
        expect.objectContaining({
          capabilities: expect.arrayContaining([SystemCapabilities.READ_ROLES]),
        }),
      );
    });

    it('checks MANAGE_ROLES for role principal type', async () => {
      const deps = createDeps({
        getHeldCapabilities: jest
          .fn()
          .mockResolvedValue(
            new Set([SystemCapabilities.MANAGE_ROLES, SystemCapabilities.READ_USERS]),
          ),
      });
      const handlers = createAdminGrantsHandlers(deps);
      const { req, res } = createReqRes({ body: validBody });

      await handlers.assignGrant(req, res);

      expect(deps.getHeldCapabilities).toHaveBeenCalledWith(
        expect.objectContaining({
          capabilities: expect.arrayContaining([SystemCapabilities.MANAGE_ROLES]),
        }),
      );
    });

    it('rejects group principal type before checking capabilities', async () => {
      const deps = createDeps();
      const handlers = createAdminGrantsHandlers(deps);
      const { req, res, status, json } = createReqRes({
        body: {
          principalType: PrincipalType.GROUP,
          principalId: validObjectId,
          capability: SystemCapabilities.READ_USERS,
        },
      });

      await handlers.assignGrant(req, res);

      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith({ error: 'Invalid principal type' });
      expect(deps.getHeldCapabilities).not.toHaveBeenCalled();
    });

    it('rejects user principal type before checking capabilities', async () => {
      const deps = createDeps();
      const handlers = createAdminGrantsHandlers(deps);
      const { req, res, status, json } = createReqRes({
        body: {
          principalType: PrincipalType.USER,
          principalId: validObjectId,
          capability: SystemCapabilities.READ_USERS,
        },
      });

      await handlers.assignGrant(req, res);

      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith({ error: 'Invalid principal type' });
      expect(deps.getHeldCapabilities).not.toHaveBeenCalled();
    });

    it('returns 400 when role does not exist', async () => {
      const deps = createDeps({
        checkRoleExists: jest.fn().mockResolvedValue(false),
      });
      const handlers = createAdminGrantsHandlers(deps);
      const { req, res, status, json } = createReqRes({ body: validBody });

      await handlers.assignGrant(req, res);

      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith({ error: 'Role not found' });
      expect(deps.grantCapability).not.toHaveBeenCalled();
    });

    it('skips role existence check when checkRoleExists is not provided', async () => {
      const { checkRoleExists: _, ...depsWithoutCheck } = createDeps();
      const deps = { ...depsWithoutCheck, checkRoleExists: undefined };
      const handlers = createAdminGrantsHandlers(deps as AdminGrantsDeps);
      const { req, res, status } = createReqRes({ body: validBody });

      await handlers.assignGrant(req, res);

      expect(status).toHaveBeenCalledWith(201);
    });

    it('returns 500 when checkRoleExists throws', async () => {
      const deps = createDeps({
        checkRoleExists: jest.fn().mockRejectedValue(new Error('db error')),
      });
      const handlers = createAdminGrantsHandlers(deps);
      const { req, res, status, json } = createReqRes({ body: validBody });

      await handlers.assignGrant(req, res);

      expect(status).toHaveBeenCalledWith(500);
      expect(json).toHaveBeenCalledWith({ error: 'Failed to assign grant' });
    });

    it('returns 500 when grantCapability returns null', async () => {
      const deps = createDeps({
        grantCapability: jest.fn().mockResolvedValue({ grant: null, created: false }),
      });
      const handlers = createAdminGrantsHandlers(deps);
      const { req, res, status, json } = createReqRes({ body: validBody });

      await handlers.assignGrant(req, res);

      expect(status).toHaveBeenCalledWith(500);
      expect(json).toHaveBeenCalledWith({ error: 'Grant operation returned no result' });
    });

    it('returns 500 on unexpected error', async () => {
      const deps = createDeps({
        grantCapability: jest.fn().mockRejectedValue(new Error('db error')),
      });
      const handlers = createAdminGrantsHandlers(deps);
      const { req, res, status, json } = createReqRes({ body: validBody });

      await handlers.assignGrant(req, res);

      expect(status).toHaveBeenCalledWith(500);
      expect(json).toHaveBeenCalledWith({ error: 'Failed to assign grant' });
    });
  });

  describe('revokeGrant', () => {
    const validParams = {
      principalType: PrincipalType.ROLE,
      principalId: 'editor',
      capability: SystemCapabilities.READ_USERS,
    };

    it('returns 200 idempotently and skips audit emission when the grant does not exist', async () => {
      const recordAuditEntry = jest.fn().mockResolvedValue(undefined);
      const deps = createDeps({
        revokeCapability: jest.fn().mockResolvedValue({ deletedCount: 0 }),
        recordAuditEntry,
      });
      const handlers = createAdminGrantsHandlers(deps);
      const { req, res, status, json } = createReqRes({ params: validParams });

      await handlers.revokeGrant(req, res);

      expect(status).toHaveBeenCalledWith(200);
      expect(json).toHaveBeenCalledWith({ success: true });
      /** A no-op revoke must not produce an audit row. The whole point of the
       * `deletedCount > 0` gate is to avoid logging fictitious revocations. */
      expect(recordAuditEntry).not.toHaveBeenCalled();
    });

    it('revokes a grant and returns 200', async () => {
      const deps = createDeps();
      const handlers = createAdminGrantsHandlers(deps);
      const { req, res, status, json } = createReqRes({ params: validParams });

      await handlers.revokeGrant(req, res);

      expect(deps.revokeCapability).toHaveBeenCalledWith(
        expect.objectContaining({
          principalType: PrincipalType.ROLE,
          principalId: 'editor',
          capability: SystemCapabilities.READ_USERS,
        }),
      );
      expect(status).toHaveBeenCalledWith(200);
      expect(json).toHaveBeenCalledWith({ success: true });
    });

    it('passes tenantId to dep calls', async () => {
      const deps = createDeps();
      const handlers = createAdminGrantsHandlers(deps);
      const { req, res } = createReqRes({
        params: validParams,
        user: { _id: new Types.ObjectId(), role: 'admin', tenantId: 'tenant-1' },
      });

      await handlers.revokeGrant(req, res);

      expect(deps.hasCapabilityForPrincipals).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: 'tenant-1' }),
      );
      expect(deps.revokeCapability).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: 'tenant-1' }),
      );
    });

    it('accepts section-level config capability with colons', async () => {
      const deps = createDeps();
      const handlers = createAdminGrantsHandlers(deps);
      const { req, res, status } = createReqRes({
        params: { ...validParams, capability: 'manage:configs:endpoints' },
      });

      await handlers.revokeGrant(req, res);

      expect(status).toHaveBeenCalledWith(200);
      expect(deps.revokeCapability).toHaveBeenCalledWith(
        expect.objectContaining({ capability: 'manage:configs:endpoints' }),
      );
    });

    it('returns 400 for missing principalType', async () => {
      const deps = createDeps();
      const handlers = createAdminGrantsHandlers(deps);
      const { req, res, status, json } = createReqRes({
        params: {
          principalType: '',
          principalId: 'editor',
          capability: SystemCapabilities.READ_USERS,
        },
      });

      await handlers.revokeGrant(req, res);

      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith({ error: 'Invalid principal type' });
    });

    it('returns 400 for missing principalId', async () => {
      const deps = createDeps();
      const handlers = createAdminGrantsHandlers(deps);
      const { req, res, status, json } = createReqRes({
        params: {
          principalType: PrincipalType.ROLE,
          principalId: '',
          capability: SystemCapabilities.READ_USERS,
        },
      });

      await handlers.revokeGrant(req, res);

      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith({ error: 'Principal ID is required' });
    });

    it('returns 400 for invalid capability', async () => {
      const deps = createDeps();
      const handlers = createAdminGrantsHandlers(deps);
      const { req, res, status, json } = createReqRes({
        params: { ...validParams, capability: 'fake' },
      });

      await handlers.revokeGrant(req, res);

      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith({ error: 'Invalid capability' });
    });

    it('returns 400 for missing capability param', async () => {
      const deps = createDeps();
      const handlers = createAdminGrantsHandlers(deps);
      const { req, res, status, json } = createReqRes({
        params: { principalType: PrincipalType.ROLE, principalId: 'editor' },
      });

      await handlers.revokeGrant(req, res);

      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith({ error: 'Invalid capability' });
    });

    it('returns 401 when user is not authenticated', async () => {
      const deps = createDeps();
      const handlers = createAdminGrantsHandlers(deps);
      const { req, res, status, json } = createReqRes({ params: validParams });
      (req as unknown as Record<string, unknown>).user = undefined;

      await handlers.revokeGrant(req, res);

      expect(status).toHaveBeenCalledWith(401);
      expect(json).toHaveBeenCalledWith({ error: 'Authentication required' });
      expect(deps.revokeCapability).not.toHaveBeenCalled();
    });

    it('returns 403 when caller lacks manage capability', async () => {
      const deps = createDeps({
        hasCapabilityForPrincipals: jest.fn().mockResolvedValue(false),
      });
      const handlers = createAdminGrantsHandlers(deps);
      const { req, res, status, json } = createReqRes({ params: validParams });

      await handlers.revokeGrant(req, res);

      expect(status).toHaveBeenCalledWith(403);
      expect(json).toHaveBeenCalledWith({ error: 'Insufficient permissions' });
      expect(deps.revokeCapability).not.toHaveBeenCalled();
    });

    it('returns 400 for group principal type', async () => {
      const deps = createDeps();
      const handlers = createAdminGrantsHandlers(deps);
      const { req, res, status, json } = createReqRes({
        params: {
          principalType: PrincipalType.GROUP,
          principalId: validObjectId,
          capability: SystemCapabilities.READ_USERS,
        },
      });

      await handlers.revokeGrant(req, res);

      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith({ error: 'Invalid principal type' });
    });

    it('returns 400 for user principal type', async () => {
      const deps = createDeps();
      const handlers = createAdminGrantsHandlers(deps);
      const { req, res, status, json } = createReqRes({
        params: {
          principalType: PrincipalType.USER,
          principalId: validObjectId,
          capability: SystemCapabilities.READ_USERS,
        },
      });

      await handlers.revokeGrant(req, res);

      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith({ error: 'Invalid principal type' });
    });

    it('returns 500 on unexpected error', async () => {
      const deps = createDeps({
        revokeCapability: jest.fn().mockRejectedValue(new Error('db error')),
      });
      const handlers = createAdminGrantsHandlers(deps);
      const { req, res, status, json } = createReqRes({ params: validParams });

      await handlers.revokeGrant(req, res);

      expect(status).toHaveBeenCalledWith(500);
      expect(json).toHaveBeenCalledWith({ error: 'Failed to revoke grant' });
    });
  });

  describe('audit emission', () => {
    const assignBody = {
      principalType: PrincipalType.ROLE,
      principalId: 'editor',
      capability: SystemCapabilities.READ_USERS,
    };

    function reqUser(overrides: { name?: string; username?: string; email?: string } = {}) {
      return {
        _id: new Types.ObjectId(),
        role: 'admin',
        tenantId: 'tenant-1',
        ...overrides,
      } as { _id: Types.ObjectId; role: string; tenantId?: string };
    }

    it('emits a grant.assigned entry after a successful assignment', async () => {
      const recordAuditEntry = jest.fn().mockResolvedValue(undefined);
      const deps = createDeps({ recordAuditEntry });
      const handlers = createAdminGrantsHandlers(deps);
      const user = reqUser({ name: 'Alice Admin' });
      const { req, res } = createReqRes({ body: assignBody, user });

      await handlers.assignGrant(req, res);

      expect(recordAuditEntry).toHaveBeenCalledTimes(1);
      expect(recordAuditEntry).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'grant.assigned',
          outcome: 'success',
          actor: { type: 'user', id: user._id.toString(), name: 'Alice Admin' },
          /** ROLE targets carry the human-readable name in `principalId`, so the
           * audit target id and name are both that role name. */
          target: { type: PrincipalType.ROLE, id: 'editor', name: 'editor' },
          metadata: { capability: SystemCapabilities.READ_USERS },
          tenantId: 'tenant-1',
        }),
      );
    });

    it('emits a grant.removed entry when deletedCount > 0', async () => {
      const recordAuditEntry = jest.fn().mockResolvedValue(undefined);
      const deps = createDeps({
        revokeCapability: jest.fn().mockResolvedValue({ deletedCount: 1 }),
        recordAuditEntry,
      });
      const handlers = createAdminGrantsHandlers(deps);
      const user = reqUser({ username: 'alice' });
      const { req, res } = createReqRes({ params: assignBody, user });

      await handlers.revokeGrant(req, res);

      expect(recordAuditEntry).toHaveBeenCalledTimes(1);
      expect(recordAuditEntry).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'grant.removed',
          actor: expect.objectContaining({ type: 'user', name: 'alice' }),
          target: { type: PrincipalType.ROLE, id: 'editor', name: 'editor' },
        }),
      );
    });

    it('does not emit when recordAuditEntry is not configured', async () => {
      const deps = createDeps();
      const handlers = createAdminGrantsHandlers(deps);
      const { req, res, status } = createReqRes({ body: assignBody, user: reqUser() });

      await handlers.assignGrant(req, res);

      expect(status).toHaveBeenCalledWith(201);
    });

    it('does not audit re-assigning a capability the role already holds', async () => {
      const recordAuditEntry = jest.fn().mockResolvedValue(undefined);
      const deps = createDeps({
        recordAuditEntry,
        // the upsert reports created:false → idempotent re-assert, no change
        grantCapability: jest.fn().mockResolvedValue({ grant: mockGrant(), created: false }),
      });
      const handlers = createAdminGrantsHandlers(deps);
      const { req, res, status } = createReqRes({ body: assignBody, user: reqUser() });

      await handlers.assignGrant(req, res);

      expect(status).toHaveBeenCalledWith(201);
      expect(recordAuditEntry).not.toHaveBeenCalled();
    });

    it('fail-open: a failed audit write does not fail the grant', async () => {
      const recordAuditEntry = jest.fn().mockRejectedValue(new Error('audit down'));
      const deps = createDeps({ recordAuditEntry });
      const handlers = createAdminGrantsHandlers(deps);
      const { req, res, status } = createReqRes({ body: assignBody, user: reqUser() });

      await handlers.assignGrant(req, res);

      expect(status).toHaveBeenCalledWith(201);
    });

    it('fail-closed: a failed assign audit rolls back the grant and 500s', async () => {
      const recordAuditEntry = jest.fn().mockRejectedValue(new Error('audit down'));
      const deps = createDeps({ recordAuditEntry, auditFailClosed: true });
      const handlers = createAdminGrantsHandlers(deps);
      const { req, res, status } = createReqRes({ body: assignBody, user: reqUser() });

      await handlers.assignGrant(req, res);

      expect(recordAuditEntry).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ failClosed: true }),
      );
      // compensating rollback removes the grant we just created
      expect(deps.revokeCapability).toHaveBeenCalledWith(
        expect.objectContaining({
          principalType: PrincipalType.ROLE,
          principalId: 'editor',
          capability: SystemCapabilities.READ_USERS,
        }),
      );
      expect(status).toHaveBeenCalledWith(500);
    });

    it('fail-closed: a failed revoke audit restores the grant and 500s', async () => {
      const recordAuditEntry = jest.fn().mockRejectedValue(new Error('audit down'));
      const grantCapability = jest.fn().mockResolvedValue({ grant: { id: 'g1' }, created: true });
      const deps = createDeps({
        recordAuditEntry,
        auditFailClosed: true,
        grantCapability,
        revokeCapability: jest.fn().mockResolvedValue({ deletedCount: 1 }),
      });
      const handlers = createAdminGrantsHandlers(deps);
      const { req, res, status } = createReqRes({ params: assignBody, user: reqUser() });

      await handlers.revokeGrant(req, res);

      // compensating re-grant restores access removed before the audit failed
      expect(grantCapability).toHaveBeenCalledWith(
        expect.objectContaining({
          principalType: PrincipalType.ROLE,
          principalId: 'editor',
          capability: SystemCapabilities.READ_USERS,
        }),
      );
      expect(status).toHaveBeenCalledWith(500);
    });
  });
});
