import { AUTH_SESSION_CHECK_UNAVAILABLE } from 'librechat-data-provider';
import { OPENID_REFRESH_CANCELLED_BEFORE_GRANT, createOpenIDSessionEndedError } from './errors';
import { ProviderSessionUnavailableError } from './providerSession/errors';
import { respondToProviderSessionError } from './reuseSession';
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

describe('OpenID failed-flight waiters', () => {
  function createFlightStore() {
    let record: Record<string, unknown> | null = null;
    const service = createOpenIDRefreshFlightService({
      db: {
        acquireOpenIDRefreshFlight: jest.fn(),
        completeOpenIDRefreshFlight: jest.fn(),
        renewOpenIDRefreshFlight: jest.fn(),
        failOpenIDRefreshFlight: jest.fn(async ({ errorMessage }) => {
          record = { status: 'failed', ownerId: 'owner', errorMessage };
          return record;
        }),
        revokeOpenIDRefreshFlight: jest.fn(),
        findOpenIDRefreshFlight: jest.fn(async () => record),
        claimOpenIDRefreshFlightDelivery: jest.fn(),
        releaseOpenIDRefreshFlightDelivery: jest.fn(),
      },
      logger: { warn: jest.fn() },
      encrypt: jest.fn(),
      decrypt: jest.fn(),
    });
    return {
      service,
      setRecord: (value: Record<string, unknown>) => {
        record = value;
      },
    };
  }

  function respond(error: unknown): { status?: number; body?: unknown } {
    const response: { status?: number; body?: unknown } = {};
    const res = {
      status: (code: number) => {
        response.status = code;
        return {
          send: (body: unknown) => {
            response.body = body;
            return response;
          },
        };
      },
    };
    respondToProviderSessionError(res, error, { warn: jest.fn(), error: jest.fn() }, 'test');
    return response;
  }

  async function waiterError(service: ReturnType<typeof createFlightStore>['service']) {
    return service
      .waitForOpenIDRefreshFlight({ key: 'flight', timeoutMs: 1, intervalMs: 1 })
      .then(() => {
        throw new Error('waiter resolved');
      })
      .catch((error: unknown) => error);
  }

  it.each([
    ['provider session ended', () => createOpenIDSessionEndedError('denied'), 401],
    ['provider session check unavailable', () => new ProviderSessionUnavailableError(), 503],
  ])('gives a waiter the same response as the owner when the %s', async (_, ownerError, status) => {
    const { service } = createFlightStore();
    const error = ownerError();
    await service.failOpenIDRefreshFlight({ key: 'flight', ownerId: 'owner', error });

    const owner = respond(error);
    const waiter = respond(await waiterError(service));
    expect(owner.status).toBe(status);
    expect(waiter).toEqual(owner);
  });

  it('keeps a waiter signed in with a retryable 503 when the owner stopped before the grant', async () => {
    const { service } = createFlightStore();
    await service.failOpenIDRefreshFlight({
      key: 'flight',
      ownerId: 'owner',
      error: new Error(OPENID_REFRESH_CANCELLED_BEFORE_GRANT),
    });

    const error = await waiterError(service);
    expect(error).toMatchObject({ status: 503, retryable: true });
    expect(respond(error)).toEqual({
      status: 503,
      body: { code: AUTH_SESSION_CHECK_UNAVAILABLE },
    });
  });

  it.each(['invalid_grant', undefined])(
    'gives a waiter a plain error for a record without a code (message: %s)',
    async (errorMessage) => {
      const { service, setRecord } = createFlightStore();
      setRecord({ status: 'failed', ownerId: 'owner', errorMessage });

      const error = await waiterError(service);
      expect(error).toEqual(new Error(errorMessage ?? 'OpenID refresh failed in another worker'));
      expect(respond(error)).toEqual({});
    },
  );
});
