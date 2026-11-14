import { Types } from 'mongoose';
import { PrincipalType } from 'librechat-data-provider';
import type { IGroup, IUser } from '@librechat/data-schemas';
import type { Response } from 'express';
import type { ServerRequest } from '~/types/http';
import type { AdminGroupsDeps } from './groups';
import { createAdminGroupsHandlers } from './groups';

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

describe('createAdminGroupsHandlers', () => {
  let validId: string;
  let validUserId: string;

  beforeEach(() => {
    validId = new Types.ObjectId().toString();
    validUserId = new Types.ObjectId().toString();
  });

  function mockGroup(overrides: Partial<IGroup> = {}): IGroup {
    return {
      _id: new Types.ObjectId(validId),
      name: 'Test Group',
      source: 'local',
      memberIds: [],
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    } as IGroup;
  }

  function mockUser(overrides: Partial<IUser> = {}): IUser {
    return {
      _id: new Types.ObjectId(validUserId),
      name: 'Test User',
      email: 'test@example.com',
      avatar: 'https://example.com/avatar.png',
      ...overrides,
    } as IUser;
  }

  function createReqRes(
    overrides: {
      params?: Record<string, string>;
      query?: Record<string, string>;
      body?: Record<string, unknown>;
    } = {},
  ) {
    const req = {
      params: overrides.params ?? {},
      query: overrides.query ?? {},
      body: overrides.body ?? {},
    } as unknown as ServerRequest;

    const json = jest.fn();
    const status = jest.fn().mockReturnValue({ json });
    const res = { status, json } as unknown as Response;

    return { req, res, status, json };
  }

  function createDeps(overrides: Partial<AdminGroupsDeps> = {}): AdminGroupsDeps {
    return {
      listGroups: jest.fn().mockResolvedValue([]),
      countGroups: jest.fn().mockResolvedValue(0),
      findGroupById: jest.fn().mockResolvedValue(null),
      createGroup: jest.fn().mockResolvedValue(mockGroup()),
      updateGroupFieldsTracked: jest
        .fn()
        .mockResolvedValue({ group: mockGroup(), changed: true, changedFields: ['name'] }),
      deleteGroup: jest.fn().mockResolvedValue(mockGroup()),
      addUserToGroup: jest
        .fn()
        .mockResolvedValue({ user: mockUser(), group: mockGroup(), changed: true }),
      removeUserFromGroup: jest
        .fn()
        .mockResolvedValue({ user: mockUser(), group: mockGroup(), changed: true }),
      removeMemberByIdTracked: jest
        .fn()
        .mockResolvedValue({ group: mockGroup(), changed: true, changedFields: ['name'] }),
      findUsers: jest.fn().mockResolvedValue([]),
      deleteConfig: jest.fn().mockResolvedValue(null),
      deleteAclEntries: jest.fn().mockResolvedValue({ deletedCount: 0 }),
      ...overrides,
    };
  }

  describe('listGroups', () => {
    it('returns groups with total, limit, offset', async () => {
      const groups = [mockGroup()];
      const deps = createDeps({
        listGroups: jest.fn().mockResolvedValue(groups),
        countGroups: jest.fn().mockResolvedValue(1),
      });
      const handlers = createAdminGroupsHandlers(deps);
      const { req, res, status, json } = createReqRes({ query: {} });

      await handlers.listGroups(req, res);

      expect(status).toHaveBeenCalledWith(200);
      expect(json).toHaveBeenCalledWith({ groups, total: 1, limit: 50, offset: 0 });
    });

    it('passes source and search filters with pagination', async () => {
      const deps = createDeps();
      const handlers = createAdminGroupsHandlers(deps);
      const { req, res } = createReqRes({
        query: { source: 'entra', search: 'engineering', limit: '20', offset: '10' },
      });

      await handlers.listGroups(req, res);

      expect(deps.listGroups).toHaveBeenCalledWith({
        source: 'entra',
        search: 'engineering',
        limit: 20,
        offset: 10,
      });
      expect(deps.countGroups).toHaveBeenCalledWith({
        source: 'entra',
        search: 'engineering',
      });
    });

    it('passes search filter alone', async () => {
      const deps = createDeps();
      const handlers = createAdminGroupsHandlers(deps);
      const { req, res } = createReqRes({ query: { search: 'eng' } });

      await handlers.listGroups(req, res);

      expect(deps.listGroups).toHaveBeenCalledWith({ search: 'eng', limit: 50, offset: 0 });
      expect(deps.countGroups).toHaveBeenCalledWith({ search: 'eng' });
    });

    it('ignores invalid source values', async () => {
      const deps = createDeps();
      const handlers = createAdminGroupsHandlers(deps);
      const { req, res } = createReqRes({ query: { source: 'invalid' } });

      await handlers.listGroups(req, res);

      expect(deps.listGroups).toHaveBeenCalledWith({ limit: 50, offset: 0 });
      expect(deps.countGroups).toHaveBeenCalledWith({});
    });

    it('clamps limit and offset', async () => {
      const deps = createDeps();
      const handlers = createAdminGroupsHandlers(deps);
      const { req, res } = createReqRes({ query: { limit: '999', offset: '-5' } });

      await handlers.listGroups(req, res);

      expect(deps.listGroups).toHaveBeenCalledWith({ limit: 200, offset: 0 });
    });

    it('returns 400 when search exceeds max length', async () => {
      const deps = createDeps();
      const handlers = createAdminGroupsHandlers(deps);
      const { req, res, status, json } = createReqRes({
        query: { search: 'a'.repeat(201) },
      });

      await handlers.listGroups(req, res);

      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith({ error: 'search must not exceed 200 characters' });
      expect(deps.listGroups).not.toHaveBeenCalled();
    });

    it('returns 500 when countGroups fails', async () => {
      const deps = createDeps({
        countGroups: jest.fn().mockRejectedValue(new Error('count failed')),
      });
      const handlers = createAdminGroupsHandlers(deps);
      const { req, res, status, json } = createReqRes();

      await handlers.listGroups(req, res);

      expect(status).toHaveBeenCalledWith(500);
      expect(json).toHaveBeenCalledWith({ error: 'Failed to list groups' });
    });

    it('returns 500 on error', async () => {
      const deps = createDeps({ listGroups: jest.fn().mockRejectedValue(new Error('db down')) });
      const handlers = createAdminGroupsHandlers(deps);
      const { req, res, status, json } = createReqRes();

      await handlers.listGroups(req, res);

      expect(status).toHaveBeenCalledWith(500);
      expect(json).toHaveBeenCalledWith({ error: 'Failed to list groups' });
    });
  });

  describe('getGroup', () => {
    it('returns group with 200', async () => {
      const group = mockGroup();
      const deps = createDeps({ findGroupById: jest.fn().mockResolvedValue(group) });
      const handlers = createAdminGroupsHandlers(deps);
      const { req, res, status, json } = createReqRes({ params: { id: validId } });

      await handlers.getGroup(req, res);

      expect(status).toHaveBeenCalledWith(200);
      expect(json).toHaveBeenCalledWith({ group });
    });

    it('returns 400 for invalid ID', async () => {
      const deps = createDeps();
      const handlers = createAdminGroupsHandlers(deps);
      const { req, res, status, json } = createReqRes({ params: { id: 'not-an-id' } });

      await handlers.getGroup(req, res);

      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith({ error: 'Invalid group ID format' });
      expect(deps.findGroupById).not.toHaveBeenCalled();
    });

    it('returns 404 when group not found', async () => {
      const deps = createDeps({ findGroupById: jest.fn().mockResolvedValue(null) });
      const handlers = createAdminGroupsHandlers(deps);
      const { req, res, status, json } = createReqRes({ params: { id: validId } });

      await handlers.getGroup(req, res);

      expect(status).toHaveBeenCalledWith(404);
      expect(json).toHaveBeenCalledWith({ error: 'Group not found' });
    });

    it('returns 500 on error', async () => {
      const deps = createDeps({
        findGroupById: jest.fn().mockRejectedValue(new Error('db down')),
      });
      const handlers = createAdminGroupsHandlers(deps);
      const { req, res, status, json } = createReqRes({ params: { id: validId } });

      await handlers.getGroup(req, res);

      expect(status).toHaveBeenCalledWith(500);
      expect(json).toHaveBeenCalledWith({ error: 'Failed to get group' });
    });
  });

  describe('createGroup', () => {
    it('creates group and returns 201', async () => {
      const group = mockGroup();
      const deps = createDeps({ createGroup: jest.fn().mockResolvedValue(group) });
      const handlers = createAdminGroupsHandlers(deps);
      const { req, res, status, json } = createReqRes({
        body: { name: 'New Group', description: 'A group' },
      });

      await handlers.createGroup(req, res);

      expect(status).toHaveBeenCalledWith(201);
      expect(json).toHaveBeenCalledWith({ group });
      expect(deps.createGroup).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'New Group',
          description: 'A group',
          source: 'local',
          memberIds: [],
        }),
      );
    });

    it('normalizes memberIds to idOnTheSource values', async () => {
      const userId = new Types.ObjectId().toString();
      const user = { _id: new Types.ObjectId(userId), idOnTheSource: 'ext-norm-1' } as IUser;
      const group = mockGroup();
      const deps = createDeps({
        createGroup: jest.fn().mockResolvedValue(group),
        findUsers: jest.fn().mockResolvedValue([user]),
      });
      const handlers = createAdminGroupsHandlers(deps);
      const { req, res, status } = createReqRes({
        body: { name: 'With Members', memberIds: [userId] },
      });

      await handlers.createGroup(req, res);

      expect(status).toHaveBeenCalledWith(201);
      expect(deps.findUsers).toHaveBeenCalledWith({ _id: { $in: [userId] } }, 'idOnTheSource');
      expect(deps.createGroup).toHaveBeenCalledWith(
        expect.objectContaining({ memberIds: ['ext-norm-1'] }),
      );
    });

    it('logs warning when memberIds contain non-existent user ObjectIds', async () => {
      const { logger } = jest.requireMock('@librechat/data-schemas');
      const unknownId = new Types.ObjectId().toString();
      const group = mockGroup();
      const deps = createDeps({
        createGroup: jest.fn().mockResolvedValue(group),
        findUsers: jest.fn().mockResolvedValue([]),
      });
      const handlers = createAdminGroupsHandlers(deps);
      const { req, res, status } = createReqRes({
        body: { name: 'With Unknown', memberIds: [unknownId] },
      });

      await handlers.createGroup(req, res);

      expect(status).toHaveBeenCalledWith(201);
      expect(logger.warn).toHaveBeenCalledWith(
        '[adminGroups] createGroup: memberIds contain unknown user ObjectIds:',
        [unknownId],
      );
    });

    it('passes idOnTheSource when provided', async () => {
      const group = mockGroup();
      const deps = createDeps({ createGroup: jest.fn().mockResolvedValue(group) });
      const handlers = createAdminGroupsHandlers(deps);
      const { req, res, status } = createReqRes({
        body: { name: 'Entra Group', source: 'entra', idOnTheSource: 'ent-abc-123' },
      });

      await handlers.createGroup(req, res);

      expect(status).toHaveBeenCalledWith(201);
      expect(deps.createGroup).toHaveBeenCalledWith(
        expect.objectContaining({ idOnTheSource: 'ent-abc-123', source: 'entra' }),
      );
    });

    it('returns 400 for invalid source value', async () => {
      const deps = createDeps();
      const handlers = createAdminGroupsHandlers(deps);
      const { req, res, status, json } = createReqRes({
        body: { name: 'Bad Source', source: 'azure' },
      });

      await handlers.createGroup(req, res);

      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith({ error: 'Invalid source value' });
      expect(deps.createGroup).not.toHaveBeenCalled();
    });

    it('returns 400 when name exceeds max length', async () => {
      const deps = createDeps();
      const handlers = createAdminGroupsHandlers(deps);
      const { req, res, status, json } = createReqRes({
        body: { name: 'a'.repeat(501) },
      });

      await handlers.createGroup(req, res);

      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith({ error: 'name must not exceed 500 characters' });
      expect(deps.createGroup).not.toHaveBeenCalled();
    });

    it('returns 400 when description exceeds max length', async () => {
      const deps = createDeps();
      const handlers = createAdminGroupsHandlers(deps);
      const { req, res, status, json } = createReqRes({
        body: { name: 'Valid', description: 'x'.repeat(2001) },
      });

      await handlers.createGroup(req, res);

      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith({
        error: 'description must not exceed 2000 characters',
      });
      expect(deps.createGroup).not.toHaveBeenCalled();
    });

    it('returns 400 when email exceeds max length', async () => {
      const deps = createDeps();
      const handlers = createAdminGroupsHandlers(deps);
      const { req, res, status, json } = createReqRes({
        body: { name: 'Valid', email: 'x'.repeat(501) },
      });

      await handlers.createGroup(req, res);

      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith({ error: 'email must not exceed 500 characters' });
      expect(deps.createGroup).not.toHaveBeenCalled();
    });

    it('returns 400 when avatar exceeds max length', async () => {
      const deps = createDeps();
      const handlers = createAdminGroupsHandlers(deps);
      const { req, res, status, json } = createReqRes({
        body: { name: 'Valid', avatar: 'x'.repeat(2001) },
      });

      await handlers.createGroup(req, res);

      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith({ error: 'avatar must not exceed 2000 characters' });
      expect(deps.createGroup).not.toHaveBeenCalled();
    });

    it('returns 400 when idOnTheSource exceeds max length', async () => {
      const deps = createDeps();
      const handlers = createAdminGroupsHandlers(deps);
      const { req, res, status, json } = createReqRes({
        body: { name: 'Valid', idOnTheSource: 'x'.repeat(501) },
      });

      await handlers.createGroup(req, res);

      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith({
        error: 'idOnTheSource must not exceed 500 characters',
      });
      expect(deps.createGroup).not.toHaveBeenCalled();
    });

    it('returns 400 when memberIds exceeds cap', async () => {
      const deps = createDeps();
      const handlers = createAdminGroupsHandlers(deps);
      const memberIds = Array.from({ length: 501 }, (_, i) => `ext-${i}`);
      const { req, res, status, json } = createReqRes({
        body: { name: 'Too Many Members', memberIds },
      });

      await handlers.createGroup(req, res);

      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith({ error: 'memberIds must not exceed 500 entries' });
      expect(deps.createGroup).not.toHaveBeenCalled();
    });

    it('passes non-ObjectId memberIds through unchanged', async () => {
      const deps = createDeps();
      const handlers = createAdminGroupsHandlers(deps);
      const { req, res, status } = createReqRes({
        body: { name: 'Ext Group', memberIds: ['ext-1', 'ext-2'] },
      });

      await handlers.createGroup(req, res);

      expect(deps.findUsers).not.toHaveBeenCalled();
      expect(deps.createGroup).toHaveBeenCalledWith(
        expect.objectContaining({ memberIds: ['ext-1', 'ext-2'] }),
      );
      expect(status).toHaveBeenCalledWith(201);
    });

    it('returns 400 when name is missing', async () => {
      const deps = createDeps();
      const handlers = createAdminGroupsHandlers(deps);
      const { req, res, status, json } = createReqRes({ body: {} });

      await handlers.createGroup(req, res);

      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith({ error: 'name is required' });
      expect(deps.createGroup).not.toHaveBeenCalled();
    });

    it('returns 400 when name is whitespace-only', async () => {
      const deps = createDeps();
      const handlers = createAdminGroupsHandlers(deps);
      const { req, res, status, json } = createReqRes({ body: { name: '   ' } });

      await handlers.createGroup(req, res);

      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith({ error: 'name is required' });
    });

    it('returns 400 on ValidationError', async () => {
      const validationError = new Error('source must be local or entra');
      validationError.name = 'ValidationError';
      const deps = createDeps({ createGroup: jest.fn().mockRejectedValue(validationError) });
      const handlers = createAdminGroupsHandlers(deps);
      const { req, res, status, json } = createReqRes({ body: { name: 'Test' } });

      await handlers.createGroup(req, res);

      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith({ error: 'source must be local or entra' });
    });

    it('returns 500 on unexpected error', async () => {
      const deps = createDeps({ createGroup: jest.fn().mockRejectedValue(new Error('db crash')) });
      const handlers = createAdminGroupsHandlers(deps);
      const { req, res, status, json } = createReqRes({ body: { name: 'Test' } });

      await handlers.createGroup(req, res);

      expect(status).toHaveBeenCalledWith(500);
      expect(json).toHaveBeenCalledWith({ error: 'Failed to create group' });
    });
  });

  describe('updateGroup', () => {
    it('updates group and returns 200', async () => {
      const group = mockGroup({ name: 'Updated' });
      const deps = createDeps({
        findGroupById: jest
          .fn()
          .mockResolvedValue(
            mockGroup({ name: 'old', description: 'old', email: 'old@example.com', avatar: 'old' }),
          ),
        updateGroupFieldsTracked: jest
          .fn()
          .mockResolvedValue({ group: group, changed: true, changedFields: ['name'] }),
      });
      const handlers = createAdminGroupsHandlers(deps);
      const { req, res, status, json } = createReqRes({
        params: { id: validId },
        body: { name: 'Updated' },
      });

      await handlers.updateGroup(req, res);

      expect(status).toHaveBeenCalledWith(200);
      expect(json).toHaveBeenCalledWith({ group });
    });

    it('updates description only', async () => {
      const group = mockGroup({ description: 'New desc' });
      const deps = createDeps({
        findGroupById: jest
          .fn()
          .mockResolvedValue(
            mockGroup({ name: 'old', description: 'old', email: 'old@example.com', avatar: 'old' }),
          ),
        updateGroupFieldsTracked: jest
          .fn()
          .mockResolvedValue({ group: group, changed: true, changedFields: ['name'] }),
      });
      const handlers = createAdminGroupsHandlers(deps);
      const { req, res, status } = createReqRes({
        params: { id: validId },
        body: { description: 'New desc' },
      });

      await handlers.updateGroup(req, res);

      expect(status).toHaveBeenCalledWith(200);
      expect(deps.updateGroupFieldsTracked).toHaveBeenCalledWith(validId, {
        description: 'New desc',
      });
    });

    it('updates email only', async () => {
      const group = mockGroup({ email: 'team@co.com' });
      const deps = createDeps({
        findGroupById: jest
          .fn()
          .mockResolvedValue(
            mockGroup({ name: 'old', description: 'old', email: 'old@example.com', avatar: 'old' }),
          ),
        updateGroupFieldsTracked: jest
          .fn()
          .mockResolvedValue({ group: group, changed: true, changedFields: ['name'] }),
      });
      const handlers = createAdminGroupsHandlers(deps);
      const { req, res, status } = createReqRes({
        params: { id: validId },
        body: { email: 'team@co.com' },
      });

      await handlers.updateGroup(req, res);

      expect(status).toHaveBeenCalledWith(200);
      expect(deps.updateGroupFieldsTracked).toHaveBeenCalledWith(validId, { email: 'team@co.com' });
    });

    it('updates avatar only', async () => {
      const group = mockGroup({ avatar: 'https://img.co/a.png' });
      const deps = createDeps({
        findGroupById: jest
          .fn()
          .mockResolvedValue(
            mockGroup({ name: 'old', description: 'old', email: 'old@example.com', avatar: 'old' }),
          ),
        updateGroupFieldsTracked: jest
          .fn()
          .mockResolvedValue({ group: group, changed: true, changedFields: ['name'] }),
      });
      const handlers = createAdminGroupsHandlers(deps);
      const { req, res, status } = createReqRes({
        params: { id: validId },
        body: { avatar: 'https://img.co/a.png' },
      });

      await handlers.updateGroup(req, res);

      expect(status).toHaveBeenCalledWith(200);
      expect(deps.updateGroupFieldsTracked).toHaveBeenCalledWith(validId, {
        avatar: 'https://img.co/a.png',
      });
    });

    it('updates multiple fields at once', async () => {
      const group = mockGroup({ name: 'New', description: 'Desc', email: 'a@b.com' });
      const deps = createDeps({
        findGroupById: jest
          .fn()
          .mockResolvedValue(
            mockGroup({ name: 'old', description: 'old', email: 'old@example.com', avatar: 'old' }),
          ),
        updateGroupFieldsTracked: jest
          .fn()
          .mockResolvedValue({ group: group, changed: true, changedFields: ['name'] }),
      });
      const handlers = createAdminGroupsHandlers(deps);
      const { req, res, status } = createReqRes({
        params: { id: validId },
        body: { name: ' New ', description: 'Desc', email: 'a@b.com' },
      });

      await handlers.updateGroup(req, res);

      expect(status).toHaveBeenCalledWith(200);
      expect(deps.updateGroupFieldsTracked).toHaveBeenCalledWith(validId, {
        name: 'New',
        description: 'Desc',
        email: 'a@b.com',
      });
    });

    it('returns 400 for invalid ID', async () => {
      const deps = createDeps();
      const handlers = createAdminGroupsHandlers(deps);
      const { req, res, status, json } = createReqRes({
        params: { id: 'bad' },
        body: { name: 'Updated' },
      });

      await handlers.updateGroup(req, res);

      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith({ error: 'Invalid group ID format' });
    });

    it('returns 400 when name is empty string', async () => {
      const deps = createDeps();
      const handlers = createAdminGroupsHandlers(deps);
      const { req, res, status, json } = createReqRes({
        params: { id: validId },
        body: { name: '' },
      });

      await handlers.updateGroup(req, res);

      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith({ error: 'name must be a non-empty string' });
    });

    it('returns 400 when name is whitespace-only', async () => {
      const deps = createDeps();
      const handlers = createAdminGroupsHandlers(deps);
      const { req, res, status, json } = createReqRes({
        params: { id: validId },
        body: { name: '   ' },
      });

      await handlers.updateGroup(req, res);

      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith({ error: 'name must be a non-empty string' });
    });

    it('returns 400 when name exceeds max length', async () => {
      const deps = createDeps();
      const handlers = createAdminGroupsHandlers(deps);
      const { req, res, status, json } = createReqRes({
        params: { id: validId },
        body: { name: 'a'.repeat(501) },
      });

      await handlers.updateGroup(req, res);

      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith({ error: 'name must not exceed 500 characters' });
      expect(deps.updateGroupFieldsTracked).not.toHaveBeenCalled();
    });

    it('returns 400 when description exceeds max length', async () => {
      const deps = createDeps();
      const handlers = createAdminGroupsHandlers(deps);
      const { req, res, status, json } = createReqRes({
        params: { id: validId },
        body: { description: 'x'.repeat(2001) },
      });

      await handlers.updateGroup(req, res);

      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith({
        error: 'description must not exceed 2000 characters',
      });
      expect(deps.updateGroupFieldsTracked).not.toHaveBeenCalled();
    });

    it('returns 400 when email exceeds max length', async () => {
      const deps = createDeps();
      const handlers = createAdminGroupsHandlers(deps);
      const { req, res, status, json } = createReqRes({
        params: { id: validId },
        body: { email: 'x'.repeat(501) },
      });

      await handlers.updateGroup(req, res);

      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith({ error: 'email must not exceed 500 characters' });
      expect(deps.updateGroupFieldsTracked).not.toHaveBeenCalled();
    });

    it('returns 400 when avatar exceeds max length', async () => {
      const deps = createDeps();
      const handlers = createAdminGroupsHandlers(deps);
      const { req, res, status, json } = createReqRes({
        params: { id: validId },
        body: { avatar: 'x'.repeat(2001) },
      });

      await handlers.updateGroup(req, res);

      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith({ error: 'avatar must not exceed 2000 characters' });
      expect(deps.updateGroupFieldsTracked).not.toHaveBeenCalled();
    });

    it('returns 400 when no valid fields provided', async () => {
      const deps = createDeps();
      const handlers = createAdminGroupsHandlers(deps);
      const { req, res, status, json } = createReqRes({
        params: { id: validId },
        body: {},
      });

      await handlers.updateGroup(req, res);

      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith({ error: 'No valid fields to update' });
      expect(deps.updateGroupFieldsTracked).not.toHaveBeenCalled();
    });

    it('returns 404 when updateGroupFieldsTracked returns null', async () => {
      const deps = createDeps({
        findGroupById: jest
          .fn()
          .mockResolvedValue(
            mockGroup({ name: 'old', description: 'old', email: 'old@example.com', avatar: 'old' }),
          ),
        updateGroupFieldsTracked: jest.fn().mockResolvedValue(null),
      });
      const handlers = createAdminGroupsHandlers(deps);
      const { req, res, status, json } = createReqRes({
        params: { id: validId },
        body: { name: 'Updated' },
      });

      await handlers.updateGroup(req, res);

      expect(status).toHaveBeenCalledWith(404);
      expect(json).toHaveBeenCalledWith({ error: 'Group not found' });
    });

    it('returns 400 on ValidationError', async () => {
      const validationError = new Error('invalid field');
      validationError.name = 'ValidationError';
      const deps = createDeps({
        findGroupById: jest
          .fn()
          .mockResolvedValue(
            mockGroup({ name: 'old', description: 'old', email: 'old@example.com', avatar: 'old' }),
          ),
        updateGroupFieldsTracked: jest.fn().mockRejectedValue(validationError),
      });
      const handlers = createAdminGroupsHandlers(deps);
      const { req, res, status, json } = createReqRes({
        params: { id: validId },
        body: { name: 'Updated' },
      });

      await handlers.updateGroup(req, res);

      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith({ error: 'invalid field' });
    });

    it('returns 500 on error', async () => {
      const deps = createDeps({
        findGroupById: jest
          .fn()
          .mockResolvedValue(
            mockGroup({ name: 'old', description: 'old', email: 'old@example.com', avatar: 'old' }),
          ),
        updateGroupFieldsTracked: jest.fn().mockRejectedValue(new Error('db down')),
      });
      const handlers = createAdminGroupsHandlers(deps);
      const { req, res, status, json } = createReqRes({
        params: { id: validId },
        body: { name: 'Updated' },
      });

      await handlers.updateGroup(req, res);

      expect(status).toHaveBeenCalledWith(500);
      expect(json).toHaveBeenCalledWith({ error: 'Failed to update group' });
    });
  });

  describe('deleteGroup', () => {
    it('deletes group and returns 200 with id', async () => {
      const deps = createDeps({
        findGroupById: jest.fn().mockResolvedValue(mockGroup()),
        deleteGroup: jest.fn().mockResolvedValue(mockGroup()),
      });
      const handlers = createAdminGroupsHandlers(deps);
      const { req, res, status, json } = createReqRes({ params: { id: validId } });

      await handlers.deleteGroup(req, res);

      expect(deps.deleteGroup).toHaveBeenCalledWith(validId);
      expect(status).toHaveBeenCalledWith(200);
      expect(json).toHaveBeenCalledWith({ success: true, id: validId });
    });

    it('returns 400 for invalid ID', async () => {
      const deps = createDeps();
      const handlers = createAdminGroupsHandlers(deps);
      const { req, res, status, json } = createReqRes({ params: { id: 'bad-id' } });

      await handlers.deleteGroup(req, res);

      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith({ error: 'Invalid group ID format' });
    });

    it('returns 404 and cleans nothing when the group is missing', async () => {
      const deps = createDeps({ findGroupById: jest.fn().mockResolvedValue(null) });
      const handlers = createAdminGroupsHandlers(deps);
      const { req, res, status, json } = createReqRes({ params: { id: validId } });

      await handlers.deleteGroup(req, res);

      expect(status).toHaveBeenCalledWith(404);
      expect(json).toHaveBeenCalledWith({ error: 'Group not found' });
      expect(deps.deleteConfig).not.toHaveBeenCalled();
      expect(deps.deleteGroup).not.toHaveBeenCalled();
    });

    it('returns 500 on error', async () => {
      const deps = createDeps({
        findGroupById: jest.fn().mockResolvedValue(mockGroup()),
        deleteGroup: jest.fn().mockRejectedValue(new Error('db down')),
      });
      const handlers = createAdminGroupsHandlers(deps);
      const { req, res, status, json } = createReqRes({ params: { id: validId } });

      await handlers.deleteGroup(req, res);

      expect(status).toHaveBeenCalledWith(500);
      expect(json).toHaveBeenCalledWith({ error: 'Failed to delete group' });
    });

    it('returns 500 and keeps the group when cascade cleanup fails', async () => {
      const deps = createDeps({
        findGroupById: jest.fn().mockResolvedValue(mockGroup()),
        deleteAclEntries: jest.fn().mockRejectedValue(new Error('cleanup failed')),
      });
      const handlers = createAdminGroupsHandlers(deps);
      const { req, res, status, json } = createReqRes({ params: { id: validId } });

      await handlers.deleteGroup(req, res);

      expect(status).toHaveBeenCalledWith(500);
      expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: 'GROUP_CLEANUP_FAILED' }));
      expect(deps.deleteGroup).not.toHaveBeenCalled();
    });

    describe('compensation and audit', () => {
      const withUser = <T extends { req: ServerRequest }>(reqRes: T): T => {
        (reqRes.req as unknown as { user: Partial<IUser> }).user = {
          _id: new Types.ObjectId(),
          name: 'Admin',
        };
        return reqRes;
      };
      const config = { principalType: 'group', principalId: 'p', overrides: {} };

      function compensationDeps(overrides: Partial<AdminGroupsDeps> = {}) {
        return createDeps({
          findGroupById: jest.fn().mockResolvedValue(mockGroup()),
          deleteConfig: jest.fn().mockResolvedValue(config),
          restoreConfig: jest.fn().mockResolvedValue(true),
          ...overrides,
        });
      }

      it('restores the config when the ACL removal fails after it', async () => {
        const deps = compensationDeps({
          deleteAclEntries: jest.fn().mockRejectedValue(new Error('acl down')),
        });
        const handlers = createAdminGroupsHandlers(deps);
        const { req, res, status, json } = createReqRes({ params: { id: validId } });

        await handlers.deleteGroup(req, res);

        expect(status).toHaveBeenCalledWith(500);
        expect(json).toHaveBeenCalledWith(
          expect.objectContaining({ code: 'GROUP_CLEANUP_FAILED' }),
        );
        expect(deps.restoreConfig).toHaveBeenCalledWith(config);
        expect(deps.deleteGroup).not.toHaveBeenCalled();
      });

      it('does not restore the config when a concurrent delete already removed the group', async () => {
        const deps = compensationDeps({
          findGroupById: jest.fn().mockResolvedValueOnce(mockGroup()).mockResolvedValueOnce(null),
          deleteAclEntries: jest.fn().mockRejectedValue(new Error('acl down')),
        });
        const handlers = createAdminGroupsHandlers(deps);
        const { req, res, status } = createReqRes({ params: { id: validId } });

        await handlers.deleteGroup(req, res);

        expect(status).toHaveBeenCalledWith(500);
        expect(deps.restoreConfig).not.toHaveBeenCalled();
      });

      it('restores the config when the group state recheck fails', async () => {
        const deps = compensationDeps({
          findGroupById: jest
            .fn()
            .mockResolvedValueOnce(mockGroup())
            .mockRejectedValueOnce(new Error('db down')),
          deleteAclEntries: jest.fn().mockRejectedValue(new Error('acl down')),
        });
        const handlers = createAdminGroupsHandlers(deps);
        const { req, res, status } = createReqRes({ params: { id: validId } });

        await handlers.deleteGroup(req, res);

        expect(status).toHaveBeenCalledWith(500);
        expect(deps.restoreConfig).toHaveBeenCalledWith(config);
      });

      it('restores the config when the delete fails and the group state cannot be read', async () => {
        const deps = compensationDeps({
          findGroupById: jest
            .fn()
            .mockResolvedValueOnce(mockGroup())
            .mockRejectedValueOnce(new Error('db down')),
          deleteGroup: jest.fn().mockRejectedValue(new Error('delete failed')),
        });
        const handlers = createAdminGroupsHandlers(deps);
        const { req, res, status } = createReqRes({ params: { id: validId } });

        await handlers.deleteGroup(req, res);

        expect(status).toHaveBeenCalledWith(500);
        expect(deps.restoreConfig).toHaveBeenCalledWith(config);
      });

      it('restores the config from a pre-delete snapshot when the removal rejects after committing', async () => {
        const deps = compensationDeps({
          findConfigByPrincipal: jest.fn().mockResolvedValue(config),
          deleteConfig: jest.fn().mockRejectedValue(new Error('ack lost')),
        });
        const handlers = createAdminGroupsHandlers(deps);
        const { req, res, status } = createReqRes({ params: { id: validId } });

        await handlers.deleteGroup(req, res);

        expect(status).toHaveBeenCalledWith(500);
        expect(deps.findConfigByPrincipal).toHaveBeenCalledWith('group', validId, {
          includeInactive: true,
        });
        expect(deps.restoreConfig).toHaveBeenCalledWith(config);
        expect(deps.deleteGroup).not.toHaveBeenCalled();
      });

      it('completes the deletion when the config restore itself fails', async () => {
        const deps = compensationDeps({
          restoreConfig: jest.fn().mockRejectedValue(new Error('restore down')),
          deleteAclEntries: jest.fn().mockRejectedValue(new Error('acl down')),
        });
        const handlers = createAdminGroupsHandlers(deps);
        const { req, res, status } = createReqRes({ params: { id: validId } });

        await handlers.deleteGroup(req, res);

        expect(deps.deleteGroup).toHaveBeenCalledWith(validId);
        expect(deps.deleteAclEntries).toHaveBeenCalledTimes(2);
        expect(status).toHaveBeenCalledWith(200);
      });

      it('treats a compensating deletion that throws after committing as completed', async () => {
        const group = mockGroup();
        const deps = compensationDeps({
          restoreConfig: jest.fn().mockRejectedValue(new Error('restore down')),
          deleteAclEntries: jest.fn().mockRejectedValue(new Error('acl down')),
          findGroupById: jest
            .fn()
            .mockResolvedValueOnce(group)
            .mockResolvedValueOnce(group)
            .mockResolvedValue(null),
          deleteGroup: jest.fn().mockRejectedValue(new Error('cache invalidation failed')),
        });
        const handlers = createAdminGroupsHandlers(deps);
        const { req, res, status } = createReqRes({ params: { id: validId } });

        await handlers.deleteGroup(req, res);

        expect(status).toHaveBeenCalledWith(200);
      });

      it('reports not found when a concurrent delete won the race during the compensating deletion', async () => {
        const deps = compensationDeps({
          restoreConfig: jest.fn().mockRejectedValue(new Error('restore down')),
          deleteAclEntries: jest.fn().mockRejectedValue(new Error('acl down')),
          deleteGroup: jest.fn().mockResolvedValue(null),
        });
        const handlers = createAdminGroupsHandlers(deps);
        const { req, res, status } = createReqRes({ params: { id: validId } });

        await handlers.deleteGroup(req, res);

        expect(status).toHaveBeenCalledWith(404);
      });

      it('reports GROUP_RESTORE_FAILED when neither the restore nor the deletion succeeds', async () => {
        const deps = compensationDeps({
          restoreConfig: jest.fn().mockRejectedValue(new Error('restore down')),
          deleteAclEntries: jest.fn().mockRejectedValue(new Error('acl down')),
          deleteGroup: jest.fn().mockRejectedValue(new Error('delete down')),
        });
        const handlers = createAdminGroupsHandlers(deps);
        const { req, res, status, json } = createReqRes({ params: { id: validId } });

        await handlers.deleteGroup(req, res);

        expect(status).toHaveBeenCalledWith(500);
        expect(json).toHaveBeenCalledWith(
          expect.objectContaining({ code: 'GROUP_RESTORE_FAILED' }),
        );
      });

      it('restores the config but never the ACL entries when the group delete fails', async () => {
        const deps = compensationDeps({
          deleteGroup: jest.fn().mockRejectedValue(new Error('db down')),
        });
        const handlers = createAdminGroupsHandlers(deps);
        const { req, res, status } = createReqRes({ params: { id: validId } });

        await handlers.deleteGroup(req, res);

        expect(status).toHaveBeenCalledWith(500);
        expect(deps.deleteAclEntries).toHaveBeenCalled();
        expect(deps.restoreConfig).toHaveBeenCalledWith(config);
      });

      it('leaves the removed ACL entries removed when the config removal fails', async () => {
        const deps = compensationDeps({
          deleteConfig: jest.fn().mockRejectedValue(new Error('config down')),
        });
        const handlers = createAdminGroupsHandlers(deps);
        const { req, res, status } = createReqRes({ params: { id: validId } });

        await handlers.deleteGroup(req, res);

        expect(status).toHaveBeenCalledWith(500);
        expect(deps.restoreConfig).not.toHaveBeenCalled();
        expect(deps.deleteGroup).not.toHaveBeenCalled();
      });

      it('does not restore dependents of a group that is already gone', async () => {
        const deps = compensationDeps({
          findGroupById: jest.fn().mockResolvedValueOnce(mockGroup()).mockResolvedValue(null),
          deleteGroup: jest.fn().mockRejectedValue(new Error('db down')),
        });
        const handlers = createAdminGroupsHandlers(deps);
        const { req, res, status } = createReqRes({ params: { id: validId } });

        await handlers.deleteGroup(req, res);

        expect(status).toHaveBeenCalledWith(200);
        expect(deps.restoreConfig).not.toHaveBeenCalled();
      });

      it('records a pending group.deleted before any removal and a failure entry after a failed cleanup', async () => {
        const order: string[] = [];
        const recordAuditEntry = jest.fn().mockImplementation(async (input) => {
          order.push(`audit:${input.outcome ?? 'success'}`);
        });
        const deps = compensationDeps({
          recordAuditEntry,
          deleteConfig: jest.fn().mockImplementation(async () => {
            order.push('config');
            return config;
          }),
          deleteAclEntries: jest.fn().mockRejectedValue(new Error('acl down')),
        });
        const handlers = createAdminGroupsHandlers(deps);
        const { req, res } = withUser(createReqRes({ params: { id: validId } }));

        await handlers.deleteGroup(req, res);

        expect(order).toEqual(['audit:pending', 'config', 'audit:failure']);
        expect(recordAuditEntry).toHaveBeenLastCalledWith(
          expect.objectContaining({
            action: 'group.deleted',
            outcome: 'failure',
            metadata: { code: 'GROUP_CLEANUP_FAILED' },
          }),
        );
      });

      it('appends a not_found failure entry when the request loses the race', async () => {
        const recordAuditEntry = jest.fn().mockResolvedValue(undefined);
        const deps = compensationDeps({
          recordAuditEntry,
          deleteGroup: jest.fn().mockResolvedValue(null),
        });
        const handlers = createAdminGroupsHandlers(deps);
        const { req, res, status } = withUser(createReqRes({ params: { id: validId } }));

        await handlers.deleteGroup(req, res);

        expect(status).toHaveBeenCalledWith(404);
        expect(recordAuditEntry).toHaveBeenLastCalledWith(
          expect.objectContaining({ outcome: 'failure', metadata: { code: 'not_found' } }),
        );
        expect(deps.restoreConfig).not.toHaveBeenCalled();
      });

      it('does not wait for a slow pending audit write before removing dependents', async () => {
        let releaseAudit: () => void = () => undefined;
        const order: string[] = [];
        const recordAuditEntry = jest.fn().mockImplementation(async (input) => {
          if (input.outcome === 'pending') {
            await new Promise<void>((resolve) => (releaseAudit = resolve));
          }
          order.push(`audit:${input.outcome ?? 'success'}`);
        });
        const deps = compensationDeps({
          recordAuditEntry,
          deleteGroup: jest.fn().mockImplementation(async () => {
            order.push('group');
            releaseAudit();
            return mockGroup();
          }),
        });
        const handlers = createAdminGroupsHandlers(deps);
        const { req, res, status } = withUser(createReqRes({ params: { id: validId } }));

        await handlers.deleteGroup(req, res);

        expect(status).toHaveBeenCalledWith(200);
        expect(order).toEqual(['group', 'audit:pending', 'audit:success']);
      });

      it('still appends the terminal outcome when member-removal audits fail under fail-closed', async () => {
        const recordAuditEntry = jest.fn().mockImplementation(async (input) => {
          if (input.action === 'group.member_removed') {
            throw new Error('audit down');
          }
        });
        const group = mockGroup({ memberIds: ['m1'] });
        const deps = compensationDeps({
          recordAuditEntry,
          auditFailClosed: true,
          findGroupById: jest.fn().mockResolvedValue(group),
          deleteGroup: jest.fn().mockResolvedValue(group),
        });
        const handlers = createAdminGroupsHandlers(deps);
        const { req, res, status } = withUser(createReqRes({ params: { id: validId } }));

        await handlers.deleteGroup(req, res);

        expect(status).toHaveBeenCalledWith(200);
        expect(recordAuditEntry).toHaveBeenLastCalledWith(
          expect.objectContaining({ action: 'group.deleted', outcome: 'success' }),
        );
      });

      it('never blocks the delete on an audit outage, even when fail-closed', async () => {
        const deps = compensationDeps({
          recordAuditEntry: jest.fn().mockRejectedValue(new Error('audit down')),
          auditFailClosed: true,
          deleteGroup: jest.fn().mockResolvedValue(mockGroup()),
        });
        const handlers = createAdminGroupsHandlers(deps);
        const { req, res, status } = withUser(createReqRes({ params: { id: validId } }));

        await handlers.deleteGroup(req, res);

        expect(status).toHaveBeenCalledWith(200);
        expect(deps.deleteGroup).toHaveBeenCalled();
      });
    });

    it('removes dependents before the group', async () => {
      const order: string[] = [];
      const deps = createDeps({
        findGroupById: jest.fn().mockResolvedValue(mockGroup()),
        deleteConfig: jest.fn().mockImplementation(async () => void order.push('config')),
        deleteAclEntries: jest.fn().mockImplementation(async () => void order.push('acl')),
        deleteGroup: jest.fn().mockImplementation(async () => {
          order.push('group');
          return mockGroup();
        }),
      });
      const handlers = createAdminGroupsHandlers(deps);
      const { req, res } = createReqRes({ params: { id: validId } });

      await handlers.deleteGroup(req, res);

      expect(order[order.length - 1]).toBe('group');
      expect(order).toHaveLength(3);
    });

    it('cleans up Config and AclEntry on group delete', async () => {
      const deps = createDeps({
        findGroupById: jest.fn().mockResolvedValue(mockGroup()),
        deleteGroup: jest.fn().mockResolvedValue(mockGroup()),
      });
      const handlers = createAdminGroupsHandlers(deps);
      const { req, res, status } = createReqRes({ params: { id: validId } });

      await handlers.deleteGroup(req, res);

      expect(status).toHaveBeenCalledWith(200);
      expect(deps.deleteConfig).toHaveBeenCalledWith(PrincipalType.GROUP, validId);
      expect(deps.deleteAclEntries).toHaveBeenCalledWith({
        principalType: PrincipalType.GROUP,
        principalId: new Types.ObjectId(validId),
      });
    });
  });

  describe('getGroupMembers', () => {
    it('fetches group with memberIds projection only', async () => {
      const group = mockGroup({ memberIds: [] });
      const deps = createDeps({ findGroupById: jest.fn().mockResolvedValue(group) });
      const handlers = createAdminGroupsHandlers(deps);
      const { req, res } = createReqRes({ params: { id: validId } });

      await handlers.getGroupMembers(req, res);

      expect(deps.findGroupById).toHaveBeenCalledWith(validId, { memberIds: 1 });
    });

    it('returns empty members for group with no memberIds', async () => {
      const group = mockGroup({ memberIds: [] });
      const deps = createDeps({ findGroupById: jest.fn().mockResolvedValue(group) });
      const handlers = createAdminGroupsHandlers(deps);
      const { req, res, status, json } = createReqRes({ params: { id: validId } });

      await handlers.getGroupMembers(req, res);

      expect(status).toHaveBeenCalledWith(200);
      expect(json).toHaveBeenCalledWith({ members: [], total: 0, limit: 50, offset: 0 });
      expect(deps.findUsers).not.toHaveBeenCalled();
    });

    it('batches member lookup with $or query', async () => {
      const user = mockUser({ idOnTheSource: 'ext-123' });
      const group = mockGroup({ memberIds: [validUserId, 'ext-123'] });
      const deps = createDeps({
        findGroupById: jest.fn().mockResolvedValue(group),
        findUsers: jest.fn().mockResolvedValue([user]),
      });
      const handlers = createAdminGroupsHandlers(deps);
      const { req, res, status, json } = createReqRes({ params: { id: validId } });

      await handlers.getGroupMembers(req, res);

      expect(deps.findUsers).toHaveBeenCalledWith(
        {
          $or: [
            { idOnTheSource: { $in: [validUserId, 'ext-123'] } },
            { _id: { $in: [validUserId] } },
          ],
        },
        'name email avatar idOnTheSource',
      );
      expect(status).toHaveBeenCalledWith(200);
      const members = json.mock.calls[0][0].members;
      expect(members).toHaveLength(1);
    });

    it('skips _id condition when no valid ObjectIds in memberIds', async () => {
      const group = mockGroup({ memberIds: ['ext-1', 'ext-2'] });
      const deps = createDeps({
        findGroupById: jest.fn().mockResolvedValue(group),
        findUsers: jest.fn().mockResolvedValue([]),
      });
      const handlers = createAdminGroupsHandlers(deps);
      const { req, res } = createReqRes({ params: { id: validId } });

      await handlers.getGroupMembers(req, res);

      expect(deps.findUsers).toHaveBeenCalledWith(
        { $or: [{ idOnTheSource: { $in: ['ext-1', 'ext-2'] } }] },
        'name email avatar idOnTheSource',
      );
    });

    it('falls back to memberId when user not found', async () => {
      const group = mockGroup({ memberIds: ['unknown-member'] });
      const deps = createDeps({
        findGroupById: jest.fn().mockResolvedValue(group),
        findUsers: jest.fn().mockResolvedValue([]),
      });
      const handlers = createAdminGroupsHandlers(deps);
      const { req, res, json } = createReqRes({ params: { id: validId } });

      await handlers.getGroupMembers(req, res);

      expect(json.mock.calls[0][0].members).toEqual([
        { userId: 'unknown-member', name: 'unknown-member', email: '', avatarUrl: undefined },
      ]);
    });

    it('deduplicates when identical memberId appears twice', async () => {
      const user = mockUser({ idOnTheSource: validUserId });
      const group = mockGroup({ memberIds: [validUserId, validUserId] });
      const deps = createDeps({
        findGroupById: jest.fn().mockResolvedValue(group),
        findUsers: jest.fn().mockResolvedValue([user]),
      });
      const handlers = createAdminGroupsHandlers(deps);
      const { req, res, json } = createReqRes({ params: { id: validId } });

      await handlers.getGroupMembers(req, res);

      const result = json.mock.calls[0][0];
      expect(result.members).toHaveLength(1);
      expect(result.total).toBe(1);
    });

    it('deduplicates when objectId and idOnTheSource both present for same user', async () => {
      const extId = 'ext-dedup-123';
      const user = mockUser({ idOnTheSource: extId });
      const group = mockGroup({ memberIds: [validUserId, extId] });
      const deps = createDeps({
        findGroupById: jest.fn().mockResolvedValue(group),
        findUsers: jest.fn().mockResolvedValue([user]),
      });
      const handlers = createAdminGroupsHandlers(deps);
      const { req, res, json } = createReqRes({ params: { id: validId } });

      await handlers.getGroupMembers(req, res);

      expect(json.mock.calls[0][0].members).toHaveLength(1);
    });

    it('reports deduplicated total for duplicate memberIds', async () => {
      const group = mockGroup({ memberIds: ['m1', 'm2', 'm1', 'm3', 'm2'] });
      const deps = createDeps({
        findGroupById: jest.fn().mockResolvedValue(group),
        findUsers: jest.fn().mockResolvedValue([]),
      });
      const handlers = createAdminGroupsHandlers(deps);
      const { req, res, json } = createReqRes({ params: { id: validId } });

      await handlers.getGroupMembers(req, res);

      const result = json.mock.calls[0][0];
      expect(result.total).toBe(3);
      expect(result.members).toHaveLength(3);
    });

    it('paginates members with limit and offset', async () => {
      const ids = ['m1', 'm2', 'm3', 'm4', 'm5'];
      const group = mockGroup({ memberIds: ids });
      const deps = createDeps({
        findGroupById: jest.fn().mockResolvedValue(group),
        findUsers: jest.fn().mockResolvedValue([]),
      });
      const handlers = createAdminGroupsHandlers(deps);
      const { req, res, json } = createReqRes({
        params: { id: validId },
        query: { limit: '2', offset: '1' },
      });

      await handlers.getGroupMembers(req, res);

      const result = json.mock.calls[0][0];
      expect(result.total).toBe(5);
      expect(result.limit).toBe(2);
      expect(result.offset).toBe(1);
      expect(result.members).toHaveLength(2);
      expect(result.members[0].userId).toBe('m2');
      expect(result.members[1].userId).toBe('m3');
    });

    it('caps limit at 200', async () => {
      const ids = Array.from({ length: 5 }, (_, i) => `m${i}`);
      const group = mockGroup({ memberIds: ids });
      const deps = createDeps({
        findGroupById: jest.fn().mockResolvedValue(group),
        findUsers: jest.fn().mockResolvedValue([]),
      });
      const handlers = createAdminGroupsHandlers(deps);
      const { req, res, json } = createReqRes({
        params: { id: validId },
        query: { limit: '999' },
      });

      await handlers.getGroupMembers(req, res);

      const result = json.mock.calls[0][0];
      expect(result.limit).toBe(200);
    });

    it('returns empty when offset exceeds total', async () => {
      const group = mockGroup({ memberIds: ['m1', 'm2'] });
      const deps = createDeps({
        findGroupById: jest.fn().mockResolvedValue(group),
      });
      const handlers = createAdminGroupsHandlers(deps);
      const { req, res, json } = createReqRes({
        params: { id: validId },
        query: { offset: '10' },
      });

      await handlers.getGroupMembers(req, res);

      const result = json.mock.calls[0][0];
      expect(result.members).toHaveLength(0);
      expect(result.total).toBe(2);
      expect(deps.findUsers).not.toHaveBeenCalled();
    });

    it('returns 400 for invalid group ID', async () => {
      const deps = createDeps();
      const handlers = createAdminGroupsHandlers(deps);
      const { req, res, status, json } = createReqRes({ params: { id: 'nope' } });

      await handlers.getGroupMembers(req, res);

      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith({ error: 'Invalid group ID format' });
    });

    it('returns 404 when group not found', async () => {
      const deps = createDeps({ findGroupById: jest.fn().mockResolvedValue(null) });
      const handlers = createAdminGroupsHandlers(deps);
      const { req, res, status, json } = createReqRes({ params: { id: validId } });

      await handlers.getGroupMembers(req, res);

      expect(status).toHaveBeenCalledWith(404);
      expect(json).toHaveBeenCalledWith({ error: 'Group not found' });
    });

    it('returns 500 on error', async () => {
      const deps = createDeps({
        findGroupById: jest.fn().mockRejectedValue(new Error('db down')),
      });
      const handlers = createAdminGroupsHandlers(deps);
      const { req, res, status, json } = createReqRes({ params: { id: validId } });

      await handlers.getGroupMembers(req, res);

      expect(status).toHaveBeenCalledWith(500);
      expect(json).toHaveBeenCalledWith({ error: 'Failed to get group members' });
    });
  });

  describe('addGroupMember', () => {
    it('adds member and returns 200', async () => {
      const group = mockGroup();
      const deps = createDeps({
        addUserToGroup: jest.fn().mockResolvedValue({ user: mockUser(), group, changed: true }),
      });
      const handlers = createAdminGroupsHandlers(deps);
      const { req, res, status, json } = createReqRes({
        params: { id: validId },
        body: { userId: validUserId },
      });

      await handlers.addGroupMember(req, res);

      expect(deps.addUserToGroup).toHaveBeenCalledWith(validUserId, validId);
      expect(status).toHaveBeenCalledWith(200);
      expect(json).toHaveBeenCalledWith({ group });
    });

    it('returns 400 for invalid group ID', async () => {
      const deps = createDeps();
      const handlers = createAdminGroupsHandlers(deps);
      const { req, res, status, json } = createReqRes({
        params: { id: 'bad' },
        body: { userId: validUserId },
      });

      await handlers.addGroupMember(req, res);

      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith({ error: 'Invalid group ID format' });
    });

    it('returns 400 when userId is missing', async () => {
      const deps = createDeps();
      const handlers = createAdminGroupsHandlers(deps);
      const { req, res, status, json } = createReqRes({
        params: { id: validId },
        body: {},
      });

      await handlers.addGroupMember(req, res);

      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith({ error: 'userId is required' });
    });

    it('returns 400 for non-ObjectId userId', async () => {
      const deps = createDeps();
      const handlers = createAdminGroupsHandlers(deps);
      const { req, res, status, json } = createReqRes({
        params: { id: validId },
        body: { userId: 'not-valid' },
      });

      await handlers.addGroupMember(req, res);

      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith({
        error: 'Only native user ObjectIds can be added via this endpoint',
      });
    });

    it('returns 404 when addUserToGroup returns null group', async () => {
      const deps = createDeps({
        addUserToGroup: jest
          .fn()
          .mockResolvedValue({ user: mockUser(), group: null, changed: false }),
      });
      const handlers = createAdminGroupsHandlers(deps);
      const { req, res, status, json } = createReqRes({
        params: { id: validId },
        body: { userId: validUserId },
      });

      await handlers.addGroupMember(req, res);

      expect(status).toHaveBeenCalledWith(404);
      expect(json).toHaveBeenCalledWith({ error: 'Group not found' });
    });

    it('returns 404 for "User not found" error', async () => {
      const deps = createDeps({
        addUserToGroup: jest.fn().mockRejectedValue(new Error('User not found')),
      });
      const handlers = createAdminGroupsHandlers(deps);
      const { req, res, status, json } = createReqRes({
        params: { id: validId },
        body: { userId: validUserId },
      });

      await handlers.addGroupMember(req, res);

      expect(status).toHaveBeenCalledWith(404);
      expect(json).toHaveBeenCalledWith({ error: 'User not found' });
    });

    it('returns 500 for unrelated errors', async () => {
      const deps = createDeps({
        addUserToGroup: jest.fn().mockRejectedValue(new Error('connection lost')),
      });
      const handlers = createAdminGroupsHandlers(deps);
      const { req, res, status, json } = createReqRes({
        params: { id: validId },
        body: { userId: validUserId },
      });

      await handlers.addGroupMember(req, res);

      expect(status).toHaveBeenCalledWith(500);
      expect(json).toHaveBeenCalledWith({ error: 'Failed to add member' });
    });

    it('does not misclassify errors containing "not found" substring', async () => {
      const deps = createDeps({
        addUserToGroup: jest.fn().mockRejectedValue(new Error('Permission not found in config')),
      });
      const handlers = createAdminGroupsHandlers(deps);
      const { req, res, status } = createReqRes({
        params: { id: validId },
        body: { userId: validUserId },
      });

      await handlers.addGroupMember(req, res);

      expect(status).toHaveBeenCalledWith(500);
    });
  });

  describe('removeGroupMember', () => {
    it('removes member and returns 200', async () => {
      const deps = createDeps({
        removeUserFromGroup: jest
          .fn()
          .mockResolvedValue({ user: mockUser(), group: mockGroup(), changed: true }),
      });
      const handlers = createAdminGroupsHandlers(deps);
      const { req, res, status, json } = createReqRes({
        params: { id: validId, userId: validUserId },
      });

      await handlers.removeGroupMember(req, res);

      expect(deps.removeUserFromGroup).toHaveBeenCalledWith(validUserId, validId);
      expect(status).toHaveBeenCalledWith(200);
      expect(json).toHaveBeenCalledWith({ success: true });
    });

    it('returns 400 for invalid group ID', async () => {
      const deps = createDeps();
      const handlers = createAdminGroupsHandlers(deps);
      const { req, res, status, json } = createReqRes({
        params: { id: 'bad', userId: validUserId },
      });

      await handlers.removeGroupMember(req, res);

      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith({ error: 'Invalid group ID format' });
    });

    it('removes non-ObjectId member via removeMemberByIdTracked', async () => {
      const deps = createDeps({
        removeMemberByIdTracked: jest
          .fn()
          .mockResolvedValue({ group: mockGroup(), changed: true, changedFields: ['name'] }),
      });
      const handlers = createAdminGroupsHandlers(deps);
      const { req, res, status, json } = createReqRes({
        params: { id: validId, userId: 'ent-abc-123' },
      });

      await handlers.removeGroupMember(req, res);

      expect(deps.removeMemberByIdTracked).toHaveBeenCalledWith(validId, 'ent-abc-123');
      expect(deps.removeUserFromGroup).not.toHaveBeenCalled();
      expect(status).toHaveBeenCalledWith(200);
      expect(json).toHaveBeenCalledWith({ success: true });
    });

    it('returns 404 when removeMemberById returns null', async () => {
      const deps = createDeps({
        removeMemberByIdTracked: jest.fn().mockResolvedValue({ group: null, changed: false }),
      });
      const handlers = createAdminGroupsHandlers(deps);
      const { req, res, status, json } = createReqRes({
        params: { id: validId, userId: 'ent-abc-123' },
      });

      await handlers.removeGroupMember(req, res);

      expect(status).toHaveBeenCalledWith(404);
      expect(json).toHaveBeenCalledWith({ error: 'Group not found' });
    });

    it('falls back to removeMemberById when ObjectId userId not found as user', async () => {
      const deps = createDeps({
        removeUserFromGroup: jest.fn().mockRejectedValue(new Error('User not found')),
        removeMemberByIdTracked: jest
          .fn()
          .mockResolvedValue({ group: mockGroup(), changed: true, changedFields: ['name'] }),
      });
      const handlers = createAdminGroupsHandlers(deps);
      const { req, res, status, json } = createReqRes({
        params: { id: validId, userId: validUserId },
      });

      await handlers.removeGroupMember(req, res);

      expect(deps.removeUserFromGroup).toHaveBeenCalledWith(validUserId, validId);
      expect(deps.removeMemberByIdTracked).toHaveBeenCalledWith(validId, validUserId);
      expect(status).toHaveBeenCalledWith(200);
      expect(json).toHaveBeenCalledWith({ success: true });
    });

    it('returns 404 when removeUserFromGroup returns null group', async () => {
      const deps = createDeps({
        removeUserFromGroup: jest
          .fn()
          .mockResolvedValue({ user: mockUser(), group: null, changed: false }),
      });
      const handlers = createAdminGroupsHandlers(deps);
      const { req, res, status, json } = createReqRes({
        params: { id: validId, userId: validUserId },
      });

      await handlers.removeGroupMember(req, res);

      expect(status).toHaveBeenCalledWith(404);
      expect(json).toHaveBeenCalledWith({ error: 'Group not found' });
    });

    it('returns 404 when fallback removeMemberById also returns null', async () => {
      const deps = createDeps({
        removeUserFromGroup: jest.fn().mockRejectedValue(new Error('User not found')),
        removeMemberByIdTracked: jest.fn().mockResolvedValue({ group: null, changed: false }),
      });
      const handlers = createAdminGroupsHandlers(deps);
      const { req, res, status, json } = createReqRes({
        params: { id: validId, userId: validUserId },
      });

      await handlers.removeGroupMember(req, res);

      expect(status).toHaveBeenCalledWith(404);
      expect(json).toHaveBeenCalledWith({ error: 'Group not found' });
    });

    it('returns 500 for unrelated errors', async () => {
      const deps = createDeps({
        removeUserFromGroup: jest.fn().mockRejectedValue(new Error('timeout')),
      });
      const handlers = createAdminGroupsHandlers(deps);
      const { req, res, status, json } = createReqRes({
        params: { id: validId, userId: validUserId },
      });

      await handlers.removeGroupMember(req, res);

      expect(status).toHaveBeenCalledWith(500);
      expect(json).toHaveBeenCalledWith({ error: 'Failed to remove member' });
    });

    it('returns 200 when removing ObjectId member not in group (idempotent delete)', async () => {
      const group = mockGroup({ memberIds: [] });
      const deps = createDeps({
        removeUserFromGroup: jest
          .fn()
          .mockResolvedValue({ user: mockUser(), group, changed: true }),
      });
      const handlers = createAdminGroupsHandlers(deps);
      const { req, res, status, json } = createReqRes({
        params: { id: validId, userId: validUserId },
      });

      await handlers.removeGroupMember(req, res);

      expect(status).toHaveBeenCalledWith(200);
      expect(json).toHaveBeenCalledWith({ success: true });
    });

    it('returns 200 when removing non-ObjectId member not in group (idempotent delete)', async () => {
      const group = mockGroup({ memberIds: [] });
      const deps = createDeps({
        removeMemberByIdTracked: jest.fn().mockResolvedValue({ group, changed: true }),
      });
      const handlers = createAdminGroupsHandlers(deps);
      const { req, res, status, json } = createReqRes({
        params: { id: validId, userId: 'ext-not-in-group' },
      });

      await handlers.removeGroupMember(req, res);

      expect(status).toHaveBeenCalledWith(200);
      expect(json).toHaveBeenCalledWith({ success: true });
    });
  });

  describe('audit entries', () => {
    function withUser<T extends { req: ServerRequest }>(reqRes: T, tenantId?: string): T {
      (reqRes.req as unknown as { user: Partial<IUser> }).user = {
        _id: new Types.ObjectId(),
        name: 'Admin',
        tenantId,
      };
      return reqRes;
    }

    it('records group.created', async () => {
      const recordAuditEntry = jest.fn().mockResolvedValue(undefined);
      const deps = createDeps({ recordAuditEntry });
      const handlers = createAdminGroupsHandlers(deps);
      const { req, res, status } = withUser(createReqRes({ body: { name: 'Test Group' } }), 't1');

      await handlers.createGroup(req, res);

      expect(status).toHaveBeenCalledWith(201);
      expect(recordAuditEntry).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'group.created',
          actor: expect.objectContaining({ type: 'user', name: 'Admin' }),
          target: { type: 'group', id: validId, name: 'Test Group' },
          metadata: { source: 'local', memberCount: 0 },
          tenantId: 't1',
        }),
      );
    });

    it('records a member_added entry for each initial member', async () => {
      const recordAuditEntry = jest.fn().mockResolvedValue(undefined);
      const deps = createDeps({ recordAuditEntry });
      const handlers = createAdminGroupsHandlers(deps);
      const { req, res, status } = withUser(
        createReqRes({ body: { name: 'Test Group', memberIds: ['ext-1', 'ext-2', 'ext-1'] } }),
        't1',
      );

      await handlers.createGroup(req, res);

      expect(status).toHaveBeenCalledWith(201);
      const added = recordAuditEntry.mock.calls
        .map(([entry]) => entry)
        .filter((entry) => entry.action === 'group.member_added');
      expect(added).toHaveLength(1);
      expect(added[0].metadata).toEqual({ userIds: 'ext-1,ext-2', count: 2 });
    });

    it('records group.updated with the changed field names only', async () => {
      const recordAuditEntry = jest.fn().mockResolvedValue(undefined);
      const deps = createDeps({
        recordAuditEntry,
        updateGroupFieldsTracked: jest.fn().mockResolvedValue({
          group: mockGroup(),
          changed: true,
          changedFields: ['name', 'description'],
        }),
      });
      const handlers = createAdminGroupsHandlers(deps);
      const { req, res, status } = withUser(
        createReqRes({ params: { id: validId }, body: { name: 'Renamed', description: 'd' } }),
      );

      await handlers.updateGroup(req, res);

      expect(status).toHaveBeenCalledWith(200);
      expect(recordAuditEntry).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'group.updated',
          metadata: { fields: 'description,name' },
        }),
      );
    });

    it('records no group.updated entry when the write changed nothing', async () => {
      const recordAuditEntry = jest.fn().mockResolvedValue(undefined);
      const deps = createDeps({
        recordAuditEntry,
        updateGroupFieldsTracked: jest.fn().mockResolvedValue({
          group: mockGroup({ name: 'Same' }),
          changed: false,
          changedFields: [],
        }),
      });
      const handlers = createAdminGroupsHandlers(deps);
      const { req, res, status } = withUser(
        createReqRes({ params: { id: validId }, body: { name: 'Same' } }),
      );

      await handlers.updateGroup(req, res);

      expect(status).toHaveBeenCalledWith(200);
      expect(recordAuditEntry).not.toHaveBeenCalled();
    });

    it('records group.deleted', async () => {
      const recordAuditEntry = jest.fn().mockResolvedValue(undefined);
      const deps = createDeps({
        recordAuditEntry,
        findGroupById: jest.fn().mockResolvedValue(mockGroup()),
      });
      const handlers = createAdminGroupsHandlers(deps);
      const { req, res, status } = withUser(createReqRes({ params: { id: validId } }));

      await handlers.deleteGroup(req, res);

      expect(status).toHaveBeenCalledWith(200);
      expect(recordAuditEntry).toHaveBeenLastCalledWith(
        expect.objectContaining({
          action: 'group.deleted',
          outcome: 'success',
          target: { type: 'group', id: validId, name: 'Test Group' },
        }),
      );
    });

    it('records the members whose access a group deletion revokes', async () => {
      const recordAuditEntry = jest.fn().mockResolvedValue(undefined);
      const deps = createDeps({
        recordAuditEntry,
        findGroupById: jest.fn().mockResolvedValue(mockGroup({ memberIds: ['m1', 'm2'] })),
        deleteGroup: jest.fn().mockResolvedValue(mockGroup({ memberIds: ['m1', 'm2'] })),
      });
      const handlers = createAdminGroupsHandlers(deps);
      const { req, res } = withUser(createReqRes({ params: { id: validId } }));

      await handlers.deleteGroup(req, res);

      expect(recordAuditEntry).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'group.member_removed',
          metadata: { userIds: 'm1,m2', count: 2, cause: 'group_deleted' },
        }),
      );
    });

    it('records group.member_added and group.member_removed when membership changes', async () => {
      const recordAuditEntry = jest.fn().mockResolvedValue(undefined);
      const deps = createDeps({
        recordAuditEntry,
        addUserToGroup: jest.fn().mockResolvedValue({
          user: mockUser(),
          group: mockGroup({ memberIds: ['m1'] }),
          changed: true,
        }),
        removeUserFromGroup: jest.fn().mockResolvedValue({
          user: mockUser(),
          group: mockGroup({ memberIds: [] }),
          changed: true,
        }),
      });
      const handlers = createAdminGroupsHandlers(deps);
      const add = withUser(
        createReqRes({ params: { id: validId }, body: { userId: validUserId } }),
      );
      const remove = withUser(createReqRes({ params: { id: validId, userId: validUserId } }));

      await handlers.addGroupMember(add.req, add.res);
      await handlers.removeGroupMember(remove.req, remove.res);

      expect(add.status).toHaveBeenCalledWith(200);
      expect(remove.status).toHaveBeenCalledWith(200);
      expect(recordAuditEntry).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          action: 'group.member_added',
          metadata: { userId: validUserId },
        }),
      );
      expect(recordAuditEntry).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          action: 'group.member_removed',
          metadata: { userId: validUserId },
        }),
      );
    });

    it('does not record an idempotent add or a removal of a non-member', async () => {
      const recordAuditEntry = jest.fn().mockResolvedValue(undefined);
      const deps = createDeps({
        recordAuditEntry,
        addUserToGroup: jest.fn().mockResolvedValue({
          user: mockUser(),
          group: mockGroup({ memberIds: ['m1'] }),
          changed: false,
        }),
        removeUserFromGroup: jest.fn().mockResolvedValue({
          user: mockUser(),
          group: mockGroup({ memberIds: ['m1'] }),
          changed: false,
        }),
      });
      const handlers = createAdminGroupsHandlers(deps);
      const add = withUser(
        createReqRes({ params: { id: validId }, body: { userId: validUserId } }),
      );
      const remove = withUser(createReqRes({ params: { id: validId, userId: validUserId } }));

      await handlers.addGroupMember(add.req, add.res);
      await handlers.removeGroupMember(remove.req, remove.res);

      expect(add.status).toHaveBeenCalledWith(200);
      expect(remove.status).toHaveBeenCalledWith(200);
      expect(recordAuditEntry).not.toHaveBeenCalled();
    });

    it('does not record when the group is missing', async () => {
      const recordAuditEntry = jest.fn().mockResolvedValue(undefined);
      const deps = createDeps({
        findGroupById: jest.fn().mockResolvedValue(null),
        recordAuditEntry,
      });
      const handlers = createAdminGroupsHandlers(deps);
      const { req, res, status } = withUser(createReqRes({ params: { id: validId } }));

      await handlers.deleteGroup(req, res);

      expect(status).toHaveBeenCalledWith(404);
      expect(recordAuditEntry).not.toHaveBeenCalled();
    });
  });
});
