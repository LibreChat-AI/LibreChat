import { Types } from 'mongoose';
import { RoleDeletionError } from '@librechat/data-schemas';
import { PrincipalType, SystemRoles, promptPermissionsSchema } from 'librechat-data-provider';
import type { IRole, IUser } from '@librechat/data-schemas';
import type { Response } from 'express';
import type { ServerRequest } from '~/types/http';
import type { AdminRolesDeps } from './roles';
import { createAdminRolesHandlers, createRolePermissionsUpdateHandler } from './roles';

const { RoleConflictError } = jest.requireActual('@librechat/data-schemas');
const { logger } = jest.requireMock('@librechat/data-schemas');

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

const validUserId = new Types.ObjectId().toString();

function mockRole(overrides: Partial<IRole> = {}): IRole {
  return {
    name: 'editor',
    description: 'Can edit content',
    permissions: {},
    ...overrides,
  } as IRole;
}

function mockUser(overrides: Partial<IUser> = {}): IUser {
  return {
    _id: new Types.ObjectId(validUserId),
    name: 'Test User',
    email: 'test@example.com',
    avatar: 'https://example.com/avatar.png',
    role: 'editor',
    ...overrides,
  } as IUser;
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
    user: overrides.user,
  } as unknown as ServerRequest;

  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const res = { status, json } as unknown as Response;

  return { req, res, status, json };
}

function createDeps(overrides: Partial<AdminRolesDeps> = {}): AdminRolesDeps {
  return {
    listRoles: jest.fn().mockResolvedValue([]),
    countRoles: jest.fn().mockResolvedValue(0),
    getRoleByName: jest.fn().mockResolvedValue(null),
    createRoleByName: jest.fn().mockResolvedValue(mockRole()),
    updateRoleByName: jest.fn().mockResolvedValue(mockRole()),
    updateAccessPermissions: jest.fn().mockResolvedValue(undefined),
    deleteRoleByName: jest.fn().mockResolvedValue({
      role: mockRole(),
      reassignedUserIds: ['uid-1', 'uid-2'],
    }),
    findUser: jest.fn().mockResolvedValue(null),
    updateUser: jest.fn().mockResolvedValue(mockUser()),
    updateUsersByRole: jest.fn().mockResolvedValue(undefined),
    findUserIdsByRole: jest.fn().mockResolvedValue(['uid-1', 'uid-2']),
    updateUsersRoleByIds: jest.fn().mockResolvedValue(undefined),
    listUsersByRole: jest.fn().mockResolvedValue([]),
    countUsersByRole: jest.fn().mockResolvedValue(0),
    deleteConfig: jest.fn().mockResolvedValue(null),
    deleteAclEntries: jest.fn().mockResolvedValue(undefined),
    deleteGrantsForPrincipal: jest.fn().mockResolvedValue([]),
    ...overrides,
  };
}

describe('createAdminRolesHandlers', () => {
  describe('listRoles', () => {
    it('returns paginated roles with 200', async () => {
      const roles = [mockRole()];
      const deps = createDeps({
        listRoles: jest.fn().mockResolvedValue(roles),
        countRoles: jest.fn().mockResolvedValue(1),
      });
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status, json } = createReqRes();

      await handlers.listRoles(req, res);

      expect(status).toHaveBeenCalledWith(200);
      expect(json).toHaveBeenCalledWith({ roles, total: 1, limit: 50, offset: 0 });
      expect(deps.listRoles).toHaveBeenCalledWith({ limit: 50, offset: 0 });
    });

    it('passes custom limit and offset from query', async () => {
      const deps = createDeps({
        countRoles: jest.fn().mockResolvedValue(100),
      });
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status, json } = createReqRes({
        query: { limit: '25', offset: '50' },
      });

      await handlers.listRoles(req, res);

      expect(status).toHaveBeenCalledWith(200);
      expect(json).toHaveBeenCalledWith({ roles: [], total: 100, limit: 25, offset: 50 });
      expect(deps.listRoles).toHaveBeenCalledWith({ limit: 25, offset: 50 });
    });

    it('clamps limit to 200', async () => {
      const deps = createDeps();
      const handlers = createAdminRolesHandlers(deps);
      const { req, res } = createReqRes({ query: { limit: '999' } });

      await handlers.listRoles(req, res);

      expect(deps.listRoles).toHaveBeenCalledWith({ limit: 200, offset: 0 });
    });

    it('clamps negative offset to 0', async () => {
      const deps = createDeps();
      const handlers = createAdminRolesHandlers(deps);
      const { req, res } = createReqRes({ query: { offset: '-5' } });

      await handlers.listRoles(req, res);

      expect(deps.listRoles).toHaveBeenCalledWith({ limit: 50, offset: 0 });
    });

    it('treats non-numeric limit as default', async () => {
      const deps = createDeps();
      const handlers = createAdminRolesHandlers(deps);
      const { req, res } = createReqRes({ query: { limit: 'abc' } });

      await handlers.listRoles(req, res);

      expect(deps.listRoles).toHaveBeenCalledWith({ limit: 50, offset: 0 });
    });

    it('clamps limit=0 to 1', async () => {
      const deps = createDeps();
      const handlers = createAdminRolesHandlers(deps);
      const { req, res } = createReqRes({ query: { limit: '0' } });

      await handlers.listRoles(req, res);

      expect(deps.listRoles).toHaveBeenCalledWith({ limit: 1, offset: 0 });
    });

    it('truncates float offset to integer', async () => {
      const deps = createDeps();
      const handlers = createAdminRolesHandlers(deps);
      const { req, res } = createReqRes({ query: { offset: '1.7' } });

      await handlers.listRoles(req, res);

      expect(deps.listRoles).toHaveBeenCalledWith({ limit: 50, offset: 1 });
    });

    it('returns 500 on error', async () => {
      const deps = createDeps({ listRoles: jest.fn().mockRejectedValue(new Error('db down')) });
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status, json } = createReqRes();

      await handlers.listRoles(req, res);

      expect(status).toHaveBeenCalledWith(500);
      expect(json).toHaveBeenCalledWith({ error: 'Failed to list roles' });
    });
  });

  describe('getRole', () => {
    it('returns role with 200', async () => {
      const role = mockRole();
      const deps = createDeps({ getRoleByName: jest.fn().mockResolvedValue(role) });
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status, json } = createReqRes({ params: { name: 'editor' } });

      await handlers.getRole(req, res);

      expect(status).toHaveBeenCalledWith(200);
      expect(json).toHaveBeenCalledWith({ role });
    });

    it('returns 404 when role not found', async () => {
      const deps = createDeps({ getRoleByName: jest.fn().mockResolvedValue(null) });
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status, json } = createReqRes({ params: { name: 'nonexistent' } });

      await handlers.getRole(req, res);

      expect(status).toHaveBeenCalledWith(404);
      expect(json).toHaveBeenCalledWith({ error: 'Role not found' });
    });

    it('returns 500 on error', async () => {
      const deps = createDeps({
        getRoleByName: jest.fn().mockRejectedValue(new Error('db down')),
      });
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status, json } = createReqRes({ params: { name: 'editor' } });

      await handlers.getRole(req, res);

      expect(status).toHaveBeenCalledWith(500);
      expect(json).toHaveBeenCalledWith({ error: 'Failed to get role' });
    });
  });

  describe('createRole', () => {
    it('creates role and returns 201', async () => {
      const role = mockRole();
      const deps = createDeps({ createRoleByName: jest.fn().mockResolvedValue(role) });
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status, json } = createReqRes({
        body: { name: 'editor', description: 'Can edit' },
      });

      await handlers.createRole(req, res);

      expect(status).toHaveBeenCalledWith(201);
      expect(json).toHaveBeenCalledWith({ role });
      expect(deps.createRoleByName).toHaveBeenCalledWith({
        name: 'editor',
        description: 'Can edit',
        permissions: {},
      });
    });

    it('passes provided permissions to createRoleByName', async () => {
      const perms = { chat: { read: true, write: false } } as unknown as IRole['permissions'];
      const role = mockRole({ permissions: perms });
      const deps = createDeps({ createRoleByName: jest.fn().mockResolvedValue(role) });
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status, json } = createReqRes({
        body: { name: 'editor', permissions: perms },
      });

      await handlers.createRole(req, res);

      expect(status).toHaveBeenCalledWith(201);
      expect(json).toHaveBeenCalledWith({ role });
      expect(deps.createRoleByName).toHaveBeenCalledWith({
        name: 'editor',
        permissions: perms,
      });
    });

    it('returns 400 when name is missing', async () => {
      const deps = createDeps();
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status, json } = createReqRes({ body: {} });

      await handlers.createRole(req, res);

      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith({ error: 'name is required' });
      expect(deps.createRoleByName).not.toHaveBeenCalled();
    });

    it('returns 400 when name is whitespace-only', async () => {
      const deps = createDeps();
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status, json } = createReqRes({ body: { name: '   ' } });

      await handlers.createRole(req, res);

      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith({ error: 'name is required' });
    });

    it('returns 400 when name contains control characters', async () => {
      const deps = createDeps();
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status, json } = createReqRes({ body: { name: 'bad\x00name' } });

      await handlers.createRole(req, res);

      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith({ error: 'name contains invalid characters' });
      expect(deps.createRoleByName).not.toHaveBeenCalled();
    });

    it('returns 400 when name is a reserved path segment', async () => {
      const deps = createDeps();
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status, json } = createReqRes({ body: { name: 'members' } });

      await handlers.createRole(req, res);

      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith({
        error: 'name is a reserved path segment',
        code: 'ROLE_NAME_RESERVED',
      });
      expect(deps.createRoleByName).not.toHaveBeenCalled();
    });

    it('returns 400 when name is the base config principal id', async () => {
      const deps = createDeps();
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status, json } = createReqRes({ body: { name: ' __base__ ' } });

      await handlers.createRole(req, res);

      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith({
        error: 'name is reserved for the base config',
        code: 'ROLE_NAME_RESERVED',
      });
      expect(deps.createRoleByName).not.toHaveBeenCalled();
    });

    it('returns 400 when name exceeds max length', async () => {
      const deps = createDeps();
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status, json } = createReqRes({
        body: { name: 'a'.repeat(501) },
      });

      await handlers.createRole(req, res);

      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith({ error: 'name must not exceed 500 characters' });
      expect(deps.createRoleByName).not.toHaveBeenCalled();
    });

    it('returns 400 when description exceeds max length', async () => {
      const deps = createDeps();
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status, json } = createReqRes({
        body: { name: 'editor', description: 'a'.repeat(2001) },
      });

      await handlers.createRole(req, res);

      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith({
        error: 'description must not exceed 2000 characters',
      });
      expect(deps.createRoleByName).not.toHaveBeenCalled();
    });

    it('returns 409 when role already exists', async () => {
      const deps = createDeps({
        createRoleByName: jest
          .fn()
          .mockRejectedValue(new RoleConflictError('Role "editor" already exists')),
      });
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status, json } = createReqRes({ body: { name: 'editor' } });

      await handlers.createRole(req, res);

      expect(status).toHaveBeenCalledWith(409);
      expect(json).toHaveBeenCalledWith({ error: 'Role "editor" already exists' });
    });

    it('returns 409 when name is reserved system role', async () => {
      const deps = createDeps({
        createRoleByName: jest
          .fn()
          .mockRejectedValue(
            new RoleConflictError('Cannot create role with reserved system name: ADMIN'),
          ),
      });
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status, json } = createReqRes({ body: { name: 'ADMIN' } });

      await handlers.createRole(req, res);

      expect(status).toHaveBeenCalledWith(409);
      expect(json).toHaveBeenCalledWith({
        error: 'Cannot create role with reserved system name: ADMIN',
      });
    });

    it('returns 500 on unexpected error', async () => {
      const deps = createDeps({
        createRoleByName: jest.fn().mockRejectedValue(new Error('db crash')),
      });
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status, json } = createReqRes({ body: { name: 'editor' } });

      await handlers.createRole(req, res);

      expect(status).toHaveBeenCalledWith(500);
      expect(json).toHaveBeenCalledWith({ error: 'Failed to create role' });
    });

    it('does not classify unrelated errors as 409', async () => {
      const deps = createDeps({
        createRoleByName: jest
          .fn()
          .mockRejectedValue(new Error('Disk space reserved for system use')),
      });
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status } = createReqRes({ body: { name: 'test' } });

      await handlers.createRole(req, res);

      expect(status).toHaveBeenCalledWith(500);
    });

    it('returns 400 when description is not a string', async () => {
      const deps = createDeps();
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status, json } = createReqRes({
        body: { name: 'editor', description: 123 },
      });

      await handlers.createRole(req, res);

      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith({ error: 'description must be a string' });
      expect(deps.createRoleByName).not.toHaveBeenCalled();
    });

    it('returns 400 when permissions is an array', async () => {
      const deps = createDeps();
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status, json } = createReqRes({
        body: { name: 'editor', permissions: [1, 2, 3] },
      });

      await handlers.createRole(req, res);

      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith({ error: 'permissions must be an object' });
      expect(deps.createRoleByName).not.toHaveBeenCalled();
    });
  });

  describe('updateRole', () => {
    it('updates role and returns 200', async () => {
      const role = mockRole({ name: 'senior-editor' });
      const existing = mockRole({ _id: new Types.ObjectId() } as Partial<IRole>);
      const deps = createDeps({
        getRoleByName: jest.fn().mockResolvedValueOnce(existing).mockResolvedValueOnce(null),
        updateRoleByName: jest.fn().mockResolvedValue(role),
      });
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status, json } = createReqRes({
        params: { name: 'editor' },
        body: { name: 'senior-editor' },
      });

      await handlers.updateRole(req, res);

      expect(status).toHaveBeenCalledWith(200);
      expect(json).toHaveBeenCalledWith({ role });
      /** The rename writes the role document it read, not another tenant's of that name. */
      expect(deps.updateRoleByName).toHaveBeenCalledWith(
        'editor',
        { name: 'senior-editor' },
        { id: String(existing._id) },
      );
    });

    it('writes and audits nothing when the description already matches', async () => {
      const recordAuditEntry = jest.fn().mockResolvedValue(undefined);
      const deps = createDeps({
        recordAuditEntry,
        getRoleByName: jest.fn().mockResolvedValue(mockRole({ description: 'Can edit content' })),
      });
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status } = createReqRes({
        params: { name: 'editor' },
        body: { description: 'Can edit content' },
        user: { _id: new Types.ObjectId(), role: 'admin' },
      });

      await handlers.updateRole(req, res);

      expect(status).toHaveBeenCalledWith(200);
      expect(deps.updateRoleByName).not.toHaveBeenCalled();
      expect(recordAuditEntry).not.toHaveBeenCalled();
    });

    it('trims name before storage', async () => {
      const role = mockRole({ name: 'trimmed' });
      const deps = createDeps({
        getRoleByName: jest.fn().mockResolvedValueOnce(mockRole()).mockResolvedValueOnce(null),
        updateRoleByName: jest.fn().mockResolvedValue(role),
      });
      const handlers = createAdminRolesHandlers(deps);
      const { req, res } = createReqRes({
        params: { name: 'editor' },
        body: { name: '  trimmed  ' },
      });

      await handlers.updateRole(req, res);

      expect(deps.updateRoleByName).toHaveBeenCalledWith('editor', { name: 'trimmed' }, undefined);
    });

    it('migrates users before renaming role', async () => {
      const role = mockRole({ name: 'new-name' });
      const callOrder: string[] = [];
      const deps = createDeps({
        getRoleByName: jest.fn().mockResolvedValueOnce(mockRole()).mockResolvedValueOnce(null),
        findUserIdsByRole: jest.fn().mockImplementation(() => {
          callOrder.push('findUserIdsByRole');
          return Promise.resolve(['uid-1']);
        }),
        updateUsersByRole: jest.fn().mockImplementation(() => {
          callOrder.push('updateUsersByRole');
          return Promise.resolve();
        }),
        updateRoleByName: jest.fn().mockImplementation(() => {
          callOrder.push('updateRoleByName');
          return Promise.resolve(role);
        }),
      });
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status } = createReqRes({
        params: { name: 'editor' },
        body: { name: 'new-name' },
      });

      await handlers.updateRole(req, res);

      expect(status).toHaveBeenCalledWith(200);
      expect(deps.findUserIdsByRole).toHaveBeenCalledWith('editor');
      expect(deps.updateUsersByRole).toHaveBeenCalledWith('editor', 'new-name');
      expect(callOrder).toEqual(['findUserIdsByRole', 'updateUsersByRole', 'updateRoleByName']);
    });

    it('does not rename role when user migration fails', async () => {
      const deps = createDeps({
        getRoleByName: jest.fn().mockResolvedValueOnce(mockRole()).mockResolvedValueOnce(null),
        updateUsersByRole: jest.fn().mockRejectedValue(new Error('migration failed')),
      });
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status } = createReqRes({
        params: { name: 'editor' },
        body: { name: 'new-name' },
      });

      await handlers.updateRole(req, res);

      expect(status).toHaveBeenCalledWith(500);
      expect(deps.updateRoleByName).not.toHaveBeenCalled();
    });

    it('does not migrate users when name unchanged', async () => {
      const role = mockRole({ description: 'updated' });
      const deps = createDeps({
        getRoleByName: jest.fn().mockResolvedValue(mockRole()),
        updateRoleByName: jest.fn().mockResolvedValue(role),
      });
      const handlers = createAdminRolesHandlers(deps);
      const { req, res } = createReqRes({
        params: { name: 'editor' },
        body: { description: 'updated' },
      });

      await handlers.updateRole(req, res);

      expect(deps.updateUsersByRole).not.toHaveBeenCalled();
    });

    it('renames and updates description in a single request', async () => {
      const role = mockRole({ name: 'senior-editor', description: 'Updated desc' });
      const deps = createDeps({
        getRoleByName: jest.fn().mockResolvedValueOnce(mockRole()).mockResolvedValueOnce(null),
        updateRoleByName: jest.fn().mockResolvedValue(role),
      });
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status, json } = createReqRes({
        params: { name: 'editor' },
        body: { name: 'senior-editor', description: 'Updated desc' },
      });

      await handlers.updateRole(req, res);

      expect(status).toHaveBeenCalledWith(200);
      expect(json).toHaveBeenCalledWith({ role });
      expect(deps.updateUsersByRole).toHaveBeenCalledWith('editor', 'senior-editor');
      expect(deps.updateRoleByName).toHaveBeenCalledWith(
        'editor',
        { name: 'senior-editor', description: 'Updated desc' },
        undefined,
      );
    });

    it('returns 403 when renaming a system role', async () => {
      const deps = createDeps();
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status, json } = createReqRes({
        params: { name: SystemRoles.ADMIN },
        body: { name: 'custom-admin' },
      });

      await handlers.updateRole(req, res);

      expect(status).toHaveBeenCalledWith(403);
      expect(json).toHaveBeenCalledWith({ error: 'Cannot rename system role' });
      expect(deps.getRoleByName).not.toHaveBeenCalled();
    });

    it('returns 403 when renaming to a system role name', async () => {
      const deps = createDeps();
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status, json } = createReqRes({
        params: { name: 'editor' },
        body: { name: SystemRoles.ADMIN },
      });

      await handlers.updateRole(req, res);

      expect(status).toHaveBeenCalledWith(403);
      expect(json).toHaveBeenCalledWith({ error: 'Cannot use a reserved system role name' });
    });

    it('returns 409 when target name already exists', async () => {
      const deps = createDeps({
        getRoleByName: jest.fn().mockResolvedValue(mockRole()),
      });
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status, json } = createReqRes({
        params: { name: 'editor' },
        body: { name: 'viewer' },
      });

      await handlers.updateRole(req, res);

      expect(status).toHaveBeenCalledWith(409);
      expect(json).toHaveBeenCalledWith({ error: 'Role "viewer" already exists' });
    });

    it('returns 400 when name is empty string', async () => {
      const deps = createDeps();
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status, json } = createReqRes({
        params: { name: 'editor' },
        body: { name: '' },
      });

      await handlers.updateRole(req, res);

      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith({ error: 'name must be a non-empty string' });
      expect(deps.getRoleByName).not.toHaveBeenCalled();
    });

    it('returns 400 when name is whitespace-only', async () => {
      const deps = createDeps();
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status, json } = createReqRes({
        params: { name: 'editor' },
        body: { name: '   ' },
      });

      await handlers.updateRole(req, res);

      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith({ error: 'name must be a non-empty string' });
    });

    it('returns 400 when name exceeds max length', async () => {
      const deps = createDeps();
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status, json } = createReqRes({
        params: { name: 'editor' },
        body: { name: 'a'.repeat(501) },
      });

      await handlers.updateRole(req, res);

      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith({ error: 'name must not exceed 500 characters' });
      expect(deps.getRoleByName).not.toHaveBeenCalled();
    });

    it('returns 404 when role not found', async () => {
      const deps = createDeps({ getRoleByName: jest.fn().mockResolvedValue(null) });
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status, json } = createReqRes({
        params: { name: 'nonexistent' },
        body: { description: 'updated' },
      });

      await handlers.updateRole(req, res);

      expect(status).toHaveBeenCalledWith(404);
      expect(json).toHaveBeenCalledWith({ error: 'Role not found' });
    });

    it('returns 404 when updateRoleByName returns null', async () => {
      const deps = createDeps({
        getRoleByName: jest.fn().mockResolvedValue(mockRole()),
        updateRoleByName: jest.fn().mockResolvedValue(null),
      });
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status, json } = createReqRes({
        params: { name: 'editor' },
        body: { description: 'updated' },
      });

      await handlers.updateRole(req, res);

      expect(status).toHaveBeenCalledWith(404);
      expect(json).toHaveBeenCalledWith({ error: 'Role not found' });
    });

    it('rolls back user migration when rename fails', async () => {
      const ids = ['uid-1', 'uid-2'];
      const deps = createDeps({
        getRoleByName: jest.fn().mockResolvedValueOnce(mockRole()).mockResolvedValueOnce(null),
        findUserIdsByRole: jest.fn().mockResolvedValue(ids),
        updateRoleByName: jest.fn().mockResolvedValue(null),
      });
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status, json } = createReqRes({
        params: { name: 'editor' },
        body: { name: 'new-name' },
      });

      await handlers.updateRole(req, res);

      expect(status).toHaveBeenCalledWith(404);
      expect(json).toHaveBeenCalledWith({ error: 'Role not found' });
      expect(deps.updateUsersByRole).toHaveBeenCalledTimes(1);
      expect(deps.updateUsersByRole).toHaveBeenCalledWith('editor', 'new-name');
      expect(deps.updateUsersRoleByIds).toHaveBeenCalledWith(ids, 'editor', {
        fromRole: 'new-name',
      });
    });

    it('rolls back user migration when rename throws', async () => {
      const ids = ['uid-1', 'uid-2'];
      const deps = createDeps({
        getRoleByName: jest.fn().mockResolvedValueOnce(mockRole()).mockResolvedValueOnce(null),
        findUserIdsByRole: jest.fn().mockResolvedValue(ids),
        updateRoleByName: jest.fn().mockRejectedValue(new Error('db crash')),
      });
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status } = createReqRes({
        params: { name: 'editor' },
        body: { name: 'new-name' },
      });

      await handlers.updateRole(req, res);

      expect(status).toHaveBeenCalledWith(500);
      expect(deps.updateUsersByRole).toHaveBeenCalledTimes(1);
      expect(deps.updateUsersByRole).toHaveBeenCalledWith('editor', 'new-name');
      expect(deps.updateUsersRoleByIds).toHaveBeenCalledWith(ids, 'editor', {
        fromRole: 'new-name',
      });
    });

    it('logs rollback failure and still returns 500', async () => {
      const deps = createDeps({
        getRoleByName: jest.fn().mockResolvedValueOnce(mockRole()).mockResolvedValueOnce(null),
        findUserIdsByRole: jest.fn().mockResolvedValue(['uid-1']),
        updateUsersRoleByIds: jest.fn().mockRejectedValue(new Error('rollback failed')),
        updateRoleByName: jest.fn().mockRejectedValue(new Error('rename failed')),
      });
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status } = createReqRes({
        params: { name: 'editor' },
        body: { name: 'new-name' },
      });

      await handlers.updateRole(req, res);

      expect(status).toHaveBeenCalledWith(500);
      expect(deps.updateUsersByRole).toHaveBeenCalledTimes(1);
      expect(deps.updateUsersRoleByIds).toHaveBeenCalledTimes(1);
    });

    it('returns 400 when description exceeds max length', async () => {
      const deps = createDeps();
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status, json } = createReqRes({
        params: { name: 'editor' },
        body: { description: 'a'.repeat(2001) },
      });

      await handlers.updateRole(req, res);

      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith({
        error: 'description must not exceed 2000 characters',
      });
      expect(deps.getRoleByName).not.toHaveBeenCalled();
    });

    it('returns 500 on unexpected error', async () => {
      const deps = createDeps({
        getRoleByName: jest.fn().mockResolvedValue(mockRole()),
        updateRoleByName: jest.fn().mockRejectedValue(new Error('db error')),
      });
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status, json } = createReqRes({
        params: { name: 'editor' },
        body: { description: 'updated' },
      });

      await handlers.updateRole(req, res);

      expect(status).toHaveBeenCalledWith(500);
      expect(json).toHaveBeenCalledWith({ error: 'Failed to update role' });
    });

    it('does not roll back when error occurs before user migration', async () => {
      const deps = createDeps({
        getRoleByName: jest
          .fn()
          .mockResolvedValueOnce(mockRole())
          .mockRejectedValueOnce(new Error('db crash')),
      });
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status } = createReqRes({
        params: { name: 'editor' },
        body: { name: 'new-name' },
      });

      await handlers.updateRole(req, res);

      expect(status).toHaveBeenCalledWith(500);
      expect(deps.updateUsersByRole).not.toHaveBeenCalled();
    });

    it('does not migrate users when findUserIdsByRole throws', async () => {
      const deps = createDeps({
        getRoleByName: jest.fn().mockResolvedValueOnce(mockRole()).mockResolvedValueOnce(null),
        findUserIdsByRole: jest.fn().mockRejectedValue(new Error('db crash')),
      });
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status } = createReqRes({
        params: { name: 'editor' },
        body: { name: 'new-name' },
      });

      await handlers.updateRole(req, res);

      expect(status).toHaveBeenCalledWith(500);
      expect(deps.updateUsersByRole).not.toHaveBeenCalled();
      expect(deps.updateUsersRoleByIds).not.toHaveBeenCalled();
    });

    it('returns existing role early when update body has no changes', async () => {
      const role = mockRole();
      const deps = createDeps({
        getRoleByName: jest.fn().mockResolvedValue(role),
      });
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status, json } = createReqRes({
        params: { name: 'editor' },
        body: {},
      });

      await handlers.updateRole(req, res);

      expect(status).toHaveBeenCalledWith(200);
      expect(json).toHaveBeenCalledWith({ role });
      expect(deps.updateRoleByName).not.toHaveBeenCalled();
    });

    it('rejects invalid description before making DB calls', async () => {
      const deps = createDeps();
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status, json } = createReqRes({
        params: { name: 'editor' },
        body: { description: 123 },
      });

      await handlers.updateRole(req, res);

      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith({ error: 'description must be a string' });
      expect(deps.getRoleByName).not.toHaveBeenCalled();
    });
  });

  describe('updateRolePermissions', () => {
    it('updates permissions and returns 200 with updated role', async () => {
      const role = mockRole();
      const updatedRole = mockRole({
        permissions: { chat: { read: true, write: true } } as IRole['permissions'],
      });
      const deps = createDeps({
        getRoleByName: jest.fn().mockResolvedValueOnce(role).mockResolvedValueOnce(updatedRole),
      });
      const handlers = createAdminRolesHandlers(deps);
      const perms = { chat: { read: true, write: true } };
      const { req, res, status, json } = createReqRes({
        params: { name: 'editor' },
        body: { permissions: perms },
      });

      await handlers.updateRolePermissions(req, res);

      expect(deps.updateAccessPermissions).toHaveBeenCalledWith('editor', perms, role);
      expect(status).toHaveBeenCalledWith(200);
      expect(json).toHaveBeenCalledWith({ role: updatedRole });
    });

    it('returns 400 when permissions is missing', async () => {
      const deps = createDeps();
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status, json } = createReqRes({
        params: { name: 'editor' },
        body: {},
      });

      await handlers.updateRolePermissions(req, res);

      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith({ error: 'permissions object is required' });
    });

    it('returns 400 when permissions is an array', async () => {
      const deps = createDeps();
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status, json } = createReqRes({
        params: { name: 'editor' },
        body: { permissions: [1, 2, 3] },
      });

      await handlers.updateRolePermissions(req, res);

      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith({ error: 'permissions object is required' });
    });

    it('returns 404 when role not found', async () => {
      const deps = createDeps({ getRoleByName: jest.fn().mockResolvedValue(null) });
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status, json } = createReqRes({
        params: { name: 'nonexistent' },
        body: { permissions: { chat: { read: true } } },
      });

      await handlers.updateRolePermissions(req, res);

      expect(status).toHaveBeenCalledWith(404);
      expect(json).toHaveBeenCalledWith({ error: 'Role not found' });
    });

    it('returns 500 on error', async () => {
      const deps = createDeps({
        getRoleByName: jest.fn().mockResolvedValue(mockRole()),
        updateAccessPermissions: jest.fn().mockRejectedValue(new Error('db down')),
      });
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status, json } = createReqRes({
        params: { name: 'editor' },
        body: { permissions: { chat: { read: true } } },
      });

      await handlers.updateRolePermissions(req, res);

      expect(status).toHaveBeenCalledWith(500);
      expect(json).toHaveBeenCalledWith({ error: 'Failed to update role permissions' });
    });
  });

  describe('deleteRole', () => {
    const deleteDeps = (overrides: Partial<AdminRolesDeps> = {}) =>
      createDeps({ getRoleByName: jest.fn().mockResolvedValue(mockRole()), ...overrides });

    it('deletes role and returns 200', async () => {
      const deps = deleteDeps();
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status, json } = createReqRes({ params: { name: 'editor' } });

      await handlers.deleteRole(req, res);

      expect(deps.deleteRoleByName).toHaveBeenCalledWith('editor', expect.any(Object));
      expect(status).toHaveBeenCalledWith(200);
      expect(json).toHaveBeenCalledWith({ success: true });
    });

    it('cleans up grants after successful deletion', async () => {
      const deps = deleteDeps();
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status } = createReqRes({ params: { name: 'editor' } });

      await handlers.deleteRole(req, res);

      expect(status).toHaveBeenCalledWith(200);
      expect(deps.deleteConfig).toHaveBeenCalledWith(PrincipalType.ROLE, 'editor');
      expect(deps.deleteAclEntries).toHaveBeenCalledWith({
        principalType: PrincipalType.ROLE,
        principalId: 'editor',
      });
      expect(deps.deleteGrantsForPrincipal).toHaveBeenCalledWith(PrincipalType.ROLE, 'editor', {
        tenantId: undefined,
      });
    });

    it('passes tenantId to grant cleanup', async () => {
      const deps = deleteDeps();
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status } = createReqRes({
        params: { name: 'editor' },
        user: { _id: new Types.ObjectId(), role: 'admin', tenantId: 'tenant-1' },
      });

      await handlers.deleteRole(req, res);

      expect(status).toHaveBeenCalledWith(200);
      expect(deps.deleteGrantsForPrincipal).toHaveBeenCalledWith(PrincipalType.ROLE, 'editor', {
        tenantId: 'tenant-1',
      });
    });

    it('does not clean up when role not found', async () => {
      const deps = deleteDeps({ getRoleByName: jest.fn().mockResolvedValue(null) });
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status } = createReqRes({ params: { name: 'nonexistent' } });

      await handlers.deleteRole(req, res);

      expect(status).toHaveBeenCalledWith(404);
      expect(deps.deleteConfig).not.toHaveBeenCalled();
      expect(deps.deleteAclEntries).not.toHaveBeenCalled();
      expect(deps.deleteGrantsForPrincipal).not.toHaveBeenCalled();
      expect(deps.deleteRoleByName).not.toHaveBeenCalled();
    });

    it('removes grants, ACL entries and config before deleting the role', async () => {
      const order: string[] = [];
      const track = (name: string, value: unknown) =>
        jest.fn().mockImplementation(async () => {
          order.push(name);
          return value;
        });
      const deps = deleteDeps({
        deleteConfig: track('config', null),
        deleteAclEntries: track('acl', undefined),
        deleteGrantsForPrincipal: track('grants', []),
        deleteRoleByName: track('role', { role: mockRole(), reassignedUserIds: [] }),
      });
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status } = createReqRes({ params: { name: 'editor' } });

      await handlers.deleteRole(req, res);

      expect(status).toHaveBeenCalledWith(200);
      expect(order[order.length - 1]).toBe('role');
      expect(order).toHaveLength(4);
    });

    it('returns 500 and keeps the role when grant cleanup fails', async () => {
      const recordAuditEntry = jest.fn().mockResolvedValue(undefined);
      const deps = deleteDeps({
        deleteGrantsForPrincipal: jest.fn().mockRejectedValue(new Error('cleanup failed')),
        recordAuditEntry,
      });
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status, json } = createReqRes({
        params: { name: 'editor' },
        user: { _id: new Types.ObjectId(), role: 'admin' },
      });

      await handlers.deleteRole(req, res);

      expect(status).toHaveBeenCalledWith(500);
      expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: 'ROLE_CLEANUP_FAILED' }));
      expect(deps.deleteRoleByName).not.toHaveBeenCalled();
      expect(recordAuditEntry).not.toHaveBeenCalledWith(
        expect.objectContaining({ action: 'role.deleted', outcome: 'success' }),
      );
    });

    it('restores config but leaves ACL entries and grants removed, and audits the grants, when a cleanup step fails', async () => {
      const recordAuditEntry = jest.fn().mockResolvedValue(undefined);
      const config = {
        principalModel: 'Role',
        overrides: { interface: { customWelcome: 'hi' } },
        priority: 7,
      };
      const deps = deleteDeps({
        deleteConfig: jest.fn().mockResolvedValue(config),
        deleteAclEntries: jest.fn().mockRejectedValue(new Error('acl cleanup failed')),
        deleteGrantsForPrincipal: jest.fn().mockResolvedValue([{ capability: 'read:users' }]),
        restoreConfig: jest.fn().mockResolvedValue(true),
        recordAuditEntry,
      });
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status, json } = createReqRes({
        params: { name: 'editor' },
        user: { _id: new Types.ObjectId(), role: 'admin' },
      });

      await handlers.deleteRole(req, res);

      expect(status).toHaveBeenCalledWith(500);
      expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: 'ROLE_CLEANUP_FAILED' }));
      expect(deps.deleteRoleByName).not.toHaveBeenCalled();
      expect(deps.restoreConfig).toHaveBeenCalledWith(config);
      expect(deps.deleteAclEntries).toHaveBeenCalledTimes(1);
      expect(deps.deleteGrantsForPrincipal).toHaveBeenCalledTimes(1);
      expect(recordAuditEntry).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'grant.removed' }),
      );
      expect(recordAuditEntry).toHaveBeenLastCalledWith(
        expect.objectContaining({
          action: 'role.deleted',
          outcome: 'failure',
          metadata: { code: 'ROLE_CLEANUP_FAILED' },
        }),
      );
      expect(recordAuditEntry).not.toHaveBeenCalledWith(
        expect.objectContaining({ action: 'role.deleted', outcome: 'success' }),
      );
    });

    it('skips the config restore when cleanup fails after the role was deleted by another request', async () => {
      const deps = deleteDeps({
        getRoleByName: jest.fn().mockResolvedValueOnce(mockRole()).mockResolvedValue(null),
        deleteConfig: jest.fn().mockResolvedValue({ principalModel: 'Role', overrides: {} }),
        deleteAclEntries: jest.fn().mockRejectedValue(new Error('acl cleanup failed')),
        restoreConfig: jest.fn().mockResolvedValue(true),
      });
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status, json } = createReqRes({ params: { name: 'editor' } });

      await handlers.deleteRole(req, res);

      expect(status).toHaveBeenCalledWith(500);
      expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: 'ROLE_CLEANUP_FAILED' }));
      expect(deps.restoreConfig).not.toHaveBeenCalled();
    });

    it('restores only the config override when the role deletion itself fails', async () => {
      const deps = deleteDeps({
        deleteConfig: jest.fn().mockResolvedValue({
          principalModel: 'Role',
          overrides: {},
          priority: 3,
        }),
        deleteGrantsForPrincipal: jest.fn().mockResolvedValue([{ capability: 'read:users' }]),
        getRoleByName: jest.fn().mockResolvedValue(mockRole()),
        deleteRoleByName: jest.fn().mockRejectedValue(new Error('db down')),
        restoreConfig: jest.fn().mockResolvedValue(true),
        invalidatePromptGroupAccessContext: jest.fn().mockResolvedValue(undefined),
      });
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status, json } = createReqRes({ params: { name: 'editor' } });

      await handlers.deleteRole(req, res);

      expect(status).toHaveBeenCalledWith(500);
      expect(json).toHaveBeenCalledWith({ error: 'Failed to delete role' });
      expect(deps.restoreConfig).toHaveBeenCalledTimes(1);
      expect(deps.deleteAclEntries).toHaveBeenCalledTimes(1);
      expect(deps.deleteGrantsForPrincipal).toHaveBeenCalledTimes(1);
      expect(deps.invalidatePromptGroupAccessContext).toHaveBeenCalled();
    });

    it('deletes only the role it targeted and audits grants when that role is already replaced', async () => {
      const recordAuditEntry = jest.fn().mockResolvedValue(undefined);
      const original = mockRole({ _id: new Types.ObjectId() } as Partial<IRole>);
      const deps = deleteDeps({
        recordAuditEntry,
        getRoleByName: jest.fn().mockResolvedValue(original),
        deleteGrantsForPrincipal: jest.fn().mockResolvedValue([{ capability: 'read:users' }]),
        /** The id-conditional delete matched nothing: the name now belongs to another role. */
        deleteRoleByName: jest.fn().mockResolvedValue(null),
      });
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status } = createReqRes({
        params: { name: 'editor' },
        user: { _id: new Types.ObjectId(), role: 'admin' },
      });

      await handlers.deleteRole(req, res);

      expect(deps.deleteRoleByName).toHaveBeenCalledWith('editor', { id: String(original._id) });
      expect(status).toHaveBeenCalledWith(404);
      expect(recordAuditEntry).not.toHaveBeenCalledWith(
        expect.objectContaining({ action: 'role.deleted', outcome: 'success' }),
      );
    });

    it('does not restore dependents and audits the delete when the role is confirmed gone after a thrown delete', async () => {
      const recordAuditEntry = jest.fn().mockResolvedValue(undefined);
      const deps = deleteDeps({
        recordAuditEntry,
        getRoleByName: jest.fn().mockResolvedValueOnce(mockRole()).mockResolvedValue(null),
        deleteConfig: jest.fn().mockResolvedValue({
          principalModel: 'Role',
          overrides: {},
          priority: 3,
        }),
        deleteGrantsForPrincipal: jest.fn().mockResolvedValue([{ capability: 'read:users' }]),
        deleteRoleByName: jest.fn().mockRejectedValue(new Error('connection lost')),
        restoreConfig: jest.fn(),
      });
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status } = createReqRes({
        params: { name: 'editor' },
        user: { _id: new Types.ObjectId(), role: 'admin' },
      });

      await handlers.deleteRole(req, res);

      expect(status).toHaveBeenCalledWith(200);
      expect(deps.restoreConfig).not.toHaveBeenCalled();
      expect(recordAuditEntry).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'role.deleted' }),
      );
    });

    it('does not restore dependents onto a role recreated under the same name', async () => {
      const original = mockRole({ _id: new Types.ObjectId() } as Partial<IRole>);
      const replacement = mockRole({ _id: new Types.ObjectId() } as Partial<IRole>);
      const deps = deleteDeps({
        getRoleByName: jest.fn().mockResolvedValueOnce(original).mockResolvedValue(replacement),
        deleteRoleByName: jest.fn().mockRejectedValue(new Error('connection lost')),
        restoreConfig: jest.fn(),
      });
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status } = createReqRes({ params: { name: 'editor' } });

      await handlers.deleteRole(req, res);

      expect(status).toHaveBeenCalledWith(500);
      expect(deps.restoreConfig).not.toHaveBeenCalled();
    });

    it('restores nothing and reports a failure when the role state cannot be verified', async () => {
      const recordAuditEntry = jest.fn().mockResolvedValue(undefined);
      const deps = deleteDeps({
        recordAuditEntry,
        deleteGrantsForPrincipal: jest.fn().mockResolvedValue([{ capability: 'read:users' }]),
        getRoleByName: jest
          .fn()
          .mockResolvedValueOnce(mockRole())
          .mockRejectedValue(new Error('mongo down')),
        deleteRoleByName: jest.fn().mockRejectedValue(new Error('connection lost')),
        restoreConfig: jest.fn(),
      });
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status } = createReqRes({
        params: { name: 'editor' },
        user: { _id: new Types.ObjectId(), role: 'admin' },
      });

      await handlers.deleteRole(req, res);

      expect(status).toHaveBeenCalledWith(500);
      expect(deps.restoreConfig).not.toHaveBeenCalled();
      expect(recordAuditEntry).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'grant.removed' }),
      );
    });

    it('restores config insert-only so an override written after the snapshot is kept', async () => {
      const deps = deleteDeps({
        deleteConfig: jest.fn().mockResolvedValue({
          principalModel: 'Role',
          overrides: { old: true },
          priority: 3,
        }),
        deleteAclEntries: jest.fn().mockRejectedValue(new Error('acl failed')),
        /** false: a config document already exists, so the insert-only write was refused */
        restoreConfig: jest.fn().mockResolvedValue(false),
      });
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status } = createReqRes({ params: { name: 'editor' } });

      await handlers.deleteRole(req, res);

      expect(status).toHaveBeenCalledWith(500);
      expect(deps.restoreConfig).toHaveBeenCalledWith({
        principalModel: 'Role',
        overrides: { old: true },
        priority: 3,
      });
    });

    it('leaves ACL entries removed when the ACL delete itself rejects', async () => {
      const deps = deleteDeps({
        deleteAclEntries: jest.fn().mockRejectedValue(new Error('response lost')),
        invalidatePromptGroupAccessContext: jest.fn().mockResolvedValue(undefined),
      });
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status } = createReqRes({ params: { name: 'editor' } });

      await handlers.deleteRole(req, res);

      expect(status).toHaveBeenCalledWith(500);
      expect(deps.invalidatePromptGroupAccessContext).toHaveBeenCalled();
    });

    it('invalidates the access cache even when the role is gone after a failed delete', async () => {
      const deps = deleteDeps({
        getRoleByName: jest.fn().mockResolvedValueOnce(mockRole()).mockResolvedValue(null),
        deleteRoleByName: jest.fn().mockRejectedValue(new Error('connection lost')),
        invalidatePromptGroupAccessContext: jest.fn().mockResolvedValue(undefined),
      });
      const handlers = createAdminRolesHandlers(deps);
      const { req, res } = createReqRes({ params: { name: 'editor' } });

      await handlers.deleteRole(req, res);

      expect(deps.invalidatePromptGroupAccessContext).toHaveBeenCalled();
    });

    it('restores config from a pre-delete snapshot and never restores grants when their deletes reject', async () => {
      const config = { principalModel: 'Role', overrides: { a: 1 }, priority: 4 };
      const deps = deleteDeps({
        findConfigByPrincipal: jest.fn().mockResolvedValue(config),
        deleteConfig: jest.fn().mockRejectedValue(new Error('response lost')),
        deleteGrantsForPrincipal: jest.fn().mockRejectedValue(new Error('response lost')),
        restoreConfig: jest.fn().mockResolvedValue(true),
      });
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status, json } = createReqRes({ params: { name: 'editor' } });

      await handlers.deleteRole(req, res);

      expect(status).toHaveBeenCalledWith(500);
      expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: 'ROLE_CLEANUP_FAILED' }));
      expect(deps.restoreConfig).toHaveBeenCalledWith(config);
      expect(deps.deleteRoleByName).not.toHaveBeenCalled();
    });

    it('does not restore a rejected config removal onto a role recreated under the same name', async () => {
      const config = { principalModel: 'Role', overrides: { a: 1 }, priority: 4 };
      const original = mockRole({ _id: new Types.ObjectId() } as Partial<IRole>);
      const replacement = mockRole({ _id: new Types.ObjectId() } as Partial<IRole>);
      const deps = deleteDeps({
        getRoleByName: jest.fn().mockResolvedValueOnce(original).mockResolvedValue(replacement),
        findConfigByPrincipal: jest.fn().mockResolvedValue(config),
        /** The removal committed, then the original was deleted and its name reused. */
        deleteConfig: jest.fn().mockRejectedValue(new Error('response lost')),
        restoreConfig: jest.fn().mockResolvedValue(true),
      });
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status } = createReqRes({ params: { name: 'editor' } });

      await handlers.deleteRole(req, res);

      expect(status).toHaveBeenCalledWith(500);
      expect(deps.restoreConfig).not.toHaveBeenCalled();
      expect(deps.deleteRoleByName).not.toHaveBeenCalled();
    });

    it('does not restore a rejected config removal when the role cannot be read', async () => {
      const config = { principalModel: 'Role', overrides: { a: 1 }, priority: 4 };
      const deps = deleteDeps({
        getRoleByName: jest
          .fn()
          .mockResolvedValueOnce(mockRole())
          .mockRejectedValue(new Error('mongo down')),
        findConfigByPrincipal: jest.fn().mockResolvedValue(config),
        deleteConfig: jest.fn().mockRejectedValue(new Error('response lost')),
        restoreConfig: jest.fn().mockResolvedValue(true),
      });
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status } = createReqRes({ params: { name: 'editor' } });

      await handlers.deleteRole(req, res);

      expect(status).toHaveBeenCalledWith(500);
      expect(deps.restoreConfig).not.toHaveBeenCalled();
    });

    it('retries a deferred config restore once the role is readable again', async () => {
      const config = { principalModel: 'Role', overrides: { a: 1 }, priority: 4 };
      const deps = deleteDeps({
        getRoleByName: jest
          .fn()
          .mockResolvedValueOnce(mockRole())
          .mockRejectedValueOnce(new Error('mongo blip'))
          .mockResolvedValue(mockRole()),
        findConfigByPrincipal: jest.fn().mockResolvedValue(config),
        deleteConfig: jest.fn().mockRejectedValue(new Error('response lost')),
        restoreConfig: jest.fn().mockResolvedValue(true),
      });
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status } = createReqRes({ params: { name: 'editor' } });

      await handlers.deleteRole(req, res);

      expect(status).toHaveBeenCalledWith(500);
      expect(deps.restoreConfig).toHaveBeenCalledTimes(1);
      expect(deps.restoreConfig).toHaveBeenCalledWith(config);
    });

    it('still audits a committed deletion when the access cache invalidation fails', async () => {
      const recordAuditEntry = jest.fn().mockResolvedValue(undefined);
      const deps = deleteDeps({
        recordAuditEntry,
        invalidatePromptGroupAccessContext: jest.fn().mockRejectedValue(new Error('cache down')),
      });
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status } = createReqRes({
        params: { name: 'editor' },
        user: { _id: new Types.ObjectId(), role: 'admin' },
      });

      await handlers.deleteRole(req, res);

      expect(status).toHaveBeenCalledWith(200);
      expect(recordAuditEntry).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'role.deleted' }),
      );
    });

    it('does not restore anything when the cascade and role deletion succeed', async () => {
      const deps = deleteDeps({
        restoreConfig: jest.fn(),
      });
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status } = createReqRes({ params: { name: 'editor' } });

      await handlers.deleteRole(req, res);

      expect(status).toHaveBeenCalledWith(200);
      expect(deps.restoreConfig).not.toHaveBeenCalled();
    });

    it('emits a grant.removed audit entry for each grant removed by the cascade', async () => {
      const recordAuditEntry = jest.fn().mockResolvedValue(undefined);
      const deps = deleteDeps({
        deleteGrantsForPrincipal: jest.fn().mockResolvedValue([
          { capability: 'manage:users', tenantId: 'tenant-1' },
          { capability: 'read:users', tenantId: 'tenant-1' },
        ]),
        recordAuditEntry,
      });
      const handlers = createAdminRolesHandlers(deps);
      const userId = new Types.ObjectId();
      const { req, res, status } = createReqRes({
        params: { name: 'editor' },
        user: { _id: userId, role: 'admin', tenantId: 'tenant-1' },
      });

      await handlers.deleteRole(req, res);

      expect(status).toHaveBeenCalledWith(200);
      expect(recordAuditEntry).toHaveBeenCalledTimes(5);
      expect(recordAuditEntry).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'grant.removed',
          actor: expect.objectContaining({ type: 'user', id: userId.toString() }),
          target: { type: PrincipalType.ROLE, id: 'editor', name: 'editor' },
          metadata: { capability: 'manage:users' },
          tenantId: 'tenant-1',
        }),
      );
      expect(recordAuditEntry).toHaveBeenLastCalledWith(
        expect.objectContaining({
          action: 'role.deleted',
          outcome: 'success',
          target: { type: 'role', id: 'editor', name: 'editor' },
          metadata: { grantsRemoved: 2, membersReassigned: 2 },
          tenantId: 'tenant-1',
        }),
      );
    });

    it('scopes each cascade audit entry to the removed grant’s own tenant', async () => {
      const recordAuditEntry = jest.fn().mockResolvedValue(undefined);
      const deps = deleteDeps({
        // each removed grant names its own scope, whatever the caller's
        deleteGrantsForPrincipal: jest
          .fn()
          .mockResolvedValue([
            { capability: 'read:users' },
            { capability: 'manage:users', tenantId: 'tenant-x' },
          ]),
        recordAuditEntry,
      });
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status } = createReqRes({
        params: { name: 'editor' },
        user: { _id: new Types.ObjectId(), role: 'admin' },
      });

      await handlers.deleteRole(req, res);

      expect(status).toHaveBeenCalledWith(200);
      // platform grant → platform chain (tenantId undefined)
      expect(recordAuditEntry).toHaveBeenCalledWith(
        expect.objectContaining({ metadata: { capability: 'read:users' }, tenantId: undefined }),
      );
      // tenant grant → that tenant's chain, not the caller's (undefined) scope
      expect(recordAuditEntry).toHaveBeenCalledWith(
        expect.objectContaining({ metadata: { capability: 'manage:users' }, tenantId: 'tenant-x' }),
      );
    });

    it('records each account the deletion actually reassigned before the outcome', async () => {
      const recordAuditEntry = jest.fn().mockResolvedValue(undefined);
      const deps = deleteDeps({
        recordAuditEntry,
        deleteRoleByName: jest
          .fn()
          .mockResolvedValue({ role: mockRole(), reassignedUserIds: ['u1', 'u2'] }),
      });
      const handlers = createAdminRolesHandlers(deps);
      const { req, res } = createReqRes({
        params: { name: 'editor' },
        user: { _id: new Types.ObjectId(), role: 'admin' },
      });

      await handlers.deleteRole(req, res);

      const removed = recordAuditEntry.mock.calls
        .map(([entry]) => entry)
        .filter((entry) => entry.action === 'role.member_removed');
      expect(removed).toHaveLength(1);
      expect(removed[0].metadata).toMatchObject({ userIds: 'u1,u2', count: 2 });
      expect(recordAuditEntry).toHaveBeenLastCalledWith(
        expect.objectContaining({
          action: 'role.deleted',
          outcome: 'success',
          metadata: { grantsRemoved: 0, membersReassigned: 2 },
        }),
      );
    });

    it('keeps a committed deletion successful when a cascade audit write fails under auditFailClosed', async () => {
      const recordAuditEntry = jest.fn().mockImplementation(async (entry: { action: string }) => {
        if (entry.action === 'grant.removed' || entry.action === 'role.member_removed') {
          throw new Error('audit store down');
        }
      });
      const deps = deleteDeps({
        recordAuditEntry,
        auditFailClosed: true,
        deleteGrantsForPrincipal: jest.fn().mockResolvedValue([{ capability: 'read:users' }]),
      });
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status } = createReqRes({
        params: { name: 'editor' },
        user: { _id: new Types.ObjectId(), role: 'admin' },
      });

      await handlers.deleteRole(req, res);

      expect(status).toHaveBeenCalledWith(200);
      expect(recordAuditEntry).toHaveBeenLastCalledWith(
        expect.objectContaining({ action: 'role.deleted', outcome: 'success' }),
      );
    });

    it('audits grants whose removal rejected after committing, from the pre-delete snapshot', async () => {
      const recordAuditEntry = jest.fn().mockResolvedValue(undefined);
      const deps = deleteDeps({
        recordAuditEntry,
        findGrantsForPrincipal: jest
          .fn()
          .mockResolvedValueOnce([{ capability: 'read:users' }])
          .mockResolvedValue([]),
        deleteGrantsForPrincipal: jest.fn().mockRejectedValue(new Error('response lost')),
      });
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status } = createReqRes({
        params: { name: 'editor' },
        user: { _id: new Types.ObjectId(), role: 'admin' },
      });

      await handlers.deleteRole(req, res);

      expect(status).toHaveBeenCalledWith(500);
      expect(recordAuditEntry).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'grant.removed',
          metadata: { capability: 'read:users' },
        }),
      );
    });

    it('aborts before cleanup when the grant snapshot cannot be read', async () => {
      const deps = deleteDeps({
        findGrantsForPrincipal: jest.fn().mockRejectedValue(new Error('mongo down')),
      });
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status } = createReqRes({ params: { name: 'editor' } });

      await handlers.deleteRole(req, res);

      expect(status).toHaveBeenCalledWith(500);
      expect(deps.deleteGrantsForPrincipal).not.toHaveBeenCalled();
    });

    it('records role.deleted as pending before any removal, then success, in order', async () => {
      const order: string[] = [];
      const recordAuditEntry = jest.fn(async (entry: { action: string; outcome?: string }) => {
        order.push(`${entry.action}:${entry.outcome}`);
      });
      const deps = deleteDeps({
        recordAuditEntry,
        deleteConfig: jest.fn(async () => {
          order.push('removal');
          return null;
        }),
      });
      const handlers = createAdminRolesHandlers(deps);
      const { req, res } = createReqRes({
        params: { name: 'editor' },
        user: { _id: new Types.ObjectId(), role: 'admin' },
      });

      await handlers.deleteRole(req, res);

      expect(order[0]).toBe('role.deleted:pending');
      expect(order[order.length - 1]).toBe('role.deleted:success');
      expect(order).toContain('removal');
    });

    it('records role.deleted as failed when the role delete throws and the role remains', async () => {
      const recordAuditEntry = jest.fn().mockResolvedValue(undefined);
      const deps = deleteDeps({
        recordAuditEntry,
        getRoleByName: jest.fn().mockResolvedValue(mockRole()),
        deleteRoleByName: jest.fn().mockRejectedValue(new Error('db down')),
      });
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status } = createReqRes({
        params: { name: 'editor' },
        user: { _id: new Types.ObjectId(), role: 'admin' },
      });

      await handlers.deleteRole(req, res);

      expect(status).toHaveBeenCalledWith(500);
      expect(recordAuditEntry).toHaveBeenLastCalledWith(
        expect.objectContaining({ action: 'role.deleted', outcome: 'failure' }),
      );
    });

    it('audits the members a failed delete moved and keeps the role', async () => {
      const recordAuditEntry = jest.fn().mockResolvedValue(undefined);
      const deps = deleteDeps({
        recordAuditEntry,
        deleteRoleByName: jest
          .fn()
          .mockRejectedValue(new RoleDeletionError('reassignment_failed', ['u1'])),
        restoreConfig: jest.fn(),
      });
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status } = createReqRes({
        params: { name: 'editor' },
        user: { _id: new Types.ObjectId(), role: 'admin' },
      });

      await handlers.deleteRole(req, res);

      expect(status).toHaveBeenCalledWith(500);
      expect(recordAuditEntry).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'role.member_removed',
          metadata: expect.objectContaining({ userIds: 'u1', count: 1 }),
        }),
      );
      expect(recordAuditEntry).toHaveBeenLastCalledWith(
        expect.objectContaining({
          action: 'role.deleted',
          outcome: 'failure',
          metadata: { code: 'ROLE_CLEANUP_FAILED' },
        }),
      );
    });

    it('audits the members it moved and returns 404 when another request deleted the role', async () => {
      const recordAuditEntry = jest.fn().mockResolvedValue(undefined);
      const deps = deleteDeps({
        recordAuditEntry,
        getRoleByName: jest.fn().mockResolvedValueOnce(mockRole()).mockResolvedValue(null),
        deleteRoleByName: jest
          .fn()
          .mockRejectedValue(new RoleDeletionError('deleted_elsewhere', ['u7'])),
      });
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status } = createReqRes({
        params: { name: 'editor' },
        user: { _id: new Types.ObjectId(), role: 'admin' },
      });

      await handlers.deleteRole(req, res);

      expect(status).toHaveBeenCalledWith(404);
      expect(recordAuditEntry).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'role.member_removed',
          metadata: expect.objectContaining({ userIds: 'u7', count: 1 }),
        }),
      );
      expect(recordAuditEntry).toHaveBeenLastCalledWith(
        expect.objectContaining({ action: 'role.deleted', outcome: 'failure' }),
      );
    });

    it('audits the members moved when the role delete itself fails and keeps the role', async () => {
      const recordAuditEntry = jest.fn().mockResolvedValue(undefined);
      const config = { principalModel: 'Role', overrides: { a: 1 }, priority: 4 };
      const deps = deleteDeps({
        recordAuditEntry,
        deleteConfig: jest.fn().mockResolvedValue(config),
        restoreConfig: jest.fn().mockResolvedValue(true),
        deleteRoleByName: jest
          .fn()
          .mockRejectedValue(new RoleDeletionError('delete_failed', ['u4', 'u5'])),
      });
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status } = createReqRes({
        params: { name: 'editor' },
        user: { _id: new Types.ObjectId(), role: 'admin' },
      });

      await handlers.deleteRole(req, res);

      expect(status).toHaveBeenCalledWith(500);
      expect(deps.restoreConfig).toHaveBeenCalledWith(config);
      const removed = recordAuditEntry.mock.calls
        .map(([entry]) => entry)
        .filter((entry) => entry.action === 'role.member_removed');
      expect(removed).toHaveLength(1);
      expect(removed[0].metadata).toMatchObject({ userIds: 'u4,u5', count: 2 });
      expect(recordAuditEntry).toHaveBeenLastCalledWith(
        expect.objectContaining({ action: 'role.deleted', outcome: 'failure' }),
      );
    });

    it('records role.deleted success when the delete committed before it threw', async () => {
      const recordAuditEntry = jest.fn().mockResolvedValue(undefined);
      const deps = deleteDeps({
        recordAuditEntry,
        getRoleByName: jest.fn().mockResolvedValueOnce(mockRole()).mockResolvedValue(null),
        deleteRoleByName: jest
          .fn()
          .mockRejectedValue(new RoleDeletionError('delete_failed', ['uid-1', 'uid-2'])),
      });
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status } = createReqRes({
        params: { name: 'editor' },
        user: { _id: new Types.ObjectId(), role: 'admin' },
      });

      await handlers.deleteRole(req, res);

      expect(status).toHaveBeenCalledWith(200);
      /** The delete's acknowledgement is lost; its error carries the members it moved. */
      expect(deps.findUserIdsByRole).not.toHaveBeenCalled();
      expect(recordAuditEntry).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'role.member_removed',
          metadata: expect.objectContaining({ userIds: 'uid-1,uid-2', count: 2 }),
        }),
      );
      expect(recordAuditEntry).toHaveBeenLastCalledWith(
        expect.objectContaining({ action: 'role.deleted', outcome: 'success' }),
      );
    });

    it('records only role.deleted when the deleted role had no grants', async () => {
      const recordAuditEntry = jest.fn().mockResolvedValue(undefined);
      const deps = deleteDeps({ recordAuditEntry });
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status } = createReqRes({
        params: { name: 'editor' },
        user: { _id: new Types.ObjectId(), role: 'admin' },
      });

      await handlers.deleteRole(req, res);

      expect(status).toHaveBeenCalledWith(200);
      expect(recordAuditEntry).toHaveBeenCalledTimes(3);
      expect(recordAuditEntry).toHaveBeenLastCalledWith(
        expect.objectContaining({
          action: 'role.deleted',
          outcome: 'success',
          metadata: { grantsRemoved: 0, membersReassigned: 2 },
        }),
      );
    });

    it('returns 500 and keeps the role when every cascade operation fails', async () => {
      const deps = deleteDeps({
        deleteConfig: jest.fn().mockRejectedValue(new Error('config cleanup failed')),
        deleteAclEntries: jest.fn().mockRejectedValue(new Error('acl cleanup failed')),
        deleteGrantsForPrincipal: jest.fn().mockRejectedValue(new Error('grant cleanup failed')),
      });
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status, json } = createReqRes({ params: { name: 'editor' } });

      await handlers.deleteRole(req, res);

      expect(status).toHaveBeenCalledWith(500);
      expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: 'ROLE_CLEANUP_FAILED' }));
      expect(deps.deleteRoleByName).not.toHaveBeenCalled();
    });

    it('returns 403 for system role', async () => {
      const deps = deleteDeps();
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status, json } = createReqRes({ params: { name: SystemRoles.ADMIN } });

      await handlers.deleteRole(req, res);

      expect(status).toHaveBeenCalledWith(403);
      expect(json).toHaveBeenCalledWith({ error: 'Cannot delete system role' });
      expect(deps.deleteRoleByName).not.toHaveBeenCalled();
    });

    it('returns 404 when role not found', async () => {
      const deps = deleteDeps({ deleteRoleByName: jest.fn().mockResolvedValue(null) });
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status, json } = createReqRes({ params: { name: 'nonexistent' } });

      await handlers.deleteRole(req, res);

      expect(status).toHaveBeenCalledWith(404);
      expect(json).toHaveBeenCalledWith({ error: 'Role not found' });
    });

    it('returns 500 on error', async () => {
      const deps = deleteDeps({
        deleteRoleByName: jest.fn().mockRejectedValue(new Error('db down')),
      });
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status, json } = createReqRes({ params: { name: 'editor' } });

      await handlers.deleteRole(req, res);

      expect(status).toHaveBeenCalledWith(500);
      expect(json).toHaveBeenCalledWith({ error: 'Failed to delete role' });
    });
  });

  describe('getRoleMembers', () => {
    it('returns paginated members with 200', async () => {
      const user = mockUser();
      const deps = createDeps({
        getRoleByName: jest.fn().mockResolvedValue(mockRole()),
        listUsersByRole: jest.fn().mockResolvedValue([user]),
        countUsersByRole: jest.fn().mockResolvedValue(1),
      });
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status, json } = createReqRes({ params: { name: 'editor' } });

      await handlers.getRoleMembers(req, res);

      expect(deps.listUsersByRole).toHaveBeenCalledWith('editor', { limit: 50, offset: 0 });
      expect(deps.countUsersByRole).toHaveBeenCalledWith('editor');
      expect(status).toHaveBeenCalledWith(200);
      const response = json.mock.calls[0][0];
      expect(response.members).toHaveLength(1);
      expect(response.members[0]).toEqual({
        userId: validUserId,
        name: 'Test User',
        email: 'test@example.com',
        avatarUrl: 'https://example.com/avatar.png',
      });
      expect(response.total).toBe(1);
      expect(response.limit).toBe(50);
      expect(response.offset).toBe(0);
    });

    it('passes pagination parameters from query', async () => {
      const deps = createDeps({
        getRoleByName: jest.fn().mockResolvedValue(mockRole()),
        countUsersByRole: jest.fn().mockResolvedValue(0),
      });
      const handlers = createAdminRolesHandlers(deps);
      const { req, res } = createReqRes({
        params: { name: 'editor' },
        query: { limit: '10', offset: '20' },
      });

      await handlers.getRoleMembers(req, res);

      expect(deps.listUsersByRole).toHaveBeenCalledWith('editor', { limit: 10, offset: 20 });
    });

    it('clamps limit to 200', async () => {
      const deps = createDeps({
        getRoleByName: jest.fn().mockResolvedValue(mockRole()),
        countUsersByRole: jest.fn().mockResolvedValue(0),
      });
      const handlers = createAdminRolesHandlers(deps);
      const { req, res } = createReqRes({
        params: { name: 'editor' },
        query: { limit: '999' },
      });

      await handlers.getRoleMembers(req, res);

      expect(deps.listUsersByRole).toHaveBeenCalledWith('editor', { limit: 200, offset: 0 });
    });

    it('does not include joinedAt in response', async () => {
      const user = mockUser();
      const deps = createDeps({
        getRoleByName: jest.fn().mockResolvedValue(mockRole()),
        listUsersByRole: jest.fn().mockResolvedValue([user]),
        countUsersByRole: jest.fn().mockResolvedValue(1),
      });
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, json } = createReqRes({ params: { name: 'editor' } });

      await handlers.getRoleMembers(req, res);

      const member = json.mock.calls[0][0].members[0];
      expect(member).not.toHaveProperty('joinedAt');
    });

    it('returns empty array when no members', async () => {
      const deps = createDeps({
        getRoleByName: jest.fn().mockResolvedValue(mockRole()),
        countUsersByRole: jest.fn().mockResolvedValue(0),
      });
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status, json } = createReqRes({ params: { name: 'editor' } });

      await handlers.getRoleMembers(req, res);

      expect(status).toHaveBeenCalledWith(200);
      expect(json).toHaveBeenCalledWith({ members: [], total: 0, limit: 50, offset: 0 });
    });

    it('returns 404 when role not found', async () => {
      const deps = createDeps({ getRoleByName: jest.fn().mockResolvedValue(null) });
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status, json } = createReqRes({ params: { name: 'nonexistent' } });

      await handlers.getRoleMembers(req, res);

      expect(status).toHaveBeenCalledWith(404);
      expect(json).toHaveBeenCalledWith({ error: 'Role not found' });
    });

    it('returns 500 on error', async () => {
      const deps = createDeps({
        getRoleByName: jest.fn().mockResolvedValue(mockRole()),
        listUsersByRole: jest.fn().mockRejectedValue(new Error('db down')),
      });
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status, json } = createReqRes({ params: { name: 'editor' } });

      await handlers.getRoleMembers(req, res);

      expect(status).toHaveBeenCalledWith(500);
      expect(json).toHaveBeenCalledWith({ error: 'Failed to get role members' });
    });
  });

  describe('addRoleMember', () => {
    it('adds member and returns 200', async () => {
      const deps = createDeps({
        getRoleByName: jest.fn().mockResolvedValue(mockRole()),
        findUser: jest.fn().mockResolvedValue(mockUser({ role: 'viewer' })),
      });
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status, json } = createReqRes({
        params: { name: 'editor' },
        body: { userId: validUserId },
      });

      await handlers.addRoleMember(req, res);

      expect(deps.updateUser).toHaveBeenCalledWith(
        validUserId,
        { role: 'editor' },
        expect.any(Object),
      );
      expect(status).toHaveBeenCalledWith(200);
      expect(json).toHaveBeenCalledWith({ success: true });
    });

    it('records no membership entry when an overlapping request already moved the user', async () => {
      const recordAuditEntry = jest.fn().mockResolvedValue(undefined);
      const deps = createDeps({
        recordAuditEntry,
        getRoleByName: jest.fn().mockResolvedValue(mockRole()),
        findUser: jest
          .fn()
          .mockResolvedValueOnce(mockUser({ role: 'viewer' }))
          .mockResolvedValue(mockUser({ role: 'editor' })),
        /** The conditional write matched nothing: the other request got there first. */
        updateUser: jest.fn().mockResolvedValue(null),
      });
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status } = createReqRes({
        params: { name: 'editor' },
        body: { userId: validUserId },
        user: { _id: new Types.ObjectId(), role: 'admin' },
      });

      await handlers.addRoleMember(req, res);

      expect(status).toHaveBeenCalledWith(200);
      expect(recordAuditEntry).not.toHaveBeenCalled();
    });

    it('skips DB write when user already has the target role', async () => {
      const deps = createDeps({
        getRoleByName: jest.fn().mockResolvedValue(mockRole()),
        findUser: jest.fn().mockResolvedValue(mockUser({ role: 'editor' })),
      });
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status, json } = createReqRes({
        params: { name: 'editor' },
        body: { userId: validUserId },
      });

      await handlers.addRoleMember(req, res);

      expect(status).toHaveBeenCalledWith(200);
      expect(json).toHaveBeenCalledWith({ success: true });
      expect(deps.updateUser).not.toHaveBeenCalled();
    });

    it('returns 400 when userId is missing', async () => {
      const deps = createDeps();
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status, json } = createReqRes({
        params: { name: 'editor' },
        body: {},
      });

      await handlers.addRoleMember(req, res);

      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith({ error: 'userId is required' });
    });

    it('returns 400 for invalid ObjectId', async () => {
      const deps = createDeps();
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status, json } = createReqRes({
        params: { name: 'editor' },
        body: { userId: 'not-valid' },
      });

      await handlers.addRoleMember(req, res);

      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith({ error: 'Invalid user ID format' });
    });

    it('returns 404 when role not found', async () => {
      const deps = createDeps({ getRoleByName: jest.fn().mockResolvedValue(null) });
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status, json } = createReqRes({
        params: { name: 'nonexistent' },
        body: { userId: validUserId },
      });

      await handlers.addRoleMember(req, res);

      expect(status).toHaveBeenCalledWith(404);
      expect(json).toHaveBeenCalledWith({ error: 'Role not found' });
    });

    it('returns 404 when user not found', async () => {
      const deps = createDeps({
        getRoleByName: jest.fn().mockResolvedValue(mockRole()),
        findUser: jest.fn().mockResolvedValue(null),
      });
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status, json } = createReqRes({
        params: { name: 'editor' },
        body: { userId: validUserId },
      });

      await handlers.addRoleMember(req, res);

      expect(status).toHaveBeenCalledWith(404);
      expect(json).toHaveBeenCalledWith({ error: 'User not found' });
    });

    it('returns 400 when reassigning the last admin to another role', async () => {
      const deps = createDeps({
        getRoleByName: jest.fn().mockResolvedValue(mockRole({ name: 'editor' })),
        findUser: jest.fn().mockResolvedValue(mockUser({ role: SystemRoles.ADMIN })),
        countUsersByRole: jest.fn().mockResolvedValue(1),
      });
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status, json } = createReqRes({
        params: { name: 'editor' },
        body: { userId: validUserId },
      });

      await handlers.addRoleMember(req, res);

      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith({ error: 'Cannot remove the last admin user' });
      expect(deps.updateUser).not.toHaveBeenCalled();
    });

    it('allows reassigning an admin when multiple admins exist', async () => {
      const deps = createDeps({
        getRoleByName: jest.fn().mockResolvedValue(mockRole({ name: 'editor' })),
        findUser: jest.fn().mockResolvedValue(mockUser({ role: SystemRoles.ADMIN })),
        countUsersByRole: jest.fn().mockResolvedValue(3),
        updateUser: jest.fn().mockResolvedValue(mockUser({ role: 'editor' })),
      });
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status } = createReqRes({
        params: { name: 'editor' },
        body: { userId: validUserId },
      });

      await handlers.addRoleMember(req, res);

      expect(status).toHaveBeenCalledWith(200);
      expect(deps.updateUser).toHaveBeenCalledWith(
        validUserId,
        { role: 'editor' },
        expect.any(Object),
      );
    });

    it('rolls back assignment when post-write admin count is zero', async () => {
      const deps = createDeps({
        getRoleByName: jest.fn().mockResolvedValue(mockRole({ name: 'editor' })),
        findUser: jest.fn().mockResolvedValue(mockUser({ role: SystemRoles.ADMIN })),
        countUsersByRole: jest.fn().mockResolvedValueOnce(2).mockResolvedValueOnce(0),
        updateUser: jest.fn().mockResolvedValue(mockUser()),
      });
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status, json } = createReqRes({
        params: { name: 'editor' },
        body: { userId: validUserId },
      });

      await handlers.addRoleMember(req, res);

      expect(deps.updateUser).toHaveBeenCalledTimes(2);
      expect(deps.updateUser).toHaveBeenLastCalledWith(validUserId, { role: SystemRoles.ADMIN });
      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith({ error: 'Cannot remove the last admin user' });
    });

    it('returns 403 when adding to a non-ADMIN system role', async () => {
      const deps = createDeps();
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status, json } = createReqRes({
        params: { name: SystemRoles.USER },
        body: { userId: validUserId },
      });

      await handlers.addRoleMember(req, res);

      expect(status).toHaveBeenCalledWith(403);
      expect(json).toHaveBeenCalledWith({
        error: 'Cannot directly assign members to a system role',
      });
      expect(deps.updateUser).not.toHaveBeenCalled();
    });

    it('allows promoting a non-admin user to the ADMIN role', async () => {
      const deps = createDeps({
        getRoleByName: jest.fn().mockResolvedValue(mockRole({ name: SystemRoles.ADMIN })),
        findUser: jest.fn().mockResolvedValue(mockUser({ role: 'editor' })),
        updateUser: jest.fn().mockResolvedValue(mockUser({ role: SystemRoles.ADMIN })),
      });
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status, json } = createReqRes({
        params: { name: SystemRoles.ADMIN },
        body: { userId: validUserId },
      });

      await handlers.addRoleMember(req, res);

      expect(deps.updateUser).toHaveBeenCalledWith(
        validUserId,
        { role: SystemRoles.ADMIN },
        expect.any(Object),
      );
      expect(status).toHaveBeenCalledWith(200);
      expect(json).toHaveBeenCalledWith({ success: true });
    });

    it('returns 500 on unexpected error', async () => {
      const deps = createDeps({
        getRoleByName: jest.fn().mockResolvedValue(mockRole()),
        findUser: jest.fn().mockResolvedValue(mockUser({ role: 'viewer' })),
        updateUser: jest.fn().mockRejectedValue(new Error('timeout')),
      });
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status, json } = createReqRes({
        params: { name: 'editor' },
        body: { userId: validUserId },
      });

      await handlers.addRoleMember(req, res);

      expect(status).toHaveBeenCalledWith(500);
      expect(json).toHaveBeenCalledWith({ error: 'Failed to add role member' });
    });
  });

  describe('removeRoleMember', () => {
    it('removes member and returns 200', async () => {
      const deps = createDeps({
        getRoleByName: jest.fn().mockResolvedValue(mockRole()),
        findUser: jest.fn().mockResolvedValue(mockUser({ role: 'editor' })),
      });
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status, json } = createReqRes({
        params: { name: 'editor', userId: validUserId },
      });

      await handlers.removeRoleMember(req, res);

      expect(deps.updateUser).toHaveBeenCalledWith(
        validUserId,
        { role: SystemRoles.USER },
        expect.any(Object),
      );
      expect(status).toHaveBeenCalledWith(200);
      expect(json).toHaveBeenCalledWith({ success: true });
    });

    it('records no entry when an overlapping request already removed the member', async () => {
      const recordAuditEntry = jest.fn().mockResolvedValue(undefined);
      const deps = createDeps({
        recordAuditEntry,
        getRoleByName: jest.fn().mockResolvedValue(mockRole()),
        findUser: jest
          .fn()
          .mockResolvedValueOnce(mockUser({ role: 'editor' }))
          .mockResolvedValue(mockUser({ role: SystemRoles.USER })),
        updateUser: jest.fn().mockResolvedValue(null),
      });
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status } = createReqRes({
        params: { name: 'editor', userId: validUserId },
        user: { _id: new Types.ObjectId(), role: 'admin' },
      });

      await handlers.removeRoleMember(req, res);

      expect(status).toHaveBeenCalledWith(400);
      expect(recordAuditEntry).not.toHaveBeenCalled();
    });

    it('returns 403 when removing from a non-ADMIN system role', async () => {
      const deps = createDeps();
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status, json } = createReqRes({
        params: { name: SystemRoles.USER, userId: validUserId },
      });

      await handlers.removeRoleMember(req, res);

      expect(status).toHaveBeenCalledWith(403);
      expect(json).toHaveBeenCalledWith({ error: 'Cannot remove members from a system role' });
      expect(deps.getRoleByName).not.toHaveBeenCalled();
    });

    it('returns 400 for invalid ObjectId', async () => {
      const deps = createDeps();
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status, json } = createReqRes({
        params: { name: 'editor', userId: 'bad' },
      });

      await handlers.removeRoleMember(req, res);

      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith({ error: 'Invalid user ID format' });
      expect(deps.findUser).not.toHaveBeenCalled();
    });

    it('returns 404 when role not found', async () => {
      const deps = createDeps({ getRoleByName: jest.fn().mockResolvedValue(null) });
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status, json } = createReqRes({
        params: { name: 'nonexistent', userId: validUserId },
      });

      await handlers.removeRoleMember(req, res);

      expect(status).toHaveBeenCalledWith(404);
      expect(json).toHaveBeenCalledWith({ error: 'Role not found' });
      expect(deps.findUser).not.toHaveBeenCalled();
    });

    it('returns 404 when user not found', async () => {
      const deps = createDeps({
        getRoleByName: jest.fn().mockResolvedValue(mockRole()),
        findUser: jest.fn().mockResolvedValue(null),
      });
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status, json } = createReqRes({
        params: { name: 'editor', userId: validUserId },
      });

      await handlers.removeRoleMember(req, res);

      expect(status).toHaveBeenCalledWith(404);
      expect(json).toHaveBeenCalledWith({ error: 'User not found' });
    });

    it('returns 400 when user is not a member of the role', async () => {
      const deps = createDeps({
        getRoleByName: jest.fn().mockResolvedValue(mockRole()),
        findUser: jest.fn().mockResolvedValue(mockUser({ role: 'other-role' })),
      });
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status, json } = createReqRes({
        params: { name: 'editor', userId: validUserId },
      });

      await handlers.removeRoleMember(req, res);

      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith({ error: 'User is not a member of this role' });
      expect(deps.updateUser).not.toHaveBeenCalled();
    });

    it('returns 400 when removing the last admin user', async () => {
      const deps = createDeps({
        getRoleByName: jest.fn().mockResolvedValue(mockRole({ name: SystemRoles.ADMIN })),
        findUser: jest.fn().mockResolvedValue(mockUser({ role: SystemRoles.ADMIN })),
        countUsersByRole: jest.fn().mockResolvedValue(1),
      });
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status, json } = createReqRes({
        params: { name: SystemRoles.ADMIN, userId: validUserId },
      });

      await handlers.removeRoleMember(req, res);

      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith({ error: 'Cannot remove the last admin user' });
      expect(deps.updateUser).not.toHaveBeenCalled();
    });

    it('allows removing an admin when multiple admins exist', async () => {
      const deps = createDeps({
        getRoleByName: jest.fn().mockResolvedValue(mockRole({ name: SystemRoles.ADMIN })),
        findUser: jest.fn().mockResolvedValue(mockUser({ role: SystemRoles.ADMIN })),
        countUsersByRole: jest.fn().mockResolvedValue(3),
      });
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status, json } = createReqRes({
        params: { name: SystemRoles.ADMIN, userId: validUserId },
      });

      await handlers.removeRoleMember(req, res);

      expect(status).toHaveBeenCalledWith(200);
      expect(json).toHaveBeenCalledWith({ success: true });
      expect(deps.updateUser).toHaveBeenCalledWith(
        validUserId,
        { role: SystemRoles.USER },
        expect.any(Object),
      );
    });

    it('rolls back removal when post-write check finds zero admins', async () => {
      const deps = createDeps({
        getRoleByName: jest.fn().mockResolvedValue(mockRole({ name: SystemRoles.ADMIN })),
        findUser: jest.fn().mockResolvedValue(mockUser({ role: SystemRoles.ADMIN })),
        countUsersByRole: jest.fn().mockResolvedValueOnce(2).mockResolvedValueOnce(0),
      });
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status, json } = createReqRes({
        params: { name: SystemRoles.ADMIN, userId: validUserId },
      });

      await handlers.removeRoleMember(req, res);

      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith({ error: 'Cannot remove the last admin user' });
      expect(deps.updateUser).toHaveBeenCalledTimes(2);
      expect(deps.updateUser).toHaveBeenNthCalledWith(
        1,
        validUserId,
        { role: SystemRoles.USER },
        { role: SystemRoles.ADMIN },
      );
      expect(deps.updateUser).toHaveBeenNthCalledWith(2, validUserId, {
        role: SystemRoles.ADMIN,
      });
    });

    it('returns 400 even when rollback updateUser throws', async () => {
      const deps = createDeps({
        getRoleByName: jest.fn().mockResolvedValue(mockRole({ name: SystemRoles.ADMIN })),
        findUser: jest.fn().mockResolvedValue(mockUser({ role: SystemRoles.ADMIN })),
        countUsersByRole: jest.fn().mockResolvedValueOnce(2).mockResolvedValueOnce(0),
        updateUser: jest
          .fn()
          .mockResolvedValueOnce(mockUser({ role: SystemRoles.USER }))
          .mockRejectedValueOnce(new Error('rollback failed')),
      });
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status, json } = createReqRes({
        params: { name: SystemRoles.ADMIN, userId: validUserId },
      });

      await handlers.removeRoleMember(req, res);

      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith({ error: 'Cannot remove the last admin user' });
      expect(deps.updateUser).toHaveBeenCalledTimes(2);
    });

    it('returns 500 on unexpected error', async () => {
      const deps = createDeps({
        getRoleByName: jest.fn().mockResolvedValue(mockRole()),
        findUser: jest.fn().mockResolvedValue(mockUser({ role: 'editor' })),
        updateUser: jest.fn().mockRejectedValue(new Error('timeout')),
      });
      const handlers = createAdminRolesHandlers(deps);
      const { req, res, status, json } = createReqRes({
        params: { name: 'editor', userId: validUserId },
      });

      await handlers.removeRoleMember(req, res);

      expect(status).toHaveBeenCalledWith(500);
      expect(json).toHaveBeenCalledWith({ error: 'Failed to remove role member' });
    });
  });
});

describe('admin role audit entries', () => {
  const adminUser = () => ({ _id: new Types.ObjectId(), role: 'ADMIN', tenantId: 'tenant-1' });

  it('records role.created with the caller as actor', async () => {
    const recordAuditEntry = jest.fn().mockResolvedValue(undefined);
    const deps = createDeps({
      createRoleByName: jest
        .fn()
        .mockResolvedValue(mockRole({ permissions: { PROMPTS: { USE: true } } } as Partial<IRole>)),
      recordAuditEntry,
    });
    const handlers = createAdminRolesHandlers(deps);
    const user = adminUser();
    const { req, res, status } = createReqRes({ body: { name: 'editor' }, user });

    await handlers.createRole(req, res);

    expect(status).toHaveBeenCalledWith(201);
    expect(recordAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'role.created',
        actor: expect.objectContaining({ type: 'user', id: user._id.toString() }),
        target: { type: 'role', id: 'editor', name: 'editor' },
        metadata: { permissions: 'PROMPTS.USE=true' },
        tenantId: 'tenant-1',
      }),
    );
  });

  it('records role.updated with the previous name on rename', async () => {
    const recordAuditEntry = jest.fn().mockResolvedValue(undefined);
    const deps = createDeps({
      getRoleByName: jest.fn().mockResolvedValueOnce(mockRole()).mockResolvedValueOnce(null),
      updateRoleByName: jest.fn().mockResolvedValue(mockRole({ name: 'writer' })),
      recordAuditEntry,
    });
    const handlers = createAdminRolesHandlers(deps);
    const { req, res, status } = createReqRes({
      params: { name: 'editor' },
      body: { name: 'writer' },
      user: adminUser(),
    });

    await handlers.updateRole(req, res);

    expect(status).toHaveBeenCalledWith(200);
    expect(recordAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'role.updated',
        target: { type: 'role', id: 'writer', name: 'writer' },
        metadata: {
          previousName: 'editor',
          descriptionChanged: false,
          configMoved: false,
          grantsMoved: 0,
          grantCapabilities: null,
          aclEntriesMoved: 0,
        },
      }),
    );
  });

  it('records role.permissions_updated with only the flags that changed', async () => {
    const recordAuditEntry = jest.fn().mockResolvedValue(undefined);
    const before = mockRole({
      permissions: { PROMPTS: { USE: true, CREATE: false } },
    } as Partial<IRole>);
    const after = mockRole({
      permissions: { PROMPTS: { USE: true, CREATE: true } },
    } as Partial<IRole>);
    const deps = createDeps({
      getRoleByName: jest.fn().mockResolvedValueOnce(before).mockResolvedValueOnce(after),
      recordAuditEntry,
    });
    const handlers = createAdminRolesHandlers(deps);
    const { req, res, status } = createReqRes({
      params: { name: 'editor' },
      body: { permissions: { PROMPTS: { CREATE: true } } },
      user: adminUser(),
    });

    await handlers.updateRolePermissions(req, res);

    expect(status).toHaveBeenCalledWith(200);
    expect(recordAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'role.permissions_updated',
        metadata: { changes: 'PROMPTS.CREATE=true', changeCount: 1 },
      }),
    );
  });

  it('does not record a permissions update that changed nothing', async () => {
    const recordAuditEntry = jest.fn().mockResolvedValue(undefined);
    const role = mockRole({ permissions: { PROMPTS: { USE: true } } } as Partial<IRole>);
    const deps = createDeps({
      getRoleByName: jest.fn().mockResolvedValue(role),
      recordAuditEntry,
    });
    const handlers = createAdminRolesHandlers(deps);
    const { req, res, status } = createReqRes({
      params: { name: 'editor' },
      body: { permissions: { PROMPTS: { USE: true } } },
      user: adminUser(),
    });

    await handlers.updateRolePermissions(req, res);

    expect(status).toHaveBeenCalledWith(200);
    expect(recordAuditEntry).not.toHaveBeenCalled();
  });

  it('also records the removal from the previous role when a member is reassigned', async () => {
    const recordAuditEntry = jest.fn().mockResolvedValue(undefined);
    const deps = createDeps({
      getRoleByName: jest.fn().mockResolvedValue(mockRole()),
      findUser: jest.fn().mockResolvedValue(mockUser({ role: 'viewer' })),
      recordAuditEntry,
    });
    const handlers = createAdminRolesHandlers(deps);
    const { req, res } = createReqRes({
      params: { name: 'editor' },
      body: { userId: validUserId },
      user: adminUser(),
    });

    await handlers.addRoleMember(req, res);

    expect(recordAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'role.member_removed',
        target: { type: 'role', id: 'viewer', name: 'viewer' },
        metadata: { userId: validUserId, newRole: 'editor' },
      }),
    );
  });

  it('records role.member_added as critical when a user is promoted to ADMIN', async () => {
    const recordAuditEntry = jest.fn().mockResolvedValue(undefined);
    const deps = createDeps({
      getRoleByName: jest.fn().mockResolvedValue(mockRole({ name: SystemRoles.ADMIN })),
      findUser: jest.fn().mockResolvedValue(mockUser({ role: SystemRoles.USER })),
      recordAuditEntry,
    });
    const handlers = createAdminRolesHandlers(deps);
    const { req, res, status } = createReqRes({
      params: { name: SystemRoles.ADMIN },
      body: { userId: validUserId },
      user: adminUser(),
    });

    await handlers.addRoleMember(req, res);

    expect(status).toHaveBeenCalledWith(200);
    expect(recordAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'role.member_added',
        severity: 'critical',
        target: { type: 'role', id: SystemRoles.ADMIN, name: SystemRoles.ADMIN },
        metadata: { userId: validUserId, previousRole: SystemRoles.USER },
      }),
    );
  });

  it('does not record a membership change that was rolled back', async () => {
    const recordAuditEntry = jest.fn().mockResolvedValue(undefined);
    const deps = createDeps({
      getRoleByName: jest.fn().mockResolvedValue(mockRole()),
      findUser: jest.fn().mockResolvedValue(mockUser({ role: SystemRoles.ADMIN })),
      countUsersByRole: jest.fn().mockResolvedValueOnce(2).mockResolvedValueOnce(0),
      recordAuditEntry,
    });
    const handlers = createAdminRolesHandlers(deps);
    const { req, res, status } = createReqRes({
      params: { name: 'editor' },
      body: { userId: validUserId },
      user: adminUser(),
    });

    await handlers.addRoleMember(req, res);

    expect(status).toHaveBeenCalledWith(400);
    expect(recordAuditEntry).not.toHaveBeenCalled();
  });

  it('records role.member_removed', async () => {
    const recordAuditEntry = jest.fn().mockResolvedValue(undefined);
    const deps = createDeps({
      getRoleByName: jest.fn().mockResolvedValue(mockRole()),
      findUser: jest.fn().mockResolvedValue(mockUser()),
      recordAuditEntry,
    });
    const handlers = createAdminRolesHandlers(deps);
    const { req, res, status } = createReqRes({
      params: { name: 'editor', userId: validUserId },
      user: adminUser(),
    });

    await handlers.removeRoleMember(req, res);

    expect(status).toHaveBeenCalledWith(200);
    expect(recordAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'role.member_removed',
        severity: 'warning',
        metadata: { userId: validUserId, newRole: SystemRoles.USER },
      }),
    );
  });

  it('keeps the mutation and logs when an audit write fails (fail-open)', async () => {
    const recordAuditEntry = jest.fn().mockRejectedValue(new Error('audit down: secret-dsn'));
    const deps = createDeps({ recordAuditEntry });
    const handlers = createAdminRolesHandlers(deps);
    const { req, res, status } = createReqRes({ body: { name: 'editor' }, user: adminUser() });

    await handlers.createRole(req, res);

    expect(status).toHaveBeenCalledWith(201);
    const logged = JSON.stringify(
      (logger.error as jest.Mock).mock.calls.filter(([message]) =>
        String(message).includes('audit write failed'),
      ),
    );
    expect(logged).toContain('audit write failed');
    expect(logged).not.toContain('secret-dsn');
  });

  it('surfaces an audit write failure as a 5xx when auditFailClosed is set', async () => {
    const recordAuditEntry = jest.fn().mockRejectedValue(new Error('audit down'));
    const deps = createDeps({ recordAuditEntry, auditFailClosed: true });
    const handlers = createAdminRolesHandlers(deps);
    const { req, res, status } = createReqRes({ body: { name: 'editor' }, user: adminUser() });

    await handlers.createRole(req, res);

    expect(recordAuditEntry).toHaveBeenCalledWith(expect.anything(), { failClosed: true });
    expect(status).toHaveBeenCalledWith(500);
  });
});

describe('createRolePermissionsUpdateHandler', () => {
  const config = {
    schema: promptPermissionsSchema,
    permissionType: 'PROMPTS',
    errorMessage: 'Invalid prompt permissions.',
  };

  function setup(role: IRole | null, recordAuditEntry = jest.fn().mockResolvedValue(undefined)) {
    const deps = {
      getRoleByName: jest.fn().mockResolvedValue(role),
      updateRoleByName: jest.fn().mockImplementation(async (_name, updates) => ({
        ...role,
        ...updates,
      })),
      recordAuditEntry,
    };
    return { deps, handler: createRolePermissionsUpdateHandler(deps, config) };
  }

  function createSendReqRes(body: unknown) {
    const req = {
      params: { roleName: 'USER' },
      body,
      headers: {},
      user: { _id: new Types.ObjectId(), role: SystemRoles.ADMIN },
    } as unknown as ServerRequest;
    const send = jest.fn();
    const status = jest.fn().mockReturnValue({ send });
    return { req, res: { status, send } as unknown as Response, status, send };
  }

  it('merges the update and records role.permissions_updated', async () => {
    const { deps, handler } = setup(
      mockRole({
        name: 'USER',
        permissions: { PROMPTS: { USE: true, CREATE: true } },
      } as Partial<IRole>),
    );
    const { req, res, status } = createSendReqRes({ CREATE: false });

    await handler(req, res);

    expect(status).toHaveBeenCalledWith(200);
    expect(deps.updateRoleByName).toHaveBeenCalledWith('USER', {
      permissions: { PROMPTS: { USE: true, CREATE: false } },
    });
    expect(deps.recordAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'role.permissions_updated',
        target: { type: 'role', id: 'USER', name: 'USER' },
        metadata: { changes: 'PROMPTS.CREATE=false', changeCount: 1 },
      }),
    );
  });

  it('skips the audit entry when nothing changed', async () => {
    const { deps, handler } = setup(
      mockRole({ name: 'USER', permissions: { PROMPTS: { USE: true } } } as Partial<IRole>),
    );
    const { req, res, status } = createSendReqRes({ USE: true });

    await handler(req, res);

    expect(status).toHaveBeenCalledWith(200);
    expect(deps.recordAuditEntry).not.toHaveBeenCalled();
  });

  it('returns 400 with the validation errors for an invalid body', async () => {
    const { deps, handler } = setup(mockRole());
    const { req, res, status, send } = createSendReqRes({ USE: 'yes' });

    await handler(req, res);

    expect(status).toHaveBeenCalledWith(400);
    expect(send).toHaveBeenCalledWith({
      message: 'Invalid prompt permissions.',
      error: [expect.objectContaining({ code: 'invalid_type', path: ['USE'] })],
    });
    expect(deps.updateRoleByName).not.toHaveBeenCalled();
  });

  it('returns 404 when the role does not exist', async () => {
    const { handler } = setup(null);
    const { req, res, status } = createSendReqRes({ USE: true });

    await handler(req, res);

    expect(status).toHaveBeenCalledWith(404);
  });
});
