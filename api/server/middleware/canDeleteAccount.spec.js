const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { SystemRoles, PrincipalType } = require('librechat-data-provider');
const { SystemCapabilities } = require('@librechat/data-schemas');

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: { error: jest.fn(), warn: jest.fn(), debug: jest.fn(), info: jest.fn() },
}));

jest.mock('~/cache', () => ({
  getLogStores: jest.fn(() => ({
    get: jest.fn(),
    set: jest.fn(),
  })),
}));

const { User, SystemGrant } = require('~/db/models');
const canDeleteAccount = require('./canDeleteAccount');

let mongoServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});

beforeEach(async () => {
  await mongoose.connection.dropDatabase();
  delete process.env.ALLOW_ACCOUNT_DELETION;
});

const makeRes = () => {
  const send = jest.fn();
  const status = jest.fn().mockReturnValue({ send });
  return { status, send };
};

describe('canDeleteAccount', () => {
  describe('ALLOW_ACCOUNT_DELETION=true (default)', () => {
    it('calls next without hitting the DB', async () => {
      process.env.ALLOW_ACCOUNT_DELETION = 'true';
      const next = jest.fn();
      const req = { user: { id: 'user-1', role: SystemRoles.USER } };

      await canDeleteAccount(req, makeRes(), next);

      expect(next).toHaveBeenCalled();
    });

    it('skips capability check entirely when deletion is allowed', async () => {
      process.env.ALLOW_ACCOUNT_DELETION = 'true';
      const next = jest.fn();
      const req = { user: { id: 'user-1', role: SystemRoles.USER } };

      await canDeleteAccount(req, makeRes(), next);

      expect(next).toHaveBeenCalled();
      const grantCount = await SystemGrant.countDocuments();
      expect(grantCount).toBe(0);
    });
  });

  describe('ALLOW_ACCOUNT_DELETION=false', () => {
    beforeEach(() => {
      process.env.ALLOW_ACCOUNT_DELETION = 'false';
    });

    it('allows admin with ACCESS_ADMIN grant (real DB check)', async () => {
      const admin = await User.create({
        name: 'Admin',
        email: 'admin@test.com',
        password: 'password123',
        provider: 'local',
        role: SystemRoles.ADMIN,
      });

      await SystemGrant.create({
        principalType: PrincipalType.ROLE,
        principalId: SystemRoles.ADMIN,
        capability: SystemCapabilities.ACCESS_ADMIN,
        grantedAt: new Date(),
      });

      const next = jest.fn();
      const req = { user: { id: admin._id.toString(), role: SystemRoles.ADMIN } };

      await canDeleteAccount(req, makeRes(), next);

      expect(next).toHaveBeenCalled();
    });

    it('blocks regular user without ACCESS_ADMIN grant', async () => {
      const user = await User.create({
        name: 'Regular',
        email: 'user@test.com',
        password: 'password123',
        provider: 'local',
        role: SystemRoles.USER,
      });

      const next = jest.fn();
      const res = makeRes();
      const req = { user: { id: user._id.toString(), role: SystemRoles.USER } };

      await canDeleteAccount(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
    });

    it('blocks admin role WITHOUT the ACCESS_ADMIN grant', async () => {
      const admin = await User.create({
        name: 'Admin No Grant',
        email: 'admin2@test.com',
        password: 'password123',
        provider: 'local',
        role: SystemRoles.ADMIN,
      });

      const next = jest.fn();
      const res = makeRes();
      const req = { user: { id: admin._id.toString(), role: SystemRoles.ADMIN } };

      await canDeleteAccount(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
    });

    it('allows user-level grant (not just role-level)', async () => {
      const user = await User.create({
        name: 'Privileged User',
        email: 'priv@test.com',
        password: 'password123',
        provider: 'local',
        role: SystemRoles.USER,
      });

      await SystemGrant.create({
        principalType: PrincipalType.USER,
        principalId: user._id,
        capability: SystemCapabilities.ACCESS_ADMIN,
        grantedAt: new Date(),
      });

      const next = jest.fn();
      const req = { user: { id: user._id.toString(), role: SystemRoles.USER } };

      await canDeleteAccount(req, makeRes(), next);

      expect(next).toHaveBeenCalled();
    });

    it('blocks when user is undefined — does not throw', async () => {
      const next = jest.fn();
      const res = makeRes();

      await canDeleteAccount({ user: undefined }, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
    });

    it('blocks when user is null — does not throw', async () => {
      const next = jest.fn();
      const res = makeRes();

      await canDeleteAccount({ user: null }, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
    });
  });
});
