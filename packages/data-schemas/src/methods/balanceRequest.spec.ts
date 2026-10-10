import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { IBalanceRequest } from '..';
import { createBalanceRequestMethods } from './balanceRequest';
import { tenantStorage } from '../config/tenantContext';
import { createModels } from '../models';

jest.mock('~/config/winston', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

const TENANT_A = 'tenant-aaaaaaaaaaaaaaaaaaaa';
const TENANT_B = 'tenant-bbbbbbbbbbbbbbbbbbbb';

let mongoServer: MongoMemoryServer;
let BalanceRequest: mongoose.Model<IBalanceRequest>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let User: mongoose.Model<any>;
let methods: ReturnType<typeof createBalanceRequestMethods>;

function runAs<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  return tenantStorage.run({ tenantId }, fn);
}

async function createTestUser(overrides: {
  name?: string;
  email?: string;
  role?: string;
  tenantId?: string;
}): Promise<string> {
  const user = await User.create({
    email: overrides.email ?? `${new mongoose.Types.ObjectId().toString()}@example.com`,
    name: overrides.name,
    role: overrides.role,
    tenantId: overrides.tenantId,
  });
  return user._id.toString();
}

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  createModels(mongoose);
  BalanceRequest = mongoose.models.BalanceRequest as mongoose.Model<IBalanceRequest>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  User = mongoose.models.User as mongoose.Model<any>;
  methods = createBalanceRequestMethods(mongoose);
  await methods.ensureBalanceRequestIndexes();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await Promise.all([BalanceRequest.deleteMany({}), User.deleteMany({})]);
});

describe('createBalanceRequest', () => {
  it('creates a pending request with the given reason', async () => {
    const userId = new mongoose.Types.ObjectId().toString();

    const created = await methods.createBalanceRequest(userId, 'ran out mid-sprint');

    expect(created.status).toBe('pending');
    expect(created.reason).toBe('ran out mid-sprint');
    expect(created.user.toString()).toBe(userId);
  });

  it('returns the existing pending request instead of throwing on a duplicate', async () => {
    const userId = new mongoose.Types.ObjectId().toString();

    const first = await methods.createBalanceRequest(userId, 'first reason');
    const second = await methods.createBalanceRequest(userId, 'second reason');

    expect(second._id.toString()).toBe(first._id.toString());
    expect(second.reason).toBe('first reason');

    const count = await BalanceRequest.countDocuments({ user: userId, status: 'pending' });
    expect(count).toBe(1);
  });

  it('allows a new pending request after the previous one was resolved', async () => {
    const userId = new mongoose.Types.ObjectId().toString();
    const adminId = new mongoose.Types.ObjectId().toString();

    const first = await methods.createBalanceRequest(userId, 'first');
    await methods.resolveBalanceRequestIfPending(first._id.toString(), userId, {
      resolvedBy: adminId,
      resolvedAmount: 1000,
    });

    const second = await methods.createBalanceRequest(userId, 'second');

    expect(second._id.toString()).not.toBe(first._id.toString());
    expect(second.status).toBe('pending');
  });
});

describe('findPendingBalanceRequestByUser / findPendingBalanceRequestsByUsers', () => {
  it('finds a single pending request for a user', async () => {
    const userId = new mongoose.Types.ObjectId().toString();
    await methods.createBalanceRequest(userId, 'need more credits');

    const found = await methods.findPendingBalanceRequestByUser(userId);

    expect(found?.status).toBe('pending');
    expect(found?.reason).toBe('need more credits');
  });

  it('returns null when the user has no pending request', async () => {
    const userId = new mongoose.Types.ObjectId().toString();
    const found = await methods.findPendingBalanceRequestByUser(userId);
    expect(found).toBeNull();
  });

  it('batches lookups across multiple users, returning only the pending ones', async () => {
    const userA = new mongoose.Types.ObjectId().toString();
    const userB = new mongoose.Types.ObjectId().toString();
    const userC = new mongoose.Types.ObjectId().toString();
    const adminId = new mongoose.Types.ObjectId().toString();

    await methods.createBalanceRequest(userA, 'a');
    const bRequest = await methods.createBalanceRequest(userB, 'b');
    await methods.resolveBalanceRequestIfPending(bRequest._id.toString(), userB, {
      resolvedBy: adminId,
      resolvedAmount: 500,
    });
    // userC never requests anything.

    const results = await methods.findPendingBalanceRequestsByUsers([userA, userB, userC]);

    expect(results).toHaveLength(1);
    expect(results[0].user.toString()).toBe(userA);
  });

  it('returns an empty array immediately for an empty input list', async () => {
    const results = await methods.findPendingBalanceRequestsByUsers([]);
    expect(results).toEqual([]);
  });
});

describe('findAllPendingBalanceRequests / countPendingBalanceRequests', () => {
  it('resolves the requester for each pending request, newest first', async () => {
    const userA = await createTestUser({ name: 'Alice', email: 'alice@example.com', role: 'USER' });
    const userB = await createTestUser({ name: 'Bob', email: 'bob@example.com', role: 'ADMIN' });
    await methods.createBalanceRequest(userA, 'first');
    await new Promise((resolve) => setTimeout(resolve, 5));
    await methods.createBalanceRequest(userB, 'second');

    const results = await methods.findAllPendingBalanceRequests();

    expect(results).toHaveLength(2);
    // Newest first.
    expect(results[0].user.name).toBe('Bob');
    expect(results[0].reason).toBe('second');
    expect(results[1].user.name).toBe('Alice');
    expect(results[1].user.email).toBe('alice@example.com');
    expect(results[1].user.role).toBe('USER');
  });

  it('excludes resolved requests', async () => {
    const userA = await createTestUser({ name: 'Alice' });
    const adminId = new mongoose.Types.ObjectId().toString();
    const request = await methods.createBalanceRequest(userA, 'reason');
    await methods.resolveBalanceRequestIfPending(request._id.toString(), userA, {
      resolvedBy: adminId,
      resolvedAmount: 1000,
    });

    const results = await methods.findAllPendingBalanceRequests();

    expect(results).toEqual([]);
  });

  it('omits a request whose user has been deleted, rather than crashing on the missing populate', async () => {
    const userA = await createTestUser({ name: 'Alice' });
    await methods.createBalanceRequest(userA, 'reason');
    await User.deleteOne({ _id: userA });

    const results = await methods.findAllPendingBalanceRequests();

    expect(results).toEqual([]);
  });

  it('counts pending requests globally, unaffected by resolved ones', async () => {
    const userA = await createTestUser({ name: 'Alice' });
    const userB = await createTestUser({ name: 'Bob' });
    const adminId = new mongoose.Types.ObjectId().toString();
    await methods.createBalanceRequest(userA, 'a');
    const bRequest = await methods.createBalanceRequest(userB, 'b');
    await methods.resolveBalanceRequestIfPending(bRequest._id.toString(), userB, {
      resolvedBy: adminId,
      resolvedAmount: 500,
    });

    const count = await methods.countPendingBalanceRequests();

    expect(count).toBe(1);
  });
});

describe('resolveBalanceRequestIfPending', () => {
  it('resolves the exact request matched by id and user', async () => {
    const userId = new mongoose.Types.ObjectId().toString();
    const adminId = new mongoose.Types.ObjectId().toString();
    const request = await methods.createBalanceRequest(userId, 'reason');

    const resolved = await methods.resolveBalanceRequestIfPending(request._id.toString(), userId, {
      resolvedBy: adminId,
      resolvedAmount: 40000000,
    });

    expect(resolved?.status).toBe('resolved');
    expect(resolved?.resolvedBy?.toString()).toBe(adminId);
    expect(resolved?.resolvedAmount).toBe(40000000);
    expect(resolved?.resolvedAt).toBeInstanceOf(Date);
  });

  it('is a safe no-op (returns null) when called again for an already-resolved request', async () => {
    const userId = new mongoose.Types.ObjectId().toString();
    const adminId = new mongoose.Types.ObjectId().toString();
    const request = await methods.createBalanceRequest(userId, 'reason');

    await methods.resolveBalanceRequestIfPending(request._id.toString(), userId, {
      resolvedBy: adminId,
      resolvedAmount: 1000,
    });
    const second = await methods.resolveBalanceRequestIfPending(request._id.toString(), userId, {
      resolvedBy: adminId,
      resolvedAmount: 1000,
    });

    expect(second).toBeNull();
  });

  it('does not resolve a request belonging to a different user', async () => {
    const userId = new mongoose.Types.ObjectId().toString();
    const otherUserId = new mongoose.Types.ObjectId().toString();
    const adminId = new mongoose.Types.ObjectId().toString();
    const request = await methods.createBalanceRequest(userId, 'reason');

    const result = await methods.resolveBalanceRequestIfPending(
      request._id.toString(),
      otherUserId,
      { resolvedBy: adminId, resolvedAmount: 1000 },
    );

    expect(result).toBeNull();
    const stillPending = await methods.findPendingBalanceRequestByUser(userId);
    expect(stillPending).not.toBeNull();
  });

  it('returns null for a nonexistent request id', async () => {
    const userId = new mongoose.Types.ObjectId().toString();
    const adminId = new mongoose.Types.ObjectId().toString();
    const bogusId = new mongoose.Types.ObjectId().toString();

    const result = await methods.resolveBalanceRequestIfPending(bogusId, userId, {
      resolvedBy: adminId,
      resolvedAmount: 1000,
    });

    expect(result).toBeNull();
  });

  it('leaves resolvedBy unset when an older caller omits it', async () => {
    const userId = new mongoose.Types.ObjectId().toString();
    const request = await methods.createBalanceRequest(userId, 'reason');

    const resolved = await methods.resolveBalanceRequestIfPending(request._id.toString(), userId, {
      resolvedAmount: 1000,
    });

    expect(resolved?.status).toBe('resolved');
    expect(resolved?.resolvedBy).toBeUndefined();
    expect(resolved?.resolvedAmount).toBe(1000);
  });

  it('ignores the resolution lease — callers reach this only after already winning it', async () => {
    const userId = new mongoose.Types.ObjectId().toString();
    const adminId = new mongoose.Types.ObjectId().toString();
    const request = await methods.createBalanceRequest(userId, 'reason');

    const claimed = await methods.claimBalanceRequestResolution(request._id.toString(), userId);
    expect(claimed).toBe(true);

    // Resolving while still holding the very lease just claimed must not be
    // blocked by that lease — this is the lease holder finishing its own
    // claimed work, not a second, competing caller.
    const resolved = await methods.resolveBalanceRequestIfPending(request._id.toString(), userId, {
      resolvedBy: adminId,
      resolvedAmount: 1000,
    });

    expect(resolved?.status).toBe('resolved');
  });
});

describe('claimBalanceRequestResolution / releaseBalanceRequestResolutionLease', () => {
  it('claims exactly one of several concurrent attempts to resolve the same request', async () => {
    const userId = new mongoose.Types.ObjectId().toString();
    const request = await methods.createBalanceRequest(userId, 'reason');

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        methods.claimBalanceRequestResolution(request._id.toString(), userId),
      ),
    );

    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('does not claim a request that is not pending', async () => {
    const userId = new mongoose.Types.ObjectId().toString();
    const adminId = new mongoose.Types.ObjectId().toString();
    const request = await methods.createBalanceRequest(userId, 'reason');
    await methods.resolveBalanceRequestIfPending(request._id.toString(), userId, {
      resolvedBy: adminId,
      resolvedAmount: 1000,
    });

    const claimed = await methods.claimBalanceRequestResolution(request._id.toString(), userId);

    expect(claimed).toBe(false);
  });

  it('does not claim a request belonging to a different user', async () => {
    const userId = new mongoose.Types.ObjectId().toString();
    const otherUserId = new mongoose.Types.ObjectId().toString();
    const request = await methods.createBalanceRequest(userId, 'reason');

    const claimed = await methods.claimBalanceRequestResolution(
      request._id.toString(),
      otherUserId,
    );

    expect(claimed).toBe(false);
  });

  it('releaseBalanceRequestResolutionLease lets a failed attempt be reclaimed immediately', async () => {
    const userId = new mongoose.Types.ObjectId().toString();
    const request = await methods.createBalanceRequest(userId, 'reason');

    const firstClaim = await methods.claimBalanceRequestResolution(request._id.toString(), userId);
    expect(firstClaim).toBe(true);

    // Without releasing, a second claim attempt (simulating a retry) would
    // fail while the first lease is still live.
    const blockedRetry = await methods.claimBalanceRequestResolution(
      request._id.toString(),
      userId,
    );
    expect(blockedRetry).toBe(false);

    await methods.releaseBalanceRequestResolutionLease(request._id.toString());

    const retryAfterRelease = await methods.claimBalanceRequestResolution(
      request._id.toString(),
      userId,
    );
    expect(retryAfterRelease).toBe(true);
  });

  it('an unreleased lease — simulating a crash mid-credit — becomes reclaimable once it expires', async () => {
    const userId = new mongoose.Types.ObjectId().toString();
    const request = await methods.createBalanceRequest(userId, 'reason');

    const claimed = await methods.claimBalanceRequestResolution(request._id.toString(), userId, 10);
    expect(claimed).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 20));

    const reclaimed = await methods.claimBalanceRequestResolution(request._id.toString(), userId);
    expect(reclaimed).toBe(true);
  });

  it('resolveBalanceRequestIfPending succeeds even while this caller still holds its own claimed lease', async () => {
    const userId = new mongoose.Types.ObjectId().toString();
    const adminId = new mongoose.Types.ObjectId().toString();
    const request = await methods.createBalanceRequest(userId, 'reason');

    const claimed = await methods.claimBalanceRequestResolution(request._id.toString(), userId);
    expect(claimed).toBe(true);

    const resolved = await methods.resolveBalanceRequestIfPending(request._id.toString(), userId, {
      resolvedBy: adminId,
      resolvedAmount: 1000,
    });

    expect(resolved?.status).toBe('resolved');
    expect(resolved?.resolutionLeaseExpiresAt).toBeUndefined();
  });
});

describe('deleteBalanceRequests', () => {
  it('deletes all requests matching the filter', async () => {
    const userId = new mongoose.Types.ObjectId().toString();
    await methods.createBalanceRequest(userId, 'reason');

    const result = await methods.deleteBalanceRequests({ user: userId });

    expect(result.deletedCount).toBe(1);
    const remaining = await BalanceRequest.countDocuments({ user: userId });
    expect(remaining).toBe(0);
  });
});

describe('tenant isolation', () => {
  it('never surfaces a pending request from another tenant', async () => {
    const userId = new mongoose.Types.ObjectId().toString();

    await runAs(TENANT_A, () => methods.createBalanceRequest(userId, 'tenant A request'));

    const foundInB = await runAs(TENANT_B, () => methods.findPendingBalanceRequestByUser(userId));
    expect(foundInB).toBeNull();

    const foundInA = await runAs(TENANT_A, () => methods.findPendingBalanceRequestByUser(userId));
    expect(foundInA?.reason).toBe('tenant A request');
  });

  it('allows the same user to have independent pending requests per tenant', async () => {
    const userId = new mongoose.Types.ObjectId().toString();

    await runAs(TENANT_A, () => methods.createBalanceRequest(userId, 'A'));
    await runAs(TENANT_B, () => methods.createBalanceRequest(userId, 'B'));

    const aRequest = await runAs(TENANT_A, () => methods.findPendingBalanceRequestByUser(userId));
    const bRequest = await runAs(TENANT_B, () => methods.findPendingBalanceRequestByUser(userId));

    expect(aRequest?.reason).toBe('A');
    expect(bRequest?.reason).toBe('B');
  });
});

describe('indexes', () => {
  it('provisions the partial-unique pending-request index and the TTL index', async () => {
    const indexes = await BalanceRequest.collection.indexes();

    const pendingUniqueIndex = indexes.find(
      (index) => index.unique && index.key.user === 1 && index.key.status === 1,
    );
    expect(pendingUniqueIndex).toBeDefined();
    expect(pendingUniqueIndex?.partialFilterExpression).toEqual({ status: 'pending' });

    const ttlIndex = indexes.find(
      (index) => typeof index.expireAfterSeconds === 'number' && index.key.resolvedAt === 1,
    );
    expect(ttlIndex).toBeDefined();
  });
});
