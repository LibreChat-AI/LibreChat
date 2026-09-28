jest.mock('@librechat/data-schemas', () => ({
  logger: {
    warn: jest.fn(),
  },
  encryptV2: jest.fn(async (value) => `encrypted:${value}`),
  decryptV2: jest.fn(async (value) => value.replace(/^encrypted:/, '')),
}));

jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  createOpenIDRefreshIdentityTuple: ({ user, requestUser }) => {
    const subject = user?.openidId || user?.id || requestUser?.openidId || requestUser?.id;
    if (!subject) {
      return null;
    }
    return {
      tenantId: user?.tenantId || requestUser?.tenantId || 'no-tenant',
      openidIssuer: user?.openidIssuer || requestUser?.openidIssuer || 'no-issuer',
      subject,
    };
  },
  serializeAuthIdentityTuple: ({ tenantId, openidIssuer, subject }) =>
    [tenantId, openidIssuer, subject].join('\x1f'),
}));

jest.mock('~/models', () => ({
  acquireOpenIDRefreshFlight: jest.fn(),
  claimOpenIDRefreshFlightDelivery: jest.fn(),
  completeOpenIDRefreshFlight: jest.fn(),
  failOpenIDRefreshFlight: jest.fn(),
  findOpenIDRefreshFlight: jest.fn(),
  revokeOpenIDRefreshFlight: jest.fn(),
  renewOpenIDRefreshFlight: jest.fn(),
  releaseOpenIDRefreshFlightDelivery: jest.fn(),
}));

const { encryptV2, decryptV2 } = require('@librechat/data-schemas');
const db = require('~/models');
const {
  acquireOpenIDRefreshFlight,
  assertOpenIDRefreshFlightAvailable,
  assertOpenIDRefreshFlightDeliveryAvailable,
  assertOpenIDRefreshSessionGenerationAvailable,
  claimOpenIDRefreshFlightDelivery,
  completeOpenIDRefreshFlight,
  createOpenIDRefreshFlightKey,
  failOpenIDRefreshFlight,
  renewOpenIDRefreshFlight,
  releaseOpenIDRefreshFlightDelivery,
  revokeOpenIDRefreshFlights,
  waitForOpenIDRefreshFlight,
  withOpenIDRefreshFlightLease,
  __internals,
} = require('./OpenIDRefreshFlight');

describe('OpenIDRefreshFlight', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.acquireOpenIDRefreshFlight.mockResolvedValue({ acquired: true, flight: null });
    db.claimOpenIDRefreshFlightDelivery.mockResolvedValue({
      status: 'completed',
      ownerId: 'owner-1',
      deliveryId: 'delivery-1',
    });
    db.completeOpenIDRefreshFlight.mockResolvedValue({});
    db.failOpenIDRefreshFlight.mockResolvedValue({});
    db.findOpenIDRefreshFlight.mockResolvedValue(null);
    db.renewOpenIDRefreshFlight.mockResolvedValue({ ownerId: 'owner-1', status: 'pending' });
    db.releaseOpenIDRefreshFlightDelivery.mockResolvedValue({ status: 'completed' });
    db.revokeOpenIDRefreshFlight.mockResolvedValue({ status: 'revoked' });
  });

  it('creates a stable hash key from session, user, issuer, tenant, and refresh token', () => {
    const req = {
      sessionID: 'session-1',
      user: { tenantId: 'tenant-1', openidIssuer: 'issuer-1' },
    };
    const user = { openidId: 'oidc-sub-1' };

    const keyA = createOpenIDRefreshFlightKey({ req, user, refreshToken: 'rt-old' });
    const keyB = createOpenIDRefreshFlightKey({ req, user, refreshToken: 'rt-old' });
    const keyC = createOpenIDRefreshFlightKey({ req, user, refreshToken: 'rt-other' });
    const keyFromNewSession = createOpenIDRefreshFlightKey({
      req: { ...req, sessionID: 'session-2' },
      user,
      refreshToken: 'rt-old',
    });

    expect(keyA).toBe(keyB);
    expect(keyA).toBe(keyFromNewSession);
    expect(keyA).not.toBe(keyC);
    expect(keyA).not.toContain('rt-old');
  });

  it('allows follower publication only while the completed flight remains available', async () => {
    db.findOpenIDRefreshFlight.mockResolvedValueOnce({ status: 'completed', ownerId: 'owner-1' });

    await expect(
      assertOpenIDRefreshFlightAvailable({ key: 'flight-key', ownerId: 'owner-1' }),
    ).resolves.toMatchObject({ status: 'completed' });

    db.findOpenIDRefreshFlight.mockResolvedValueOnce({ status: 'completed', ownerId: 'owner-2' });
    await expect(
      assertOpenIDRefreshFlightAvailable({ key: 'flight-key', ownerId: 'owner-1' }),
    ).rejects.toMatchObject({ code: 'OPENID_REFRESH_OWNERSHIP_LOST' });
  });

  it('rejects tombstoned or replaced session generations but permits expired records', async () => {
    db.findOpenIDRefreshFlight.mockResolvedValueOnce({ status: 'revoked', ownerId: 'owner-1' });
    await expect(
      assertOpenIDRefreshSessionGenerationAvailable({ key: 'flight-key', ownerId: 'owner-1' }),
    ).rejects.toMatchObject({ code: 'OPENID_REFRESH_OWNERSHIP_LOST' });

    db.findOpenIDRefreshFlight.mockResolvedValueOnce({ status: 'completed', ownerId: 'owner-2' });
    await expect(
      assertOpenIDRefreshSessionGenerationAvailable({ key: 'flight-key', ownerId: 'owner-1' }),
    ).rejects.toMatchObject({ code: 'OPENID_REFRESH_OWNERSHIP_LOST' });

    db.findOpenIDRefreshFlight.mockResolvedValueOnce(null);
    await expect(
      assertOpenIDRefreshSessionGenerationAvailable({ key: 'flight-key', ownerId: 'owner-1' }),
    ).resolves.toBe(true);
  });

  it('claims and releases a durable response-delivery lease for the exact generation', async () => {
    const createdAt = Date.now() - 1000;
    const claimed = await claimOpenIDRefreshFlightDelivery({
      key: 'flight-key',
      ownerId: 'owner-1',
      createdAt,
      deliveryId: 'delivery-1',
      ttl: 5000,
    });

    expect(claimed.deliveryId).toBe('delivery-1');
    expect(db.claimOpenIDRefreshFlightDelivery).toHaveBeenCalledWith({
      key: 'flight-key',
      ownerId: 'owner-1',
      deliveryId: 'delivery-1',
      deliveryExpiresAt: expect.any(Date),
      createdAt: new Date(createdAt),
    });

    await releaseOpenIDRefreshFlightDelivery({
      key: 'flight-key',
      ownerId: 'owner-1',
      deliveryId: 'delivery-1',
    });
    expect(db.releaseOpenIDRefreshFlightDelivery).toHaveBeenCalledWith({
      key: 'flight-key',
      ownerId: 'owner-1',
      deliveryId: 'delivery-1',
    });
  });

  it('retries an expired synthetic generation when its previous delivery releases between reads', async () => {
    db.claimOpenIDRefreshFlightDelivery.mockResolvedValueOnce(null).mockResolvedValueOnce({
      status: 'completed',
      ownerId: 'owner-1',
      deliveryId: 'delivery-2',
    });
    db.findOpenIDRefreshFlight.mockResolvedValueOnce(null);

    await expect(
      claimOpenIDRefreshFlightDelivery({
        key: 'flight-key',
        ownerId: 'owner-1',
        createdAt: Date.now() - 1000,
        deliveryId: 'delivery-2',
        ttl: 1000,
      }),
    ).resolves.toMatchObject({ deliveryId: 'delivery-2' });
    expect(db.claimOpenIDRefreshFlightDelivery).toHaveBeenCalledTimes(2);
  });

  it('authorizes only the active, unrevoked response-delivery lease', async () => {
    db.findOpenIDRefreshFlight.mockResolvedValueOnce({
      status: 'completed',
      ownerId: 'owner-1',
      deliveryId: 'delivery-1',
      deliveryExpiresAt: new Date(Date.now() + 5000),
    });
    await expect(
      assertOpenIDRefreshFlightDeliveryAvailable({
        key: 'flight-key',
        ownerId: 'owner-1',
        deliveryId: 'delivery-1',
      }),
    ).resolves.toBeUndefined();

    db.findOpenIDRefreshFlight.mockResolvedValueOnce({
      status: 'completed',
      ownerId: 'owner-1',
      deliveryId: 'delivery-1',
      deliveryExpiresAt: new Date(Date.now() + 5000),
      revocationRequestedAt: new Date(),
    });
    await expect(
      assertOpenIDRefreshFlightDeliveryAvailable({
        key: 'flight-key',
        ownerId: 'owner-1',
        deliveryId: 'delivery-1',
      }),
    ).rejects.toMatchObject({ code: 'OPENID_REFRESH_OWNERSHIP_LOST' });
  });

  it('uses explicit identity context when safe user lacks tenant and issuer', () => {
    const req = {
      sessionID: 'session-1',
      user: { id: 'safe-user' },
    };
    const user = { id: 'safe-user' };

    const keyA = createOpenIDRefreshFlightKey({
      req,
      user,
      refreshToken: 'rt-old',
      identityContext: {
        openidSubject: 'oidc-sub-1',
        tenantId: 'tenant-a',
        openidIssuer: 'https://issuer-a.example.com',
      },
    });
    const keyB = createOpenIDRefreshFlightKey({
      req,
      user,
      refreshToken: 'rt-old',
      identityContext: {
        openidSubject: 'oidc-sub-1',
        tenantId: 'tenant-b',
        openidIssuer: 'https://issuer-a.example.com',
      },
    });

    expect(keyA).not.toBe(keyB);
  });

  it('returns null key when identity or refresh token is unavailable', () => {
    expect(createOpenIDRefreshFlightKey({ req: {}, user: {}, refreshToken: 'rt' })).toBeNull();
    expect(
      createOpenIDRefreshFlightKey({
        req: { user: { id: 'user-1' } },
        user: undefined,
        refreshToken: undefined,
      }),
    ).toBeNull();
  });

  it('acquires a Mongo flight with owner and expiry metadata', async () => {
    const result = await acquireOpenIDRefreshFlight({
      key: 'flight-key',
      ownerId: 'owner-1',
      ttl: 60000,
      lockTtl: 30000,
    });

    expect(result.acquired).toBe(true);
    expect(result.key).toBe('flight-key');
    expect(result.ownerId).toBe('owner-1');
    expect(db.acquireOpenIDRefreshFlight).toHaveBeenCalledWith({
      key: 'flight-key',
      ownerId: 'owner-1',
      lockExpiresAt: expect.any(Date),
      expiresAt: expect.any(Date),
    });
  });

  it('renews only the owning pending flight lease', async () => {
    await renewOpenIDRefreshFlight({
      key: 'flight-key',
      ownerId: 'owner-1',
      lockTtl: 30000,
      ttl: 60000,
    });

    expect(db.renewOpenIDRefreshFlight).toHaveBeenCalledWith({
      key: 'flight-key',
      ownerId: 'owner-1',
      lockExpiresAt: expect.any(Date),
      expiresAt: expect.any(Date),
    });
  });

  it('keeps renewing a leader lease until its refresh operation settles', async () => {
    jest.useFakeTimers();
    let resolveOperation;
    const operation = jest.fn(
      () =>
        new Promise((resolve) => {
          resolveOperation = resolve;
        }),
    );

    try {
      const resultPromise = withOpenIDRefreshFlightLease({
        key: 'flight-key',
        ownerId: 'owner-1',
        heartbeatInterval: 1000,
        lockTtl: 30000,
        ttl: 60000,
        operation,
      });

      await jest.advanceTimersByTimeAsync(1000);
      expect(db.renewOpenIDRefreshFlight).toHaveBeenCalledTimes(1);

      resolveOperation('tokens');
      await expect(resultPromise).resolves.toBe('tokens');

      await jest.advanceTimersByTimeAsync(2000);
      expect(db.renewOpenIDRefreshFlight).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('rejects a stale owner after the heartbeat observes lease loss', async () => {
    jest.useFakeTimers();
    db.renewOpenIDRefreshFlight.mockResolvedValueOnce(null);
    let finishOperation;
    const operation = jest.fn(
      () =>
        new Promise((resolve) => {
          finishOperation = resolve;
        }),
    );

    try {
      const resultPromise = withOpenIDRefreshFlightLease({
        key: 'flight-key',
        ownerId: 'owner-1',
        heartbeatInterval: 1000,
        operation,
      });

      await jest.advanceTimersByTimeAsync(1000);
      finishOperation('tokens');
      await expect(resultPromise).rejects.toThrow('ownership was lost');
    } finally {
      jest.useRealTimers();
    }
  });

  it("does not treat the owner's completed flight as heartbeat lease loss", async () => {
    jest.useFakeTimers();
    db.renewOpenIDRefreshFlight.mockResolvedValueOnce(null);
    db.findOpenIDRefreshFlight.mockResolvedValueOnce({
      ownerId: 'owner-1',
      status: 'completed',
    });
    let finishOperation;
    const operation = jest.fn(
      () =>
        new Promise((resolve) => {
          finishOperation = resolve;
        }),
    );

    try {
      const resultPromise = withOpenIDRefreshFlightLease({
        key: 'flight-key',
        ownerId: 'owner-1',
        heartbeatInterval: 1000,
        operation,
      });

      await jest.advanceTimersByTimeAsync(1000);
      finishOperation('tokens');
      await expect(resultPromise).resolves.toBe('tokens');
      expect(db.findOpenIDRefreshFlight).toHaveBeenCalledWith({ key: 'flight-key' });
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not let a trailing renewal failure replace a completed result', async () => {
    jest.useFakeTimers();
    let rejectRenewal;
    db.renewOpenIDRefreshFlight.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectRenewal = reject;
      }),
    );
    let finishOperation;
    const operation = jest.fn(
      ({ markLeaseSettled }) =>
        new Promise((resolve) => {
          finishOperation = (value) => {
            markLeaseSettled();
            resolve(value);
          };
        }),
    );

    try {
      const resultPromise = withOpenIDRefreshFlightLease({
        key: 'flight-key',
        ownerId: 'owner-1',
        heartbeatInterval: 1000,
        operation,
      });

      /** Heartbeat issues a renewal that is still in flight when the operation finishes. */
      await jest.advanceTimersByTimeAsync(1000);
      finishOperation('tokens');
      rejectRenewal(new Error('connection timed out'));

      await expect(resultPromise).resolves.toBe('tokens');
    } finally {
      jest.useRealTimers();
    }
  });

  it('encrypts completed token results before storing them', async () => {
    const tokens = {
      access_token: 'access',
      id_token: 'id',
      refresh_token: 'refresh',
      expires_at: 123,
      appAuthToken: 'app-auth-token',
      __identityClaims: { sub: 'user-123', iss: 'https://issuer.example.com' },
    };

    await completeOpenIDRefreshFlight({
      key: 'flight-key',
      ownerId: 'owner-1',
      tokens,
      ttl: 60000,
    });

    expect(encryptV2).toHaveBeenCalledWith(JSON.stringify(tokens));
    expect(db.completeOpenIDRefreshFlight).toHaveBeenCalledWith({
      key: 'flight-key',
      ownerId: 'owner-1',
      encryptedResult: `encrypted:${JSON.stringify(tokens)}`,
      expiresAt: expect.any(Date),
    });
  });

  it('expires a completed flight at the access token usable-lifetime boundary', async () => {
    const now = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(now);
    const tokens = {
      access_token: 'short-access',
      expires_at: Math.floor(now / 1000) + 45,
    };

    await completeOpenIDRefreshFlight({
      key: 'flight-key',
      ownerId: 'owner-1',
      tokens,
      ttl: 60000,
    });

    const storedExpiry = db.completeOpenIDRefreshFlight.mock.calls[0][0].expiresAt;
    expect(storedExpiry.getTime()).toBeLessThanOrEqual(now + 15_000);
    expect(storedExpiry.getTime()).toBeGreaterThan(now);
    Date.now.mockRestore();
  });

  it('preserves non-enumerable publication metadata for shared flight joiners', async () => {
    const tokens = {
      access_token: 'access',
      refresh_token: 'refresh',
      expires_at: 123,
    };
    Object.defineProperty(tokens, '__browserRefreshToken', {
      value: 'browser-refresh',
      enumerable: false,
    });
    Object.defineProperty(tokens, '__predecessorRefreshToken', {
      value: 'predecessor-refresh',
      enumerable: false,
    });
    Object.defineProperty(tokens, '__predecessorAccessToken', {
      value: 'predecessor-access',
      enumerable: false,
    });
    Object.defineProperty(tokens, '__deferredPublication', {
      value: true,
      enumerable: false,
    });

    await completeOpenIDRefreshFlight({
      key: 'flight-key',
      ownerId: 'owner-1',
      tokens,
      ttl: 60000,
    });

    const serializedTokens = JSON.parse(encryptV2.mock.calls[0][0]);
    expect(serializedTokens.__browserRefreshToken).toBe('browser-refresh');
    expect(serializedTokens.__predecessorRefreshToken).toBe('predecessor-refresh');
    expect(serializedTokens.__predecessorAccessToken).toBe('predecessor-access');
    expect(serializedTokens.__deferredPublication).toBe(true);
    expect(Object.keys(tokens)).not.toContain('__browserRefreshToken');
  });

  it('marks a flight failed with a non-sensitive message', async () => {
    await failOpenIDRefreshFlight({
      key: 'flight-key',
      ownerId: 'owner-1',
      error: new Error('invalid_grant'),
      ttl: 60000,
    });

    expect(db.failOpenIDRefreshFlight).toHaveBeenCalledWith({
      key: 'flight-key',
      ownerId: 'owner-1',
      errorMessage: 'invalid_grant',
      expiresAt: expect.any(Date),
    });
  });

  it('persists logout revocation fences for every distinct flight key', async () => {
    await revokeOpenIDRefreshFlights({
      keys: ['flight-a', 'flight-b', 'flight-a', null],
      ttl: 60000,
    });

    expect(db.revokeOpenIDRefreshFlight).toHaveBeenCalledTimes(2);
    expect(db.revokeOpenIDRefreshFlight).toHaveBeenCalledWith({
      key: 'flight-a',
      expiresAt: expect.any(Date),
    });
    expect(db.revokeOpenIDRefreshFlight).toHaveBeenCalledWith({
      key: 'flight-b',
      expiresAt: expect.any(Date),
    });
  });

  it('returns the retained successor from a completed flight during revocation', async () => {
    const result = {
      tokenset: { access_token: 'access', refresh_token: 'successor' },
      claims: { sub: 'subject' },
      appAuthToken: 'app-token',
    };
    db.revokeOpenIDRefreshFlight.mockResolvedValueOnce({
      status: 'revoked',
      encryptedResult: `encrypted:${JSON.stringify(result)}`,
    });

    await expect(revokeOpenIDRefreshFlights({ keys: ['flight-a'] })).resolves.toEqual([result]);
  });

  it('waits for and decrypts a completed flight result', async () => {
    const tokens = {
      access_token: 'access',
      refresh_token: 'refresh',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    };
    db.findOpenIDRefreshFlight.mockResolvedValueOnce({
      status: 'completed',
      encryptedResult: `encrypted:${JSON.stringify(tokens)}`,
    });

    const result = await waitForOpenIDRefreshFlight({
      key: 'flight-key',
      timeoutMs: 1,
      intervalMs: 1,
    });

    expect(decryptV2).toHaveBeenCalledWith(`encrypted:${JSON.stringify(tokens)}`);
    expect(result).toEqual(tokens);
  });

  it('waits for validated publication instead of returning deferred credentials', async () => {
    db.findOpenIDRefreshFlight
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ status: 'pending' })
      .mockResolvedValueOnce({
        status: 'completed',
        ownerId: 'owner-1',
        encryptedResult: 'encrypted:{"access_token":"unpublished","__deferredPublication":true}',
      })
      .mockResolvedValueOnce({
        status: 'completed',
        ownerId: 'owner-1',
        encryptedResult: 'encrypted:{"access_token":"published"}',
      });
    await expect(
      waitForOpenIDRefreshFlight({
        key: 'flight-key',
        requirePublication: true,
        timeoutMs: 1000,
        intervalMs: 1,
      }),
    ).resolves.toEqual({ access_token: 'published' });
    expect(db.findOpenIDRefreshFlight).toHaveBeenCalledTimes(4);
  });

  it.each(['before-read', 'during-read', 'during-delay'])(
    'cancels publication polling %s without another database read',
    async (phase) => {
      const controller = new AbortController();
      const reason = new Error('request stopped');
      let finishRead;
      db.findOpenIDRefreshFlight.mockImplementation(
        () =>
          new Promise((resolve) => {
            finishRead = resolve;
          }),
      );
      if (phase === 'before-read') controller.abort(reason);
      const waiting = waitForOpenIDRefreshFlight({
        key: 'publication-key',
        requirePublication: true,
        timeoutMs: 10000,
        intervalMs: 5000,
        signal: controller.signal,
      });
      const outcome = waiting.then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      if (phase !== 'before-read') {
        if (phase === 'during-read') controller.abort(reason);
        finishRead(null);
        await new Promise((resolve) => setImmediate(resolve));
        if (phase === 'during-delay') controller.abort(reason);
      }
      await expect(outcome).resolves.toEqual({ error: reason });
      expect(db.findOpenIDRefreshFlight).toHaveBeenCalledTimes(phase === 'before-read' ? 0 : 1);
    },
  );

  it('bounds the publication wait without returning an unvalidated result', async () => {
    db.findOpenIDRefreshFlight.mockResolvedValue({
      status: 'completed',
      ownerId: 'owner-1',
      expiresAt: new Date(Date.now() + 60000),
      encryptedResult: 'encrypted:{"access_token":"unpublished","__deferredPublication":true}',
    });
    await expect(
      waitForOpenIDRefreshFlight({
        key: 'flight-key',
        requirePublication: true,
        timeoutMs: 5,
        intervalMs: 1,
      }),
    ).resolves.toBeNull();
  });

  it('keeps cross-worker pre-grant cancellation retryable rather than requiring sign-in', async () => {
    db.findOpenIDRefreshFlight.mockResolvedValueOnce({
      status: 'failed',
      errorMessage: 'OPENID_REFRESH_CANCELLED_BEFORE_GRANT',
    });
    await expect(waitForOpenIDRefreshFlight({ key: 'flight-key' })).rejects.toMatchObject({
      status: 503,
      retryable: true,
    });
  });

  it('throws when another worker records a failed flight', async () => {
    db.findOpenIDRefreshFlight.mockResolvedValueOnce({
      status: 'failed',
      errorMessage: 'invalid_grant',
    });

    await expect(
      waitForOpenIDRefreshFlight({ key: 'flight-key', timeoutMs: 1, intervalMs: 1 }),
    ).rejects.toThrow('invalid_grant');
  });

  it('throws when logout revokes the flight', async () => {
    db.findOpenIDRefreshFlight.mockResolvedValueOnce({
      status: 'revoked',
      errorMessage: 'OpenID refresh was revoked by logout',
    });

    await expect(
      waitForOpenIDRefreshFlight({ key: 'flight-key', timeoutMs: 1, intervalMs: 1 }),
    ).rejects.toThrow('revoked by logout');
  });

  it('waits for the full renewable-flight lifetime by default', () => {
    expect(__internals.DEFAULT_WAIT_TIMEOUT_MS).toBe(__internals.DEFAULT_FLIGHT_TTL_MS);
    expect(__internals.DEFAULT_WAIT_TIMEOUT_MS).toBeGreaterThan(__internals.DEFAULT_LOCK_TTL_MS);
    const initialDeadline = Date.now() + __internals.DEFAULT_WAIT_TIMEOUT_MS;
    const renewedExpiry = new Date(initialDeadline + 60_000);
    expect(__internals.getRenewedWaitDeadline(initialDeadline, { expiresAt: renewedExpiry })).toBe(
      renewedExpiry.getTime(),
    );
  });

  it('does not reuse a completed result inside the access-token expiry buffer', async () => {
    const tokens = {
      access_token: 'near-expiry',
      expires_at: Math.floor(Date.now() / 1000) + 10,
    };
    await expect(
      __internals.readCompletedFlight({
        status: 'completed',
        encryptedResult: `encrypted:${JSON.stringify(tokens)}`,
      }),
    ).resolves.toBeNull();
  });

  it('exposes completed-flight parsing for focused tests', async () => {
    const tokens = { access_token: 'access' };
    await expect(
      __internals.readCompletedFlight({
        status: 'completed',
        encryptedResult: `encrypted:${JSON.stringify(tokens)}`,
      }),
    ).resolves.toEqual(tokens);
  });

  it('restores publication metadata as non-enumerable', async () => {
    const createdAt = new Date('2026-08-29T12:00:00.000Z');
    const result = await __internals.readCompletedFlight({
      status: 'completed',
      ownerId: 'generation-owner',
      createdAt,
      encryptedResult:
        'encrypted:{"access_token":"access","__browserRefreshToken":"browser-refresh","__predecessorRefreshToken":"predecessor-refresh","__predecessorAccessToken":"predecessor-access","__deferredPublication":true}',
    });

    expect(result.__browserRefreshToken).toBe('browser-refresh');
    expect(result.__predecessorRefreshToken).toBe('predecessor-refresh');
    expect(result.__predecessorAccessToken).toBe('predecessor-access');
    expect(result.__deferredPublication).toBe(true);
    expect(result.__flightOwnerId).toBe('generation-owner');
    expect(result.__flightCreatedAt).toBe(createdAt.getTime());
    expect(Object.keys(result)).toEqual(['access_token']);
  });
});
