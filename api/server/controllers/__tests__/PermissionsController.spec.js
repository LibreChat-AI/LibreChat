const mongoose = require('mongoose');

const mockLogger = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() };
const mockGetTenantId = jest.fn();

jest.mock('@librechat/data-schemas', () => ({
  logger: mockLogger,
  getTenantId: mockGetTenantId,
  SYSTEM_TENANT_ID: '__SYSTEM__',
}));

const { AccessRoleIds, ResourceType, PrincipalType, SystemRoles, PermissionTypes, Permissions } =
  jest.requireActual('librechat-data-provider');
const { createPeoplePickerAccess } = jest.requireActual('@librechat/api');

jest.mock('librechat-data-provider', () => ({
  ...jest.requireActual('librechat-data-provider'),
}));

jest.mock('@librechat/api', () => {
  const actual = jest.requireActual('@librechat/api');
  return {
    ...actual,
    enrichRemoteAgentPrincipals: jest.fn(),
    backfillRemoteAgentPermissions: jest.fn(),
  };
});

const mockInvalidateCodeEnvironmentConfigCache = jest.fn().mockResolvedValue(undefined);
jest.mock('~/server/services/Config', () => ({
  invalidateCodeEnvironmentConfigCache: (...args) =>
    mockInvalidateCodeEnvironmentConfigCache(...args),
}));

const mockBulkUpdateResourcePermissions = jest.fn();
const mockRestoreInsightsPermissionChanges = jest.fn();

jest.mock('~/server/services/PermissionService', () => ({
  bulkUpdateResourcePermissions: (...args) => mockBulkUpdateResourcePermissions(...args),
  restoreInsightsPermissionChanges: (...args) => mockRestoreInsightsPermissionChanges(...args),
  ensureGroupPrincipalExists: jest.fn(),
  getEffectivePermissions: jest.fn(),
  ensurePrincipalExists: jest.fn(),
  getAvailableRoles: jest.fn(),
  findAccessibleResources: jest.fn(),
  getResourcePermissionsMap: jest.fn(),
}));

const mockRemoveAgentFromUserFavorites = jest.fn();
const mockRecordAuditEntry = jest.fn();

jest.mock('~/models', () => ({
  aggregateAclEntries: jest.fn(),
  searchPrincipals: jest.fn(),
  sortPrincipalsByRelevance: jest.fn(),
  calculateRelevanceScore: jest.fn(),
  removeAgentFromUserFavorites: (...args) => mockRemoveAgentFromUserFavorites(...args),
  getAgent: jest.fn(),
  recordAuditEntry: (...args) => mockRecordAuditEntry(...args),
}));

jest.mock('~/server/services/GraphApiService', () => ({
  entraIdPrincipalFeatureEnabled: jest.fn(() => false),
  searchEntraIdPrincipals: jest.fn(),
}));

const db = require('~/models');
const {
  updateResourcePermissions,
  searchPrincipals,
  getResourcePermissions,
} = require('../PermissionsController');

const createMockReq = (overrides = {}) => ({
  params: { resourceType: ResourceType.AGENT, resourceId: '507f1f77bcf86cd799439011' },
  body: { updated: [], removed: [], public: false },
  user: { id: 'user-1', role: 'USER' },
  headers: { authorization: '' },
  ...overrides,
});

const createMockRes = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

const flushPromises = () => new Promise((resolve) => setImmediate(resolve));

describe('PermissionsController', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetTenantId.mockReturnValue(undefined);
  });

  describe('searchPrincipals', () => {
    beforeEach(() => {
      db.searchPrincipals.mockResolvedValue([]);
      db.calculateRelevanceScore.mockReturnValue(50);
      db.sortPrincipalsByRelevance.mockImplementation((results) => results);
    });

    it.each([{ q: 'al', type: PrincipalType.GROUP }, { q: 'al', types: 'foobar' }, { q: 'al' }])(
      'searches only the types the people picker check resolved for %j',
      async (query) => {
        const checkAccess = createPeoplePickerAccess({
          getRoleByName: async () => ({
            permissions: {
              [PermissionTypes.PEOPLE_PICKER]: {
                [Permissions.VIEW_USERS]: false,
                [Permissions.VIEW_GROUPS]: true,
                [Permissions.VIEW_ROLES]: false,
              },
            },
          }),
        });
        const req = createMockReq({ query });
        const res = createMockRes();

        await checkAccess(req, res, () => searchPrincipals(req, res));

        expect(db.searchPrincipals).toHaveBeenCalledWith('al', 20, [PrincipalType.GROUP]);
        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.json).toHaveBeenCalledWith(
          expect.objectContaining({ types: [PrincipalType.GROUP] }),
        );
      },
    );
  });

  describe('getResourcePermissions — principal details', () => {
    const currentTenantId = 'tenant-a';
    const otherTenantId = 'tenant-b';
    const userId = new mongoose.Types.ObjectId();
    const groupId = new mongoose.Types.ObjectId();

    it('omits joined user and group details outside the current request context', async () => {
      mockGetTenantId.mockReturnValue(currentTenantId);
      db.aggregateAclEntries.mockResolvedValue([
        {
          principalType: PrincipalType.USER,
          accessRoleId: AccessRoleIds.AGENT_VIEWER,
          userInfo: {
            _id: userId,
            tenantId: otherTenantId,
            name: 'Outside User',
            email: 'outside-user@example.com',
            avatar: 'outside-user.png',
          },
        },
        {
          principalType: PrincipalType.GROUP,
          accessRoleId: AccessRoleIds.AGENT_VIEWER,
          groupInfo: {
            _id: groupId,
            tenantId: otherTenantId,
            name: 'Outside Group',
            email: 'outside-group@example.com',
            avatar: 'outside-group.png',
          },
        },
        {
          principalType: PrincipalType.PUBLIC,
          accessRoleId: AccessRoleIds.AGENT_VIEWER,
        },
      ]);

      const req = createMockReq();
      const res = createMockRes();

      await getResourcePermissions(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({
        resourceType: ResourceType.AGENT,
        resourceId: req.params.resourceId,
        principals: [],
        public: true,
        publicAccessRoleId: AccessRoleIds.AGENT_VIEWER,
      });
      expect(JSON.stringify(res.json.mock.calls[0][0])).not.toContain('outside-user@example.com');
      expect(JSON.stringify(res.json.mock.calls[0][0])).not.toContain('outside-group@example.com');
    });

    it('includes joined user and group details in the current request context', async () => {
      mockGetTenantId.mockReturnValue(currentTenantId);
      db.aggregateAclEntries.mockResolvedValue([
        {
          principalType: PrincipalType.USER,
          accessRoleId: AccessRoleIds.AGENT_VIEWER,
          userInfo: {
            _id: userId,
            tenantId: currentTenantId,
            name: 'Current User',
            email: 'current-user@example.com',
            avatar: 'current-user.png',
            role: SystemRoles.ADMIN,
          },
        },
        {
          principalType: PrincipalType.GROUP,
          accessRoleId: AccessRoleIds.AGENT_VIEWER,
          groupInfo: {
            _id: groupId,
            tenantId: currentTenantId,
            name: 'Current Group',
            email: 'current-group@example.com',
            avatar: 'current-group.png',
          },
        },
      ]);

      const req = createMockReq();
      const res = createMockRes();

      await getResourcePermissions(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json.mock.calls[0][0].principals).toEqual([
        expect.objectContaining({
          type: PrincipalType.USER,
          id: userId.toString(),
          email: 'current-user@example.com',
          isAdmin: true,
        }),
        expect.objectContaining({
          type: PrincipalType.GROUP,
          id: groupId.toString(),
          email: 'current-group@example.com',
        }),
      ]);
    });
  });

  describe('updateResourcePermissions — favorites cleanup', () => {
    const agentObjectId = new mongoose.Types.ObjectId().toString();
    const revokedUserId = new mongoose.Types.ObjectId().toString();

    beforeEach(() => {
      delete process.env.AUDIT_LOG_FAIL_CLOSED;
      mockBulkUpdateResourcePermissions.mockResolvedValue({
        granted: [],
        updated: [],
        revoked: [{ type: PrincipalType.USER, id: revokedUserId, name: 'Revoked User' }],
        errors: [],
      });

      mockRemoveAgentFromUserFavorites.mockResolvedValue(undefined);
      db.getAgent.mockResolvedValue({ _id: agentObjectId, id: 'agent-a', name: 'Agent A' });
      mockRecordAuditEntry.mockResolvedValue({});
      mockRestoreInsightsPermissionChanges.mockResolvedValue(undefined);
    });

    it('rejects Insights permission changes from non-admin users', async () => {
      const req = createMockReq({
        params: { resourceType: ResourceType.AGENT, resourceId: agentObjectId },
        body: {
          updated: [
            {
              type: PrincipalType.ROLE,
              id: 'USER',
              accessRoleId: AccessRoleIds.AGENT_VIEWER,
              viewInsights: true,
            },
          ],
          removed: [],
        },
      });
      const res = createMockRes();

      await updateResourcePermissions(req, res);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(mockBulkUpdateResourcePermissions).not.toHaveBeenCalled();
    });

    it('rejects non-boolean Insights permission values', async () => {
      const req = createMockReq({
        params: { resourceType: ResourceType.AGENT, resourceId: agentObjectId },
        body: {
          updated: [
            {
              type: PrincipalType.ROLE,
              id: 'USER',
              accessRoleId: AccessRoleIds.AGENT_VIEWER,
              viewInsights: null,
            },
          ],
          removed: [],
        },
        user: { id: 'admin-id', role: SystemRoles.ADMIN },
      });
      const res = createMockRes();

      await updateResourcePermissions(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(mockBulkUpdateResourcePermissions).not.toHaveBeenCalled();
    });

    it('audits each actual Insights access transition made by an admin', async () => {
      mockBulkUpdateResourcePermissions.mockResolvedValue({
        granted: [
          {
            type: PrincipalType.ROLE,
            id: 'USER',
            accessRoleId: AccessRoleIds.AGENT_VIEWER,
            viewInsights: true,
          },
        ],
        updated: [],
        revoked: [],
        insightsChanges: [
          { action: 'assigned', principal: { type: PrincipalType.ROLE, id: 'USER' } },
        ],
        errors: [],
      });
      const req = createMockReq({
        params: { resourceType: ResourceType.AGENT, resourceId: agentObjectId },
        body: {
          updated: [
            {
              type: PrincipalType.ROLE,
              id: 'USER',
              accessRoleId: AccessRoleIds.AGENT_VIEWER,
              viewInsights: true,
            },
          ],
          removed: [],
        },
        user: {
          _id: new mongoose.Types.ObjectId(),
          id: 'admin-id',
          name: 'Admin',
          role: SystemRoles.ADMIN,
          tenantId: 'tenant-a',
        },
      });
      const res = createMockRes();

      req.config = { config: { permissions: { maxWriteAttempts: 7 } } };
      await updateResourcePermissions(req, res);

      expect(mockBulkUpdateResourcePermissions).toHaveBeenCalledWith(
        expect.objectContaining({ maxWriteAttempts: 7 }),
      );
      expect(mockRecordAuditEntry).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'permission.insights_assigned',
          tenantId: 'tenant-a',
          target: expect.objectContaining({ id: 'agent-a' }),
          metadata: { principalType: PrincipalType.ROLE, principalId: 'USER' },
        }),
        { failClosed: false },
      );
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json.mock.calls[0][0].results.principals[0]).toEqual(
        expect.objectContaining({ viewInsights: true }),
      );
    });

    it('restores unaudited Insights transitions when fail-closed auditing fails', async () => {
      process.env.AUDIT_LOG_FAIL_CLOSED = 'true';
      const changes = [{ action: 'assigned', principal: { type: PrincipalType.ROLE, id: 'USER' } }];
      mockBulkUpdateResourcePermissions.mockResolvedValue({
        granted: [],
        updated: [],
        revoked: [],
        insightsChanges: changes,
        errors: [],
      });
      mockRecordAuditEntry.mockRejectedValue(new Error('audit unavailable'));
      const req = createMockReq({
        params: { resourceType: ResourceType.AGENT, resourceId: agentObjectId },
        body: {
          updated: [
            {
              type: PrincipalType.ROLE,
              id: 'USER',
              accessRoleId: AccessRoleIds.AGENT_VIEWER,
              viewInsights: true,
            },
          ],
          removed: [],
        },
        user: { id: 'admin-id', role: SystemRoles.ADMIN, tenantId: 'tenant-a' },
      });
      const res = createMockRes();

      await updateResourcePermissions(req, res);

      expect(mockRestoreInsightsPermissionChanges).toHaveBeenCalledWith({
        resourceType: ResourceType.AGENT,
        resourceId: agentObjectId,
        changes,
      });
      expect(res.status).toHaveBeenCalledWith(500);
    });

    it('keeps a successful permission response when audit target lookup fails open', async () => {
      mockBulkUpdateResourcePermissions.mockResolvedValue({
        granted: [],
        updated: [],
        revoked: [],
        insightsChanges: [
          { action: 'assigned', principal: { type: PrincipalType.ROLE, id: 'USER' } },
        ],
        errors: [],
      });
      db.getAgent.mockRejectedValue(new Error('agent lookup unavailable'));
      const req = createMockReq({
        params: { resourceType: ResourceType.AGENT, resourceId: agentObjectId },
        user: { id: 'admin-id', role: SystemRoles.ADMIN, tenantId: 'tenant-a' },
      });
      const res = createMockRes();

      await updateResourcePermissions(req, res);

      expect(mockRestoreInsightsPermissionChanges).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('does not expose the protected bit in non-admin mutation responses', async () => {
      mockBulkUpdateResourcePermissions.mockResolvedValue({
        granted: [
          {
            type: PrincipalType.USER,
            id: revokedUserId,
            accessRoleId: AccessRoleIds.AGENT_EDITOR,
            viewInsights: true,
          },
        ],
        updated: [],
        revoked: [],
        insightsChanges: [],
        errors: [],
      });
      const req = createMockReq({
        params: { resourceType: ResourceType.AGENT, resourceId: agentObjectId },
        body: {
          updated: [
            {
              type: PrincipalType.USER,
              id: revokedUserId,
              accessRoleId: AccessRoleIds.AGENT_EDITOR,
            },
          ],
          removed: [],
        },
      });
      const res = createMockRes();

      await updateResourcePermissions(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json.mock.calls[0][0].results.principals[0]).not.toHaveProperty('viewInsights');
    });

    it('removes agent from revoked users favorites on AGENT resource type', async () => {
      const req = createMockReq({
        params: { resourceType: ResourceType.AGENT, resourceId: agentObjectId },
        body: {
          updated: [],
          removed: [{ type: PrincipalType.USER, id: revokedUserId }],
          public: false,
        },
      });
      const res = createMockRes();

      await updateResourcePermissions(req, res);
      await flushPromises();

      expect(res.status).toHaveBeenCalledWith(200);
      expect(mockRemoveAgentFromUserFavorites).toHaveBeenCalledWith(agentObjectId, [revokedUserId]);
    });

    it('removes agent from revoked users favorites on REMOTE_AGENT resource type', async () => {
      const req = createMockReq({
        params: { resourceType: ResourceType.REMOTE_AGENT, resourceId: agentObjectId },
        body: {
          updated: [],
          removed: [{ type: PrincipalType.USER, id: revokedUserId }],
          public: false,
        },
      });
      const res = createMockRes();

      await updateResourcePermissions(req, res);
      await flushPromises();

      expect(mockRemoveAgentFromUserFavorites).toHaveBeenCalledWith(agentObjectId, [revokedUserId]);
    });

    it('uses results.revoked (validated) not raw request payload', async () => {
      const validId = new mongoose.Types.ObjectId().toString();
      const invalidId = 'not-a-valid-id';

      mockBulkUpdateResourcePermissions.mockResolvedValue({
        granted: [],
        updated: [],
        revoked: [{ type: PrincipalType.USER, id: validId }],
        errors: [{ principal: { type: PrincipalType.USER, id: invalidId }, error: 'Invalid ID' }],
      });

      const req = createMockReq({
        params: { resourceType: ResourceType.AGENT, resourceId: agentObjectId },
        body: {
          updated: [],
          removed: [
            { type: PrincipalType.USER, id: validId },
            { type: PrincipalType.USER, id: invalidId },
          ],
          public: false,
        },
      });
      const res = createMockRes();

      await updateResourcePermissions(req, res);
      await flushPromises();

      expect(mockRemoveAgentFromUserFavorites).toHaveBeenCalledWith(agentObjectId, [validId]);
    });

    it('skips cleanup when no USER principals are revoked', async () => {
      mockBulkUpdateResourcePermissions.mockResolvedValue({
        granted: [],
        updated: [],
        revoked: [{ type: PrincipalType.GROUP, id: 'group-1' }],
        errors: [],
      });

      const req = createMockReq({
        params: { resourceType: ResourceType.AGENT, resourceId: agentObjectId },
        body: {
          updated: [],
          removed: [{ type: PrincipalType.GROUP, id: 'group-1' }],
          public: false,
        },
      });
      const res = createMockRes();

      await updateResourcePermissions(req, res);
      await flushPromises();

      expect(mockRemoveAgentFromUserFavorites).not.toHaveBeenCalled();
    });

    it('skips cleanup for non-agent resource types', async () => {
      mockBulkUpdateResourcePermissions.mockResolvedValue({
        granted: [],
        updated: [],
        revoked: [{ type: PrincipalType.USER, id: revokedUserId }],
        errors: [],
      });

      const req = createMockReq({
        params: { resourceType: ResourceType.PROMPTGROUP, resourceId: agentObjectId },
        body: {
          updated: [],
          removed: [{ type: PrincipalType.USER, id: revokedUserId }],
          public: false,
        },
      });
      const res = createMockRes();

      await updateResourcePermissions(req, res);
      await flushPromises();

      expect(res.status).toHaveBeenCalledWith(200);
      expect(mockRemoveAgentFromUserFavorites).not.toHaveBeenCalled();
    });

    it('invalidates shared environment configuration after code environment ACL changes', async () => {
      const req = createMockReq({
        params: { resourceType: ResourceType.CODE_ENVIRONMENT, resourceId: agentObjectId },
        body: {
          updated: [{ type: PrincipalType.USER, id: revokedUserId }],
          removed: [],
          public: false,
        },
        user: { id: 'user-1', role: 'USER', tenantId: 'tenant-a' },
      });
      const res = createMockRes();

      await updateResourcePermissions(req, res);

      expect(mockInvalidateCodeEnvironmentConfigCache).toHaveBeenCalledWith('tenant-a');
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('keeps the committed ACL response successful when cache invalidation fails', async () => {
      mockInvalidateCodeEnvironmentConfigCache.mockRejectedValueOnce(
        new Error('redis unavailable'),
      );
      const req = createMockReq({
        params: { resourceType: ResourceType.CODE_ENVIRONMENT, resourceId: agentObjectId },
        body: {
          updated: [],
          removed: [{ type: PrincipalType.USER, id: revokedUserId }],
          public: false,
        },
        user: { id: 'user-1', role: 'USER', tenantId: 'tenant-a' },
      });
      const res = createMockRes();

      await updateResourcePermissions(req, res);

      expect(mockInvalidateCodeEnvironmentConfigCache).toHaveBeenCalledWith('tenant-a');
      expect(res.status).toHaveBeenCalledWith(200);
      expect(mockLogger.error).toHaveBeenCalledWith(
        '[PermissionsController] code environment cache invalidation failed:',
        expect.any(Error),
      );
    });

    it('handles agent not found gracefully', async () => {
      mockRemoveAgentFromUserFavorites.mockResolvedValue(undefined);

      const req = createMockReq({
        params: { resourceType: ResourceType.AGENT, resourceId: agentObjectId },
        body: {
          updated: [],
          removed: [{ type: PrincipalType.USER, id: revokedUserId }],
          public: false,
        },
      });
      const res = createMockRes();

      await updateResourcePermissions(req, res);
      await flushPromises();

      expect(mockRemoveAgentFromUserFavorites).toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('logs error when removeAgentFromUserFavorites fails without blocking response', async () => {
      mockRemoveAgentFromUserFavorites.mockRejectedValue(new Error('DB connection lost'));

      const req = createMockReq({
        params: { resourceType: ResourceType.AGENT, resourceId: agentObjectId },
        body: {
          updated: [],
          removed: [{ type: PrincipalType.USER, id: revokedUserId }],
          public: false,
        },
      });
      const res = createMockRes();

      await updateResourcePermissions(req, res);
      await flushPromises();

      expect(res.status).toHaveBeenCalledWith(200);
      expect(mockLogger.error).toHaveBeenCalledWith(
        '[removeRevokedAgentFromFavorites] Error cleaning up favorites',
        expect.any(Error),
      );
    });
  });
});
