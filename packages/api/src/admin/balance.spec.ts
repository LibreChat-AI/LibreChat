import { Types } from 'mongoose';
import type { IUser, IBalance, IBalanceRequest } from '@librechat/data-schemas';
import type { Response } from 'express';
import type { ServerRequest } from '~/types/http';
import type { AdminBalanceDeps } from './balance';
import { createAdminBalanceHandlers } from './balance';

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

function mockUser(overrides: Partial<IUser> = {}): IUser {
  return {
    _id: new Types.ObjectId(),
    name: 'Test User',
    email: 'test@example.com',
    avatar: 'https://example.com/avatar.png',
    role: 'USER',
    tenantId: 'tenant-a',
    ...overrides,
  } as IUser;
}

function mockBalance(overrides: Partial<IBalance> = {}): IBalance {
  return {
    user: new Types.ObjectId(),
    tokenCredits: 1000,
    autoRefillEnabled: false,
    refillIntervalValue: 30,
    refillIntervalUnit: 'days',
    lastRefill: new Date('2026-01-01'),
    refillAmount: 0,
    ...overrides,
  } as IBalance;
}

function mockPendingRequest(overrides: Partial<IBalanceRequest> = {}): IBalanceRequest {
  return {
    _id: new Types.ObjectId(),
    user: new Types.ObjectId(),
    status: 'pending',
    requestedAt: new Date('2026-01-02'),
    ...overrides,
  } as IBalanceRequest;
}

function createReqRes(
  overrides: {
    params?: Record<string, string>;
    query?: Record<string, string>;
    body?: Record<string, unknown>;
    user?: { _id?: Types.ObjectId; id?: string; role?: string; tenantId?: string; name?: string };
  } = {},
) {
  const req = {
    params: overrides.params ?? {},
    query: overrides.query ?? {},
    body: overrides.body ?? {},
    user: overrides.user ?? { _id: new Types.ObjectId(), role: 'ADMIN', name: 'Admin' },
  } as unknown as ServerRequest;

  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const res = { status, json } as unknown as Response;

  return { req, res, status, json };
}

function createDeps(overrides: Partial<AdminBalanceDeps> = {}): AdminBalanceDeps {
  return {
    findUsers: jest.fn().mockResolvedValue([]),
    countUsers: jest.fn().mockResolvedValue(0),
    getUserById: jest.fn().mockResolvedValue(mockUser()),
    findBalancesByUsers: jest.fn().mockResolvedValue([]),
    findPendingBalanceRequestsByUsers: jest.fn().mockResolvedValue([]),
    findAllPendingBalanceRequests: jest.fn().mockResolvedValue([]),
    countPendingBalanceRequests: jest.fn().mockResolvedValue(0),
    applyIdempotentCredit: jest
      .fn()
      .mockResolvedValue({ resultingBalance: 1500, applied: true, transactionId: 'txn-1' }),
    claimAuditRecording: jest.fn().mockResolvedValue(true),
    markAuditRecorded: jest.fn().mockResolvedValue(undefined),
    releaseAuditRecordingLease: jest.fn().mockResolvedValue(undefined),
    claimBalanceRequestResolution: jest.fn().mockResolvedValue(true),
    releaseBalanceRequestResolutionLease: jest.fn().mockResolvedValue(undefined),
    resolveBalanceRequestIfPending: jest.fn().mockResolvedValue(null),
    recordAuditEntry: jest.fn().mockResolvedValue({ _id: 'audit-1' }),
    getAppConfig: jest.fn().mockResolvedValue({ balance: { enabled: true } }),
    ...overrides,
  };
}

describe('createAdminBalanceHandlers', () => {
  describe('listUsersWithBalance', () => {
    it('merges users, balances, and pending requests into one list', async () => {
      const userA = mockUser({ _id: new Types.ObjectId(), name: 'Alice' });
      const userB = mockUser({ _id: new Types.ObjectId(), name: 'Bob' });
      const balanceA = mockBalance({
        user: userA._id as Types.ObjectId,
        tokenCredits: 500,
        refillAmount: 2000,
      });
      const pendingB = mockPendingRequest({
        user: userB._id as Types.ObjectId,
        reason: 'need more',
      });

      const deps = createDeps({
        findUsers: jest.fn().mockResolvedValue([userA, userB]),
        countUsers: jest.fn().mockResolvedValue(2),
        findBalancesByUsers: jest.fn().mockResolvedValue([balanceA]),
        findPendingBalanceRequestsByUsers: jest.fn().mockResolvedValue([pendingB]),
      });
      const handlers = createAdminBalanceHandlers(deps);
      const { req, res, status, json } = createReqRes();

      await handlers.listUsersWithBalance(req, res);

      expect(status).toHaveBeenCalledWith(200);
      const response = json.mock.calls[0][0];
      expect(response.total).toBe(2);
      const items = response.items as Array<Record<string, unknown>>;
      const itemA = items.find((i) => i.name === 'Alice');
      const itemB = items.find((i) => i.name === 'Bob');

      // User with a Balance doc: real value.
      expect(itemA?.tokenCredits).toBe(500);
      expect(itemA?.refillAmount).toBe(2000);
      expect(itemA?.pendingRequest).toBeUndefined();

      // User with no Balance doc yet: explicit 0, not undefined/omitted.
      expect(itemB?.tokenCredits).toBe(0);
      expect(itemB?.pendingRequest).toMatchObject({
        requestId: pendingB._id.toString(),
        reason: 'need more',
      });
      // Both resolve enabled via the default mocked getAppConfig.
      expect(itemA?.balanceEnabled).toBe(true);
      expect(itemB?.balanceEnabled).toBe(true);
    });

    it('resolves refillAmount from the live effective config, overriding a stale value stored on the Balance document', async () => {
      // Simulates exactly what was observed in practice: an admin configures
      // `refillAmount: 1000` for a role/tenant *after* a user's Balance
      // document already existed with a different (here: unset) value —
      // the stored field never gets backfilled, so the live config must win.
      const userA = mockUser({ _id: new Types.ObjectId(), name: 'Alice' });
      const staleBalance = mockBalance({ user: userA._id as Types.ObjectId, refillAmount: 0 });

      const deps = createDeps({
        findUsers: jest.fn().mockResolvedValue([userA]),
        countUsers: jest.fn().mockResolvedValue(1),
        findBalancesByUsers: jest.fn().mockResolvedValue([staleBalance]),
        getAppConfig: jest
          .fn()
          .mockResolvedValue({ balance: { enabled: true, refillAmount: 1000 } }),
      });
      const handlers = createAdminBalanceHandlers(deps);
      const { req, res, json } = createReqRes();

      await handlers.listUsersWithBalance(req, res);

      const response = json.mock.calls[0][0];
      const items = response.items as Array<Record<string, unknown>>;
      expect(items[0].refillAmount).toBe(1000);
    });

    it('falls back to the Balance document refillAmount when the live config has none', async () => {
      const userA = mockUser({ _id: new Types.ObjectId(), name: 'Alice' });
      const balanceA = mockBalance({ user: userA._id as Types.ObjectId, refillAmount: 750 });

      const deps = createDeps({
        findUsers: jest.fn().mockResolvedValue([userA]),
        countUsers: jest.fn().mockResolvedValue(1),
        findBalancesByUsers: jest.fn().mockResolvedValue([balanceA]),
        getAppConfig: jest.fn().mockResolvedValue({ balance: { enabled: true } }),
      });
      const handlers = createAdminBalanceHandlers(deps);
      const { req, res, json } = createReqRes();

      await handlers.listUsersWithBalance(req, res);

      const response = json.mock.calls[0][0];
      const items = response.items as Array<Record<string, unknown>>;
      expect(items[0].refillAmount).toBe(750);
    });

    it('rejects an overlong search query', async () => {
      const deps = createDeps();
      const handlers = createAdminBalanceHandlers(deps);
      const { req, res, status } = createReqRes({ query: { search: 'a'.repeat(201) } });

      await handlers.listUsersWithBalance(req, res);

      expect(status).toHaveBeenCalledWith(400);
    });

    it('reports balanceEnabled: false, with 0 credits, for a user whose effective config has balance disabled', async () => {
      const userA = mockUser({ _id: new Types.ObjectId(), name: 'Alice' });
      const deps = createDeps({
        findUsers: jest.fn().mockResolvedValue([userA]),
        countUsers: jest.fn().mockResolvedValue(1),
        getAppConfig: jest.fn().mockResolvedValue({ balance: { enabled: false } }),
      });
      const handlers = createAdminBalanceHandlers(deps);
      const { req, res, json } = createReqRes();

      await handlers.listUsersWithBalance(req, res);

      const response = json.mock.calls[0][0];
      const items = response.items as Array<Record<string, unknown>>;
      expect(items[0].balanceEnabled).toBe(false);
      expect(items[0].tokenCredits).toBe(0);
    });

    it('always includes the global pendingCount, independent of the current view or search', async () => {
      const deps = createDeps({
        countPendingBalanceRequests: jest.fn().mockResolvedValue(7),
      });
      const handlers = createAdminBalanceHandlers(deps);
      const { req, res, json } = createReqRes({ query: { search: 'alice' } });

      await handlers.listUsersWithBalance(req, res);

      const response = json.mock.calls[0][0];
      expect(response.pendingCount).toBe(7);
    });

    describe('filter=requests view', () => {
      function mockPendingWithUser(overrides: {
        requestId?: string;
        requestedAt?: Date;
        reason?: string;
        user?: Partial<{
          id: string;
          name: string;
          email: string;
          avatar: string;
          role: string;
          tenantId: string;
        }>;
      }) {
        return {
          requestId: overrides.requestId ?? new Types.ObjectId().toString(),
          requestedAt: overrides.requestedAt ?? new Date('2026-01-02'),
          reason: overrides.reason,
          user: {
            id: new Types.ObjectId().toString(),
            name: 'Requester',
            email: 'requester@example.com',
            avatar: '',
            role: 'USER',
            tenantId: 'tenant-a',
            ...overrides.user,
          },
        };
      }

      it('lists users with pending requests directly, independent of alphabetical user-list pagination', async () => {
        const pendingZ = mockPendingWithUser({ user: { name: 'Zed', id: 'user-z' } });
        const deps = createDeps({
          findAllPendingBalanceRequests: jest.fn().mockResolvedValue([pendingZ]),
          findUsers: jest.fn().mockResolvedValue([]),
          countUsers: jest.fn().mockResolvedValue(0),
        });
        const handlers = createAdminBalanceHandlers(deps);
        const { req, res, json } = createReqRes({ query: { filter: 'requests' } });

        await handlers.listUsersWithBalance(req, res);

        // Never touches the alphabetically-paginated user list at all.
        expect(deps.findUsers).not.toHaveBeenCalled();
        const response = json.mock.calls[0][0];
        expect(response.total).toBe(1);
        expect(response.items[0].name).toBe('Zed');
        expect(response.items[0].pendingRequest.requestId).toBe(pendingZ.requestId);
      });

      it('filters pending requests by the requester name/email search term', async () => {
        const alice = mockPendingWithUser({ user: { name: 'Alice', email: 'alice@x.com' } });
        const bob = mockPendingWithUser({ user: { name: 'Bob', email: 'bob@x.com' } });
        const deps = createDeps({
          findAllPendingBalanceRequests: jest.fn().mockResolvedValue([alice, bob]),
        });
        const handlers = createAdminBalanceHandlers(deps);
        const { req, res, json } = createReqRes({
          query: { filter: 'requests', search: 'alice' },
        });

        await handlers.listUsersWithBalance(req, res);

        const response = json.mock.calls[0][0];
        expect(response.total).toBe(1);
        expect(response.items[0].name).toBe('Alice');
      });

      it('paginates the pending-requests view using limit/offset', async () => {
        const requests = Array.from({ length: 5 }, (_, i) =>
          mockPendingWithUser({ user: { name: `User${i}` } }),
        );
        const deps = createDeps({
          findAllPendingBalanceRequests: jest.fn().mockResolvedValue(requests),
        });
        const handlers = createAdminBalanceHandlers(deps);
        const { req, res, json } = createReqRes({
          query: { filter: 'requests', limit: '2', offset: '2' },
        });

        await handlers.listUsersWithBalance(req, res);

        const response = json.mock.calls[0][0];
        expect(response.total).toBe(5);
        expect(response.items).toHaveLength(2);
        expect(response.items.map((i: { name: string }) => i.name)).toEqual(['User2', 'User3']);
      });
    });
  });

  describe('addCredit', () => {
    const userId = new Types.ObjectId().toString();

    it('applies credit and returns the resulting balance', async () => {
      const deps = createDeps();
      const handlers = createAdminBalanceHandlers(deps);
      const { req, res, status, json } = createReqRes({
        params: { userId },
        body: { amount: 500, idempotencyKey: 'key-1' },
      });

      await handlers.addCredit(req, res);

      expect(deps.applyIdempotentCredit).toHaveBeenCalledWith({
        user: userId,
        incrementValue: 500,
        idempotencyKey: 'key-1',
        context: 'admin',
      });
      expect(deps.claimAuditRecording).toHaveBeenCalledWith('txn-1');
      expect(deps.recordAuditEntry).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'balance.credit_added' }),
      );
      // Marked recorded only after recordAuditEntry has confirmed success —
      // never released, since the write succeeded.
      expect(deps.markAuditRecorded).toHaveBeenCalledWith('txn-1');
      expect(deps.releaseAuditRecordingLease).not.toHaveBeenCalled();
      expect(status).toHaveBeenCalledWith(200);
      const response = json.mock.calls[0][0];
      expect(response).toEqual({
        resultingBalance: 1500,
        creditAlreadyApplied: false,
        requestAlreadyResolved: false,
      });
    });

    it('releases the lease instead of marking recorded when recordAuditEntry throws', async () => {
      const deps = createDeps({
        recordAuditEntry: jest.fn().mockRejectedValue(new Error('audit db unavailable')),
      });
      const handlers = createAdminBalanceHandlers(deps);
      const { req, res, status } = createReqRes({
        params: { userId },
        body: { amount: 500, idempotencyKey: 'key-1' },
      });

      await handlers.addCredit(req, res);

      expect(deps.markAuditRecorded).not.toHaveBeenCalled();
      expect(deps.releaseAuditRecordingLease).toHaveBeenCalledWith('txn-1');
      // A failed audit write must not fail the credit itself.
      expect(status).toHaveBeenCalledWith(200);
    });

    it('releases the lease instead of marking recorded when recordAuditEntry fails open and returns null', async () => {
      const deps = createDeps({
        recordAuditEntry: jest.fn().mockResolvedValue(null),
      });
      const handlers = createAdminBalanceHandlers(deps);
      const { req, res } = createReqRes({
        params: { userId },
        body: { amount: 500, idempotencyKey: 'key-1' },
      });

      await handlers.addCredit(req, res);

      expect(deps.markAuditRecorded).not.toHaveBeenCalled();
      expect(deps.releaseAuditRecordingLease).toHaveBeenCalledWith('txn-1');
    });

    it('works as a plain top-up when no requestId is given', async () => {
      const deps = createDeps();
      const handlers = createAdminBalanceHandlers(deps);
      const { req, res, status } = createReqRes({
        params: { userId },
        body: { amount: 500, idempotencyKey: 'key-1' },
      });

      await handlers.addCredit(req, res);

      expect(deps.resolveBalanceRequestIfPending).not.toHaveBeenCalled();
      expect(status).toHaveBeenCalledWith(200);
    });

    it('resolves the specific pending request when a requestId is given', async () => {
      const requestId = new Types.ObjectId().toString();
      const deps = createDeps({
        resolveBalanceRequestIfPending: jest.fn().mockResolvedValue(mockPendingRequest()),
      });
      const handlers = createAdminBalanceHandlers(deps);
      const { req, res } = createReqRes({
        params: { userId },
        body: { amount: 500, idempotencyKey: 'key-1', requestId },
      });

      await handlers.addCredit(req, res);

      expect(deps.resolveBalanceRequestIfPending).toHaveBeenCalledWith(
        requestId,
        userId,
        expect.objectContaining({ resolvedAmount: 500 }),
      );
    });

    it('reports requestAlreadyResolved when the request was already resolved', async () => {
      const requestId = new Types.ObjectId().toString();
      const deps = createDeps({
        resolveBalanceRequestIfPending: jest.fn().mockResolvedValue(null),
      });
      const handlers = createAdminBalanceHandlers(deps);
      const { req, res, json } = createReqRes({
        params: { userId },
        body: { amount: 500, idempotencyKey: 'key-1', requestId },
      });

      await handlers.addCredit(req, res);

      const response = json.mock.calls[0][0];
      expect(response.requestAlreadyResolved).toBe(true);
    });

    it('claims the request before applying credit — not after', async () => {
      const requestId = new Types.ObjectId().toString();
      const callOrder: string[] = [];
      const deps = createDeps({
        claimBalanceRequestResolution: jest.fn().mockImplementation(async () => {
          callOrder.push('claim');
          return true;
        }),
        applyIdempotentCredit: jest.fn().mockImplementation(async () => {
          callOrder.push('credit');
          return { resultingBalance: 1500, applied: true, transactionId: 'txn-1' };
        }),
      });
      const handlers = createAdminBalanceHandlers(deps);
      const { req, res } = createReqRes({
        params: { userId },
        body: { amount: 500, idempotencyKey: 'key-1', requestId },
      });

      await handlers.addCredit(req, res);

      expect(deps.claimBalanceRequestResolution).toHaveBeenCalledWith(requestId, userId);
      expect(callOrder).toEqual(['claim', 'credit']);
    });

    it('rejects with 409 — and never applies credit — when a concurrent operation already holds the claim', async () => {
      const requestId = new Types.ObjectId().toString();
      const deps = createDeps({
        claimBalanceRequestResolution: jest.fn().mockResolvedValue(false),
      });
      const handlers = createAdminBalanceHandlers(deps);
      const { req, res, status, json } = createReqRes({
        params: { userId },
        body: { amount: 500, idempotencyKey: 'key-1', requestId },
      });

      await handlers.addCredit(req, res);

      expect(deps.applyIdempotentCredit).not.toHaveBeenCalled();
      expect(status).toHaveBeenCalledWith(409);
      expect(json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.any(String) }));
    });

    it('releases the claimed lease — so a retry can reclaim immediately — when the credit step throws', async () => {
      const requestId = new Types.ObjectId().toString();
      const deps = createDeps({
        applyIdempotentCredit: jest.fn().mockRejectedValue(new Error('DB unavailable')),
      });
      const handlers = createAdminBalanceHandlers(deps);
      const { req, res, status } = createReqRes({
        params: { userId },
        body: { amount: 500, idempotencyKey: 'key-1', requestId },
      });

      await handlers.addCredit(req, res);

      expect(deps.releaseBalanceRequestResolutionLease).toHaveBeenCalledWith(requestId);
      expect(status).toHaveBeenCalledWith(500);
    });

    it('derives the ledger idempotency key from requestId — not the client-supplied key — so a retry with a new idempotencyKey cannot double-credit', async () => {
      const requestId = new Types.ObjectId().toString();
      const deps = createDeps();
      const handlers = createAdminBalanceHandlers(deps);
      const { req, res } = createReqRes({
        params: { userId },
        body: { amount: 500, idempotencyKey: 'client-key-1', requestId },
      });

      await handlers.addCredit(req, res);

      expect(deps.applyIdempotentCredit).toHaveBeenCalledWith({
        user: userId,
        incrementValue: 500,
        idempotencyKey: `balance-request:${requestId}`,
        context: 'admin',
      });
    });

    it('converges on the same ledger idempotency key across retries that each carry a different client-supplied idempotencyKey', async () => {
      const requestId = new Types.ObjectId().toString();
      const applyIdempotentCredit = jest
        .fn()
        .mockResolvedValue({ resultingBalance: 1500, applied: true, transactionId: 'txn-1' });
      const deps = createDeps({ applyIdempotentCredit });
      const handlers = createAdminBalanceHandlers(deps);

      const first = createReqRes({
        params: { userId },
        body: { amount: 500, idempotencyKey: 'client-key-1', requestId },
      });
      await handlers.addCredit(first.req, first.res);

      const second = createReqRes({
        params: { userId },
        body: { amount: 500, idempotencyKey: 'client-key-2', requestId },
      });
      await handlers.addCredit(second.req, second.res);

      expect(applyIdempotentCredit).toHaveBeenCalledTimes(2);
      const [firstCallKey] = applyIdempotentCredit.mock.calls[0];
      const [secondCallKey] = applyIdempotentCredit.mock.calls[1];
      expect(firstCallKey.idempotencyKey).toBe(secondCallKey.idempotencyKey);
      expect(firstCallKey.idempotencyKey).toBe(`balance-request:${requestId}`);
    });

    it('falls back to the client-supplied idempotencyKey when no requestId is given', async () => {
      const deps = createDeps();
      const handlers = createAdminBalanceHandlers(deps);
      const { req, res } = createReqRes({
        params: { userId },
        body: { amount: 500, idempotencyKey: 'client-key-1' },
      });

      await handlers.addCredit(req, res);

      expect(deps.applyIdempotentCredit).toHaveBeenCalledWith(
        expect.objectContaining({ idempotencyKey: 'client-key-1' }),
      );
    });

    it('never claims or releases a lease when no requestId is given', async () => {
      const deps = createDeps();
      const handlers = createAdminBalanceHandlers(deps);
      const { req, res } = createReqRes({
        params: { userId },
        body: { amount: 500, idempotencyKey: 'key-1' },
      });

      await handlers.addCredit(req, res);

      expect(deps.claimBalanceRequestResolution).not.toHaveBeenCalled();
      expect(deps.releaseBalanceRequestResolutionLease).not.toHaveBeenCalled();
    });

    it('still writes the audit entry when the credit was already applied but the audit was never recorded (crash repair)', async () => {
      // Simulates a prior attempt that applied the credit and wrote its
      // ledger row (via applyIdempotentCredit) but crashed before the audit
      // entry — this retry must repair the missing audit row even though it
      // did not itself move the balance. `claimAuditRecording` is the sole
      // authority on whether the audit entry is still owed, independent of
      // `applied`.
      const deps = createDeps({
        applyIdempotentCredit: jest
          .fn()
          .mockResolvedValue({ resultingBalance: 1500, applied: false, transactionId: 'txn-1' }),
        claimAuditRecording: jest.fn().mockResolvedValue(true),
      });
      const handlers = createAdminBalanceHandlers(deps);
      const { req, res, json } = createReqRes({
        params: { userId },
        body: { amount: 500, idempotencyKey: 'key-1' },
      });

      await handlers.addCredit(req, res);

      expect(deps.claimAuditRecording).toHaveBeenCalledWith('txn-1');
      expect(deps.recordAuditEntry).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'balance.credit_added' }),
      );
      const response = json.mock.calls[0][0];
      expect(response.creditAlreadyApplied).toBe(true);
    });

    it('does not write a duplicate audit entry when the audit was already recorded by a prior attempt', async () => {
      const deps = createDeps({
        applyIdempotentCredit: jest
          .fn()
          .mockResolvedValue({ resultingBalance: 1500, applied: false, transactionId: 'txn-1' }),
        claimAuditRecording: jest.fn().mockResolvedValue(false),
      });
      const handlers = createAdminBalanceHandlers(deps);
      const { req, res, json } = createReqRes({
        params: { userId },
        body: { amount: 500, idempotencyKey: 'key-1' },
      });

      await handlers.addCredit(req, res);

      expect(deps.recordAuditEntry).not.toHaveBeenCalled();
      const response = json.mock.calls[0][0];
      expect(response.creditAlreadyApplied).toBe(true);
    });

    it('returns 404 for a nonexistent (or cross-tenant) user without touching balance data', async () => {
      const deps = createDeps({ getUserById: jest.fn().mockResolvedValue(null) });
      const handlers = createAdminBalanceHandlers(deps);
      const { req, res, status } = createReqRes({
        params: { userId },
        body: { amount: 500, idempotencyKey: 'key-1' },
      });

      await handlers.addCredit(req, res);

      expect(status).toHaveBeenCalledWith(404);
      expect(deps.applyIdempotentCredit).not.toHaveBeenCalled();
    });

    it('returns 400 when balance is disabled for the target user', async () => {
      const deps = createDeps({
        getAppConfig: jest.fn().mockResolvedValue({ balance: { enabled: false } }),
      });
      const handlers = createAdminBalanceHandlers(deps);
      const { req, res, status } = createReqRes({
        params: { userId },
        body: { amount: 500, idempotencyKey: 'key-1' },
      });

      await handlers.addCredit(req, res);

      expect(status).toHaveBeenCalledWith(400);
      expect(deps.applyIdempotentCredit).not.toHaveBeenCalled();
    });

    it('resolves config for the target user, not the caller', async () => {
      const targetUser = mockUser({ role: 'CONTRACTOR', tenantId: 'tenant-b' });
      const deps = createDeps({ getUserById: jest.fn().mockResolvedValue(targetUser) });
      const handlers = createAdminBalanceHandlers(deps);
      const { req, res } = createReqRes({
        params: { userId },
        body: { amount: 500, idempotencyKey: 'key-1' },
        user: { _id: new Types.ObjectId(), role: 'ADMIN', tenantId: 'tenant-admin' },
      });

      await handlers.addCredit(req, res);

      expect(deps.getAppConfig).toHaveBeenCalledWith({
        role: 'CONTRACTOR',
        userId: targetUser._id?.toString(),
        tenantId: 'tenant-b',
      });
    });

    it.each([
      ['missing amount', {}],
      ['zero amount', { amount: 0 }],
      ['negative amount', { amount: -100 }],
      ['non-integer amount', { amount: 12.5 }],
      ['amount over the max', { amount: 200_000_000 }],
    ])('returns 400 for %s', async (_label, body) => {
      const deps = createDeps();
      const handlers = createAdminBalanceHandlers(deps);
      const { req, res, status } = createReqRes({
        params: { userId },
        body: { idempotencyKey: 'key-1', ...body },
      });

      await handlers.addCredit(req, res);

      expect(status).toHaveBeenCalledWith(400);
      expect(deps.applyIdempotentCredit).not.toHaveBeenCalled();
    });

    it('returns 400 when idempotencyKey is missing', async () => {
      const deps = createDeps();
      const handlers = createAdminBalanceHandlers(deps);
      const { req, res, status } = createReqRes({
        params: { userId },
        body: { amount: 500 },
      });

      await handlers.addCredit(req, res);

      expect(status).toHaveBeenCalledWith(400);
      expect(deps.applyIdempotentCredit).not.toHaveBeenCalled();
    });

    it('returns 400 for an invalid userId format', async () => {
      const deps = createDeps();
      const handlers = createAdminBalanceHandlers(deps);
      const { req, res, status } = createReqRes({
        params: { userId: 'not-an-object-id' },
        body: { amount: 500, idempotencyKey: 'key-1' },
      });

      await handlers.addCredit(req, res);

      expect(status).toHaveBeenCalledWith(400);
      expect(deps.getUserById).not.toHaveBeenCalled();
    });
  });
});
