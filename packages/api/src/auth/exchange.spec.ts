import crypto from 'crypto';
import { Keyv } from 'keyv';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const KeyvRedis = require('@keyv/redis').default as typeof import('@keyv/redis').default;
import type { IUser } from '@librechat/data-schemas';

jest.mock(
  '@librechat/data-schemas',
  () => ({
    logger: {
      info: jest.fn(),
      warn: jest.fn(),
    },
  }),
  { virtual: true },
);

import {
  exchangeAdminCode,
  generateAdminExchangeCode,
  isAdminPanelRedirect,
  verifyCodeChallenge,
} from './exchange';

describe('admin OAuth code exchange', () => {
  const user = {
    _id: 'user123',
    email: 'admin@example.com',
    name: 'Admin User',
    username: 'admin',
    role: 'ADMIN',
    provider: 'openid',
  } as unknown as IUser;

  const createCache = () => ({ cache: new Keyv() });

  describe('origin binding', () => {
    it('exchanges code when request origin matches generated origin', async () => {
      const { cache } = createCache();
      const exchangeCode = await generateAdminExchangeCode(
        cache,
        user,
        'jwt-token',
        'refresh-token',
        'https://admin.example.com',
      );

      const result = await exchangeAdminCode(cache, exchangeCode, 'https://admin.example.com');

      expect(result).not.toBeNull();
      expect(result!.token).toBe('jwt-token');
      expect(result!.refreshToken).toBe('refresh-token');
      expect(result!.user.email).toBe('admin@example.com');
    });

    it('rejects code exchange when request origin does not match generated origin', async () => {
      const { cache } = createCache();
      const exchangeCode = await generateAdminExchangeCode(
        cache,
        user,
        'jwt-token',
        'refresh-token',
        'https://admin.example.com',
      );

      const result = await exchangeAdminCode(cache, exchangeCode, 'https://evil.example.com');

      expect(result).toBeNull();
      await expect(cache.get(exchangeCode)).resolves.toBeUndefined();
    });

    it('rejects code exchange when origin is stored but request has no origin', async () => {
      const { cache } = createCache();
      const exchangeCode = await generateAdminExchangeCode(
        cache,
        user,
        'jwt-token',
        'refresh-token',
        'https://admin.example.com',
      );

      const result = await exchangeAdminCode(cache, exchangeCode, undefined);

      expect(result).toBeNull();
    });

    it('allows exchange when no origin was stored (backward compat)', async () => {
      const { cache } = createCache();
      const exchangeCode = await generateAdminExchangeCode(
        cache,
        user,
        'jwt-token',
        'refresh-token',
      );

      const result = await exchangeAdminCode(cache, exchangeCode, 'https://any-origin.com');

      expect(result).not.toBeNull();
      expect(result!.token).toBe('jwt-token');
    });
  });

  describe('one-time use', () => {
    it('rejects code that has already been used', async () => {
      const { cache } = createCache();
      const exchangeCode = await generateAdminExchangeCode(
        cache,
        user,
        'jwt-token',
        'refresh-token',
        'https://admin.example.com',
      );

      await exchangeAdminCode(cache, exchangeCode, 'https://admin.example.com');
      const secondAttempt = await exchangeAdminCode(
        cache,
        exchangeCode,
        'https://admin.example.com',
      );

      expect(secondAttempt).toBeNull();
    });

    it('allows only one simultaneous exchange with the in-memory cache', async () => {
      const { cache } = createCache();
      const code = await generateAdminExchangeCode(cache, user, 'jwt-token');

      const results = await Promise.all([
        exchangeAdminCode(cache, code),
        exchangeAdminCode(cache, code),
      ]);

      expect(results.filter((result) => result?.token === 'jwt-token')).toHaveLength(1);
      expect(results.filter((result) => result === null)).toHaveLength(1);
    });

    it('rejects an entry whose Keyv TTL has expired before redemption', async () => {
      const cache = new Keyv({ ttl: 50 });
      const code = await generateAdminExchangeCode(cache, user, 'jwt-token');
      const now = Date.now();
      const clock = jest.spyOn(Date, 'now').mockReturnValue(now + 100);
      try {
        await expect(exchangeAdminCode(cache, code)).resolves.toBeNull();
      } finally {
        clock.mockRestore();
      }
      await expect(cache.get(code)).resolves.toBeUndefined();
    });

    const createRedisCache = () => {
      const values = new Map<string, string>();
      const client = {
        set: jest.fn(async (key: string, value: string) => {
          values.set(key, value);
          return 'OK';
        }),
        getDel: jest.fn(async (key: string) => {
          const value = values.get(key) ?? null;
          values.delete(key);
          return value;
        }),
      };
      const store = new KeyvRedis();
      Object.defineProperty(store, 'getClient', { value: async () => client });
      const cache = new Keyv(store, { namespace: 'ADMIN_OAUTH_EXCHANGE', ttl: 30_000 });
      store.namespace = 'deployment';
      store.keyPrefixSeparator = '::';
      const onError = jest.fn();
      cache.on('error', onError);
      return { cache, client, values, onError };
    };

    it('uses one prefixed GETDEL per attempt so concurrent Redis exchanges cannot replay', async () => {
      const { cache, client, values } = createRedisCache();
      const code = await generateAdminExchangeCode(cache, user, 'jwt-token');

      const results = await Promise.all([
        exchangeAdminCode(cache, code),
        exchangeAdminCode(cache, code),
      ]);

      expect(results.filter((result) => result?.token === 'jwt-token')).toHaveLength(1);
      expect(results.filter((result) => result === null)).toHaveLength(1);
      expect(client.getDel).toHaveBeenCalledTimes(2);
      expect(client.getDel).toHaveBeenCalledWith(`deployment::ADMIN_OAUTH_EXCHANGE:${code}`);
      expect(values.size).toBe(0);
    });

    it('fails closed when Redis cannot consume the code, allowing a later retry', async () => {
      const { cache, client, onError } = createRedisCache();
      const code = await generateAdminExchangeCode(cache, user, 'jwt-token');
      client.getDel.mockRejectedValueOnce(new Error('Redis unavailable'));

      await expect(exchangeAdminCode(cache, code)).rejects.toThrow('Redis unavailable');
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Redis unavailable' }),
      );
      await expect(exchangeAdminCode(cache, code)).resolves.toMatchObject({ token: 'jwt-token' });
      await expect(exchangeAdminCode(cache, code)).resolves.toBeNull();
    });
  });

  describe('PKCE verification', () => {
    const codeVerifier = crypto.randomBytes(32).toString('hex');
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('hex');

    it('verifyCodeChallenge returns true for matching verifier', () => {
      expect(verifyCodeChallenge(codeVerifier, codeChallenge)).toBe(true);
    });

    it('verifyCodeChallenge returns false for wrong verifier', () => {
      expect(verifyCodeChallenge('wrong-verifier', codeChallenge)).toBe(false);
    });

    it('verifyCodeChallenge handles hex case insensitively (input gate rejects uppercase)', () => {
      const uppercaseChallenge = codeChallenge.toUpperCase();
      // Buffer.from(hex) is case-insensitive, so verification passes at this layer.
      // Uppercase challenges are rejected earlier by PKCE_CHALLENGE_PATTERN (no /i flag).
      expect(verifyCodeChallenge(codeVerifier, uppercaseChallenge)).toBe(true);
    });

    it('exchanges code when valid code_verifier is provided', async () => {
      const { cache } = createCache();
      const exchangeCode = await generateAdminExchangeCode(
        cache,
        user,
        'jwt-token',
        'refresh-token',
        'https://admin.example.com',
        codeChallenge,
      );

      const result = await exchangeAdminCode(
        cache,
        exchangeCode,
        'https://admin.example.com',
        codeVerifier,
      );

      expect(result).not.toBeNull();
      expect(result!.token).toBe('jwt-token');
    });

    it('rejects exchange when code_verifier does not match challenge', async () => {
      const { cache } = createCache();
      const exchangeCode = await generateAdminExchangeCode(
        cache,
        user,
        'jwt-token',
        'refresh-token',
        'https://admin.example.com',
        codeChallenge,
      );

      const result = await exchangeAdminCode(
        cache,
        exchangeCode,
        'https://admin.example.com',
        'wrong-verifier',
      );

      expect(result).toBeNull();
    });

    it('rejects exchange when challenge stored but no verifier provided', async () => {
      const { cache } = createCache();
      const exchangeCode = await generateAdminExchangeCode(
        cache,
        user,
        'jwt-token',
        'refresh-token',
        'https://admin.example.com',
        codeChallenge,
      );

      const result = await exchangeAdminCode(cache, exchangeCode, 'https://admin.example.com');

      expect(result).toBeNull();
    });

    it('allows exchange when no challenge stored and no verifier sent (backward compat)', async () => {
      const { cache } = createCache();
      const exchangeCode = await generateAdminExchangeCode(
        cache,
        user,
        'jwt-token',
        'refresh-token',
        'https://admin.example.com',
      );

      const result = await exchangeAdminCode(cache, exchangeCode, 'https://admin.example.com');

      expect(result).not.toBeNull();
      expect(result!.token).toBe('jwt-token');
    });
  });

  describe('isAdminPanelRedirect', () => {
    it('returns true for cross-origin admin callback redirects', () => {
      expect(
        isAdminPanelRedirect(
          'https://admin.example.com/auth/openid/callback',
          'https://admin.example.com',
          'https://chat.example.com',
        ),
      ).toBe(true);
    });

    it('returns true for same-origin callbacks under the admin subpath', () => {
      expect(
        isAdminPanelRedirect(
          'https://chat.example.com/admin/auth/openid/callback',
          'https://chat.example.com/admin',
          'https://chat.example.com',
        ),
      ).toBe(true);
    });

    it('returns false for same-origin callbacks outside the admin subpath', () => {
      expect(
        isAdminPanelRedirect(
          'https://chat.example.com/oauth/openid/callback',
          'https://chat.example.com/admin',
          'https://chat.example.com',
        ),
      ).toBe(false);
    });

    it('does not treat similarly prefixed paths as admin subpaths', () => {
      expect(
        isAdminPanelRedirect(
          'https://chat.example.com/administrator/auth/openid/callback',
          'https://chat.example.com/admin',
          'https://chat.example.com',
        ),
      ).toBe(false);
    });

    it('treats trailing slash variants of admin subpath as equivalent', () => {
      expect(
        isAdminPanelRedirect(
          'https://chat.example.com/admin/auth/openid/callback',
          'https://chat.example.com/admin/',
          'https://chat.example.com',
        ),
      ).toBe(true);
    });

    it('returns true when redirect path exactly matches admin subpath', () => {
      expect(
        isAdminPanelRedirect(
          'https://chat.example.com/admin',
          'https://chat.example.com/admin',
          'https://chat.example.com',
        ),
      ).toBe(true);
    });

    it('returns false for same-origin root admin URL', () => {
      expect(
        isAdminPanelRedirect(
          'https://chat.example.com/auth/openid/callback',
          'https://chat.example.com/',
          'https://chat.example.com',
        ),
      ).toBe(false);
    });
  });
});
