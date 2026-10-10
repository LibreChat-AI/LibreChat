import { Types } from 'mongoose';
import type { IBalance, IBalanceRequest } from '@librechat/data-schemas';
import type { Response } from 'express';
import type { ServerRequest } from '~/types/http';
import type { BalanceDeps } from './handlers';
import { createBalanceHandlers } from './handlers';

function mockBalance(overrides: Partial<IBalance> = {}): IBalance {
  return {
    _id: new Types.ObjectId(),
    user: new Types.ObjectId(),
    tokenCredits: 1000,
    autoRefillEnabled: false,
    refillIntervalValue: 30,
    refillIntervalUnit: 'days',
    lastRefill: new Date('2026-01-01'),
    refillAmount: 0,
    ...overrides,
  } as unknown as IBalance;
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
    body?: Record<string, unknown>;
    user?: { id?: string; role?: string; tenantId?: string };
    locals?: Record<string, unknown>;
  } = {},
) {
  const req = {
    body: overrides.body ?? {},
    user: overrides.user ?? { id: 'user-1', role: 'USER' },
  } as unknown as ServerRequest;

  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const sendStatus = jest.fn();
  const res = { status, json, sendStatus, locals: overrides.locals ?? {} } as unknown as Response;

  return { req, res, status, json, sendStatus };
}

function createDeps(overrides: Partial<BalanceDeps> = {}): BalanceDeps {
  return {
    findBalanceByUser: jest.fn().mockResolvedValue(mockBalance()),
    findPendingBalanceRequestByUser: jest.fn().mockResolvedValue(null),
    createBalanceRequest: jest.fn().mockResolvedValue(mockPendingRequest()),
    getAppConfig: jest.fn().mockResolvedValue({ balance: { enabled: true } }),
    ...overrides,
  };
}

describe('createBalanceHandlers', () => {
  describe('getBalance', () => {
    it('returns 204 without reading balance when balance config is disabled', async () => {
      const deps = createDeps();
      const handlers = createBalanceHandlers(deps);
      const { req, res, sendStatus } = createReqRes({ locals: { balanceConfigEnabled: false } });

      await handlers.getBalance(req, res);

      expect(deps.findBalanceByUser).not.toHaveBeenCalled();
      expect(sendStatus).toHaveBeenCalledWith(204);
    });

    it('returns 404 when balance is enabled and no record exists', async () => {
      const deps = createDeps({ findBalanceByUser: jest.fn().mockResolvedValue(null) });
      const handlers = createBalanceHandlers(deps);
      const { req, res, status, json } = createReqRes({ locals: { balanceConfigEnabled: true } });

      await handlers.getBalance(req, res);

      expect(status).toHaveBeenCalledWith(404);
      expect(json).toHaveBeenCalledWith({ error: 'Balance not found' });
    });

    it('merges a pending credit request into the response', async () => {
      const pending = mockPendingRequest({ reason: 'ran out mid-sprint' });
      const deps = createDeps({
        findPendingBalanceRequestByUser: jest.fn().mockResolvedValue(pending),
      });
      const handlers = createBalanceHandlers(deps);
      const { req, res, json } = createReqRes({ locals: { balanceConfigEnabled: true } });

      await handlers.getBalance(req, res);

      const response = json.mock.calls[0][0];
      expect(response.pendingCreditRequest).toMatchObject({
        requestId: pending._id.toString(),
        reason: 'ran out mid-sprint',
      });
    });

    it('omits pendingCreditRequest when there is nothing pending', async () => {
      const deps = createDeps();
      const handlers = createBalanceHandlers(deps);
      const { req, res, json } = createReqRes({ locals: { balanceConfigEnabled: true } });

      await handlers.getBalance(req, res);

      const response = json.mock.calls[0][0];
      expect(response.pendingCreditRequest).toBeUndefined();
    });

    it('uses balance data already attached by middleware without a second read', async () => {
      const deps = createDeps();
      const handlers = createBalanceHandlers(deps);
      const balanceData = mockBalance({ tokenCredits: 42 });
      const { req, res, json } = createReqRes({
        locals: { balanceConfigEnabled: true, balanceData },
      });

      await handlers.getBalance(req, res);

      expect(deps.findBalanceByUser).not.toHaveBeenCalled();
      expect(json.mock.calls[0][0].tokenCredits).toBe(42);
    });

    it('strips interval/lastRefill fields when autoRefillEnabled is false, but still exposes refillAmount', async () => {
      // refillAmount is needed for the "running low" threshold regardless
      // of whether automatic refilling itself is on; the countdown fields
      // only make sense when it is.
      const deps = createDeps({
        findBalanceByUser: jest
          .fn()
          .mockResolvedValue(mockBalance({ autoRefillEnabled: false, refillAmount: 500 })),
      });
      const handlers = createBalanceHandlers(deps);
      const { req, res, json } = createReqRes({ locals: { balanceConfigEnabled: true } });

      await handlers.getBalance(req, res);

      const response = json.mock.calls[0][0];
      expect(response.refillAmount).toBe(500);
      expect(response.refillIntervalValue).toBeUndefined();
      expect(response.lastRefill).toBeUndefined();
    });

    it('resolves autoRefillEnabled and refillAmount from the live effective config, overriding a stale value stored on the Balance document', async () => {
      const deps = createDeps({
        findBalanceByUser: jest
          .fn()
          .mockResolvedValue(mockBalance({ autoRefillEnabled: false, refillAmount: 0 })),
        getAppConfig: jest.fn().mockResolvedValue({
          balance: { enabled: true, autoRefillEnabled: true, refillAmount: 1000 },
        }),
      });
      const handlers = createBalanceHandlers(deps);
      const { req, res, json } = createReqRes({ locals: { balanceConfigEnabled: true } });

      await handlers.getBalance(req, res);

      const response = json.mock.calls[0][0];
      expect(response.autoRefillEnabled).toBe(true);
      expect(response.refillAmount).toBe(1000);
    });

    it('falls back to the Balance document values when the live config has none', async () => {
      const deps = createDeps({
        findBalanceByUser: jest
          .fn()
          .mockResolvedValue(mockBalance({ autoRefillEnabled: true, refillAmount: 750 })),
        getAppConfig: jest.fn().mockResolvedValue({ balance: { enabled: true } }),
      });
      const handlers = createBalanceHandlers(deps);
      const { req, res, json } = createReqRes({ locals: { balanceConfigEnabled: true } });

      await handlers.getBalance(req, res);

      const response = json.mock.calls[0][0];
      expect(response.autoRefillEnabled).toBe(true);
      expect(response.refillAmount).toBe(750);
    });

    it('never leaks internal Balance fields (recentIdempotencyKeys, user, tenantId) to the client', async () => {
      const deps = createDeps({
        findBalanceByUser: jest.fn().mockResolvedValue(
          mockBalance({
            autoRefillEnabled: true,
            recentIdempotencyKeys: ['secret-admin-op-key-1', 'secret-admin-op-key-2'],
          } as Partial<IBalance>),
        ),
      });
      const handlers = createBalanceHandlers(deps);
      const { req, res, json } = createReqRes({ locals: { balanceConfigEnabled: true } });

      await handlers.getBalance(req, res);

      const response = json.mock.calls[0][0];
      expect(response.recentIdempotencyKeys).toBeUndefined();
      expect(response.user).toBeUndefined();
      expect(response.tenantId).toBeUndefined();
      expect(response._id).toBeUndefined();
      expect(Object.keys(response).sort()).toEqual(
        [
          'autoRefillEnabled',
          'lastRefill',
          'refillAmount',
          'refillIntervalUnit',
          'refillIntervalValue',
          'tokenCredits',
        ].sort(),
      );
    });
  });

  describe('requestTopUp', () => {
    it('creates a request with a trimmed, length-clamped reason', async () => {
      const deps = createDeps();
      const handlers = createBalanceHandlers(deps);
      const longReason = `  ${'a'.repeat(600)}  `;
      const { req, res, status } = createReqRes({ body: { reason: longReason } });

      await handlers.requestTopUp(req, res);

      expect(deps.createBalanceRequest).toHaveBeenCalledWith('user-1', 'a'.repeat(500));
      expect(status).toHaveBeenCalledWith(200);
    });

    it('treats a blank reason as no reason', async () => {
      const deps = createDeps();
      const handlers = createBalanceHandlers(deps);
      const { req, res } = createReqRes({ body: { reason: '   ' } });

      await handlers.requestTopUp(req, res);

      expect(deps.createBalanceRequest).toHaveBeenCalledWith('user-1', undefined);
    });

    it('resolves config for the requesting user', async () => {
      const deps = createDeps();
      const handlers = createBalanceHandlers(deps);
      const { req, res } = createReqRes({
        user: { id: 'user-1', role: 'CONTRACTOR', tenantId: 'tenant-b' },
      });

      await handlers.requestTopUp(req, res);

      expect(deps.getAppConfig).toHaveBeenCalledWith({
        role: 'CONTRACTOR',
        userId: 'user-1',
        tenantId: 'tenant-b',
      });
    });

    it('rejects with 400 when balance is disabled', async () => {
      const deps = createDeps({
        getAppConfig: jest.fn().mockResolvedValue({ balance: { enabled: false } }),
      });
      const handlers = createBalanceHandlers(deps);
      const { req, res, status } = createReqRes();

      await handlers.requestTopUp(req, res);

      expect(status).toHaveBeenCalledWith(400);
      expect(deps.createBalanceRequest).not.toHaveBeenCalled();
    });
  });
});
