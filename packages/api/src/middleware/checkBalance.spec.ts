import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { logger, createMethods, createModels } from '@librechat/data-schemas';
import {
  ViolationTypes,
  MIN_BALANCE_RESERVATION_TTL_MS,
  DEFAULT_BALANCE_RESERVATION_TTL_MS,
} from 'librechat-data-provider';
import type { BalanceConfig, IBalance } from '@librechat/data-schemas';
import type { Response } from 'express';
import type { BalanceReservation, CheckBalanceDeps } from './checkBalance';
import type { ServerRequest } from '~/types/http';
import {
  checkBalance,
  createBalanceReservations,
  withBalanceReservations,
  reserveBalanceCredits,
} from './checkBalance';

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: {
    debug: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
  },
}));

describe('checkBalance', () => {
  const createMockDeps = (overrides: Partial<CheckBalanceDeps> = {}): CheckBalanceDeps => ({
    reserveBalance: jest.fn().mockResolvedValue({ reserved: true, balance: 1000 }),
    renewBalanceReservation: jest.fn().mockResolvedValue(undefined),
    releaseBalanceReservation: jest.fn().mockResolvedValue(undefined),
    getMultiplier: jest.fn().mockReturnValue(1),
    logViolation: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  });

  const req = { user: { id: 'user-1' } } as ServerRequest;
  const res = {} as Response;

  const baseTxData = {
    user: 'user-1',
    tokenType: 'prompt',
    amount: 100,
    endpoint: 'openAI',
    model: 'gpt-4',
  };

  const reserveRequest = (deps: CheckBalanceDeps) =>
    (deps.reserveBalance as jest.Mock).mock.calls[0][0];

  it('shares reservation lifecycle with an already-priced background call without HTTP dependencies', async () => {
    const deps = createMockDeps();
    const admitted = await reserveBalanceCredits({ user: 'user-1', amount: 75 }, deps);
    expect(admitted.balance).toEqual({ reserved: true, balance: 1000 });
    expect(reserveRequest(deps).amount).toBe(75);
    await admitted.reservation?.release();
    expect(deps.releaseBalanceReservation).toHaveBeenCalledTimes(1);
    expect(deps.logViolation).not.toHaveBeenCalled();
  });

  it('returns an unfunded background admission without creating a reservation handle', async () => {
    const deps = createMockDeps({
      reserveBalance: jest.fn().mockResolvedValue({ reserved: false, balance: 10 }),
    });
    await expect(reserveBalanceCredits({ user: 'user-1', amount: 75 }, deps)).resolves.toEqual({
      balance: { reserved: false, balance: 10 },
      reservation: undefined,
    });
    expect(deps.releaseBalanceReservation).not.toHaveBeenCalled();
    expect(deps.logViolation).not.toHaveBeenCalled();
  });

  it.each([NaN, Infinity, -1])(
    'rejects invalid priced credit input %s before touching storage',
    async (amount) => {
      const deps = createMockDeps();
      await expect(reserveBalanceCredits({ user: 'user-1', amount }, deps)).rejects.toThrow(
        'credit amount',
      );
      expect(deps.reserveBalance).not.toHaveBeenCalled();
    },
  );

  it('reserves the token cost and releases that reservation exactly once', async () => {
    const deps = createMockDeps({ getMultiplier: jest.fn().mockReturnValue(2) });

    const reservation = await checkBalance({ req, res, txData: baseTxData }, deps);

    expect(deps.reserveBalance).toHaveBeenCalledWith({
      user: 'user-1',
      amount: 200,
      reservationId: expect.any(String),
      expiresAt: expect.any(Date),
      initialBalance: undefined,
    });
    const { reservationId } = reserveRequest(deps);
    expect(deps.releaseBalanceReservation).not.toHaveBeenCalled();

    await Promise.all([reservation.release(), reservation.release()]);
    await reservation.release();

    expect(deps.releaseBalanceReservation).toHaveBeenCalledTimes(1);
    expect(deps.releaseBalanceReservation).toHaveBeenCalledWith({
      user: 'user-1',
      reservationId,
      amount: 200,
    });
  });

  it('logs instead of throwing when a release fails', async () => {
    const deps = createMockDeps({
      releaseBalanceReservation: jest.fn().mockRejectedValue(new Error('DB unavailable')),
    });

    const reservation = await checkBalance({ req, res, txData: baseTxData }, deps);

    await expect(reservation.release()).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(
      '[Balance.check] Failed to release balance reservation',
      expect.objectContaining({ user: 'user-1' }),
    );
  });

  it('throws a TOKEN_BALANCE violation with the unreserved balance when refused', async () => {
    const deps = createMockDeps({
      reserveBalance: jest.fn().mockResolvedValue({ reserved: false, balance: 10 }),
    });

    await expect(
      checkBalance({ req, res, txData: { ...baseTxData, amount: 100 } }, deps),
    ).rejects.toThrow();

    expect(deps.logViolation).toHaveBeenCalledWith(
      req,
      res,
      ViolationTypes.TOKEN_BALANCE,
      expect.objectContaining({ balance: 10, tokenCost: 100 }),
      0,
    );
  });

  it('reports no less than zero balance when reservations exceed the credits', async () => {
    const deps = createMockDeps({
      reserveBalance: jest.fn().mockResolvedValue({ reserved: false, balance: -200 }),
    });

    await expect(checkBalance({ req, res, txData: baseTxData }, deps)).rejects.toThrow();

    expect(deps.logViolation).toHaveBeenCalledWith(
      req,
      res,
      ViolationTypes.TOKEN_BALANCE,
      expect.objectContaining({ balance: 0, tokenCost: 100 }),
      0,
    );
  });

  it('propagates a failure of the balance store instead of reporting a balance violation', async () => {
    const deps = createMockDeps({
      reserveBalance: jest.fn().mockRejectedValue(new Error('DB unavailable')),
    });

    await expect(checkBalance({ req, res, txData: baseTxData }, deps)).rejects.toThrow(
      'DB unavailable',
    );
    expect(deps.logViolation).not.toHaveBeenCalled();
  });

  describe('reservation expiry', () => {
    const expiryOf = (deps: CheckBalanceDeps) => reserveRequest(deps).expiresAt.getTime();

    it('expires reservations after the configured TTL', async () => {
      const deps = createMockDeps({ balanceConfig: { reservationTtlMs: 20_000 } });
      const before = Date.now();

      await checkBalance({ req, res, txData: baseTxData }, deps);

      expect(expiryOf(deps)).toBeGreaterThanOrEqual(before + 20_000);
      expect(expiryOf(deps)).toBeLessThanOrEqual(Date.now() + 20_000);
    });

    it('falls back to the default TTL, warning once, when the configured TTL is invalid', async () => {
      const balanceConfig = { reservationTtlMs: -1 } as BalanceConfig;
      const before = Date.now();

      for (let i = 0; i < 2; i++) {
        const deps = createMockDeps({ balanceConfig });
        await checkBalance({ req, res, txData: baseTxData }, deps);
        expect(expiryOf(deps)).toBeGreaterThanOrEqual(before + DEFAULT_BALANCE_RESERVATION_TTL_MS);
      }

      expect(logger.warn).toHaveBeenCalledTimes(1);
    });
  });

  describe('reservation renewal', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('renews a held reservation every half TTL until it is released', async () => {
      const deps = createMockDeps({ balanceConfig: { reservationTtlMs: 10_000 } });

      const reservation = await checkBalance({ req, res, txData: baseTxData }, deps);
      const { reservationId } = reserveRequest(deps);

      await jest.advanceTimersByTimeAsync(5_000);
      expect(deps.renewBalanceReservation).toHaveBeenCalledTimes(1);
      expect(deps.renewBalanceReservation).toHaveBeenCalledWith({
        user: 'user-1',
        reservationId,
        expiresAt: new Date(Date.now() + 10_000),
      });
      await jest.advanceTimersByTimeAsync(5_000);
      expect(deps.renewBalanceReservation).toHaveBeenCalledTimes(2);

      await reservation.release();
      await jest.advanceTimersByTimeAsync(50_000);
      expect(deps.renewBalanceReservation).toHaveBeenCalledTimes(2);
    });

    it('retries a failed renewal well before the reservation would expire', async () => {
      const deps = createMockDeps({
        balanceConfig: { reservationTtlMs: 10_000 },
        renewBalanceReservation: jest
          .fn()
          .mockRejectedValueOnce(new Error('DB unavailable'))
          .mockResolvedValue(undefined),
      });

      const reservation = await checkBalance({ req, res, txData: baseTxData }, deps);

      await jest.advanceTimersByTimeAsync(5_000);
      expect(deps.renewBalanceReservation).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(500);
      expect(deps.renewBalanceReservation).toHaveBeenCalledTimes(2);
      await jest.advanceTimersByTimeAsync(4_999);
      expect(deps.renewBalanceReservation).toHaveBeenCalledTimes(2);

      await reservation.release();
    });

    it('renews from the stored expiry when the admission write is slow', async () => {
      const deps = createMockDeps({
        balanceConfig: { reservationTtlMs: 10_000 },
        reserveBalance: jest.fn(
          () =>
            new Promise((resolve) =>
              setTimeout(() => resolve({ reserved: true, balance: 1000 }), 3_000),
            ),
        ),
      });

      const admission = checkBalance({ req, res, txData: baseTxData }, deps);
      await jest.advanceTimersByTimeAsync(3_000);
      const reservation = await admission;

      await jest.advanceTimersByTimeAsync(1_999);
      expect(deps.renewBalanceReservation).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1);
      expect(deps.renewBalanceReservation).toHaveBeenCalledTimes(1);

      await reservation.release();
    });

    it('renews from the stored expiry when a renewal write is slow', async () => {
      const deps = createMockDeps({
        balanceConfig: { reservationTtlMs: 10_000 },
        renewBalanceReservation: jest.fn(
          () => new Promise<void>((resolve) => setTimeout(resolve, 3_000)),
        ),
      });

      const reservation = await checkBalance({ req, res, txData: baseTxData }, deps);

      await jest.advanceTimersByTimeAsync(5_000);
      expect(deps.renewBalanceReservation).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(4_999);
      expect(deps.renewBalanceReservation).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1);
      expect(deps.renewBalanceReservation).toHaveBeenCalledTimes(2);

      await reservation.release();
    });

    it('keeps the renewal delay within the timer range for a very long TTL', async () => {
      const deps = createMockDeps({ balanceConfig: { reservationTtlMs: 6_000_000_000 } });

      const reservation = await checkBalance({ req, res, txData: baseTxData }, deps);
      await jest.advanceTimersByTimeAsync(60_000);

      expect(deps.renewBalanceReservation).not.toHaveBeenCalled();
      await reservation.release();
    });

    it('raises a TTL below the minimum so renewal stays bounded', async () => {
      const deps = createMockDeps({ balanceConfig: { reservationTtlMs: 1 } });
      const before = Date.now();

      const reservation = await checkBalance({ req, res, txData: baseTxData }, deps);
      expect(reserveRequest(deps).expiresAt.getTime()).toBe(
        before + MIN_BALANCE_RESERVATION_TTL_MS,
      );

      await jest.advanceTimersByTimeAsync(MIN_BALANCE_RESERVATION_TTL_MS / 2 - 1);
      expect(deps.renewBalanceReservation).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1);
      expect(deps.renewBalanceReservation).toHaveBeenCalledTimes(1);

      await reservation.release();
    });

    it('does not renew a zero-cost admission, which holds nothing', async () => {
      const deps = createMockDeps({ balanceConfig: { reservationTtlMs: 10_000 } });

      const reservation = await checkBalance(
        { req, res, txData: { ...baseTxData, amount: 0 } },
        deps,
      );
      await jest.advanceTimersByTimeAsync(50_000);

      expect(deps.renewBalanceReservation).not.toHaveBeenCalled();
      await reservation.release();
    });
  });

  describe('lazy balance initialization', () => {
    it('creates a missing record from startBalance', async () => {
      const deps = createMockDeps({ balanceConfig: { startBalance: 5000 } });

      await checkBalance({ req, res, txData: baseTxData }, deps);

      expect(reserveRequest(deps).initialBalance).toEqual({ user: 'user-1', tokenCredits: 5000 });
    });

    it('includes auto-refill fields when configured', async () => {
      const deps = createMockDeps({
        balanceConfig: {
          startBalance: 5000,
          autoRefillEnabled: true,
          refillIntervalValue: 1,
          refillIntervalUnit: 'days',
          refillAmount: 1000,
        },
      });

      await checkBalance({ req, res, txData: baseTxData }, deps);

      expect(reserveRequest(deps).initialBalance).toEqual({
        user: 'user-1',
        tokenCredits: 5000,
        autoRefillEnabled: true,
        refillIntervalValue: 1,
        refillIntervalUnit: 'days',
        refillAmount: 1000,
        lastRefill: expect.any(Date),
      });
    });

    it('omits auto-refill fields when the refill config is partial', async () => {
      const deps = createMockDeps({
        balanceConfig: { startBalance: 5000, autoRefillEnabled: true },
      });

      await checkBalance({ req, res, txData: baseTxData }, deps);

      expect(reserveRequest(deps).initialBalance).toEqual({ user: 'user-1', tokenCredits: 5000 });
    });

    it('creates a record with a startBalance of 0', async () => {
      const deps = createMockDeps({ balanceConfig: { startBalance: 0 } });

      await checkBalance({ req, res, txData: baseTxData }, deps);

      expect(reserveRequest(deps).initialBalance).toEqual({ user: 'user-1', tokenCredits: 0 });
    });

    it.each([
      ['no balance config', undefined],
      ['no startBalance', {}],
    ])(
      'throws a TOKEN_BALANCE violation for a missing record with %s',
      async (_case, balanceConfig) => {
        const deps = createMockDeps({
          reserveBalance: jest.fn().mockResolvedValue(null),
          balanceConfig,
        });

        await expect(checkBalance({ req, res, txData: baseTxData }, deps)).rejects.toThrow();
        expect(reserveRequest(deps).initialBalance).toBeUndefined();
        expect(deps.logViolation).toHaveBeenCalledWith(
          req,
          res,
          ViolationTypes.TOKEN_BALANCE,
          expect.objectContaining({ balance: 0 }),
          0,
        );
      },
    );
  });

  describe('balance reservations of a turn', () => {
    const createReservation = () => {
      const reservation: BalanceReservation = { release: jest.fn().mockResolvedValue(undefined) };
      return reservation;
    };

    it('releases an admission that settles after the release was requested', async () => {
      const reservations = createBalanceReservations();
      const reservation = createReservation();
      let admit: (value: BalanceReservation) => void = () => undefined;
      reservations.track(new Promise<BalanceReservation>((resolve) => (admit = resolve)));

      const released = reservations.release();
      expect(reservation.release).not.toHaveBeenCalled();
      admit(reservation);
      await released;

      expect(reservation.release).toHaveBeenCalledTimes(1);
    });

    it('releases nothing for a refused admission and does not reject', async () => {
      const reservations = createBalanceReservations();
      const refused = Promise.reject(new Error('insufficient'));

      await expect(reservations.track(refused)).rejects.toThrow('insufficient');
      await expect(reservations.release()).resolves.toBeUndefined();
    });

    it('releases each tracked reservation once across repeated releases', async () => {
      const reservations = createBalanceReservations();
      const first = createReservation();
      const second = createReservation();

      await reservations.track(Promise.resolve(first));
      await reservations.release();
      await reservations.track(Promise.resolve(second));
      await reservations.release();
      await reservations.release();

      expect(first.release).toHaveBeenCalledTimes(1);
      expect(second.release).toHaveBeenCalledTimes(1);
    });

    it('keeps reservations held until background work settles, even when it fails', async () => {
      const reservations = createBalanceReservations();
      const reservation = createReservation();
      let finishWork: (error: Error) => void = () => undefined;
      await reservations.track(Promise.resolve(reservation));
      reservations.holdUntil(new Promise((_resolve, reject) => (finishWork = reject)));

      const released = reservations.release();
      await new Promise((resolve) => setImmediate(resolve));
      expect(reservation.release).not.toHaveBeenCalled();
      finishWork(new Error('background run failed'));
      await released;

      expect(reservation.release).toHaveBeenCalledTimes(1);
    });

    it('releases the turn reservations whether the turn resolves or throws', async () => {
      const kept = createReservation();
      const failed = createReservation();

      await expect(
        withBalanceReservations(async (reservations) => {
          await reservations.track(Promise.resolve(kept));
          return 'done';
        }),
      ).resolves.toBe('done');
      await expect(
        withBalanceReservations(async (reservations) => {
          await reservations.track(Promise.resolve(failed));
          throw new Error('turn failed');
        }),
      ).rejects.toThrow('turn failed');

      expect(kept.release).toHaveBeenCalledTimes(1);
      expect(failed.release).toHaveBeenCalledTimes(1);
    });
  });

  describe('against a real balance store', () => {
    let mongoServer: MongoMemoryServer;
    let Balance: mongoose.Model<IBalance>;
    let methods: ReturnType<typeof createMethods>;

    beforeAll(async () => {
      mongoServer = await MongoMemoryServer.create();
      await mongoose.connect(mongoServer.getUri());
      createModels(mongoose);
      Balance = mongoose.models.Balance as mongoose.Model<IBalance>;
      methods = createMethods(mongoose);
    });

    afterAll(async () => {
      await mongoose.disconnect();
      await mongoServer.stop();
    });

    beforeEach(async () => {
      await mongoose.connection.dropDatabase();
    });

    const realDeps = (balanceConfig?: BalanceConfig): CheckBalanceDeps => ({
      getMultiplier: () => 1,
      reserveBalance: methods.reserveBalance,
      renewBalanceReservation: methods.renewBalanceReservation,
      releaseBalanceReservation: methods.releaseBalanceReservation,
      logViolation: jest.fn().mockResolvedValue(undefined),
      balanceConfig,
    });

    const admitConcurrently = (user: string, count: number, deps: CheckBalanceDeps, amount = 400) =>
      Promise.allSettled(
        Array.from({ length: count }, () =>
          checkBalance({ req, res, txData: { ...baseTxData, user, amount } }, deps),
        ),
      );

    const admittedOf = (outcomes: PromiseSettledResult<BalanceReservation>[]) =>
      outcomes.flatMap((outcome) => (outcome.status === 'fulfilled' ? [outcome.value] : []));

    it('admits concurrent requests only against credits no in-flight request holds', async () => {
      const user = new mongoose.Types.ObjectId().toString();
      await Balance.create({ user, tokenCredits: 1000 });
      const deps = realDeps();

      const admitted = admittedOf(await admitConcurrently(user, 20, deps));

      expect(admitted).toHaveLength(2);
      expect(deps.logViolation).toHaveBeenCalledTimes(18);

      await Promise.all(admitted.map((reservation) => reservation.release()));
      expect(admittedOf(await admitConcurrently(user, 3, deps))).toHaveLength(2);
    });

    it('admits every request of a funded concurrent burst', async () => {
      const user = new mongoose.Types.ObjectId().toString();
      await Balance.create({ user, tokenCredits: 100_000 });

      const outcomes = await admitConcurrently(user, 40, realDeps(), 100);

      expect(admittedOf(outcomes)).toHaveLength(40);
    });

    it('refills once for concurrent requests arriving in one refill window', async () => {
      const user = new mongoose.Types.ObjectId().toString();
      await Balance.create({
        user,
        tokenCredits: 5,
        autoRefillEnabled: true,
        refillAmount: 1000,
        refillIntervalValue: 30,
        refillIntervalUnit: 'days',
        lastRefill: new Date('2020-01-01T00:00:00.000Z'),
      });

      const outcomes = await admitConcurrently(user, 10, realDeps());

      expect(admittedOf(outcomes)).toHaveLength(2);
      const stored = await Balance.findOne({ user }).lean();
      expect(stored?.tokenCredits).toBe(1005);
      const refills = await methods.getTransactions({ user, context: 'autoRefill' });
      expect(refills).toHaveLength(1);
    });

    it('lazily initializes a missing record and reserves against it', async () => {
      const user = new mongoose.Types.ObjectId().toString();
      const deps = realDeps({ startBalance: 1000 });

      await checkBalance({ req, res, txData: { ...baseTxData, user, amount: 400 } }, deps);
      const outcomes = await admitConcurrently(user, 4, deps);

      expect(admittedOf(outcomes)).toHaveLength(1);
      const stored = await Balance.findOne({ user }).select('+reservedCredits').lean();
      expect(stored?.tokenCredits).toBe(1000);
      expect(stored?.reservedCredits).toBe(800);
    });
  });
});
