import type { IUser } from '@librechat/data-schemas';
import {
  OpenIDReauthRequiredError,
  extractOpenIDTokenInfo,
  isOpenIDTokenValid,
  processOpenIDPlaceholders,
  isAccessTokenJwt,
} from './oidc';

describe('OpenID Token Utilities', () => {
  describe('extractOpenIDTokenInfo', () => {
    it('should extract token info from user with federatedTokens', () => {
      const user: Partial<IUser> = {
        id: 'user-123',
        provider: 'openid',
        openidId: 'oidc-sub-456',
        email: 'test@example.com',
        name: 'Test User',
        federatedTokens: {
          access_token: 'access-token-value',
          id_token: 'id-token-value',
          refresh_token: 'refresh-token-value',
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        },
      };

      const result = extractOpenIDTokenInfo(user);

      expect(result).toMatchObject({
        accessToken: 'access-token-value',
        idToken: 'id-token-value',
        userId: expect.any(String),
        userEmail: 'test@example.com',
        userName: 'Test User',
      });
      expect(result?.expiresAt).toBeDefined();
    });

    it('should return null when user is undefined', () => {
      const result = extractOpenIDTokenInfo(undefined);
      expect(result).toBeNull();
    });

    it('should return null when user is not OpenID provider', () => {
      const user: Partial<IUser> = {
        id: 'user-123',
        provider: 'email',
      };

      const result = extractOpenIDTokenInfo(user);
      expect(result).toBeNull();
    });

    it('should return token info when user has no federatedTokens but is OpenID provider', () => {
      const user: Partial<IUser> = {
        id: 'user-123',
        provider: 'openid',
        openidId: 'oidc-sub-456',
        email: 'test@example.com',
        name: 'Test User',
      };

      const result = extractOpenIDTokenInfo(user);

      expect(result).toMatchObject({
        userId: 'oidc-sub-456',
        userEmail: 'test@example.com',
        userName: 'Test User',
      });
      expect(result?.accessToken).toBeUndefined();
      expect(result?.idToken).toBeUndefined();
    });

    it('should extract partial token info when some tokens are missing', () => {
      const user: Partial<IUser> = {
        id: 'user-123',
        provider: 'openid',
        openidId: 'oidc-sub-456',
        email: 'test@example.com',
        federatedTokens: {
          access_token: 'access-token-value',
          id_token: undefined,
          refresh_token: undefined,
          expires_at: undefined,
        },
      };

      const result = extractOpenIDTokenInfo(user);

      expect(result).toMatchObject({
        accessToken: 'access-token-value',
        userId: 'oidc-sub-456',
        userEmail: 'test@example.com',
      });
    });

    it('should prioritize openidId over regular id', () => {
      const user: Partial<IUser> = {
        id: 'user-123',
        provider: 'openid',
        openidId: 'oidc-sub-456',
        federatedTokens: {
          access_token: 'access-token-value',
        },
      };

      const result = extractOpenIDTokenInfo(user);

      expect(result?.userId).toBe('oidc-sub-456');
    });

    it('should fall back to regular id when openidId is not available', () => {
      const user: Partial<IUser> = {
        id: 'user-123',
        provider: 'openid',
        federatedTokens: {
          access_token: 'access-token-value',
        },
      };

      const result = extractOpenIDTokenInfo(user);

      expect(result?.userId).toBe('user-123');
    });

    it('should keep the stored access token expiry when the ID token carries an older exp', () => {
      const nowSeconds = Math.floor(Date.now() / 1000);
      const staleIdTokenPayload = Buffer.from(
        JSON.stringify({ sub: 'oidc-sub-456', exp: nowSeconds - 3600 }),
      ).toString('base64');
      const user: Partial<IUser> = {
        id: 'user-123',
        provider: 'openid',
        openidId: 'oidc-sub-456',
        federatedTokens: {
          access_token: 'fresh-access-token',
          id_token: `header.${staleIdTokenPayload}.signature`,
          expires_at: nowSeconds + 3600,
        },
      };

      const result = extractOpenIDTokenInfo(user);

      expect(result?.expiresAt).toBe(nowSeconds + 3600);
      expect(isOpenIDTokenValid(result)).toBe(true);
      expect(processOpenIDPlaceholders('Bearer {{LIBRECHAT_OPENID_ACCESS_TOKEN}}', result)).toBe(
        'Bearer fresh-access-token',
      );
    });

    it('should leave expiresAt unset when no expires_at is stored, regardless of the ID token exp', () => {
      const nowSeconds = Math.floor(Date.now() / 1000);
      const idTokenPayload = Buffer.from(
        JSON.stringify({ sub: 'oidc-sub-456', exp: nowSeconds + 1800 }),
      ).toString('base64');
      const user: Partial<IUser> = {
        id: 'user-123',
        provider: 'openid',
        openidId: 'oidc-sub-456',
        federatedTokens: {
          access_token: 'access-token-value',
          id_token: `header.${idTokenPayload}.signature`,
        },
      };

      const result = extractOpenIDTokenInfo(user);

      expect(result?.expiresAt).toBeUndefined();
      expect(result?.idTokenExpiresAt).toBe(nowSeconds + 1800);
      expect(isOpenIDTokenValid(result)).toBe(true);
    });

    it('should keep an opaque access token valid when the stored ID token is already expired', () => {
      const nowSeconds = Math.floor(Date.now() / 1000);
      const staleIdTokenPayload = Buffer.from(
        JSON.stringify({ sub: 'oidc-sub-456', exp: nowSeconds - 3600 }),
      ).toString('base64');
      const user: Partial<IUser> = {
        id: 'user-123',
        provider: 'openid',
        openidId: 'oidc-sub-456',
        federatedTokens: {
          access_token: 'opaque-access-token',
          id_token: `header.${staleIdTokenPayload}.signature`,
        },
      };

      const result = extractOpenIDTokenInfo(user);

      expect(result?.expiresAt).toBeUndefined();
      expect(result?.idTokenExpiresAt).toBe(nowSeconds - 3600);
      expect(isOpenIDTokenValid(result)).toBe(true);
      expect(processOpenIDPlaceholders('{{LIBRECHAT_OPENID_ACCESS_TOKEN}}', result)).toBe(
        'opaque-access-token',
      );
      expect(() => processOpenIDPlaceholders('{{LIBRECHAT_OPENID_ID_TOKEN}}', result)).toThrow(
        OpenIDReauthRequiredError,
      );
    });

    it('should gate only the ID token on an exp of 0, leaving access token validity untouched', () => {
      const idTokenPayload = Buffer.from(JSON.stringify({ sub: 'oidc-sub-456', exp: 0 })).toString(
        'base64',
      );
      const user: Partial<IUser> = {
        id: 'user-123',
        provider: 'openid',
        openidId: 'oidc-sub-456',
        federatedTokens: {
          access_token: 'access-token-value',
          id_token: `header.${idTokenPayload}.signature`,
        },
      };

      const result = extractOpenIDTokenInfo(user);

      expect(result?.idTokenExpiresAt).toBe(0);
      expect(result?.expiresAt).toBeUndefined();
      expect(isOpenIDTokenValid(result)).toBe(true);
      expect(() => processOpenIDPlaceholders('{{LIBRECHAT_OPENID_ID_TOKEN}}', result)).toThrow(
        /re-authentication is required/,
      );
    });

    it('should ignore a non-numeric ID token exp', () => {
      const idTokenPayload = Buffer.from(
        JSON.stringify({ sub: 'oidc-sub-456', exp: '1700000000' }),
      ).toString('base64');
      const user: Partial<IUser> = {
        id: 'user-123',
        provider: 'openid',
        openidId: 'oidc-sub-456',
        federatedTokens: {
          access_token: 'access-token-value',
          id_token: `header.${idTokenPayload}.signature`,
        },
      };

      const result = extractOpenIDTokenInfo(user);

      expect(result?.idTokenExpiresAt).toBeUndefined();
      expect(result?.expiresAt).toBeUndefined();
      expect(() => processOpenIDPlaceholders('{{LIBRECHAT_OPENID_ID_TOKEN}}', result)).toThrow(
        /re-authentication is required/,
      );
    });

    it('should still enrich identity fields from ID token claims when expires_at is stored', () => {
      const nowSeconds = Math.floor(Date.now() / 1000);
      const idTokenPayload = Buffer.from(
        JSON.stringify({
          sub: 'claims-sub',
          email: 'claims@example.com',
          name: 'Claims Name',
          exp: nowSeconds - 3600,
        }),
      ).toString('base64');
      const user: Partial<IUser> = {
        id: 'user-123',
        provider: 'openid',
        openidId: 'oidc-sub-456',
        federatedTokens: {
          access_token: 'access-token-value',
          id_token: `header.${idTokenPayload}.signature`,
          expires_at: nowSeconds + 3600,
        },
      };

      const result = extractOpenIDTokenInfo(user);

      expect(result?.userId).toBe('claims-sub');
      expect(result?.userEmail).toBe('claims@example.com');
      expect(result?.userName).toBe('Claims Name');
    });
  });

  describe('isOpenIDTokenValid', () => {
    it('should return false when tokenInfo is null', () => {
      expect(isOpenIDTokenValid(null)).toBe(false);
    });

    it('should return false when tokenInfo has no accessToken', () => {
      const tokenInfo = {
        userId: 'oidc-sub-456',
      };

      expect(isOpenIDTokenValid(tokenInfo)).toBe(false);
    });

    it('should return true when token has access token and no expiresAt', () => {
      const tokenInfo = {
        accessToken: 'access-token-value',
        userId: 'oidc-sub-456',
      };

      expect(isOpenIDTokenValid(tokenInfo)).toBe(true);
    });

    it('should return true when token has not expired', () => {
      const futureTimestamp = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now
      const tokenInfo = {
        accessToken: 'access-token-value',
        expiresAt: futureTimestamp,
        userId: 'oidc-sub-456',
      };

      expect(isOpenIDTokenValid(tokenInfo)).toBe(true);
    });

    it('should return false when token has expired', () => {
      const pastTimestamp = Math.floor(Date.now() / 1000) - 3600; // 1 hour ago
      const tokenInfo = {
        accessToken: 'access-token-value',
        expiresAt: pastTimestamp,
        userId: 'oidc-sub-456',
      };

      expect(isOpenIDTokenValid(tokenInfo)).toBe(false);
    });

    it('should return false when token expires exactly now', () => {
      const nowTimestamp = Math.floor(Date.now() / 1000);
      const tokenInfo = {
        accessToken: 'access-token-value',
        expiresAt: nowTimestamp,
        userId: 'oidc-sub-456',
      };

      expect(isOpenIDTokenValid(tokenInfo)).toBe(false);
    });

    it('should return false when token expires within the expiry buffer', () => {
      const almostExpiredTimestamp = Math.floor(Date.now() / 1000) + 1;
      const tokenInfo = {
        accessToken: 'access-token-value',
        expiresAt: almostExpiredTimestamp,
        userId: 'oidc-sub-456',
      };

      expect(isOpenIDTokenValid(tokenInfo)).toBe(false);
    });

    it('should return true when token expires beyond the expiry buffer', () => {
      const beyondBufferTimestamp = Math.floor(Date.now() / 1000) + 120;
      const tokenInfo = {
        accessToken: 'access-token-value',
        expiresAt: beyondBufferTimestamp,
        userId: 'oidc-sub-456',
      };

      expect(isOpenIDTokenValid(tokenInfo)).toBe(true);
    });

    it('should pin the buffer boundary at 30 seconds', () => {
      const nowMs = 1_700_000_000_000;
      const nowSeconds = Math.floor(nowMs / 1000);
      const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(nowMs);

      try {
        expect(
          isOpenIDTokenValid({
            accessToken: 'access-token-value',
            expiresAt: nowSeconds + 29,
            userId: 'oidc-sub-456',
          }),
        ).toBe(false);
        expect(
          isOpenIDTokenValid({
            accessToken: 'access-token-value',
            expiresAt: nowSeconds + 31,
            userId: 'oidc-sub-456',
          }),
        ).toBe(true);
      } finally {
        nowSpy.mockRestore();
      }
    });

    it('should return false when expiresAt is 0', () => {
      const tokenInfo = {
        accessToken: 'access-token-value',
        expiresAt: 0,
        userId: 'oidc-sub-456',
      };

      expect(isOpenIDTokenValid(tokenInfo)).toBe(false);
    });
  });

  describe('processOpenIDPlaceholders', () => {
    it('should not substitute an expired ID token for the ID token placeholder', () => {
      const nowSeconds = Math.floor(Date.now() / 1000);
      const tokenInfo = {
        accessToken: 'fresh-access-token',
        idToken: 'stale-id-token-value',
        expiresAt: nowSeconds + 3600,
        idTokenExpiresAt: nowSeconds - 3600,
      };

      expect(() => processOpenIDPlaceholders('{{LIBRECHAT_OPENID_ID_TOKEN}}', tokenInfo)).toThrow(
        /re-authentication is required/,
      );
    });

    it('should substitute a current ID token for the ID token placeholder', () => {
      const nowSeconds = Math.floor(Date.now() / 1000);
      const tokenInfo = {
        accessToken: 'fresh-access-token',
        idToken: 'current-id-token-value',
        expiresAt: nowSeconds + 3600,
        idTokenExpiresAt: nowSeconds + 1800,
      };

      const result = processOpenIDPlaceholders('{{LIBRECHAT_OPENID_ID_TOKEN}}', tokenInfo);

      expect(result).toBe('current-id-token-value');
    });

    it('should replace LIBRECHAT_OPENID_TOKEN with access token', () => {
      const tokenInfo = {
        accessToken: 'access-token-value',
        idToken: 'id-token-value',
        userId: 'oidc-sub-456',
      };

      const input = 'Authorization: Bearer {{LIBRECHAT_OPENID_TOKEN}}';
      const result = processOpenIDPlaceholders(input, tokenInfo);

      expect(result).toBe('Authorization: Bearer access-token-value');
    });

    it('should replace LIBRECHAT_OPENID_ACCESS_TOKEN with access token', () => {
      const tokenInfo = {
        accessToken: 'access-token-value',
        userId: 'oidc-sub-456',
      };

      const input = 'Token: {{LIBRECHAT_OPENID_ACCESS_TOKEN}}';
      const result = processOpenIDPlaceholders(input, tokenInfo);

      expect(result).toBe('Token: access-token-value');
    });

    it('should replace LIBRECHAT_OPENID_ID_TOKEN with id token', () => {
      const tokenInfo = {
        idTokenExpiresAt: Math.floor(Date.now() / 1000) + 3600,
        idToken: 'id-token-value',
        userId: 'oidc-sub-456',
      };

      const input = 'ID Token: {{LIBRECHAT_OPENID_ID_TOKEN}}';
      const result = processOpenIDPlaceholders(input, tokenInfo);

      expect(result).toBe('ID Token: id-token-value');
    });

    it('should replace LIBRECHAT_OPENID_USER_ID with user id', () => {
      const tokenInfo = {
        userId: 'oidc-sub-456',
      };

      const input = 'User: {{LIBRECHAT_OPENID_USER_ID}}';
      const result = processOpenIDPlaceholders(input, tokenInfo);

      expect(result).toBe('User: oidc-sub-456');
    });

    it('should replace LIBRECHAT_OPENID_USER_EMAIL with user email', () => {
      const tokenInfo = {
        userEmail: 'test@example.com',
        userId: 'oidc-sub-456',
      };

      const input = 'Email: {{LIBRECHAT_OPENID_USER_EMAIL}}';
      const result = processOpenIDPlaceholders(input, tokenInfo);

      expect(result).toBe('Email: test@example.com');
    });

    it('should replace LIBRECHAT_OPENID_USER_NAME with user name', () => {
      const tokenInfo = {
        userName: 'Test User',
        userId: 'oidc-sub-456',
      };

      const input = 'Name: {{LIBRECHAT_OPENID_USER_NAME}}';
      const result = processOpenIDPlaceholders(input, tokenInfo);

      expect(result).toBe('Name: Test User');
    });

    it('should replace multiple placeholders in a single string', () => {
      const tokenInfo = {
        accessToken: 'access-token-value',
        idToken: 'id-token-value',
        idTokenExpiresAt: Math.floor(Date.now() / 1000) + 3600,
        userId: 'oidc-sub-456',
        userEmail: 'test@example.com',
      };

      const input =
        'Authorization: Bearer {{LIBRECHAT_OPENID_TOKEN}}, ID: {{LIBRECHAT_OPENID_ID_TOKEN}}, User: {{LIBRECHAT_OPENID_USER_ID}}';
      const result = processOpenIDPlaceholders(input, tokenInfo);

      expect(result).toBe(
        'Authorization: Bearer access-token-value, ID: id-token-value, User: oidc-sub-456',
      );
    });

    it('should replace empty string when token field is undefined', () => {
      const tokenInfo = {
        accessToken: undefined,
        userId: 'oidc-sub-456',
      };

      const input = 'Access: {{LIBRECHAT_OPENID_TOKEN}}, User: {{LIBRECHAT_OPENID_USER_ID}}';
      const result = processOpenIDPlaceholders(input, tokenInfo);

      expect(result).toBe('Access: , User: oidc-sub-456');
    });

    it('should throw for the ID token placeholder when no ID token is stored', () => {
      const tokenInfo = {
        accessToken: 'access-token-value',
        userId: 'oidc-sub-456',
      };

      expect(() => processOpenIDPlaceholders('{{LIBRECHAT_OPENID_ID_TOKEN}}', tokenInfo)).toThrow(
        /re-authentication is required/,
      );
    });

    it('should throw for the ID token placeholder when the ID token has no decodable exp', () => {
      const tokenInfo = {
        accessToken: 'access-token-value',
        idToken: 'malformed-id-token',
        userId: 'oidc-sub-456',
      };

      expect(() => processOpenIDPlaceholders('{{LIBRECHAT_OPENID_ID_TOKEN}}', tokenInfo)).toThrow(
        /re-authentication is required/,
      );
    });

    it('should handle all placeholder types in one value', () => {
      const tokenInfo = {
        accessToken: 'access-token-value',
        idToken: 'id-token-value',
        idTokenExpiresAt: Math.floor(Date.now() / 1000) + 3600,
        userId: 'oidc-sub-456',
        userEmail: 'test@example.com',
        userName: 'Test User',
        expiresAt: 1234567890,
      };

      const input = `
        Authorization: Bearer {{LIBRECHAT_OPENID_TOKEN}}
        ID Token: {{LIBRECHAT_OPENID_ID_TOKEN}}
        Access Token (alt): {{LIBRECHAT_OPENID_ACCESS_TOKEN}}
        User ID: {{LIBRECHAT_OPENID_USER_ID}}
        User Email: {{LIBRECHAT_OPENID_USER_EMAIL}}
        User Name: {{LIBRECHAT_OPENID_USER_NAME}}
        Expires: {{LIBRECHAT_OPENID_EXPIRES_AT}}
      `;

      const result = processOpenIDPlaceholders(input, tokenInfo);

      expect(result).toContain('Bearer access-token-value');
      expect(result).toContain('ID Token: id-token-value');
      expect(result).toContain('Access Token (alt): access-token-value');
      expect(result).toContain('User ID: oidc-sub-456');
      expect(result).toContain('User Email: test@example.com');
      expect(result).toContain('User Name: Test User');
      expect(result).toContain('Expires: 1234567890');
    });

    it('should not modify string when no placeholders are present', () => {
      const tokenInfo = {
        accessToken: 'access-token-value',
        userId: 'oidc-sub-456',
      };

      const input = 'Authorization: Bearer static-token';
      const result = processOpenIDPlaceholders(input, tokenInfo);

      expect(result).toBe('Authorization: Bearer static-token');
    });

    it('should handle case-sensitive placeholders', () => {
      const tokenInfo = {
        accessToken: 'access-token-value',
        userId: 'oidc-sub-456',
      };

      // Wrong case should NOT be replaced
      const input = 'Token: {{librechat_openid_token}}';
      const result = processOpenIDPlaceholders(input, tokenInfo);

      expect(result).toBe('Token: {{librechat_openid_token}}');
    });

    it('should handle multiple occurrences of the same placeholder', () => {
      const tokenInfo = {
        accessToken: 'access-token-value',
        userId: 'oidc-sub-456',
      };

      const input =
        'Primary: {{LIBRECHAT_OPENID_TOKEN}}, Secondary: {{LIBRECHAT_OPENID_TOKEN}}, Backup: {{LIBRECHAT_OPENID_TOKEN}}';
      const result = processOpenIDPlaceholders(input, tokenInfo);

      expect(result).toBe(
        'Primary: access-token-value, Secondary: access-token-value, Backup: access-token-value',
      );
    });

    it('should handle token info with all fields undefined except userId', () => {
      const tokenInfo = {
        accessToken: undefined,
        idToken: undefined,
        userId: 'oidc-sub-456',
        userEmail: undefined,
        userName: undefined,
      };

      const input = 'Access: {{LIBRECHAT_OPENID_TOKEN}}, User: {{LIBRECHAT_OPENID_USER_ID}}';
      const result = processOpenIDPlaceholders(input, tokenInfo);

      expect(result).toBe('Access: , User: oidc-sub-456');
    });

    it('should return original value when tokenInfo is null', () => {
      const input = 'Authorization: Bearer {{LIBRECHAT_OPENID_TOKEN}}';
      const result = processOpenIDPlaceholders(input, null);

      expect(result).toBe('Authorization: Bearer {{LIBRECHAT_OPENID_TOKEN}}');
    });

    it('should return original value when value is not a string', () => {
      const tokenInfo = {
        accessToken: 'access-token-value',
        userId: 'oidc-sub-456',
      };

      const result = processOpenIDPlaceholders(123 as unknown as string, tokenInfo);

      expect(result).toBe(123);
    });
  });

  describe('Integration: Full OpenID Token Flow', () => {
    it('should extract, validate, and process tokens correctly', () => {
      const user: Partial<IUser> = {
        id: 'user-123',
        provider: 'openid',
        openidId: 'oidc-sub-456',
        email: 'test@example.com',
        name: 'Test User',
        federatedTokens: {
          access_token: 'access-token-value',
          id_token: 'id-token-value',
          refresh_token: 'refresh-token-value',
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        },
      };

      // Step 1: Extract token info
      const tokenInfo = extractOpenIDTokenInfo(user);
      expect(tokenInfo).not.toBeNull();

      // Step 2: Validate token
      const isValid = isOpenIDTokenValid(tokenInfo!);
      expect(isValid).toBe(true);

      // Step 3: Process placeholders
      const input =
        'Authorization: Bearer {{LIBRECHAT_OPENID_TOKEN}}, User: {{LIBRECHAT_OPENID_USER_ID}}';
      const result = processOpenIDPlaceholders(input, tokenInfo!);
      expect(result).toContain('Authorization: Bearer access-token-value');
      expect(result).toContain('User:');
    });

    it('should resolve LIBRECHAT_OPENID_ID_TOKEN and LIBRECHAT_OPENID_ACCESS_TOKEN to different values', () => {
      const nowSeconds = Math.floor(Date.now() / 1000);
      const idTokenPayload = Buffer.from(
        JSON.stringify({ sub: 'oidc-sub-456', exp: nowSeconds + 3600 }),
      ).toString('base64');
      const myIdToken = `header.${idTokenPayload}.signature`;
      const user: Partial<IUser> = {
        id: 'user-123',
        provider: 'openid',
        openidId: 'oidc-sub-456',
        email: 'test@example.com',
        name: 'Test User',
        federatedTokens: {
          access_token: 'my-access-token',
          id_token: myIdToken,
          refresh_token: 'my-refresh-token',
          expires_at: nowSeconds + 3600,
        },
      };

      const tokenInfo = extractOpenIDTokenInfo(user);
      expect(tokenInfo).not.toBeNull();
      expect(tokenInfo!.accessToken).toBe('my-access-token');
      expect(tokenInfo!.idToken).toBe(myIdToken);
      expect(tokenInfo!.accessToken).not.toBe(tokenInfo!.idToken);

      const input = 'ACCESS={{LIBRECHAT_OPENID_ACCESS_TOKEN}}, ID={{LIBRECHAT_OPENID_ID_TOKEN}}';
      const result = processOpenIDPlaceholders(input, tokenInfo!);

      expect(result).toBe(`ACCESS=my-access-token, ID=${myIdToken}`);
      // Verify they are not the same value (the reported bug)
      expect(result).not.toBe('ACCESS=my-access-token, ID=my-access-token');
    });

    it('should handle expired tokens correctly', () => {
      const user: Partial<IUser> = {
        id: 'user-123',
        provider: 'openid',
        openidId: 'oidc-sub-456',
        federatedTokens: {
          access_token: 'access-token-value',
          expires_at: Math.floor(Date.now() / 1000) - 3600, // Expired 1 hour ago
        },
      };

      const tokenInfo = extractOpenIDTokenInfo(user);
      expect(tokenInfo).not.toBeNull();

      const isValid = isOpenIDTokenValid(tokenInfo!);
      expect(isValid).toBe(false); // Token is expired

      // Even if expired, processOpenIDPlaceholders should still work
      // (validation is checked separately by the caller)
      const input = 'Authorization: Bearer {{LIBRECHAT_OPENID_TOKEN}}';
      const result = processOpenIDPlaceholders(input, tokenInfo!);
      expect(result).toBe('Authorization: Bearer access-token-value');
    });

    it('should handle user with no federatedTokens but still has OpenID provider', () => {
      const user: Partial<IUser> = {
        id: 'user-123',
        provider: 'openid',
        openidId: 'oidc-sub-456',
      };

      const tokenInfo = extractOpenIDTokenInfo(user);
      expect(tokenInfo).not.toBeNull();
      expect(tokenInfo?.userId).toBe('oidc-sub-456');
      expect(tokenInfo?.accessToken).toBeUndefined();
    });

    it('should handle missing user', () => {
      const tokenInfo = extractOpenIDTokenInfo(undefined);
      expect(tokenInfo).toBeNull();
    });

    it('should handle non-OpenID users', () => {
      const user: Partial<IUser> = {
        id: 'user-123',
        provider: 'email',
      };

      const tokenInfo = extractOpenIDTokenInfo(user);
      expect(tokenInfo).toBeNull();
    });
  });

  describe('isAccessTokenJwt', () => {
    const encodeSegment = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64');
    const makeJwt = (claims: object, header: object = { alg: 'RS256' }) =>
      `${encodeSegment(header)}.${encodeSegment(claims)}.signature`;
    const audiences = { resources: new Set(['api://resource-app']), clientId: 'client-id' };

    it('accepts an RFC 9068 `at+jwt` header type regardless of case', () => {
      const claims = { aud: 'client-id' };
      expect(isAccessTokenJwt(makeJwt(claims, { alg: 'RS256', typ: 'at+JWT' }), claims)).toBe(true);
      expect(
        isAccessTokenJwt(makeJwt(claims, { alg: 'RS256', typ: 'application/at+jwt' }), claims),
      ).toBe(true);
    });

    it('accepts a token whose audience names a configured resource', () => {
      const claims = { aud: 'api://resource-app' };
      expect(isAccessTokenJwt(makeJwt(claims), claims, audiences)).toBe(true);
    });

    it('accepts a scope claim once the audience has ruled out an ID token', () => {
      const scp = { aud: 'api://other-app', scp: 'User.Read Files.Read' };
      const scope = { aud: 'api://other-app', scope: 'openid api.read' };
      expect(isAccessTokenJwt(makeJwt(scp), scp, audiences)).toBe(true);
      expect(isAccessTokenJwt(makeJwt(scope), scope, audiences)).toBe(true);
    });

    it('does not treat `nonce` or `auth_time` as disqualifying once the audience has ruled out an ID token', () => {
      const claims = {
        aud: 'api://resource-app',
        scope: 'api.read',
        nonce: 'abc',
        auth_time: 1700000000,
      };
      expect(isAccessTokenJwt(makeJwt(claims), claims, audiences)).toBe(true);
    });

    it('rejects a scope claim while the client id is still an audience', () => {
      const claims = { aud: 'client-id', scp: 'User.Read' };
      expect(isAccessTokenJwt(makeJwt(claims), claims, audiences)).toBe(false);
    });

    it('rejects an ID token carrying a provider-added scope claim', () => {
      const claims = { aud: 'client-id', scope: 'openid email profile', nonce: 'n-0S6_WzA2Mj' };
      expect(isAccessTokenJwt(makeJwt(claims), claims, audiences)).toBe(false);
    });

    it('rejects a multi-audience ID token that also names a configured resource', () => {
      const claims = { aud: ['client-id', 'api://resource-app'], nonce: 'n-0S6_WzA2Mj' };
      expect(isAccessTokenJwt(makeJwt(claims), claims, audiences)).toBe(false);
    });

    it('rejects an Entra-shaped ID token', () => {
      const claims = { aud: 'client-id', nonce: 'n-0S6_WzA2Mj', tid: 'tenant-1', oid: 'object-1' };
      expect(isAccessTokenJwt(makeJwt(claims), claims, audiences)).toBe(false);
    });

    it('rejects a token bearing the ID-token-only `at_hash` claim even when scoped', () => {
      const claims = { aud: 'api://resource-app', scp: 'User.Read', at_hash: 'HK6E_P6Dh8Y93mRN' };
      expect(isAccessTokenJwt(makeJwt(claims), claims, audiences)).toBe(false);
    });

    it('rejects a token bearing the ID-token-only `c_hash` claim', () => {
      const claims = { aud: 'api://resource-app', scope: 'api.read', c_hash: 'LDktKdoQak3Pk0cn' };
      expect(isAccessTokenJwt(makeJwt(claims), claims, audiences)).toBe(false);
    });

    it('rejects a token whose audience is only the OIDC client id', () => {
      const claims = { aud: 'client-id' };
      expect(isAccessTokenJwt(makeJwt(claims), claims, audiences)).toBe(false);
    });

    it('qualifies nothing but `at+jwt` when no client id is configured', () => {
      const claims = { aud: 'api://resource-app', scp: 'User.Read' };
      expect(isAccessTokenJwt(makeJwt(claims), claims)).toBe(false);
      expect(isAccessTokenJwt(makeJwt(claims, { alg: 'RS256', typ: 'at+jwt' }), claims)).toBe(true);
    });

    it('rejects a missing token, missing claims, or an unparseable header', () => {
      expect(isAccessTokenJwt(undefined, { aud: 'api://resource-app' }, audiences)).toBe(false);
      expect(isAccessTokenJwt('a.b.c', undefined, audiences)).toBe(false);
      expect(isAccessTokenJwt('not-a-jwt', { aud: 'client-id' }, audiences)).toBe(false);
    });
  });
});
