import { Types } from 'mongoose';
import { PrincipalType, SystemRoles } from 'librechat-data-provider';
import type { IUser, UserDeleteResult } from '@librechat/data-schemas';
import type { Response } from 'express';
import type { ServerRequest } from '~/types/http';
import type { AdminUsersDeps } from './users';
import { createAdminUsersHandlers } from './users';

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

const validUserId = new Types.ObjectId().toString();

function mockUser(overrides: Partial<IUser> = {}): IUser {
  return {
    _id: new Types.ObjectId(),
    name: 'Test User',
    username: 'testuser',
    email: 'test@example.com',
    avatar: 'https://example.com/avatar.png',
    role: 'USER',
    provider: 'local',
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-06-01'),
    ...overrides,
  } as IUser;
}

function createReqRes(
  overrides: {
    params?: Record<string, string>;
    query?: Record<string, string | string[]>;
    user?: { _id?: Types.ObjectId; id?: string; role?: string; tenantId?: string };
  } = {},
) {
  const req = {
    params: overrides.params ?? {},
    query: overrides.query ?? {},
    body: {},
    user: overrides.user ?? { _id: new Types.ObjectId(), role: 'admin' },
  } as unknown as ServerRequest;

  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const res = { status, json } as unknown as Response;

  return { req, res, status, json };
}

function createDeps(overrides: Partial<AdminUsersDeps> = {}): AdminUsersDeps {
  return {
    findUsers: jest.fn().mockResolvedValue([]),
    countUsers: jest.fn().mockResolvedValue(0),
    beginAgentTriggerUserDeletion: jest.fn().mockResolvedValue('acquired'),
    cancelAgentTriggerUserDeletion: jest.fn().mockResolvedValue(true),
    drainAgentTriggerDeliveriesForUser: jest.fn().mockResolvedValue(undefined),
    prepareAgentTriggerUserPurge: jest.fn().mockResolvedValue(undefined),
    cancelAgentTriggerUserPurge: jest.fn().mockResolvedValue(true),
    purgeAgentTriggerDeliveriesForUser: jest.fn().mockResolvedValue(undefined),
    revokeUserCodeEnvironmentWorkers: jest.fn().mockResolvedValue(0),
    deleteUserById: jest
      .fn()
      .mockResolvedValue({ deletedCount: 1, message: 'User was deleted successfully.' }),
    deleteUserCodeEnvironments: jest.fn().mockResolvedValue(0),
    invalidateCodeEnvironmentConfigCache: jest.fn().mockResolvedValue(undefined),
    deleteConfig: jest.fn().mockResolvedValue(null),
    deleteAclEntries: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('createAdminUsersHandlers', () => {
  describe('listUsers', () => {
    it('returns paginated users with total count', async () => {
      const users = [
        mockUser({ _id: new Types.ObjectId(validUserId) }),
        mockUser({ name: 'Other' }),
      ];
      const deps = createDeps({
        findUsers: jest.fn().mockResolvedValue(users),
        countUsers: jest.fn().mockResolvedValue(2),
      });
      const handlers = createAdminUsersHandlers(deps);
      const { req, res, status, json } = createReqRes();

      await handlers.listUsers(req, res);

      expect(status).toHaveBeenCalledWith(200);
      const response = json.mock.calls[0][0];
      expect(response.users).toHaveLength(2);
      expect(response.total).toBe(2);
      expect(response).toHaveProperty('limit');
      expect(response).toHaveProperty('offset');
      expect(response.users[0]).toHaveProperty('id');
      expect(response.users[0]).toHaveProperty('name');
      expect(response.users[0]).toHaveProperty('email');
      expect(response.users[0]).toHaveProperty('role');
    });

    it('passes pagination params to findUsers and unfiltered count', async () => {
      const findUsers = jest.fn().mockResolvedValue([]);
      const countUsers = jest.fn().mockResolvedValue(0);
      const deps = createDeps({ findUsers, countUsers });
      const handlers = createAdminUsersHandlers(deps);
      const { req, res } = createReqRes({ query: { limit: '10', offset: '20' } });

      await handlers.listUsers(req, res);

      expect(findUsers).toHaveBeenCalledWith({}, expect.any(String), {
        limit: 10,
        offset: 20,
        sort: { createdAt: -1 },
      });
      expect(countUsers).toHaveBeenCalledWith();
    });

    it('returns empty list when no users', async () => {
      const deps = createDeps();
      const handlers = createAdminUsersHandlers(deps);
      const { req, res, status, json } = createReqRes();

      await handlers.listUsers(req, res);

      expect(status).toHaveBeenCalledWith(200);
      expect(json.mock.calls[0][0].users).toEqual([]);
      expect(json.mock.calls[0][0].total).toBe(0);
    });

    it('returns 500 when findUsers throws', async () => {
      const deps = createDeps({ findUsers: jest.fn().mockRejectedValue(new Error('db down')) });
      const handlers = createAdminUsersHandlers(deps);
      const { req, res, status, json } = createReqRes();

      await handlers.listUsers(req, res);

      expect(status).toHaveBeenCalledWith(500);
      expect(json).toHaveBeenCalledWith({ error: 'Failed to list users' });
    });

    it('returns 500 when countUsers throws', async () => {
      const deps = createDeps({
        countUsers: jest.fn().mockRejectedValue(new Error('count failed')),
      });
      const handlers = createAdminUsersHandlers(deps);
      const { req, res, status, json } = createReqRes();

      await handlers.listUsers(req, res);

      expect(status).toHaveBeenCalledWith(500);
      expect(json).toHaveBeenCalledWith({ error: 'Failed to list users' });
    });
  });

  describe('searchUsers', () => {
    it('returns matching users with total and capped flag', async () => {
      const users = [mockUser()];
      const deps = createDeps({ findUsers: jest.fn().mockResolvedValue(users) });
      const handlers = createAdminUsersHandlers(deps);
      const { req, res, status, json } = createReqRes({ query: { q: 'test' } });

      await handlers.searchUsers(req, res);

      expect(status).toHaveBeenCalledWith(200);
      const response = json.mock.calls[0][0];
      expect(response.users).toHaveLength(1);
      expect(response.total).toBe(1);
      expect(response.capped).toBe(false);
      expect(response.users[0]).toHaveProperty('id');
      expect(response.users[0]).toHaveProperty('name');
      expect(response.users[0]).toHaveProperty('email');
      expect(response.users[0]).toHaveProperty('username');
    });

    it('sets capped to true when results hit the limit', async () => {
      const users = Array.from({ length: 20 }, () => mockUser());
      const deps = createDeps({ findUsers: jest.fn().mockResolvedValue(users) });
      const handlers = createAdminUsersHandlers(deps);
      const { req, res, json } = createReqRes({ query: { q: 'test', limit: '20' } });

      await handlers.searchUsers(req, res);

      const response = json.mock.calls[0][0];
      expect(response.total).toBe(20);
      expect(response.capped).toBe(true);
    });

    it('searches name, email, and username with anchored prefix regex', async () => {
      const findUsers = jest.fn().mockResolvedValue([]);
      const deps = createDeps({ findUsers });
      const handlers = createAdminUsersHandlers(deps);
      const { req, res } = createReqRes({ query: { q: 'test' } });

      await handlers.searchUsers(req, res);

      const filter = findUsers.mock.calls[0][0];
      expect(filter.$or).toHaveLength(3);
      expect(filter.$or[0]).toHaveProperty('name');
      expect(filter.$or[1]).toHaveProperty('email');
      expect(filter.$or[2]).toHaveProperty('username');
      expect(filter.$or[0].name.source).toBe('^test');
    });

    it('projects username in the field selection', async () => {
      const findUsers = jest.fn().mockResolvedValue([]);
      const deps = createDeps({ findUsers });
      const handlers = createAdminUsersHandlers(deps);
      const { req, res } = createReqRes({ query: { q: 'test' } });

      await handlers.searchUsers(req, res);

      const projection = findUsers.mock.calls[0][1];
      expect(projection).toContain('username');
    });

    it('escapes regex special characters in query', async () => {
      const findUsers = jest.fn().mockResolvedValue([]);
      const deps = createDeps({ findUsers });
      const handlers = createAdminUsersHandlers(deps);
      const { req, res } = createReqRes({ query: { q: 'test.user+1' } });

      await handlers.searchUsers(req, res);

      const filter = findUsers.mock.calls[0][0];
      expect(filter.$or[0].name).toBeInstanceOf(RegExp);
      expect(filter.$or[0].name.source).toBe('^test\\.user\\+1');
    });

    it('returns 400 when query is missing', async () => {
      const deps = createDeps();
      const handlers = createAdminUsersHandlers(deps);
      const { req, res, status, json } = createReqRes({ query: {} });

      await handlers.searchUsers(req, res);

      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith({ error: 'Query parameter "q" is required' });
    });

    it('returns 400 when query is empty string', async () => {
      const deps = createDeps();
      const handlers = createAdminUsersHandlers(deps);
      const { req, res, status, json } = createReqRes({ query: { q: '' } });

      await handlers.searchUsers(req, res);

      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith({ error: 'Query parameter "q" is required' });
    });

    it('returns 400 when query is whitespace-only', async () => {
      const deps = createDeps();
      const handlers = createAdminUsersHandlers(deps);
      const { req, res, status, json } = createReqRes({ query: { q: '   ' } });

      await handlers.searchUsers(req, res);

      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith({ error: 'Query parameter "q" is required' });
    });

    it('returns 400 when query is too short', async () => {
      const deps = createDeps();
      const handlers = createAdminUsersHandlers(deps);
      const { req, res, status, json } = createReqRes({ query: { q: 'a' } });

      await handlers.searchUsers(req, res);

      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith({ error: 'Query must be at least 2 characters' });
    });

    it('returns 400 when query exceeds max length', async () => {
      const deps = createDeps();
      const handlers = createAdminUsersHandlers(deps);
      const { req, res, status, json } = createReqRes({ query: { q: 'a'.repeat(201) } });

      await handlers.searchUsers(req, res);

      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringContaining('200') }),
      );
    });

    it('treats array query param as missing', async () => {
      const deps = createDeps();
      const handlers = createAdminUsersHandlers(deps);
      const { req, res, status, json } = createReqRes({ query: { q: ['foo', 'bar'] } });

      await handlers.searchUsers(req, res);

      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith({ error: 'Query parameter "q" is required' });
    });

    it('passes limit to findUsers', async () => {
      const findUsers = jest.fn().mockResolvedValue([mockUser()]);
      const deps = createDeps({ findUsers });
      const handlers = createAdminUsersHandlers(deps);
      const { req, res } = createReqRes({ query: { q: 'User', limit: '3' } });

      await handlers.searchUsers(req, res);

      expect(findUsers).toHaveBeenCalledWith(expect.any(Object), expect.any(String), {
        limit: 3,
        sort: { name: 1 },
      });
    });

    it('caps limit at 50', async () => {
      const findUsers = jest.fn().mockResolvedValue([]);
      const deps = createDeps({ findUsers });
      const handlers = createAdminUsersHandlers(deps);
      const { req, res } = createReqRes({ query: { q: 'User', limit: '100' } });

      await handlers.searchUsers(req, res);

      expect(findUsers).toHaveBeenCalledWith(expect.any(Object), expect.any(String), {
        limit: 50,
        sort: { name: 1 },
      });
    });

    it('returns 500 on error', async () => {
      const deps = createDeps({ findUsers: jest.fn().mockRejectedValue(new Error('db down')) });
      const handlers = createAdminUsersHandlers(deps);
      const { req, res, status, json } = createReqRes({ query: { q: 'test' } });

      await handlers.searchUsers(req, res);

      expect(status).toHaveBeenCalledWith(500);
      expect(json).toHaveBeenCalledWith({ error: 'Failed to search users' });
    });
  });

  describe('deleteUser', () => {
    it('deletes user and returns 200', async () => {
      const result: UserDeleteResult = {
        deletedCount: 1,
        message: 'User was deleted successfully.',
      };
      const deps = createDeps({ deleteUserById: jest.fn().mockResolvedValue(result) });
      const handlers = createAdminUsersHandlers(deps);
      const { req, res, status, json } = createReqRes({ params: { id: validUserId } });

      await handlers.deleteUser(req, res);

      expect(status).toHaveBeenCalledWith(200);
      expect(json).toHaveBeenCalledWith({ message: 'User was deleted successfully.' });
      expect(deps.beginAgentTriggerUserDeletion).toHaveBeenCalledWith(
        validUserId,
        expect.any(Date),
      );
      expect(deps.drainAgentTriggerDeliveriesForUser).toHaveBeenCalledWith(validUserId);
      expect(deps.prepareAgentTriggerUserPurge).toHaveBeenCalledWith(
        validUserId,
        expect.any(Date),
        undefined,
      );
      expect(deps.purgeAgentTriggerDeliveriesForUser).toHaveBeenCalledWith(validUserId);
      expect(deps.cancelAgentTriggerUserPurge).not.toHaveBeenCalled();
      expect(deps.cancelAgentTriggerUserDeletion).not.toHaveBeenCalled();
    });

    it('returns fallback message when result.message is empty', async () => {
      const result: UserDeleteResult = { deletedCount: 1, message: '' };
      const deps = createDeps({ deleteUserById: jest.fn().mockResolvedValue(result) });
      const handlers = createAdminUsersHandlers(deps);
      const { req, res, status, json } = createReqRes({ params: { id: validUserId } });

      await handlers.deleteUser(req, res);

      expect(status).toHaveBeenCalledWith(200);
      expect(json).toHaveBeenCalledWith({ message: 'User deleted successfully' });
    });

    it('returns 403 when deleting own account', async () => {
      const userId = new Types.ObjectId();
      const deps = createDeps();
      const handlers = createAdminUsersHandlers(deps);
      const { req, res, status, json } = createReqRes({
        params: { id: userId.toString() },
        user: { _id: userId, role: 'admin' },
      });

      await handlers.deleteUser(req, res);

      expect(status).toHaveBeenCalledWith(403);
      expect(json).toHaveBeenCalledWith({ error: 'Cannot delete your own account' });
      expect(deps.deleteUserById).not.toHaveBeenCalled();
    });

    it('returns 400 when deleting the last admin', async () => {
      const targetId = new Types.ObjectId().toString();
      const deps = createDeps({
        findUsers: jest.fn().mockResolvedValue([mockUser({ role: SystemRoles.ADMIN })]),
        countUsers: jest.fn().mockResolvedValue(1),
      });
      const handlers = createAdminUsersHandlers(deps);
      const { req, res, status, json } = createReqRes({ params: { id: targetId } });

      await handlers.deleteUser(req, res);

      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith({ error: 'Cannot delete the last admin user' });
      expect(deps.deleteUserById).not.toHaveBeenCalled();
      expect(deps.countUsers).toHaveBeenCalledWith({ role: SystemRoles.ADMIN });
    });

    it('allows deleting an admin when other admins exist', async () => {
      const targetId = new Types.ObjectId().toString();
      const deps = createDeps({
        findUsers: jest.fn().mockResolvedValue([mockUser({ role: SystemRoles.ADMIN })]),
        countUsers: jest.fn().mockResolvedValue(3),
      });
      const handlers = createAdminUsersHandlers(deps);
      const { req, res, status } = createReqRes({ params: { id: targetId } });

      await handlers.deleteUser(req, res);

      expect(status).toHaveBeenCalledWith(200);
      expect(deps.deleteUserById).toHaveBeenCalledWith(targetId);
    });

    it('does not check admin count when target is a regular user', async () => {
      const targetId = new Types.ObjectId().toString();
      const deps = createDeps({
        findUsers: jest.fn().mockResolvedValue([mockUser({ role: 'USER' })]),
      });
      const handlers = createAdminUsersHandlers(deps);
      const { req, res, status } = createReqRes({ params: { id: targetId } });

      await handlers.deleteUser(req, res);

      expect(status).toHaveBeenCalledWith(200);
      expect(deps.countUsers).not.toHaveBeenCalled();
    });

    it('cascades cleanup of Config, code environments, and AclEntries', async () => {
      const result: UserDeleteResult = {
        deletedCount: 1,
        message: 'User was deleted successfully.',
      };
      const deps = createDeps({ deleteUserById: jest.fn().mockResolvedValue(result) });
      const handlers = createAdminUsersHandlers(deps);
      const { req, res, status } = createReqRes({ params: { id: validUserId } });

      await handlers.deleteUser(req, res);

      expect(status).toHaveBeenCalledWith(200);
      expect(deps.deleteConfig).toHaveBeenCalledWith(PrincipalType.USER, validUserId);
      expect(deps.deleteUserCodeEnvironments).toHaveBeenCalledWith(expect.any(Types.ObjectId));
      expect(deps.invalidateCodeEnvironmentConfigCache).toHaveBeenCalledWith(undefined);
      expect(deps.deleteAclEntries).toHaveBeenCalledWith({
        principalType: PrincipalType.USER,
        principalId: expect.any(Types.ObjectId),
      });
    });

    it('returns success even when cascade cleanup partially fails', async () => {
      const result: UserDeleteResult = {
        deletedCount: 1,
        message: 'User was deleted successfully.',
      };
      const deps = createDeps({
        deleteUserById: jest.fn().mockResolvedValue(result),
        deleteConfig: jest.fn().mockRejectedValue(new Error('cleanup failed')),
      });
      const handlers = createAdminUsersHandlers(deps);
      const { req, res, status, json } = createReqRes({ params: { id: validUserId } });

      await handlers.deleteUser(req, res);

      expect(status).toHaveBeenCalledWith(200);
      expect(json).toHaveBeenCalledWith({ message: 'User was deleted successfully.' });
    });

    it('preserves code environment records when revocation marking fails', async () => {
      const deps = createDeps({
        revokeUserCodeEnvironmentWorkers: jest.fn().mockRejectedValue(new Error('mongo down')),
      });
      const handlers = createAdminUsersHandlers(deps);
      const { req, res } = createReqRes({ params: { id: validUserId } });

      await handlers.deleteUser(req, res);

      expect(deps.deleteUserById).toHaveBeenCalledWith(validUserId);
      expect(deps.deleteUserCodeEnvironments).not.toHaveBeenCalled();
    });

    it('does not cascade when user is not found', async () => {
      const result: UserDeleteResult = { deletedCount: 0, message: '' };
      const deps = createDeps({ deleteUserById: jest.fn().mockResolvedValue(result) });
      const handlers = createAdminUsersHandlers(deps);
      const { req, res, status } = createReqRes({ params: { id: validUserId } });

      await handlers.deleteUser(req, res);

      expect(status).toHaveBeenCalledWith(404);
      expect(deps.deleteConfig).not.toHaveBeenCalled();
      expect(deps.deleteUserCodeEnvironments).not.toHaveBeenCalled();
      expect(deps.deleteAclEntries).not.toHaveBeenCalled();
      expect(deps.purgeAgentTriggerDeliveriesForUser).not.toHaveBeenCalled();
      expect(deps.cancelAgentTriggerUserDeletion).toHaveBeenCalledWith(
        validUserId,
        expect.any(Date),
      );
      expect(deps.cancelAgentTriggerUserPurge).toHaveBeenCalledWith(validUserId, expect.any(Date));
    });

    it('returns 400 for invalid ObjectId', async () => {
      const deps = createDeps();
      const handlers = createAdminUsersHandlers(deps);
      const { req, res, status, json } = createReqRes({ params: { id: 'not-valid' } });

      await handlers.deleteUser(req, res);

      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith({ error: 'Invalid user ID format' });
    });

    it('returns 404 when user not found', async () => {
      const result: UserDeleteResult = { deletedCount: 0, message: '' };
      const deps = createDeps({ deleteUserById: jest.fn().mockResolvedValue(result) });
      const handlers = createAdminUsersHandlers(deps);
      const { req, res, status, json } = createReqRes({ params: { id: validUserId } });

      await handlers.deleteUser(req, res);

      expect(status).toHaveBeenCalledWith(404);
      expect(json).toHaveBeenCalledWith({ error: 'User not found' });
    });

    it('returns 500 on error', async () => {
      const deps = createDeps({
        deleteUserById: jest.fn().mockRejectedValue(new Error('db crash')),
      });
      const handlers = createAdminUsersHandlers(deps);
      const { req, res, status, json } = createReqRes({ params: { id: validUserId } });

      await handlers.deleteUser(req, res);

      expect(status).toHaveBeenCalledWith(500);
      expect(json).toHaveBeenCalledWith({ error: 'Failed to delete user' });
      expect(deps.cancelAgentTriggerUserDeletion).toHaveBeenCalledWith(
        validUserId,
        expect.any(Date),
      );
      expect(deps.cancelAgentTriggerUserPurge).toHaveBeenCalledWith(validUserId, expect.any(Date));
      expect(deps.purgeAgentTriggerDeliveriesForUser).not.toHaveBeenCalled();
    });

    it('does not delete while another deletion owns the trigger fence', async () => {
      const deps = createDeps({
        beginAgentTriggerUserDeletion: jest.fn().mockResolvedValue('in_progress'),
      });
      const handlers = createAdminUsersHandlers(deps);
      const { req, res, status, json } = createReqRes({ params: { id: validUserId } });

      await handlers.deleteUser(req, res);

      expect(status).toHaveBeenCalledWith(409);
      expect(json).toHaveBeenCalledWith({ error: 'User deletion is already in progress' });
      expect(deps.drainAgentTriggerDeliveriesForUser).not.toHaveBeenCalled();
      expect(deps.deleteUserById).not.toHaveBeenCalled();
      expect(deps.cancelAgentTriggerUserDeletion).not.toHaveBeenCalled();
    });

    it('returns not found without draining when the trigger fence principal is missing', async () => {
      const deps = createDeps({
        beginAgentTriggerUserDeletion: jest.fn().mockResolvedValue('missing'),
      });
      const handlers = createAdminUsersHandlers(deps);
      const { req, res, status, json } = createReqRes({ params: { id: validUserId } });

      await handlers.deleteUser(req, res);

      expect(status).toHaveBeenCalledWith(404);
      expect(json).toHaveBeenCalledWith({ error: 'User not found' });
      expect(deps.drainAgentTriggerDeliveriesForUser).not.toHaveBeenCalled();
      expect(deps.deleteUserById).not.toHaveBeenCalled();
      expect(deps.cancelAgentTriggerUserDeletion).not.toHaveBeenCalled();
    });

    it('drains before commit and purges only after the user is deleted', async () => {
      const deps = createDeps();
      const handlers = createAdminUsersHandlers(deps);
      const { req, res } = createReqRes({ params: { id: validUserId } });

      await handlers.deleteUser(req, res);

      const beginOrder = (deps.beginAgentTriggerUserDeletion as jest.Mock).mock
        .invocationCallOrder[0];
      const prepareOrder = (deps.prepareAgentTriggerUserPurge as jest.Mock).mock
        .invocationCallOrder[0];
      const drainOrder = (deps.drainAgentTriggerDeliveriesForUser as jest.Mock).mock
        .invocationCallOrder[0];
      const deleteOrder = (deps.deleteUserById as jest.Mock).mock.invocationCallOrder[0];
      const revokeCodeOrder = (deps.revokeUserCodeEnvironmentWorkers as jest.Mock).mock
        .invocationCallOrder[0];
      const deleteCodeOrder = (deps.deleteUserCodeEnvironments as jest.Mock).mock
        .invocationCallOrder[0];
      const purgeOrder = (deps.purgeAgentTriggerDeliveriesForUser as jest.Mock).mock
        .invocationCallOrder[0];
      expect(beginOrder).toBeLessThan(drainOrder);
      expect(beginOrder).toBeLessThan(prepareOrder);
      expect(prepareOrder).toBeLessThan(drainOrder);
      expect(drainOrder).toBeLessThan(deleteOrder);
      expect(deleteOrder).toBeLessThan(revokeCodeOrder);
      expect(revokeCodeOrder).toBeLessThan(deleteCodeOrder);
      expect(deleteOrder).toBeLessThan(purgeOrder);
    });

    it('leaves durable purge recovery armed when immediate post-commit cleanup fails', async () => {
      const deps = createDeps({
        purgeAgentTriggerDeliveriesForUser: jest.fn().mockRejectedValue(new Error('db down')),
      });
      const handlers = createAdminUsersHandlers(deps);
      const { req, res, status, json } = createReqRes({ params: { id: validUserId } });

      await handlers.deleteUser(req, res);

      expect(status).toHaveBeenCalledWith(500);
      expect(json).toHaveBeenCalledWith({ error: 'Failed to delete user' });
      expect(deps.deleteUserById).toHaveBeenCalledWith(validUserId);
      expect(deps.prepareAgentTriggerUserPurge).toHaveBeenCalled();
      expect(deps.cancelAgentTriggerUserPurge).not.toHaveBeenCalled();
      expect(deps.cancelAgentTriggerUserDeletion).not.toHaveBeenCalled();
    });
  });
});
