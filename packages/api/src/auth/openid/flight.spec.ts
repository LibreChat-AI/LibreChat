import type { OpenIDRefreshFlightDeps } from './flight';
import type { RefreshFlightRecord } from './types';
import { createOpenIDRefreshFlightService } from './flight';

jest.mock('../../utils/identity', () => ({
  createOpenIDRefreshIdentityTuple: jest.fn(),
  serializeAuthIdentityTuple: jest.fn(),
}));

function createService(db: Partial<OpenIDRefreshFlightDeps['db']>) {
  return createOpenIDRefreshFlightService({
    db: {
      acquireOpenIDRefreshFlight: jest.fn(),
      completeOpenIDRefreshFlight: jest.fn(),
      renewOpenIDRefreshFlight: jest.fn(),
      failOpenIDRefreshFlight: jest.fn(),
      revokeOpenIDRefreshFlight: jest.fn(),
      findOpenIDRefreshFlight: jest.fn(),
      claimOpenIDRefreshFlightDelivery: jest.fn(),
      releaseOpenIDRefreshFlightDelivery: jest.fn(),
      ...db,
    },
    logger: { warn: jest.fn() },
    encrypt: async (value) => value,
    decrypt: async (value) => value,
  });
}

describe('OpenID flight supersession', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  const spent = (flight: RefreshFlightRecord = {}): RefreshFlightRecord => ({
    status: 'completed',
    ownerId: 'owner-1',
    usable: { ownerId: 'owner-1', until: new Date(Date.now() - 1000) },
    ...flight,
  });

  it('records when a completed result stops being reusable', async () => {
    const complete = jest.fn(async () => null);
    const service = createService({ completeOpenIDRefreshFlight: complete });

    await service.completeOpenIDRefreshFlight({
      key: 'publication',
      ownerId: 'owner',
      tokens: { access_token: 'access', expires_at: 2_000_000_000 },
    });
    await service.completeOpenIDRefreshFlight({
      key: 'publication',
      ownerId: 'owner',
      tokens: { access_token: 'access' },
    });

    expect(complete).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ usableUntil: new Date(2_000_000_000_000 - 30_000) }),
    );
    expect(complete).toHaveBeenNthCalledWith(
      2,
      expect.not.objectContaining({ usableUntil: expect.anything() }),
    );
  });

  it('supersedes a spent result once the response delivering it lets go', async () => {
    const delivering = spent({
      deliveryId: 'delivery-1',
      deliveryExpiresAt: new Date(Date.now() + 30_000),
    });
    const acquire = jest
      .fn()
      .mockResolvedValueOnce({ acquired: false, flight: delivering })
      .mockResolvedValueOnce({ acquired: true, flight: { ownerId: 'owner-2', status: 'pending' } });
    const service = createService({ acquireOpenIDRefreshFlight: acquire });

    await expect(
      service.acquireOpenIDRefreshFlight({ key: 'publication', ownerId: 'owner-2' }),
    ).resolves.toMatchObject({ acquired: true, flight: { ownerId: 'owner-2' } });
    expect(acquire).toHaveBeenCalledTimes(2);
  });

  it.each<[string, RefreshFlightRecord]>([
    [
      'still usable',
      spent({ usable: { ownerId: 'owner-1', until: new Date(Date.now() + 60_000) } }),
    ],
    ['of unknown lifetime', spent({ usable: undefined })],
    ['replaced by an older replica', spent({ ownerId: 'owner-0' })],
    ['fenced by a logout', spent({ revocationRequestedAt: new Date() })],
    ['revoked', spent({ status: 'revoked' })],
    ['still pending', { status: 'pending', ownerId: 'owner-1' }],
  ])('returns at once when the flight is %s', async (_state, flight) => {
    const acquire = jest.fn(async () => ({ acquired: false, flight }));
    const service = createService({ acquireOpenIDRefreshFlight: acquire });

    await expect(
      service.acquireOpenIDRefreshFlight({ key: 'publication', ownerId: 'owner-2' }),
    ).resolves.toMatchObject({ acquired: false, flight });
    expect(acquire).toHaveBeenCalledTimes(1);
  });

  it('stops waiting on a delivery after one delivery lease', async () => {
    let clock = Date.now();
    jest.spyOn(Date, 'now').mockImplementation(() => clock);
    const acquire = jest.fn(async () => {
      clock += 10_000;
      return {
        acquired: false,
        flight: spent({ deliveryId: 'delivery-1', deliveryExpiresAt: new Date(clock + 60_000) }),
      };
    });
    const service = createService({ acquireOpenIDRefreshFlight: acquire });

    await expect(
      service.acquireOpenIDRefreshFlight({ key: 'publication', ownerId: 'owner-2' }),
    ).resolves.toMatchObject({ acquired: false });
    expect(acquire).toHaveBeenCalledTimes(4);
  });
});

describe('OpenID completion write boundary', () => {
  it.each([true, false])(
    'marks dispatch only after encryption (encryption fails: %s)',
    async (fails) => {
      const onWriteStart = jest.fn();
      const error = new Error('encryption failed');
      const complete = jest.fn(async () => {
        expect(onWriteStart).toHaveBeenCalledTimes(1);
        return null;
      });
      const service = createOpenIDRefreshFlightService({
        db: {
          acquireOpenIDRefreshFlight: jest.fn(),
          completeOpenIDRefreshFlight: complete,
          renewOpenIDRefreshFlight: jest.fn(),
          failOpenIDRefreshFlight: jest.fn(),
          revokeOpenIDRefreshFlight: jest.fn(),
          findOpenIDRefreshFlight: jest.fn(),
          claimOpenIDRefreshFlightDelivery: jest.fn(),
          releaseOpenIDRefreshFlightDelivery: jest.fn(),
        },
        logger: { warn: jest.fn() },
        encrypt: async () => {
          expect(onWriteStart).not.toHaveBeenCalled();
          if (fails) throw error;
          return 'encrypted';
        },
        decrypt: jest.fn(),
      });
      const result = service.completeOpenIDRefreshFlight({
        key: 'publication',
        ownerId: 'owner',
        tokens: { access_token: 'access' },
        onWriteStart,
      });
      if (fails) {
        await expect(result).rejects.toBe(error);
        expect(onWriteStart).not.toHaveBeenCalled();
        expect(complete).not.toHaveBeenCalled();
      } else {
        await expect(result).resolves.toBeNull();
        expect(complete).toHaveBeenCalledTimes(1);
      }
    },
  );
});
