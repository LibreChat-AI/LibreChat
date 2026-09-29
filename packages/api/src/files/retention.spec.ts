import { RetentionMode } from 'librechat-data-provider';
import { createChatExpirationDate } from '@librechat/data-schemas';
import {
  createMinimalRetentionRequest,
  getAgentFileRetentionExpiry,
  getConversationExpirationDate,
  getRetentionExpiry,
  getSharedLinkExpiration,
  isActiveExpirationDate,
  isBooleanOrStringTrue,
  type RetentionDependencies,
  type RetentionRequest,
} from './retention';

describe('retention helpers', () => {
  const expirationDate = new Date('2030-01-01T00:00:00.000Z');
  let dependencies: jest.Mocked<RetentionDependencies>;

  beforeEach(() => {
    dependencies = {
      getConvo: jest.fn(),
      createExpirationDate: jest.fn().mockReturnValue(expirationDate),
      logger: {
        error: jest.fn(),
      },
    };
  });

  const request = (overrides: RetentionRequest = {}): RetentionRequest => ({
    user: {
      id: 'user-1',
      tenantId: 'tenant-1',
      ...overrides.user,
    },
    body: {
      conversationId: 'convo-1',
      ...overrides.body,
    },
    config: {
      interfaceConfig: {
        ...overrides.config?.interfaceConfig,
      },
    },
  });

  it('returns expiry when retentionMode is ALL', async () => {
    const result = await getRetentionExpiry(
      request({ config: { interfaceConfig: { retentionMode: RetentionMode.ALL } } }),
      dependencies,
    );

    expect(result).toEqual({ expiredAt: expirationDate });
    expect(dependencies.getConvo).not.toHaveBeenCalled();
  });

  it('preserves a loaded message deadline across file request reconstruction without a read', async () => {
    const req = request({
      body: { isTemporary: false },
      config: { interfaceConfig: { retentionMode: RetentionMode.ALL } },
    });
    req.fileRetentionSource = { isTemporary: true, expiredAt: expirationDate };
    const result = await getRetentionExpiry(createMinimalRetentionRequest(req), dependencies);
    expect(result).toEqual({ expiredAt: expirationDate });
    expect(dependencies.getConvo).not.toHaveBeenCalled();
    expect(dependencies.createExpirationDate).not.toHaveBeenCalled();
  });

  it('uses loaded message type when a legacy row lacks a deadline', async () => {
    const req = request({
      body: { isTemporary: false },
      config: { interfaceConfig: { retentionMode: RetentionMode.ALL } },
    });
    req.fileRetentionSource = { isTemporary: true };
    await getRetentionExpiry(req, dependencies);
    expect(dependencies.getConvo).not.toHaveBeenCalled();
    expect(dependencies.createExpirationDate).toHaveBeenCalledWith(
      req.config?.interfaceConfig,
      true,
    );
  });

  describe('independent retention periods', () => {
    const interfaceConfig = {
      retentionMode: RetentionMode.ALL,
      temporaryChatRetention: 1,
      generalChatRetention: 2160,
    };

    beforeEach(() => {
      dependencies.createExpirationDate.mockImplementation(createChatExpirationDate);
    });

    it.each([true, 'true', false, 'false'])(
      'uses explicit temporary intent %s when the conversation does not exist yet',
      async (isTemporary) => {
        dependencies.getConvo.mockResolvedValue(null);
        const now = Date.now();
        const result = await getRetentionExpiry(
          request({ body: { isTemporary }, config: { interfaceConfig } }),
          dependencies,
        );
        const hours = isTemporary === true || isTemporary === 'true' ? 1 : 2160;
        expect(result.expiredAt?.getTime()).toBeGreaterThanOrEqual(now + hours * 3600000);
        expect(result.expiredAt?.getTime()).toBeLessThan(now + hours * 3600000 + 1000);
        expect(dependencies.getConvo).toHaveBeenCalledWith('user-1', 'convo-1');
      },
    );

    it.each([
      { supplied: false, stored: true, hours: 1 },
      { supplied: true, stored: false, hours: 2160 },
      { supplied: true, stored: false, hours: 2160, expiredAt: null },
    ])(
      'uses stored chat type $stored instead of caller-supplied type $supplied',
      async ({ supplied, stored, hours, expiredAt }) => {
        dependencies.getConvo.mockResolvedValue({
          isTemporary: stored,
          expiredAt: expiredAt === null ? null : expirationDate,
        });
        const now = Date.now();
        const result = await getRetentionExpiry(
          request({ body: { isTemporary: supplied }, config: { interfaceConfig } }),
          dependencies,
        );

        expect(result.expiredAt?.getTime()).toBeGreaterThanOrEqual(now + hours * 3600000);
        expect(result.expiredAt?.getTime()).toBeLessThan(now + hours * 3600000 + 1000);
        expect(dependencies.getConvo).toHaveBeenCalledWith('user-1', 'convo-1');
      },
    );

    it.each([true, false])(
      'uses the stored chat type %s when omitted and caches the lookup',
      async (isTemporary) => {
        dependencies.getConvo.mockResolvedValue({ isTemporary, expiredAt: expirationDate });
        const req = request({ config: { interfaceConfig } });
        const now = Date.now();
        const result = await getRetentionExpiry(req, dependencies);
        const hours = isTemporary ? 1 : 2160;
        expect(result.expiredAt?.getTime()).toBeGreaterThanOrEqual(now + hours * 3600000);
        expect(result.expiredAt?.getTime()).toBeLessThan(now + hours * 3600000 + 1000);
        expect(await getRetentionExpiry(req, dependencies)).toBe(result);
        expect(dependencies.getConvo).toHaveBeenCalledTimes(1);
      },
    );

    it.each([true, false])('uses the source chat type %s for shared links', async (isTemporary) => {
      dependencies.getConvo.mockResolvedValue({ isTemporary, expiredAt: expirationDate });
      const now = Date.now();
      const result = await getSharedLinkExpiration(
        { req: request({ config: { interfaceConfig } }), conversationId: 'convo-1' },
        dependencies,
      );
      const hours = isTemporary ? 1 : 2160;
      expect(result?.getTime()).toBeGreaterThanOrEqual(now + hours * 3600000);
      expect(result?.getTime()).toBeLessThan(now + hours * 3600000 + 1000);
    });
  });

  it('returns a fresh expiry when the conversation has an active expiration', async () => {
    dependencies.getConvo.mockResolvedValue({
      expiredAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    const result = await getRetentionExpiry(request(), dependencies);

    expect(result).toEqual({ expiredAt: expirationDate });
  });

  it('returns the conversation expiration when the conversation is already expired', async () => {
    const expiredAt = new Date(Date.now() - 60 * 60 * 1000);
    dependencies.getConvo.mockResolvedValue({ expiredAt });

    const result = await getRetentionExpiry(request(), dependencies);

    expect(result).toEqual({ expiredAt });
    expect(dependencies.createExpirationDate).not.toHaveBeenCalled();
  });

  it('returns no retention fields when the conversation has no expiration', async () => {
    dependencies.getConvo.mockResolvedValue({ expiredAt: null });

    await expect(getRetentionExpiry(request(), dependencies)).resolves.toEqual({});
  });

  it('returns expiry when the conversation has no expiration but explicit temporary intent is present', async () => {
    dependencies.getConvo.mockResolvedValue({ expiredAt: null });

    const result = await getRetentionExpiry(
      request({ body: { conversationId: 'convo-1', isTemporary: true } }),
      dependencies,
    );

    expect(result).toEqual({ expiredAt: expirationDate });
  });

  it('returns no retention fields when conversation is missing and isTemporary is false', async () => {
    dependencies.getConvo.mockResolvedValue(null);

    const result = await getRetentionExpiry(
      request({ body: { conversationId: 'convo-1', isTemporary: false } }),
      dependencies,
    );

    expect(result).toEqual({});
  });

  it('uses temporary retention when an all-data lookup cannot determine the chat type', async () => {
    dependencies.getConvo.mockRejectedValue(new Error('offline'));

    await getRetentionExpiry(
      request({
        config: {
          interfaceConfig: {
            retentionMode: RetentionMode.ALL,
            temporaryChatRetention: 1,
            generalChatRetention: 2160,
          },
        },
      }),
      dependencies,
    );

    expect(dependencies.createExpirationDate).toHaveBeenCalledWith(expect.any(Object), true);
    expect(dependencies.createExpirationDate).toHaveBeenCalledWith(expect.any(Object), false);
  });

  it('uses the shorter configured period when an all-data lookup fails', async () => {
    dependencies.getConvo.mockRejectedValue(new Error('offline'));
    dependencies.createExpirationDate.mockImplementation(createChatExpirationDate);
    const now = Date.now();

    const result = await getRetentionExpiry(
      request({
        config: {
          interfaceConfig: {
            retentionMode: RetentionMode.ALL,
            temporaryChatRetention: 8760,
            generalChatRetention: 1,
          },
        },
      }),
      dependencies,
    );

    expect(result.expiredAt?.getTime()).toBeGreaterThanOrEqual(now + 3600000);
    expect(result.expiredAt?.getTime()).toBeLessThan(now + 3601000);
  });

  it('returns expiry when isTemporary is true', async () => {
    dependencies.getConvo.mockResolvedValue(null);

    const result = await getRetentionExpiry(
      request({ body: { conversationId: 'convo-1', isTemporary: true } }),
      dependencies,
    );

    expect(result).toEqual({ expiredAt: expirationDate });
  });

  it('returns expiry when isTemporary is the string "true"', async () => {
    dependencies.getConvo.mockResolvedValue(null);

    const result = await getRetentionExpiry(
      request({ body: { conversationId: 'convo-1', isTemporary: 'true' } }),
      dependencies,
    );

    expect(result).toEqual({ expiredAt: expirationDate });
  });

  it('returns no retention fields when conversation lookup throws without explicit temporary intent', async () => {
    const error = new Error('database unavailable');
    dependencies.getConvo.mockRejectedValue(error);

    const result = await getRetentionExpiry(request(), dependencies);

    expect(result).toEqual({});
    expect(dependencies.logger?.error).toHaveBeenCalledWith(
      '[getRetentionExpiry] Error checking conversation retention:',
      error,
    );
  });

  it('applies retention when explicit temporary intent is present and conversation lookup throws', async () => {
    const error = new Error('database unavailable');
    dependencies.getConvo.mockRejectedValue(error);

    const result = await getRetentionExpiry(
      request({ body: { conversationId: 'convo-1', isTemporary: true } }),
      dependencies,
    );

    expect(result).toEqual({ expiredAt: expirationDate });
    expect(dependencies.logger?.error).toHaveBeenCalledWith(
      '[getRetentionExpiry] Error checking conversation retention:',
      error,
    );
  });

  it('returns a fallback expiration when expiration creation throws', async () => {
    const error = new Error('bad config');
    const nowSpy = jest
      .spyOn(Date, 'now')
      .mockReturnValue(new Date('2026-01-01T00:00:00.000Z').getTime());
    dependencies.createExpirationDate.mockImplementation(() => {
      throw error;
    });

    const result = await getRetentionExpiry(
      request({ body: { conversationId: undefined, isTemporary: true } }),
      dependencies,
    );

    expect(result).toEqual({ expiredAt: new Date('2026-01-31T00:00:00.000Z') });
    expect(dependencies.logger?.error).toHaveBeenCalledWith(
      '[getRetentionExpiry] Error creating file expiration date:',
      error,
    );
    nowSpy.mockRestore();
  });

  it('memoizes retention lookup per request object', async () => {
    dependencies.getConvo.mockResolvedValue({
      expiredAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    const req = request();

    const first = await getRetentionExpiry(req, dependencies);
    const second = await getRetentionExpiry(req, dependencies);

    expect(first).toEqual({ expiredAt: expirationDate });
    expect(second).toEqual({ expiredAt: expirationDate });
    expect(dependencies.getConvo).toHaveBeenCalledTimes(1);
  });

  it('returns no retention fields when req is null or undefined', async () => {
    await expect(getRetentionExpiry(null, dependencies)).resolves.toEqual({});
    await expect(getRetentionExpiry(undefined, dependencies)).resolves.toEqual({});
  });

  it('skips persistent agent files in temporary retention mode when retainAgentFiles is disabled', async () => {
    const result = await getAgentFileRetentionExpiry(
      {
        req: request({
          config: {
            interfaceConfig: {
              retentionMode: RetentionMode.TEMPORARY,
              retainAgentFiles: false,
            },
          },
        }),
        messageAttachment: false,
        toolResource: 'context',
      },
      dependencies,
    );

    expect(result).toEqual({});
    expect(dependencies.getConvo).not.toHaveBeenCalled();
    expect(dependencies.createExpirationDate).not.toHaveBeenCalled();
  });

  it('skips persistent agent files in temporary retention mode when retainAgentFiles is enabled', async () => {
    const result = await getAgentFileRetentionExpiry(
      {
        req: request({
          config: {
            interfaceConfig: {
              retentionMode: RetentionMode.TEMPORARY,
              retainAgentFiles: true,
            },
          },
        }),
        messageAttachment: false,
        toolResource: 'context',
      },
      dependencies,
    );

    expect(result).toEqual({});
    expect(dependencies.getConvo).not.toHaveBeenCalled();
    expect(dependencies.createExpirationDate).not.toHaveBeenCalled();
  });

  it('applies all-data retention to persistent agent files when retainAgentFiles is disabled', async () => {
    const result = await getAgentFileRetentionExpiry(
      {
        req: request({
          config: {
            interfaceConfig: {
              retentionMode: RetentionMode.ALL,
              retainAgentFiles: false,
            },
          },
        }),
        messageAttachment: false,
        toolResource: 'context',
      },
      dependencies,
    );

    expect(result).toEqual({ expiredAt: expirationDate });
    expect(dependencies.getConvo).not.toHaveBeenCalled();
    expect(dependencies.createExpirationDate).toHaveBeenCalledTimes(1);
  });

  it('keeps current all-data retention behavior when retainAgentFiles is unset', async () => {
    const result = await getAgentFileRetentionExpiry(
      {
        req: request({ config: { interfaceConfig: { retentionMode: RetentionMode.ALL } } }),
        messageAttachment: false,
        toolResource: 'context',
      },
      dependencies,
    );

    expect(result).toEqual({ expiredAt: expirationDate });
    expect(dependencies.createExpirationDate).toHaveBeenCalledTimes(1);
  });

  it('skips all-data retention for persistent agent files when retainAgentFiles is enabled', async () => {
    const result = await getAgentFileRetentionExpiry(
      {
        req: request({
          config: {
            interfaceConfig: {
              retentionMode: RetentionMode.ALL,
              retainAgentFiles: true,
            },
          },
        }),
        messageAttachment: false,
        toolResource: 'context',
      },
      dependencies,
    );

    expect(result).toEqual({});
    expect(dependencies.getConvo).not.toHaveBeenCalled();
    expect(dependencies.createExpirationDate).not.toHaveBeenCalled();
  });

  it('still applies all-data retention to agent message attachments when retainAgentFiles is enabled', async () => {
    const result = await getAgentFileRetentionExpiry(
      {
        req: request({
          config: {
            interfaceConfig: {
              retentionMode: RetentionMode.ALL,
              retainAgentFiles: true,
            },
          },
        }),
        messageAttachment: true,
        toolResource: 'context',
      },
      dependencies,
    );

    expect(result).toEqual({ expiredAt: expirationDate });
    expect(dependencies.createExpirationDate).toHaveBeenCalledTimes(1);
  });

  it('parses valid conversation expiration dates and ignores invalid ones', () => {
    expect(getConversationExpirationDate({ expiredAt: expirationDate })).toBe(expirationDate);
    expect(getConversationExpirationDate({ expiredAt: expirationDate.toISOString() })).toEqual(
      expirationDate,
    );
    expect(getConversationExpirationDate({ expiredAt: 'not-a-date' })).toBeNull();
    expect(getConversationExpirationDate({ expiredAt: null })).toBeNull();
  });

  it('compares active expiration dates against the provided clock', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');

    expect(isActiveExpirationDate(new Date('2026-01-01T00:00:01.000Z'), now)).toBe(true);
    expect(isActiveExpirationDate(new Date('2025-12-31T23:59:59.000Z'), now)).toBe(false);
  });

  it('uses strict temporary truthiness semantics', () => {
    expect(isBooleanOrStringTrue(true)).toBe(true);
    expect(isBooleanOrStringTrue('true')).toBe(true);
    expect(isBooleanOrStringTrue(1)).toBe(false);
    expect(isBooleanOrStringTrue('1')).toBe(false);
  });

  it('creates minimal retention requests for tool calls', () => {
    expect(
      createMinimalRetentionRequest({
        user: { id: 'user-1', tenantId: 'tenant-1' },
        body: { conversationId: 'convo-1', isTemporary: 'true' },
        config: { interfaceConfig: { retentionMode: RetentionMode.TEMPORARY } },
      }),
    ).toEqual({
      user: { id: 'user-1', tenantId: 'tenant-1' },
      body: { conversationId: 'convo-1', isTemporary: 'true' },
      config: { interfaceConfig: { retentionMode: RetentionMode.TEMPORARY } },
    });

    expect(createMinimalRetentionRequest()).toBeUndefined();
  });

  describe('getSharedLinkExpiration', () => {
    it('returns undefined when the conversation id is missing', async () => {
      await expect(
        getSharedLinkExpiration({ req: request() }, dependencies),
      ).resolves.toBeUndefined();
      expect(dependencies.getConvo).not.toHaveBeenCalled();
    });

    it('returns null for non-retained conversations in temporary retention mode', async () => {
      dependencies.getConvo.mockResolvedValue({ expiredAt: null });

      await expect(
        getSharedLinkExpiration({ req: request(), conversationId: 'convo-1' }, dependencies),
      ).resolves.toBeNull();
    });

    it('returns a fresh expiry for retentionMode ALL conversations without an expiration', async () => {
      dependencies.getConvo.mockResolvedValue({ expiredAt: null });

      await expect(
        getSharedLinkExpiration(
          {
            req: request({ config: { interfaceConfig: { retentionMode: RetentionMode.ALL } } }),
            conversationId: 'convo-1',
          },
          dependencies,
        ),
      ).resolves.toBe(expirationDate);
    });

    it('returns an expired source conversation date so callers can reject the share', async () => {
      const expiredAt = new Date(Date.now() - 60 * 60 * 1000);
      dependencies.getConvo.mockResolvedValue({ expiredAt });

      await expect(
        getSharedLinkExpiration({ req: request(), conversationId: 'convo-1' }, dependencies),
      ).resolves.toBe(expiredAt);
      expect(dependencies.createExpirationDate).not.toHaveBeenCalled();
    });
  });
});
