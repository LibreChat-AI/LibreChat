const express = require('express');
const request = require('supertest');

const GROUP_ID = '507f1f77bcf86cd799439011';

const mockRequireJwtAuth = jest.fn((req, res, next) => {
  if (req.headers.authorization !== 'Bearer admin') {
    return res.status(401).json({ message: 'Unauthorized' });
  }
  req.user = { id: 'user-1', _id: 'user-1', role: 'ADMIN', tenantId: 'tenant-a' };
  next();
});
const mockDb = {
  findGroupById: jest.fn(),
  deleteGroup: jest.fn(),
  deleteConfig: jest.fn(),
  restoreConfig: jest.fn(),
  findConfigByPrincipal: jest.fn(),
  deleteAclEntries: jest.fn(),
  recordAuditEntry: jest.fn(),
};

jest.mock('~/server/middleware', () => ({ requireJwtAuth: mockRequireJwtAuth }));

jest.mock('~/server/middleware/roles/capabilities', () => ({
  requireCapability: jest.fn(() => (_req, _res, next) => next()),
}));

jest.mock('~/server/services/Config', () => ({
  invalidateConfigCaches: jest.fn(async () => undefined),
}));

jest.mock('~/models', () => mockDb);

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/groups', require('./groups'));
  return app;
}

describe('admin group routes', () => {
  let app;

  beforeAll(() => {
    app = createApp();
  });

  beforeEach(() => {
    const group = { _id: GROUP_ID, name: 'Support', memberIds: ['member-1'] };
    mockDb.findGroupById.mockResolvedValue(group);
    mockDb.deleteGroup.mockResolvedValue(group);
    mockDb.deleteAclEntries.mockResolvedValue({ deletedCount: 0 });
    mockDb.findConfigByPrincipal.mockResolvedValue(null);
  });

  it("clears the config caches through the Config service when a deletion removes the group's profile", async () => {
    const { invalidateConfigCaches } = require('~/server/services/Config');
    mockDb.deleteConfig.mockResolvedValue({
      principalType: 'group',
      principalId: GROUP_ID,
      overrides: { interface: { customWelcome: 'group hello' } },
    });

    await request(app)
      .delete(`/api/admin/groups/${GROUP_ID}`)
      .set('authorization', 'Bearer admin')
      .expect(200);

    expect(mockDb.deleteConfig).toHaveBeenCalledWith('group', GROUP_ID);
    expect(invalidateConfigCaches).toHaveBeenCalledTimes(1);
    expect(invalidateConfigCaches).toHaveBeenCalledWith('tenant-a');
    expect(mockDb.deleteGroup).toHaveBeenCalledWith(GROUP_ID);
  });

  it('clears nothing when the group had no profile', async () => {
    const { invalidateConfigCaches } = require('~/server/services/Config');
    mockDb.deleteConfig.mockResolvedValue(null);

    await request(app)
      .delete(`/api/admin/groups/${GROUP_ID}`)
      .set('authorization', 'Bearer admin')
      .expect(200);

    expect(mockDb.deleteConfig).toHaveBeenCalledTimes(1);
    expect(invalidateConfigCaches).not.toHaveBeenCalled();
  });
});
