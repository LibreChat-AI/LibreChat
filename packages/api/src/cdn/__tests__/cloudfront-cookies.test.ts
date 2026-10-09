import type { CloudfrontSignInput } from '@aws-sdk/cloudfront-signer';

const mockGetCloudFrontConfig = jest.fn();
const mockGetSignedCookies = jest.fn();

jest.mock('~/cdn/cloudfront', () => ({
  getCloudFrontConfig: () => mockGetCloudFrontConfig(),
}));

jest.mock('@aws-sdk/cloudfront-signer', () => ({
  getSignedCookies: (params: CloudfrontSignInput) => mockGetSignedCookies(params),
}));

jest.mock('@librechat/data-schemas', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import type { Response } from 'express';
import {
  setCloudFrontCookies,
  clearCloudFrontCookies,
  forceRefreshCloudFrontAuthCookies,
  maybeRefreshCloudFrontAuthCookies,
  parseCloudFrontCookieScope,
} from '../cloudfront-cookies';

const { logger: mockLogger } = jest.requireMock('@librechat/data-schemas') as {
  logger: { warn: jest.Mock; error: jest.Mock; info: jest.Mock; debug: jest.Mock };
};

const defaultScope = { userId: 'user123' };
const encodeScope = (scope: object) =>
  Buffer.from(JSON.stringify(scope), 'utf8').toString('base64url');

afterEach(() => {
  jest.restoreAllMocks();
});

function defaultCookieConfig(overrides: object = {}) {
  return {
    domain: 'https://cdn.example.com',
    imageSigning: 'cookies',
    cookieExpiry: 1800,
    cookieDomain: '.example.com',
    privateKey: '-----BEGIN RSA PRIVATE KEY-----\ntest\n-----END RSA PRIVATE KEY-----',
    keyPairId: 'K123ABC',
    ...overrides,
  };
}

describe('setCloudFrontCookies', () => {
  let mockRes: Partial<Response>;
  let cookieArgs: Array<[string, string, object]>;
  let clearedCookies: Array<[string, object]>;

  beforeEach(() => {
    jest.clearAllMocks();
    cookieArgs = [];
    clearedCookies = [];
    mockRes = {
      cookie: jest.fn((name: string, value: string, options: object) => {
        cookieArgs.push([name, value, options]);
        return mockRes as Response;
      }) as unknown as Response['cookie'],
      clearCookie: jest.fn((name: string, options: object) => {
        clearedCookies.push([name, options]);
        return mockRes as Response;
      }) as unknown as Response['clearCookie'],
    };
  });

  it('returns false when CloudFront config is null', () => {
    mockGetCloudFrontConfig.mockReturnValue(null);

    const result = setCloudFrontCookies(mockRes as Response, defaultScope);

    expect(result).toBe(false);
    expect(mockRes.cookie).not.toHaveBeenCalled();
  });

  it('returns false when imageSigning is not "cookies"', () => {
    mockGetCloudFrontConfig.mockReturnValue({
      domain: 'https://cdn.example.com',
      imageSigning: 'none',
      cookieDomain: '.example.com',
      privateKey: 'test-key',
      keyPairId: 'K123',
    });

    const result = setCloudFrontCookies(mockRes as Response, defaultScope);

    expect(result).toBe(false);
    expect(mockRes.cookie).not.toHaveBeenCalled();
  });

  it('returns false when signing keys are missing', () => {
    mockGetCloudFrontConfig.mockReturnValue({
      domain: 'https://cdn.example.com',
      imageSigning: 'cookies',
      cookieDomain: '.example.com',
      privateKey: null,
      keyPairId: null,
    });

    const result = setCloudFrontCookies(mockRes as Response, defaultScope);

    expect(result).toBe(false);
    expect(mockRes.cookie).not.toHaveBeenCalled();
  });

  it('returns false when cookieDomain is missing', () => {
    mockGetCloudFrontConfig.mockReturnValue({
      domain: 'https://cdn.example.com',
      imageSigning: 'cookies',
      cookieExpiry: 1800,
      privateKey: '-----BEGIN RSA PRIVATE KEY-----\ntest\n-----END RSA PRIVATE KEY-----',
      keyPairId: 'K123ABC',
    });

    const result = setCloudFrontCookies(mockRes as Response, defaultScope);

    expect(result).toBe(false);
    expect(mockRes.cookie).not.toHaveBeenCalled();
  });

  it('uses default expiry of 1800s when cookieExpiry is missing from config (Zod default not applied)', () => {
    mockGetCloudFrontConfig.mockReturnValue({
      domain: 'https://cdn.example.com',
      imageSigning: 'cookies',
      // cookieExpiry intentionally absent — simulates raw YAML without Zod defaults
      cookieDomain: '.example.com',
      privateKey: '-----BEGIN RSA PRIVATE KEY-----\ntest\n-----END RSA PRIVATE KEY-----',
      keyPairId: 'K123ABC',
    });

    mockGetSignedCookies.mockReturnValue({
      'CloudFront-Policy': 'policy-value',
      'CloudFront-Signature': 'signature-value',
      'CloudFront-Key-Pair-Id': 'K123ABC',
    });

    const result = setCloudFrontCookies(mockRes as Response, defaultScope);

    expect(result).toBe(true);
    expect(mockLogger.warn).not.toHaveBeenCalled();
    const [, , options] = cookieArgs[0];
    expect((options as { expires: Date }).expires).toBeInstanceOf(Date);
    expect(isNaN((options as { expires: Date }).expires.getTime())).toBe(false);
  });

  it('sets separate CloudFront cookie sets for private images and avatars when enabled', () => {
    mockGetCloudFrontConfig.mockReturnValue({
      domain: 'https://cdn.example.com',
      imageSigning: 'cookies',
      cookieExpiry: 1800,
      cookieDomain: '.example.com',
      privateKey: '-----BEGIN RSA PRIVATE KEY-----\ntest\n-----END RSA PRIVATE KEY-----',
      keyPairId: 'K123ABC',
    });

    mockGetSignedCookies.mockReturnValue({
      'CloudFront-Policy': 'policy-value',
      'CloudFront-Signature': 'signature-value',
      'CloudFront-Key-Pair-Id': 'K123ABC',
    });

    const result = setCloudFrontCookies(mockRes as Response, defaultScope);

    expect(result).toBe(true);
    expect(mockRes.cookie).toHaveBeenCalledTimes(7);
    expect(mockRes.clearCookie).toHaveBeenCalledTimes(18);

    const cookieNames = cookieArgs.map(([name]) => name);
    expect(cookieNames).toContain('CloudFront-Policy');
    expect(cookieNames).toContain('CloudFront-Signature');
    expect(cookieNames).toContain('CloudFront-Key-Pair-Id');
  });

  it('sets a non-HttpOnly scope cookie with issuedAt and expiresAt timing', () => {
    jest.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    mockGetCloudFrontConfig.mockReturnValue(defaultCookieConfig({ cookieExpiry: 1800 }));
    mockGetSignedCookies.mockReturnValue({
      'CloudFront-Policy': 'policy-value',
      'CloudFront-Signature': 'signature-value',
      'CloudFront-Key-Pair-Id': 'K123ABC',
    });

    const result = setCloudFrontCookies(mockRes as Response, {
      userId: 'user123',
      tenantId: 'tenantA',
      storageRegion: 'us-east-2',
    });

    expect(result).toBe(true);
    const [, value, options] = cookieArgs.find(([name]) => name === 'LibreChat-CloudFront-Scope')!;
    expect(options).toMatchObject({ httpOnly: false, path: '/' });
    expect(parseCloudFrontCookieScope(value)).toEqual({
      userId: 'user123',
      tenantId: 'tenantA',
      storageRegion: 'us-east-2',
      issuedAt: 1_700_000_000,
      expiresAt: 1_700_001_800,
    });
  });

  it('uses cookieDomain from config with path-scoped cookies', () => {
    mockGetCloudFrontConfig.mockReturnValue({
      domain: 'https://cdn.example.com',
      imageSigning: 'cookies',
      cookieExpiry: 1800,
      cookieDomain: '.example.com',
      privateKey: '-----BEGIN RSA PRIVATE KEY-----\ntest\n-----END RSA PRIVATE KEY-----',
      keyPairId: 'K123ABC',
    });

    mockGetSignedCookies.mockReturnValue({
      'CloudFront-Policy': 'policy-value',
      'CloudFront-Signature': 'signature-value',
      'CloudFront-Key-Pair-Id': 'K123ABC',
    });

    setCloudFrontCookies(mockRes as Response, defaultScope);

    const [, , options] = cookieArgs[0];
    expect(options).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: 'none',
      domain: '.example.com',
      path: '/i',
    });
    expect(cookieArgs[3][2]).toMatchObject({ path: '/a' });
  });

  it('clears legacy image-wide and avatar cookie paths before setting scoped cookies', () => {
    mockGetCloudFrontConfig.mockReturnValue({
      domain: 'https://cdn.example.com',
      imageSigning: 'cookies',
      cookieExpiry: 1800,
      cookieDomain: '.example.com',
      privateKey: '-----BEGIN RSA PRIVATE KEY-----\ntest\n-----END RSA PRIVATE KEY-----',
      keyPairId: 'K123ABC',
    });

    mockGetSignedCookies.mockReturnValue({
      'CloudFront-Policy': 'policy-value',
      'CloudFront-Signature': 'signature-value',
      'CloudFront-Key-Pair-Id': 'K123ABC',
    });

    setCloudFrontCookies(mockRes as Response, defaultScope);

    expect(clearedCookies).toHaveLength(18);
    expect(clearedCookies).toContainEqual([
      'CloudFront-Policy',
      expect.objectContaining({ path: '/images' }),
    ]);
    expect(clearedCookies).toContainEqual([
      'CloudFront-Signature',
      expect.objectContaining({ path: '/images/user123' }),
    ]);
    expect(clearedCookies).toContainEqual([
      'CloudFront-Key-Pair-Id',
      expect.objectContaining({ path: '/avatars' }),
    ]);
    expect(clearedCookies).toContainEqual([
      'CloudFront-Signature',
      expect.objectContaining({ path: '/r' }),
    ]);
    expect(clearedCookies).toContainEqual([
      'CloudFront-Policy',
      expect.objectContaining({ path: '/i' }),
    ]);
    expect(clearedCookies).toContainEqual([
      'CloudFront-Key-Pair-Id',
      expect.objectContaining({ path: '/a' }),
    ]);
  });

  it('clears the previously issued scoped cookie paths before setting new cookies', () => {
    mockGetCloudFrontConfig.mockReturnValue({
      domain: 'https://cdn.example.com',
      imageSigning: 'cookies',
      cookieExpiry: 1800,
      cookieDomain: '.example.com',
      privateKey: '-----BEGIN RSA PRIVATE KEY-----\ntest\n-----END RSA PRIVATE KEY-----',
      keyPairId: 'K123ABC',
    });

    mockGetSignedCookies.mockReturnValue({
      'CloudFront-Policy': 'policy-value',
      'CloudFront-Signature': 'signature-value',
      'CloudFront-Key-Pair-Id': 'K123ABC',
    });

    setCloudFrontCookies(
      mockRes as Response,
      { userId: 'newUser', tenantId: 'newTenant' },
      { userId: 'oldUser', tenantId: 'oldTenant' },
    );

    expect(clearedCookies).toContainEqual([
      'CloudFront-Policy',
      expect.objectContaining({ path: '/t/oldTenant/images/oldUser' }),
    ]);
    expect(clearedCookies).toContainEqual([
      'CloudFront-Signature',
      expect.objectContaining({ path: '/t/oldTenant/avatars' }),
    ]);
    expect(clearedCookies).toContainEqual([
      'CloudFront-Key-Pair-Id',
      expect.objectContaining({ path: '/t/newTenant/images/newUser' }),
    ]);
    expect(clearedCookies).toContainEqual([
      'CloudFront-Policy',
      expect.objectContaining({ path: '/t/newTenant/avatars' }),
    ]);
    expect(clearedCookies).toContainEqual([
      'CloudFront-Policy',
      expect.objectContaining({ path: '/i' }),
    ]);
    expect(clearedCookies).toContainEqual([
      'CloudFront-Signature',
      expect.objectContaining({ path: '/a' }),
    ]);
  });

  it('stores the issued CloudFront cookie scope for later cleanup', () => {
    mockGetCloudFrontConfig.mockReturnValue({
      domain: 'https://cdn.example.com',
      imageSigning: 'cookies',
      cookieExpiry: 1800,
      cookieDomain: '.example.com',
      privateKey: '-----BEGIN RSA PRIVATE KEY-----\ntest\n-----END RSA PRIVATE KEY-----',
      keyPairId: 'K123ABC',
    });

    mockGetSignedCookies.mockReturnValue({
      'CloudFront-Policy': 'policy-value',
      'CloudFront-Signature': 'signature-value',
      'CloudFront-Key-Pair-Id': 'K123ABC',
    });

    setCloudFrontCookies(mockRes as Response, { userId: 'user123', tenantId: 'tenantA' });

    const [name, value, options] = cookieArgs[cookieArgs.length - 1];
    expect(name).toBe('LibreChat-CloudFront-Scope');
    expect(options).toMatchObject({ domain: '.example.com', path: '/' });
    expect(parseCloudFrontCookieScope(value)).toEqual(
      expect.objectContaining({ userId: 'user123', tenantId: 'tenantA' }),
    );
  });

  it('builds user-scoped custom policies for private images and avatars', () => {
    mockGetCloudFrontConfig.mockReturnValue({
      domain: 'https://cdn.example.com',
      imageSigning: 'cookies',
      cookieExpiry: 1800,
      cookieDomain: '.example.com',
      privateKey: '-----BEGIN RSA PRIVATE KEY-----\ntest\n-----END RSA PRIVATE KEY-----',
      keyPairId: 'K123ABC',
    });

    mockGetSignedCookies.mockReturnValue({
      'CloudFront-Policy': 'policy-value',
      'CloudFront-Signature': 'signature-value',
      'CloudFront-Key-Pair-Id': 'K123ABC',
    });

    setCloudFrontCookies(mockRes as Response, defaultScope);

    const privatePolicy = JSON.parse(mockGetSignedCookies.mock.calls[0][0].policy);
    const avatarPolicy = JSON.parse(mockGetSignedCookies.mock.calls[1][0].policy);
    expect(mockGetSignedCookies).toHaveBeenCalledTimes(2);
    expect(mockGetSignedCookies).toHaveBeenCalledWith(
      expect.objectContaining({
        keyPairId: 'K123ABC',
        privateKey: expect.stringContaining('BEGIN RSA PRIVATE KEY'),
      }),
    );
    expect(privatePolicy.Statement).toEqual([
      expect.objectContaining({ Resource: 'https://cdn.example.com/i/images/user123/*' }),
    ]);
    expect(avatarPolicy.Statement).toEqual([
      expect.objectContaining({ Resource: 'https://cdn.example.com/a/avatars/*' }),
    ]);
  });

  it('builds a tenant-scoped custom policy and cookie path', () => {
    mockGetCloudFrontConfig.mockReturnValue({
      domain: 'https://cdn.example.com',
      imageSigning: 'cookies',
      cookieExpiry: 1800,
      cookieDomain: '.example.com',
      privateKey: '-----BEGIN RSA PRIVATE KEY-----\ntest\n-----END RSA PRIVATE KEY-----',
      keyPairId: 'K123ABC',
    });

    mockGetSignedCookies.mockReturnValue({
      'CloudFront-Policy': 'policy-value',
      'CloudFront-Signature': 'signature-value',
      'CloudFront-Key-Pair-Id': 'K123ABC',
    });

    const result = setCloudFrontCookies(mockRes as Response, {
      userId: 'user123',
      tenantId: 'tenantA',
    });

    const privatePolicy = JSON.parse(mockGetSignedCookies.mock.calls[0][0].policy);
    const avatarPolicy = JSON.parse(mockGetSignedCookies.mock.calls[1][0].policy);
    expect(result).toBe(true);
    expect(privatePolicy.Statement).toEqual([
      expect.objectContaining({
        Resource: 'https://cdn.example.com/i/t/tenantA/images/user123/*',
      }),
    ]);
    expect(avatarPolicy.Statement).toEqual([
      expect.objectContaining({ Resource: 'https://cdn.example.com/a/t/tenantA/avatars/*' }),
    ]);
    expect(cookieArgs[0][2]).toMatchObject({ path: '/i' });
    expect(cookieArgs[3][2]).toMatchObject({ path: '/a' });
  });

  it('builds disjoint region-wildcard image and avatar policies', () => {
    mockGetCloudFrontConfig.mockReturnValue({
      domain: 'https://cdn.example.com',
      imageSigning: 'cookies',
      cookieExpiry: 1800,
      cookieDomain: '.example.com',
      privateKey: '-----BEGIN RSA PRIVATE KEY-----\ntest\n-----END RSA PRIVATE KEY-----',
      keyPairId: 'K123ABC',
      storageRegion: 'us-east-2',
      includeRegionInPath: true,
    });

    mockGetSignedCookies.mockReturnValue({
      'CloudFront-Policy': 'policy-value',
      'CloudFront-Signature': 'signature-value',
      'CloudFront-Key-Pair-Id': 'K123ABC',
    });

    const result = setCloudFrontCookies(mockRes as Response, {
      userId: 'user123',
      tenantId: 'tenantA',
    });

    const privatePolicy = JSON.parse(mockGetSignedCookies.mock.calls[0][0].policy);
    const avatarPolicy = JSON.parse(mockGetSignedCookies.mock.calls[1][0].policy);
    expect(result).toBe(true);
    expect(mockGetSignedCookies).toHaveBeenCalledTimes(2);
    expect(mockRes.cookie).toHaveBeenCalledTimes(7);
    expect(privatePolicy.Statement).toEqual([
      expect.objectContaining({
        Resource: 'https://cdn.example.com/i/r/*/t/tenantA/images/user123/*',
      }),
    ]);
    expect(avatarPolicy.Statement).toEqual([
      expect.objectContaining({
        Resource: 'https://cdn.example.com/a/r/*/t/tenantA/avatars/*',
      }),
    ]);
    expect(cookieArgs[0][2]).toMatchObject({ path: '/i' });
    expect(cookieArgs[3][2]).toMatchObject({ path: '/a' });

    const [, scopeValue] = cookieArgs[cookieArgs.length - 1];
    expect(parseCloudFrontCookieScope(scopeValue)).toEqual(
      expect.objectContaining({
        userId: 'user123',
        tenantId: 'tenantA',
        storageRegion: 'us-east-2',
      }),
    );
  });

  it('does not require a concrete storageRegion for wildcard region policies', () => {
    const originalRegion = process.env.AWS_REGION;
    delete process.env.AWS_REGION;
    mockGetCloudFrontConfig.mockReturnValue({
      domain: 'https://cdn.example.com',
      imageSigning: 'cookies',
      cookieExpiry: 1800,
      cookieDomain: '.example.com',
      privateKey: '-----BEGIN RSA PRIVATE KEY-----\ntest\n-----END RSA PRIVATE KEY-----',
      keyPairId: 'K123ABC',
      includeRegionInPath: true,
    });

    mockGetSignedCookies.mockReturnValue({
      'CloudFront-Policy': 'policy-value',
      'CloudFront-Signature': 'signature-value',
      'CloudFront-Key-Pair-Id': 'K123ABC',
    });

    try {
      const result = setCloudFrontCookies(mockRes as Response, {
        userId: 'user123',
        tenantId: 'tenantA',
      });

      const privatePolicy = JSON.parse(mockGetSignedCookies.mock.calls[0][0].policy);
      const avatarPolicy = JSON.parse(mockGetSignedCookies.mock.calls[1][0].policy);
      const [, scopeValue] = cookieArgs[cookieArgs.length - 1];
      expect(result).toBe(true);
      expect(privatePolicy.Statement).toEqual([
        expect.objectContaining({
          Resource: 'https://cdn.example.com/i/r/*/t/tenantA/images/user123/*',
        }),
      ]);
      expect(avatarPolicy.Statement).toEqual([
        expect.objectContaining({
          Resource: 'https://cdn.example.com/a/r/*/t/tenantA/avatars/*',
        }),
      ]);
      expect(parseCloudFrontCookieScope(scopeValue)).toEqual(
        expect.objectContaining({ userId: 'user123', tenantId: 'tenantA' }),
      );
    } finally {
      if (originalRegion == null) {
        delete process.env.AWS_REGION;
      } else {
        process.env.AWS_REGION = originalRegion;
      }
    }
  });

  it('builds a user-bounded region-wildcard policy for non-tenant installs', () => {
    mockGetCloudFrontConfig.mockReturnValue({
      domain: 'https://cdn.example.com',
      imageSigning: 'cookies',
      cookieExpiry: 1800,
      cookieDomain: '.example.com',
      privateKey: '-----BEGIN RSA PRIVATE KEY-----\ntest\n-----END RSA PRIVATE KEY-----',
      keyPairId: 'K123ABC',
      storageRegion: 'us-east-2',
      includeRegionInPath: true,
    });

    mockGetSignedCookies.mockReturnValue({
      'CloudFront-Policy': 'policy-value',
      'CloudFront-Signature': 'signature-value',
      'CloudFront-Key-Pair-Id': 'K123ABC',
    });

    const result = setCloudFrontCookies(mockRes as Response, { userId: 'user123' });

    const privatePolicy = JSON.parse(mockGetSignedCookies.mock.calls[0][0].policy);
    const avatarPolicy = JSON.parse(mockGetSignedCookies.mock.calls[1][0].policy);
    expect(result).toBe(true);
    expect(mockGetSignedCookies).toHaveBeenCalledTimes(2);
    expect(privatePolicy.Statement).toEqual([
      expect.objectContaining({ Resource: 'https://cdn.example.com/i/r/*/images/user123/*' }),
    ]);
    expect(avatarPolicy.Statement).toEqual([
      expect.objectContaining({ Resource: 'https://cdn.example.com/a/r/*/avatars/*' }),
    ]);
    expect(cookieArgs[0][2]).toMatchObject({ path: '/i' });
    expect(cookieArgs[3][2]).toMatchObject({ path: '/a' });
  });

  it('handles multiple trailing slashes in domain', () => {
    mockGetCloudFrontConfig.mockReturnValue({
      domain: 'https://cdn.example.com///',
      imageSigning: 'cookies',
      cookieExpiry: 1800,
      cookieDomain: '.example.com',
      privateKey: '-----BEGIN RSA PRIVATE KEY-----\ntest\n-----END RSA PRIVATE KEY-----',
      keyPairId: 'K123ABC',
    });

    mockGetSignedCookies.mockReturnValue({
      'CloudFront-Policy': 'policy-value',
      'CloudFront-Signature': 'signature-value',
      'CloudFront-Key-Pair-Id': 'K123ABC',
    });

    setCloudFrontCookies(mockRes as Response, defaultScope);

    expect(mockGetSignedCookies).toHaveBeenCalledWith(
      expect.objectContaining({
        policy: expect.stringContaining('https://cdn.example.com/i/images/user123/*'),
      }),
    );
  });

  it('returns false when getSignedCookies returns empty object', () => {
    mockGetCloudFrontConfig.mockReturnValue({
      domain: 'https://cdn.example.com',
      imageSigning: 'cookies',
      cookieExpiry: 1800,
      cookieDomain: '.example.com',
      privateKey: '-----BEGIN RSA PRIVATE KEY-----\ntest\n-----END RSA PRIVATE KEY-----',
      keyPairId: 'K123ABC',
    });

    mockGetSignedCookies.mockReturnValue({});

    const result = setCloudFrontCookies(mockRes as Response, defaultScope);

    expect(result).toBe(false);
    expect(mockRes.cookie).not.toHaveBeenCalled();
    expect(mockRes.clearCookie).not.toHaveBeenCalled();
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining('Missing expected cookie from AWS SDK'),
    );
  });

  it('returns false when getSignedCookies returns partial result', () => {
    mockGetCloudFrontConfig.mockReturnValue({
      domain: 'https://cdn.example.com',
      imageSigning: 'cookies',
      cookieExpiry: 1800,
      cookieDomain: '.example.com',
      privateKey: '-----BEGIN RSA PRIVATE KEY-----\ntest\n-----END RSA PRIVATE KEY-----',
      keyPairId: 'K123ABC',
    });

    mockGetSignedCookies.mockReturnValue({ 'CloudFront-Policy': 'policy-value' });

    const result = setCloudFrontCookies(mockRes as Response, defaultScope);

    expect(result).toBe(false);
    expect(mockRes.cookie).not.toHaveBeenCalled();
    expect(mockRes.clearCookie).not.toHaveBeenCalled();
  });

  it('returns false when userId is missing from scope', () => {
    mockGetCloudFrontConfig.mockReturnValue({
      domain: 'https://cdn.example.com',
      imageSigning: 'cookies',
      cookieExpiry: 1800,
      cookieDomain: '.example.com',
      privateKey: '-----BEGIN RSA PRIVATE KEY-----\ntest\n-----END RSA PRIVATE KEY-----',
      keyPairId: 'K123ABC',
    });

    const result = setCloudFrontCookies(mockRes as Response);

    expect(result).toBe(false);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      '[setCloudFrontCookies] CloudFront configured but userId missing from scope',
    );
    expect(mockRes.cookie).not.toHaveBeenCalled();
  });

  it('returns false when scope path segments contain policy wildcards or traversal', () => {
    mockGetCloudFrontConfig.mockReturnValue({
      domain: 'https://cdn.example.com',
      imageSigning: 'cookies',
      cookieExpiry: 1800,
      cookieDomain: '.example.com',
      privateKey: '-----BEGIN RSA PRIVATE KEY-----\ntest\n-----END RSA PRIVATE KEY-----',
      keyPairId: 'K123ABC',
    });

    expect(setCloudFrontCookies(mockRes as Response, { userId: 'user*' })).toBe(false);
    expect(
      setCloudFrontCookies(mockRes as Response, { userId: 'user123', tenantId: '../tenantA' }),
    ).toBe(false);
    expect(
      setCloudFrontCookies(mockRes as Response, { userId: 'user123', tenantId: 'tenant A' }),
    ).toBe(false);
    expect(mockGetSignedCookies).not.toHaveBeenCalled();
    expect(mockRes.cookie).not.toHaveBeenCalled();
  });

  it('returns false and logs error on signing error', () => {
    mockGetCloudFrontConfig.mockReturnValue({
      domain: 'https://cdn.example.com',
      imageSigning: 'cookies',
      cookieExpiry: 1800,
      cookieDomain: '.example.com',
      privateKey: 'invalid-key',
      keyPairId: 'K123ABC',
    });

    const signingError = new Error('Invalid private key');
    mockGetSignedCookies.mockImplementation(() => {
      throw signingError;
    });

    const result = setCloudFrontCookies(mockRes as Response, defaultScope);

    expect(result).toBe(false);
    expect(mockRes.cookie).not.toHaveBeenCalled();
    expect(mockLogger.error).toHaveBeenCalledWith(
      '[setCloudFrontCookies] Failed to generate signed cookies:',
      signingError,
    );
  });
});

describe('parseCloudFrontCookieScope', () => {
  it('round-trips a valid user and tenant scope', () => {
    const value = encodeScope({ userId: 'user123', tenantId: 'tenantA' });

    expect(parseCloudFrontCookieScope(value)).toEqual({
      userId: 'user123',
      tenantId: 'tenantA',
    });
  });

  it('returns null for empty, malformed, or userless values', () => {
    expect(parseCloudFrontCookieScope(null)).toBeNull();
    expect(parseCloudFrontCookieScope(undefined)).toBeNull();
    expect(parseCloudFrontCookieScope('')).toBeNull();
    expect(parseCloudFrontCookieScope('not-json')).toBeNull();
    expect(parseCloudFrontCookieScope(encodeScope({ tenantId: 'tenantA' }))).toBeNull();
  });

  it('rejects traversal and wildcard path segments', () => {
    expect(parseCloudFrontCookieScope(encodeScope({ userId: '../user' }))).toBeNull();
    expect(parseCloudFrontCookieScope(encodeScope({ userId: 'user*' }))).toBeNull();
    expect(
      parseCloudFrontCookieScope(encodeScope({ userId: 'user123', tenantId: 'tenant A' })),
    ).toBeNull();
  });

  it('handles old scope cookies without timing fields', () => {
    expect(parseCloudFrontCookieScope(encodeScope({ userId: 'user123' }))).toEqual({
      userId: 'user123',
    });
  });

  it('drops invalid timing fields while preserving valid scope', () => {
    expect(
      parseCloudFrontCookieScope(
        encodeScope({ userId: 'user123', issuedAt: 'bad', expiresAt: Number.NaN }),
      ),
    ).toEqual({ userId: 'user123' });
  });
});

describe('maybeRefreshCloudFrontAuthCookies', () => {
  let mockRes: Partial<Response>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockRes = {
      cookie: jest.fn().mockReturnThis(),
      clearCookie: jest.fn().mockReturnThis(),
    };
    mockGetSignedCookies.mockReturnValue({
      'CloudFront-Policy': 'policy-value',
      'CloudFront-Signature': 'signature-value',
      'CloudFront-Key-Pair-Id': 'K123ABC',
    });
    mockGetCloudFrontConfig.mockReturnValue(defaultCookieConfig());
    jest.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
  });

  it('refreshes when the scope cookie is missing', () => {
    const result = maybeRefreshCloudFrontAuthCookies({ cookies: {} }, mockRes as Response, {
      _id: 'user123',
    });

    expect(result).toMatchObject({ enabled: true, attempted: true, refreshed: true });
    expect(mockGetSignedCookies).toHaveBeenCalled();
  });

  it('refreshes when the scope cookie is near expiry', () => {
    const result = maybeRefreshCloudFrontAuthCookies(
      {
        cookies: {
          'LibreChat-CloudFront-Scope': encodeScope({
            userId: 'user123',
            expiresAt: 1_700_000_250,
          }),
        },
      },
      mockRes as Response,
      { _id: 'user123' },
    );

    expect(result).toMatchObject({ attempted: true, refreshed: true, reason: 'near_expiry' });
  });

  it('refreshes when the tenant or user scope mismatches', () => {
    const userMismatch = maybeRefreshCloudFrontAuthCookies(
      {
        cookies: {
          'LibreChat-CloudFront-Scope': encodeScope({
            userId: 'old-user',
            tenantId: 'tenantA',
            expiresAt: 1_700_001_000,
          }),
        },
      },
      mockRes as Response,
      { _id: 'user123', tenantId: 'tenantA' },
    );

    const tenantMismatch = maybeRefreshCloudFrontAuthCookies(
      {
        cookies: {
          'LibreChat-CloudFront-Scope': encodeScope({
            userId: 'user123',
            tenantId: 'old-tenant',
            expiresAt: 1_700_001_000,
          }),
        },
      },
      mockRes as Response,
      { _id: 'user123', tenantId: 'tenantA' },
    );

    expect(userMismatch).toMatchObject({ attempted: true, reason: 'user_scope_mismatch' });
    expect(tenantMismatch).toMatchObject({ attempted: true, reason: 'tenant_scope_mismatch' });
  });

  it('does not refresh when the scope cookie is still fresh', () => {
    const result = maybeRefreshCloudFrontAuthCookies(
      {
        cookies: {
          'LibreChat-CloudFront-Scope': encodeScope({
            userId: 'user123',
            expiresAt: 1_700_001_000,
          }),
        },
      },
      mockRes as Response,
      { _id: 'user123' },
    );

    expect(result).toMatchObject({
      enabled: true,
      attempted: false,
      refreshed: false,
      reason: 'fresh',
    });
    expect(mockGetSignedCookies).not.toHaveBeenCalled();
  });

  it('does not refresh when CloudFront is disabled', () => {
    mockGetCloudFrontConfig.mockReturnValue(null);

    const result = maybeRefreshCloudFrontAuthCookies({ cookies: {} }, mockRes as Response, {
      _id: 'user123',
    });

    expect(result).toMatchObject({ enabled: false, attempted: false, refreshed: false });
    expect(mockGetSignedCookies).not.toHaveBeenCalled();
    expect(mockLogger.debug).not.toHaveBeenCalledWith(
      '[maybeRefreshCloudFrontAuthCookies] CloudFront auth cookies skipped',
      expect.any(Object),
    );
  });

  it('does not refresh when imageSigning is not cookies', () => {
    mockGetCloudFrontConfig.mockReturnValue(defaultCookieConfig({ imageSigning: 'url' }));

    const result = maybeRefreshCloudFrontAuthCookies({ cookies: {} }, mockRes as Response, {
      _id: 'user123',
    });

    expect(result).toMatchObject({ enabled: false, attempted: false, refreshed: false });
    expect(mockGetSignedCookies).not.toHaveBeenCalled();
    expect(mockLogger.debug).not.toHaveBeenCalledWith(
      '[maybeRefreshCloudFrontAuthCookies] CloudFront auth cookies skipped',
      expect.any(Object),
    );
  });

  it('force-refreshes even when the scope cookie is fresh without calling OIDC refresh', () => {
    const oidcRefresh = jest.fn();

    const result = forceRefreshCloudFrontAuthCookies(
      {
        cookies: {
          'LibreChat-CloudFront-Scope': encodeScope({
            userId: 'user123',
            expiresAt: 1_700_001_000,
          }),
        },
      },
      mockRes as Response,
      { _id: 'user123' },
    );

    expect(result).toMatchObject({ attempted: true, refreshed: true, reason: 'forced' });
    expect(oidcRefresh).not.toHaveBeenCalled();
  });
});

describe('clearCloudFrontCookies', () => {
  let mockRes: Partial<Response>;
  let clearedCookies: Array<[string, object]>;

  beforeEach(() => {
    jest.clearAllMocks();
    clearedCookies = [];
    mockRes = {
      clearCookie: jest.fn((name: string, options: object) => {
        clearedCookies.push([name, options]);
        return mockRes as Response;
      }) as unknown as Response['clearCookie'],
    };
  });

  it('does nothing when config is null', () => {
    mockGetCloudFrontConfig.mockReturnValue(null);

    clearCloudFrontCookies(mockRes as Response);

    expect(mockRes.clearCookie).not.toHaveBeenCalled();
  });

  it('clears stale cookies when imageSigning is not "cookies"', () => {
    mockGetCloudFrontConfig.mockReturnValue({
      domain: 'https://cdn.example.com',
      imageSigning: 'none',
      cookieDomain: '.example.com',
    });

    clearCloudFrontCookies(mockRes as Response);

    expect(mockRes.clearCookie).toHaveBeenCalledTimes(19);
  });

  it('does nothing when cookieDomain is missing', () => {
    mockGetCloudFrontConfig.mockReturnValue({
      domain: 'https://cdn.example.com',
      imageSigning: 'cookies',
    });

    clearCloudFrontCookies(mockRes as Response);

    expect(mockRes.clearCookie).not.toHaveBeenCalled();
  });

  it('clears all CloudFront cookies with correct domain and legacy paths', () => {
    mockGetCloudFrontConfig.mockReturnValue({
      domain: 'https://cdn.example.com',
      imageSigning: 'cookies',
      cookieDomain: '.example.com',
      privateKey: 'test-key',
      keyPairId: 'K123',
    });

    clearCloudFrontCookies(mockRes as Response);

    expect(mockRes.clearCookie).toHaveBeenCalledTimes(19);

    const legacyPathOptions = {
      domain: '.example.com',
      path: '/images',
      httpOnly: true,
      secure: true,
      sameSite: 'none',
    };
    const rootPathOptions = {
      domain: '.example.com',
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'none',
    };
    const scopePathOptions = {
      ...rootPathOptions,
      httpOnly: false,
    };
    expect(clearedCookies).toContainEqual(['CloudFront-Policy', legacyPathOptions]);
    expect(clearedCookies).toContainEqual(['CloudFront-Signature', legacyPathOptions]);
    expect(clearedCookies).toContainEqual(['CloudFront-Key-Pair-Id', legacyPathOptions]);
    expect(clearedCookies).toContainEqual(['CloudFront-Policy', rootPathOptions]);
    expect(clearedCookies).toContainEqual(['CloudFront-Signature', rootPathOptions]);
    expect(clearedCookies).toContainEqual(['CloudFront-Key-Pair-Id', rootPathOptions]);
    expect(clearedCookies).toContainEqual(['LibreChat-CloudFront-Scope', scopePathOptions]);
    expect(clearedCookies).toContainEqual([
      'CloudFront-Policy',
      expect.objectContaining({ path: '/r' }),
    ]);
  });

  it('clears tenant-scoped cookies', () => {
    mockGetCloudFrontConfig.mockReturnValue({
      domain: 'https://cdn.example.com',
      imageSigning: 'cookies',
      cookieDomain: '.example.com',
      privateKey: 'test-key',
      keyPairId: 'K123',
    });

    clearCloudFrontCookies(mockRes as Response, { userId: 'user123', tenantId: 'tenantA' });

    expect(mockRes.clearCookie).toHaveBeenCalledTimes(28);
    expect(clearedCookies).toContainEqual([
      'CloudFront-Policy',
      {
        domain: '.example.com',
        path: '/i',
        httpOnly: true,
        secure: true,
        sameSite: 'none',
      },
    ]);
    expect(clearedCookies).toContainEqual([
      'CloudFront-Policy',
      {
        domain: '.example.com',
        path: '/a',
        httpOnly: true,
        secure: true,
        sameSite: 'none',
      },
    ]);
    expect(clearedCookies).toContainEqual([
      'CloudFront-Policy',
      expect.objectContaining({ path: '/t/tenantA/images/user123' }),
    ]);
    expect(clearedCookies).toContainEqual([
      'CloudFront-Signature',
      expect.objectContaining({ path: '/t/tenantA/avatars' }),
    ]);
    expect(clearedCookies).toContainEqual([
      'LibreChat-CloudFront-Scope',
      {
        domain: '.example.com',
        path: '/',
        httpOnly: false,
        secure: true,
        sameSite: 'none',
      },
    ]);
  });

  it('clears region-mode scoped cookies without requiring scope.storageRegion', () => {
    mockGetCloudFrontConfig.mockReturnValue({
      domain: 'https://cdn.example.com',
      imageSigning: 'cookies',
      cookieDomain: '.example.com',
      privateKey: 'test-key',
      keyPairId: 'K123',
      storageRegion: 'us-east-2',
      includeRegionInPath: true,
    });

    clearCloudFrontCookies(mockRes as Response, { userId: 'user123', tenantId: 'tenantA' });

    expect(clearedCookies).toContainEqual([
      'CloudFront-Policy',
      expect.objectContaining({ path: '/t/tenantA/images/user123' }),
    ]);
    expect(clearedCookies).toContainEqual([
      'CloudFront-Signature',
      expect.objectContaining({ path: '/t/tenantA/avatars' }),
    ]);
    expect(clearedCookies).toContainEqual([
      'CloudFront-Policy',
      expect.objectContaining({ path: '/i' }),
    ]);
    expect(clearedCookies).toContainEqual([
      'CloudFront-Policy',
      expect.objectContaining({ path: '/a' }),
    ]);
    expect(clearedCookies).toContainEqual([
      'LibreChat-CloudFront-Scope',
      expect.objectContaining({ path: '/' }),
    ]);
  });

  it('logs warning and does not throw when clearing fails', () => {
    mockGetCloudFrontConfig.mockReturnValue({
      domain: 'https://cdn.example.com',
      imageSigning: 'cookies',
      cookieDomain: '.example.com',
      privateKey: 'test-key',
      keyPairId: 'K123',
    });

    const clearError = new Error('Cookie clear failed');
    mockRes.clearCookie = jest.fn(() => {
      throw clearError;
    }) as unknown as Response['clearCookie'];

    expect(() => clearCloudFrontCookies(mockRes as Response)).not.toThrow();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      '[clearCloudFrontCookies] Failed to clear cookies:',
      clearError,
    );
  });
});
