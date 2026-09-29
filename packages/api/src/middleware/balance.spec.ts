import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { logger, balanceSchema } from '@librechat/data-schemas';
import type { NextFunction, Request as ServerRequest, Response as ServerResponse } from 'express';
import type { IBalance, IBalanceUpdate } from '@librechat/data-schemas';
import { createSetBalanceConfig } from './balance';

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: {
    error: jest.fn(),
  },
}));

let mongoServer: MongoMemoryServer;
let Balance: mongoose.Model<IBalance>;

const findBalanceByUser = (userId: string) => Balance.findOne({ user: userId }).lean<IBalance>();

const upsertBalanceFields = (
  userId: string,
  fields: IBalanceUpdate,
  insertOnly: IBalanceUpdate = {},
) =>
  Balance.findOneAndUpdate(
    { user: userId },
    { $set: fields, $setOnInsert: insertOnly },
    { upsert: true, new: true },
  ).lean<IBalance>();

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  const mongoUri = mongoServer.getUri();
  Balance = mongoose.models.Balance || mongoose.model('Balance', balanceSchema);
  await mongoose.connect(mongoUri);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await mongoose.connection.dropDatabase();
  jest.clearAllMocks();
  jest.restoreAllMocks();
});

describe('createSetBalanceConfig', () => {
  const createMockRequest = (userId: string | mongoose.Types.ObjectId): Partial<ServerRequest> => ({
    user: {
      _id: userId,
      id: userId.toString(),
      email: 'test@example.com',
    },
  });

  const createMockResponse = (): Partial<ServerResponse> => ({
    locals: {},
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  });

  const mockNext: NextFunction = jest.fn();
  describe('Basic Functionality', () => {
    test('does not overwrite credits another writer set after the balance was read', async () => {
      const userId = new mongoose.Types.ObjectId();
      const getAppConfig = jest.fn().mockResolvedValue({
        balance: { enabled: true, startBalance: 1000 },
      });
      const findThenCharge = async (id: string) => {
        const record = await findBalanceByUser(id);
        await Balance.create({ user: id, tokenCredits: 50 });
        return record;
      };

      const middleware = createSetBalanceConfig({
        getAppConfig,
        findBalanceByUser: findThenCharge,
        upsertBalanceFields,
      });
      const res = createMockResponse();

      await middleware(createMockRequest(userId) as ServerRequest, res as ServerResponse, mockNext);

      expect((await Balance.findOne({ user: userId }).lean())?.tokenCredits).toBe(50);
      expect((res.locals as { balanceData?: IBalance }).balanceData?.tokenCredits).toBe(50);
    });

    test('should create balance record for new user with start balance', async () => {
      const userId = new mongoose.Types.ObjectId();
      const getAppConfig = jest.fn().mockResolvedValue({
        balance: {
          enabled: true,
          startBalance: 1000,
          autoRefillEnabled: true,
          refillIntervalValue: 30,
          refillIntervalUnit: 'days',
          refillAmount: 500,
        },
      });

      const middleware = createSetBalanceConfig({
        getAppConfig,
        findBalanceByUser,
        upsertBalanceFields,
      });

      const req = createMockRequest(userId);
      const res = createMockResponse();

      await middleware(req as ServerRequest, res as ServerResponse, mockNext);

      expect(getAppConfig).toHaveBeenCalled();
      expect(mockNext).toHaveBeenCalled();

      const balanceRecord = await Balance.findOne({ user: userId });
      expect(balanceRecord).toBeTruthy();
      expect(balanceRecord?.tokenCredits).toBe(1000);
      expect(balanceRecord?.autoRefillEnabled).toBe(true);
      expect(balanceRecord?.refillIntervalValue).toBe(30);
      expect(balanceRecord?.refillIntervalUnit).toBe('days');
      expect(balanceRecord?.refillAmount).toBe(500);
      expect(balanceRecord?.lastRefill).toBeInstanceOf(Date);
      expect((res.locals as { balanceConfigEnabled?: boolean }).balanceConfigEnabled).toBe(true);
      expect((res.locals as { balanceData?: IBalance }).balanceData?.tokenCredits).toBe(1000);
    });

    test('should skip if balance config is not enabled', async () => {
      const userId = new mongoose.Types.ObjectId();
      const getAppConfig = jest.fn().mockResolvedValue({
        balance: {
          enabled: false,
        },
      });

      const middleware = createSetBalanceConfig({
        getAppConfig,
        findBalanceByUser,
        upsertBalanceFields,
      });

      const req = createMockRequest(userId);
      const res = createMockResponse();

      await middleware(req as ServerRequest, res as ServerResponse, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect((res.locals as { balanceConfigEnabled?: boolean }).balanceConfigEnabled).toBe(false);

      const balanceRecord = await Balance.findOne({ user: userId });
      expect(balanceRecord).toBeNull();
    });

    test('should skip if startBalance is null', async () => {
      const userId = new mongoose.Types.ObjectId();
      const getAppConfig = jest.fn().mockResolvedValue({
        balance: {
          enabled: true,
          startBalance: null,
        },
      });

      const middleware = createSetBalanceConfig({
        getAppConfig,
        findBalanceByUser,
        upsertBalanceFields,
      });

      const req = createMockRequest(userId);
      const res = createMockResponse();

      await middleware(req as ServerRequest, res as ServerResponse, mockNext);

      expect(mockNext).toHaveBeenCalled();

      const balanceRecord = await Balance.findOne({ user: userId });
      expect(balanceRecord).toBeNull();
    });

    test('should handle user._id as string', async () => {
      const userId = new mongoose.Types.ObjectId().toString();
      const getAppConfig = jest.fn().mockResolvedValue({
        balance: {
          enabled: true,
          startBalance: 1000,
          autoRefillEnabled: true,
          refillIntervalValue: 30,
          refillIntervalUnit: 'days',
          refillAmount: 500,
        },
      });

      const middleware = createSetBalanceConfig({
        getAppConfig,
        findBalanceByUser,
        upsertBalanceFields,
      });

      const req = createMockRequest(userId);
      const res = createMockResponse();

      await middleware(req as ServerRequest, res as ServerResponse, mockNext);

      expect(mockNext).toHaveBeenCalled();

      const balanceRecord = await Balance.findOne({ user: userId });
      expect(balanceRecord).toBeTruthy();
      expect(balanceRecord?.tokenCredits).toBe(1000);
    });

    test('should skip if user is not present in request', async () => {
      const getAppConfig = jest.fn().mockResolvedValue({
        balance: {
          enabled: true,
          startBalance: 1000,
          autoRefillEnabled: true,
          refillIntervalValue: 30,
          refillIntervalUnit: 'days',
          refillAmount: 500,
        },
      });

      const middleware = createSetBalanceConfig({
        getAppConfig,
        findBalanceByUser,
        upsertBalanceFields,
      });

      const req = {} as ServerRequest;
      const res = createMockResponse();

      await middleware(req, res as ServerResponse, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(getAppConfig).toHaveBeenCalled();
    });
  });

  describe('Edge Case: Auto-refill without lastRefill', () => {
    test('should initialize lastRefill when enabling auto-refill for existing user without lastRefill', async () => {
      const userId = new mongoose.Types.ObjectId();

      // Create existing balance record without lastRefill
      // Note: We need to unset lastRefill after creation since the schema has a default
      const doc = await Balance.create({
        user: userId,
        tokenCredits: 500,
        autoRefillEnabled: false,
      });

      // Remove lastRefill to simulate existing user without it
      await Balance.updateOne({ _id: doc._id }, { $unset: { lastRefill: 1 } });

      const getAppConfig = jest.fn().mockResolvedValue({
        balance: {
          enabled: true,
          startBalance: 1000,
          autoRefillEnabled: true,
          refillIntervalValue: 30,
          refillIntervalUnit: 'days',
          refillAmount: 500,
        },
      });

      const middleware = createSetBalanceConfig({
        getAppConfig,
        findBalanceByUser,
        upsertBalanceFields,
      });

      const req = createMockRequest(userId);
      const res = createMockResponse();

      const beforeTime = new Date();
      await middleware(req as ServerRequest, res as ServerResponse, mockNext);
      const afterTime = new Date();

      expect(mockNext).toHaveBeenCalled();

      const balanceRecord = await Balance.findOne({ user: userId });
      expect(balanceRecord).toBeTruthy();
      expect(balanceRecord?.tokenCredits).toBe(500); // Should not change existing credits
      expect(balanceRecord?.autoRefillEnabled).toBe(true);
      expect(balanceRecord?.lastRefill).toBeInstanceOf(Date);

      // Verify lastRefill was set to current time
      const lastRefillTime = balanceRecord?.lastRefill?.getTime() || 0;
      expect(lastRefillTime).toBeGreaterThanOrEqual(beforeTime.getTime());
      expect(lastRefillTime).toBeLessThanOrEqual(afterTime.getTime());
    });

    test('should not update lastRefill if it already exists', async () => {
      const userId = new mongoose.Types.ObjectId();
      const existingLastRefill = new Date('2024-01-01');

      // Create existing balance record with lastRefill
      await Balance.create({
        user: userId,
        tokenCredits: 500,
        autoRefillEnabled: true,
        refillIntervalValue: 30,
        refillIntervalUnit: 'days',
        refillAmount: 500,
        lastRefill: existingLastRefill,
      });

      const getAppConfig = jest.fn().mockResolvedValue({
        balance: {
          enabled: true,
          startBalance: 1000,
          autoRefillEnabled: true,
          refillIntervalValue: 30,
          refillIntervalUnit: 'days',
          refillAmount: 500,
        },
      });

      const middleware = createSetBalanceConfig({
        getAppConfig,
        findBalanceByUser,
        upsertBalanceFields,
      });

      const req = createMockRequest(userId);
      const res = createMockResponse();

      await middleware(req as ServerRequest, res as ServerResponse, mockNext);

      expect(mockNext).toHaveBeenCalled();

      const balanceRecord = await Balance.findOne({ user: userId });
      expect(balanceRecord?.lastRefill?.getTime()).toBe(existingLastRefill.getTime());
    });

    test('should handle existing user with auto-refill enabled but missing lastRefill', async () => {
      const userId = new mongoose.Types.ObjectId();

      // Create a balance record with auto-refill enabled but missing lastRefill
      // This simulates the exact edge case reported by the user
      const doc = await Balance.create({
        user: userId,
        tokenCredits: 500,
        autoRefillEnabled: true,
        refillIntervalValue: 30,
        refillIntervalUnit: 'days',
        refillAmount: 500,
      });

      // Remove lastRefill to simulate the edge case
      await Balance.updateOne({ _id: doc._id }, { $unset: { lastRefill: 1 } });

      const getAppConfig = jest.fn().mockResolvedValue({
        balance: {
          enabled: true,
          startBalance: 1000,
          autoRefillEnabled: true,
          refillIntervalValue: 30,
          refillIntervalUnit: 'days',
          refillAmount: 500,
        },
      });

      const middleware = createSetBalanceConfig({
        getAppConfig,
        findBalanceByUser,
        upsertBalanceFields,
      });

      const req = createMockRequest(userId);
      const res = createMockResponse();

      await middleware(req as ServerRequest, res as ServerResponse, mockNext);

      expect(mockNext).toHaveBeenCalled();

      const balanceRecord = await Balance.findOne({ user: userId });
      expect(balanceRecord).toBeTruthy();
      expect(balanceRecord?.autoRefillEnabled).toBe(true);
      expect(balanceRecord?.lastRefill).toBeInstanceOf(Date);
      // This should have fixed the issue - user should no longer get the error
    });

    test('should not set lastRefill when auto-refill is disabled', async () => {
      const userId = new mongoose.Types.ObjectId();

      const getAppConfig = jest.fn().mockResolvedValue({
        balance: {
          enabled: true,

          startBalance: 1000,
          autoRefillEnabled: false,
        },
      });

      const middleware = createSetBalanceConfig({
        getAppConfig,
        findBalanceByUser,
        upsertBalanceFields,
      });

      const req = createMockRequest(userId);
      const res = createMockResponse();

      await middleware(req as ServerRequest, res as ServerResponse, mockNext);

      expect(mockNext).toHaveBeenCalled();

      const balanceRecord = await Balance.findOne({ user: userId });
      expect(balanceRecord).toBeTruthy();
      expect(balanceRecord?.tokenCredits).toBe(1000);
      expect(balanceRecord?.autoRefillEnabled).toBe(false);
      // lastRefill should have default value from schema
      expect(balanceRecord?.lastRefill).toBeInstanceOf(Date);
    });

    test('should pass user identity when resolving balance config', async () => {
      const userId = new mongoose.Types.ObjectId();
      const getAppConfig = jest.fn().mockResolvedValue({
        balance: { enabled: false },
      });

      const middleware = createSetBalanceConfig({
        getAppConfig,
        findBalanceByUser,
        upsertBalanceFields,
      });

      const req = createMockRequest(userId);
      req.user = {
        ...req.user,
        role: 'USER',
        tenantId: 'tenant-a',
      } as typeof req.user;

      await middleware(req as ServerRequest, createMockResponse() as ServerResponse, mockNext);

      expect(getAppConfig).toHaveBeenCalledWith({
        role: 'USER',
        userId: userId.toString(),
        tenantId: 'tenant-a',
      });
    });
  });

  describe('Update Scenarios', () => {
    test('should update auto-refill settings for existing user', async () => {
      const userId = new mongoose.Types.ObjectId();

      // Create existing balance record
      await Balance.create({
        user: userId,
        tokenCredits: 500,
        autoRefillEnabled: false,
        refillIntervalValue: 7,
        refillIntervalUnit: 'days',
        refillAmount: 100,
      });

      const getAppConfig = jest.fn().mockResolvedValue({
        balance: {
          enabled: true,
          startBalance: 1000,
          autoRefillEnabled: true,
          refillIntervalValue: 30,
          refillIntervalUnit: 'days',
          refillAmount: 500,
        },
      });

      const middleware = createSetBalanceConfig({
        getAppConfig,
        findBalanceByUser,
        upsertBalanceFields,
      });

      const req = createMockRequest(userId);
      const res = createMockResponse();

      await middleware(req as ServerRequest, res as ServerResponse, mockNext);

      const balanceRecord = await Balance.findOne({ user: userId });
      expect(balanceRecord?.tokenCredits).toBe(500); // Should not change
      expect(balanceRecord?.autoRefillEnabled).toBe(true);
      expect(balanceRecord?.refillIntervalValue).toBe(30);
      expect(balanceRecord?.refillIntervalUnit).toBe('days');
      expect(balanceRecord?.refillAmount).toBe(500);
    });

    test('should not update if values are already the same', async () => {
      const userId = new mongoose.Types.ObjectId();
      const lastRefillTime = new Date();

      // Create existing balance record with same values
      await Balance.create({
        user: userId,
        tokenCredits: 1000,
        autoRefillEnabled: true,
        refillIntervalValue: 30,
        refillIntervalUnit: 'days',
        refillAmount: 500,
        lastRefill: lastRefillTime,
      });

      const getAppConfig = jest.fn().mockResolvedValue({
        balance: {
          enabled: true,
          startBalance: 1000,
          autoRefillEnabled: true,
          refillIntervalValue: 30,
          refillIntervalUnit: 'days',
          refillAmount: 500,
        },
      });

      const req = createMockRequest(userId);
      const res = createMockResponse();

      const upsertSpy = jest.fn();
      const spiedMiddleware = createSetBalanceConfig({
        getAppConfig,
        findBalanceByUser,
        upsertBalanceFields: upsertSpy,
      });

      await spiedMiddleware(req as ServerRequest, res as ServerResponse, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(upsertSpy).not.toHaveBeenCalled();
      expect((res.locals as { balanceData?: IBalance }).balanceData?.tokenCredits).toBe(1000);
    });

    test('should set tokenCredits for user with null tokenCredits', async () => {
      const userId = new mongoose.Types.ObjectId();

      // Create balance record with null tokenCredits
      await Balance.create({
        user: userId,
        tokenCredits: null,
      });

      const getAppConfig = jest.fn().mockResolvedValue({
        balance: {
          enabled: true,

          startBalance: 2000,
        },
      });

      const middleware = createSetBalanceConfig({
        getAppConfig,
        findBalanceByUser,
        upsertBalanceFields,
      });

      const req = createMockRequest(userId);
      const res = createMockResponse();

      await middleware(req as ServerRequest, res as ServerResponse, mockNext);

      const balanceRecord = await Balance.findOne({ user: userId });
      expect(balanceRecord?.tokenCredits).toBe(2000);
    });
  });

  describe('Error Handling', () => {
    test('should handle database errors gracefully', async () => {
      const userId = new mongoose.Types.ObjectId();
      const getAppConfig = jest.fn().mockResolvedValue({
        balance: {
          enabled: true,
          startBalance: 1000,
          autoRefillEnabled: true,
          refillIntervalValue: 30,
          refillIntervalUnit: 'days',
          refillAmount: 500,
        },
      });
      const dbError = new Error('Database error');

      const failingFindBalance = () => Promise.reject(dbError);

      const middleware = createSetBalanceConfig({
        getAppConfig,
        findBalanceByUser: failingFindBalance,
        upsertBalanceFields,
      });

      const req = createMockRequest(userId);
      const res = createMockResponse();

      await middleware(req as ServerRequest, res as ServerResponse, mockNext);

      expect(logger.error).toHaveBeenCalledWith('Error setting user balance:', dbError);
      expect(mockNext).toHaveBeenCalledWith(dbError);
    });

    test('should handle getAppConfig errors', async () => {
      const userId = new mongoose.Types.ObjectId();
      const configError = new Error('Config error');
      const getAppConfig = jest.fn().mockRejectedValue(configError);

      const middleware = createSetBalanceConfig({
        getAppConfig,
        findBalanceByUser,
        upsertBalanceFields,
      });

      const req = createMockRequest(userId);
      const res = createMockResponse();

      await middleware(req as ServerRequest, res as ServerResponse, mockNext);

      expect(logger.error).toHaveBeenCalledWith('Error setting user balance:', configError);
      expect(mockNext).toHaveBeenCalledWith(configError);
    });

    test('should handle invalid auto-refill configuration', async () => {
      const userId = new mongoose.Types.ObjectId();

      // Missing required auto-refill fields
      const getAppConfig = jest.fn().mockResolvedValue({
        balance: {
          enabled: true,

          startBalance: 1000,
          autoRefillEnabled: true,
          refillIntervalValue: null, // Invalid
          refillIntervalUnit: 'days',
          refillAmount: 500,
        },
      });

      const middleware = createSetBalanceConfig({
        getAppConfig,
        findBalanceByUser,
        upsertBalanceFields,
      });

      const req = createMockRequest(userId);
      const res = createMockResponse();

      await middleware(req as ServerRequest, res as ServerResponse, mockNext);

      expect(mockNext).toHaveBeenCalled();

      const balanceRecord = await Balance.findOne({ user: userId });
      expect(balanceRecord).toBeTruthy();
      expect(balanceRecord?.tokenCredits).toBe(1000);
      // Auto-refill fields should not be updated due to invalid config
      expect(balanceRecord?.autoRefillEnabled).toBe(false);
    });
  });

  describe('Concurrent Updates', () => {
    test('should handle concurrent middleware calls for same user', async () => {
      const userId = new mongoose.Types.ObjectId();
      const getAppConfig = jest.fn().mockResolvedValue({
        balance: {
          enabled: true,
          startBalance: 1000,
          autoRefillEnabled: true,
          refillIntervalValue: 30,
          refillIntervalUnit: 'days',
          refillAmount: 500,
        },
      });

      const middleware = createSetBalanceConfig({
        getAppConfig,
        findBalanceByUser,
        upsertBalanceFields,
      });

      const req = createMockRequest(userId);
      const res1 = createMockResponse();
      const res2 = createMockResponse();
      const mockNext1 = jest.fn();
      const mockNext2 = jest.fn();

      // Run middleware concurrently
      await Promise.all([
        middleware(req as ServerRequest, res1 as ServerResponse, mockNext1),
        middleware(req as ServerRequest, res2 as ServerResponse, mockNext2),
      ]);

      expect(mockNext1).toHaveBeenCalled();
      expect(mockNext2).toHaveBeenCalled();

      // Should only have one balance record
      const balanceRecords = await Balance.find({ user: userId });
      expect(balanceRecords).toHaveLength(1);
      expect(balanceRecords[0].tokenCredits).toBe(1000);
    });
  });

  describe('Integration with Different refillIntervalUnits', () => {
    test.each(['seconds', 'minutes', 'hours', 'days', 'weeks', 'months'])(
      'should handle refillIntervalUnit: %s',
      async (unit) => {
        const userId = new mongoose.Types.ObjectId();

        const getAppConfig = jest.fn().mockResolvedValue({
          balance: {
            enabled: true,

            startBalance: 1000,
            autoRefillEnabled: true,
            refillIntervalValue: 10,
            refillIntervalUnit: unit,
            refillAmount: 100,
          },
        });

        const middleware = createSetBalanceConfig({
          getAppConfig,
          findBalanceByUser,
          upsertBalanceFields,
        });

        const req = createMockRequest(userId);
        const res = createMockResponse();

        await middleware(req as ServerRequest, res as ServerResponse, mockNext);

        const balanceRecord = await Balance.findOne({ user: userId });
        expect(balanceRecord?.refillIntervalUnit).toBe(unit);
        expect(balanceRecord?.refillIntervalValue).toBe(10);
        expect(balanceRecord?.lastRefill).toBeInstanceOf(Date);
      },
    );
  });
});
