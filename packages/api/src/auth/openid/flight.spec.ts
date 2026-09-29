import { createOpenIDRefreshFlightService } from './flight';

jest.mock('../../utils/identity', () => ({
  createOpenIDRefreshIdentityTuple: jest.fn(),
  serializeAuthIdentityTuple: jest.fn(),
}));

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
