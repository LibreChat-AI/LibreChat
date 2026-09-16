import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import {
  extractOpenIDTokenInfo,
  processOpenIDPlaceholders,
  isOpenIDTokenValid,
  createBearerAuthHeader,
  isOpenIDAvailable,
  type OpenIDTokenInfo,
} from '../packages/api/src/utils/oidc';
import { processMCPEnv, resolveHeaders } from '../packages/api/src/utils/env';
import type { TUser } from 'librechat-data-provider';
import type { IUser } from '@librechat/data-schemas';

// Mock logger to avoid console output during tests
jest.mock('@librechat/data-schemas', () => ({
  logger: {
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
  },
}));

describe('OpenID Connect Federated Provider Token Integration', () => {
  // Mock user with Cognito tokens
  const mockCognitoUser: Partial<IUser> = {
    id: 'user-123',
    email: 'test@example.com',
    name: 'Test User',
    provider: 'openid',
    openidId: 'cognito-user-123',
    federatedTokens: {
      access_token: 'cognito-access-token-123',
      id_token:
        'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJjb2duaXRvLXVzZXItMTIzIiwiZW1haWwiOiJ0ZXN0QGV4YW1wbGUuY29tIiwibmFtZSI6IlRlc3QgVXNlciIsImV4cCI6MTcwMDAwMDAwMH0.fake-signature',
      expires_at: Math.floor(Date.now() / 1000) + 3600, // Expires in 1 hour
    },
  };

  const mockExpiredCognitoUser: Partial<IUser> = {
    ...mockCognitoUser,
    federatedTokens: {
      access_token: 'expired-cognito-token',
      id_token: 'expired-cognito-id-token',
      expires_at: Math.floor(Date.now() / 1000) - 3600, // Expired 1 hour ago
    },
  };

  // Mock user with tokens in alternative location
  const mockOpenIDTokensUser: Partial<IUser> = {
    id: 'user-456',
    email: 'alt@example.com',
    name: 'Alt User',
    provider: 'openid',
    openidId: 'alt-user-456',
    openidTokens: {
      access_token: 'alt-access-token-456',
      id_token: 'alt-id-token-789',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('extractOpenIDTokenInfo', () => {
    it('should extract federated provider token info from Cognito user', () => {
      const tokenInfo = extractOpenIDTokenInfo(mockCognitoUser as IUser);

      expect(tokenInfo).toEqual({
        accessToken: 'cognito-access-token-123',
        idToken: expect.stringContaining('eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9'),
        expiresAt: expect.any(Number),
        userId: 'cognito-user-123',
        userEmail: 'test@example.com',
        userName: 'Test User',
        claims: expect.objectContaining({
          sub: 'cognito-user-123',
          email: 'test@example.com',
          name: 'Test User',
        }),
      });
    });

    it('should extract tokens from alternative storage location', () => {
      const tokenInfo = extractOpenIDTokenInfo(mockOpenIDTokensUser as IUser);

      expect(tokenInfo).toEqual({
        accessToken: 'alt-access-token-456',
        idToken: 'alt-id-token-789',
        expiresAt: expect.any(Number),
        userId: 'alt-user-456',
        userEmail: 'alt@example.com',
        userName: 'Alt User',
      });
    });

    it('should return null for non-OpenID user', () => {
      const nonOpenIDUser: Partial<IUser> = {
        id: 'user-123',
        provider: 'google',
        email: 'test@example.com',
      };

      const tokenInfo = extractOpenIDTokenInfo(nonOpenIDUser as IUser);
      expect(tokenInfo).toBeNull();
    });

    it('should return null for null/undefined user', () => {
      expect(extractOpenIDTokenInfo(null)).toBeNull();
      expect(extractOpenIDTokenInfo(undefined)).toBeNull();
    });

    it('should handle JWT parsing errors gracefully', () => {
      const userWithMalformedJWT: Partial<IUser> = {
        ...mockCognitoUser,
        federatedTokens: {
          access_token: 'valid-access-token',
          id_token: 'malformed.jwt.token',
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        },
      };

      const tokenInfo = extractOpenIDTokenInfo(userWithMalformedJWT as IUser);

      expect(tokenInfo).toBeDefined();
      expect(tokenInfo?.accessToken).toBe('valid-access-token');
      expect(tokenInfo?.claims).toBeUndefined();
    });
  });

  describe('isOpenIDTokenValid', () => {
    it('should return true for valid Cognito token', () => {
      const tokenInfo = extractOpenIDTokenInfo(mockCognitoUser as IUser);
      expect(isOpenIDTokenValid(tokenInfo)).toBe(true);
    });

    it('should return false for expired Cognito token', () => {
      const tokenInfo = extractOpenIDTokenInfo(mockExpiredCognitoUser as IUser);
      expect(isOpenIDTokenValid(tokenInfo)).toBe(false);
    });

    it('should return false for null token info', () => {
      expect(isOpenIDTokenValid(null)).toBe(false);
    });

    it('should return false for token info without access token', () => {
      const tokenInfo: OpenIDTokenInfo = {
        userId: 'user-123',
        userEmail: 'test@example.com',
      };
      expect(isOpenIDTokenValid(tokenInfo)).toBe(false);
    });
  });

  describe('processOpenIDPlaceholders', () => {
    const tokenInfo: OpenIDTokenInfo = {
      accessToken: 'cognito-access-token-123',
      idToken: 'cognito-id-token-456',
      userId: 'cognito-user-789',
      userEmail: 'cognito@example.com',
      userName: 'Cognito User',
      expiresAt: 1700000000,
    };

    it('should replace OpenID Connect token placeholders', () => {
      const template = 'Bearer {{LIBRECHAT_OPENID_TOKEN}}';
      const result = processOpenIDPlaceholders(template, tokenInfo);
      expect(result).toBe('Bearer cognito-access-token-123');
    });

    it('should replace specific OpenID Connect placeholders', () => {
      const template = `
        Access: {{LIBRECHAT_OPENID_ACCESS_TOKEN}}
        ID: {{LIBRECHAT_OPENID_ID_TOKEN}}
        User: {{LIBRECHAT_OPENID_USER_ID}}
        Email: {{LIBRECHAT_OPENID_USER_EMAIL}}
        Name: {{LIBRECHAT_OPENID_USER_NAME}}
        Expires: {{LIBRECHAT_OPENID_EXPIRES_AT}}
      `;

      const result = processOpenIDPlaceholders(template, tokenInfo);

      expect(result).toContain('Access: cognito-access-token-123');
      expect(result).toContain('ID: cognito-id-token-456');
      expect(result).toContain('User: cognito-user-789');
      expect(result).toContain('Email: cognito@example.com');
      expect(result).toContain('Name: Cognito User');
      expect(result).toContain('Expires: 1700000000');
    });

    it('should handle missing token fields gracefully', () => {
      const partialTokenInfo: OpenIDTokenInfo = {
        accessToken: 'partial-cognito-token',
        userId: 'user-123',
      };

      const template = 'Token: {{LIBRECHAT_OPENID_TOKEN}}, Email: {{LIBRECHAT_OPENID_USER_EMAIL}}';
      const result = processOpenIDPlaceholders(template, partialTokenInfo);

      expect(result).toBe('Token: partial-cognito-token, Email: ');
    });

    it('should return original value for null token info', () => {
      const template = 'Bearer {{LIBRECHAT_OPENID_TOKEN}}';
      const result = processOpenIDPlaceholders(template, null);
      expect(result).toBe(template);
    });
  });

  describe('createBearerAuthHeader', () => {
    it('should create proper Bearer header with Cognito token', () => {
      const tokenInfo: OpenIDTokenInfo = {
        accessToken: 'cognito-test-token-123',
      };

      const header = createBearerAuthHeader(tokenInfo);
      expect(header).toBe('Bearer cognito-test-token-123');
    });

    it('should return empty string for null token info', () => {
      const header = createBearerAuthHeader(null);
      expect(header).toBe('');
    });

    it('should return empty string for token info without access token', () => {
      const tokenInfo: OpenIDTokenInfo = {
        userId: 'user-123',
      };

      const header = createBearerAuthHeader(tokenInfo);
      expect(header).toBe('');
    });
  });

  describe('isOpenIDAvailable', () => {
    const originalEnv = process.env;

    beforeEach(() => {
      jest.resetModules();
      process.env = { ...originalEnv };
    });

    afterAll(() => {
      process.env = originalEnv;
    });

    it('should return true when OpenID Connect is properly configured for Cognito', () => {
      process.env.OPENID_CLIENT_ID = 'cognito-client-id';
      process.env.OPENID_CLIENT_SECRET = 'cognito-client-secret';
      process.env.OPENID_ISSUER = 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_ABC123';

      expect(isOpenIDAvailable()).toBe(true);
    });

    it('should return false when OpenID Connect is not configured', () => {
      delete process.env.OPENID_CLIENT_ID;
      delete process.env.OPENID_CLIENT_SECRET;
      delete process.env.OPENID_ISSUER;

      expect(isOpenIDAvailable()).toBe(false);
    });

    it('should return false when OpenID Connect is partially configured', () => {
      process.env.OPENID_CLIENT_ID = 'cognito-client-id';
      delete process.env.OPENID_CLIENT_SECRET;
      delete process.env.OPENID_ISSUER;

      expect(isOpenIDAvailable()).toBe(false);
    });
  });

  describe('Integration with resolveHeaders', () => {
    it('should resolve OpenID Connect placeholders in headers for Cognito', () => {
      const headers = {
        Authorization: '{{LIBRECHAT_OPENID_TOKEN}}',
        'X-User-ID': '{{LIBRECHAT_OPENID_USER_ID}}',
        'X-User-Email': '{{LIBRECHAT_OPENID_USER_EMAIL}}',
      };

      const resolvedHeaders = resolveHeaders({
        headers,
        user: mockCognitoUser as TUser,
      });

      expect(resolvedHeaders['Authorization']).toBe('cognito-access-token-123');
      expect(resolvedHeaders['X-User-ID']).toBe('cognito-user-123');
      expect(resolvedHeaders['X-User-Email']).toBe('test@example.com');
    });

    it('should work with Bearer token format for Cognito', () => {
      const headers = {
        Authorization: 'Bearer {{LIBRECHAT_OPENID_TOKEN}}',
      };

      const resolvedHeaders = resolveHeaders({
        headers,
        user: mockCognitoUser as TUser,
      });

      expect(resolvedHeaders['Authorization']).toBe('Bearer cognito-access-token-123');
    });

    it('should work with specific access token placeholder', () => {
      const headers = {
        Authorization: 'Bearer {{LIBRECHAT_OPENID_ACCESS_TOKEN}}',
        'X-Cognito-ID-Token': '{{LIBRECHAT_OPENID_ID_TOKEN}}',
      };

      const resolvedHeaders = resolveHeaders({
        headers,
        user: mockCognitoUser as TUser,
      });

      expect(resolvedHeaders['Authorization']).toBe('Bearer cognito-access-token-123');
      expect(resolvedHeaders['X-Cognito-ID-Token']).toContain(
        'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9',
      );
    });
  });

  describe('Integration with processMCPEnv', () => {
    it('should process OpenID Connect placeholders in MCP environment variables for Cognito', () => {
      const mcpOptions = {
        command: 'node',
        args: ['server.js'],
        env: {
          COGNITO_ACCESS_TOKEN: '{{LIBRECHAT_OPENID_TOKEN}}',
          USER_ID: '{{LIBRECHAT_OPENID_USER_ID}}',
          USER_EMAIL: '{{LIBRECHAT_OPENID_USER_EMAIL}}',
        },
      };

      const processedOptions = processMCPEnv({
        options: mcpOptions,
        user: mockCognitoUser as TUser,
      });

      expect(processedOptions.env?.['COGNITO_ACCESS_TOKEN']).toBe('cognito-access-token-123');
      expect(processedOptions.env?.['USER_ID']).toBe('cognito-user-123');
      expect(processedOptions.env?.['USER_EMAIL']).toBe('test@example.com');
    });

    it('should process OpenID Connect placeholders in MCP headers for HTTP transport', () => {
      const mcpOptions = {
        type: 'sse' as const,
        url: 'https://api.example.com/mcp',
        headers: {
          Authorization: 'Bearer {{LIBRECHAT_OPENID_ACCESS_TOKEN}}',
          'X-Cognito-User-Info': '{{LIBRECHAT_OPENID_USER_EMAIL}}',
          'X-Cognito-ID-Token': '{{LIBRECHAT_OPENID_ID_TOKEN}}',
        },
      };

      const processedOptions = processMCPEnv({
        options: mcpOptions,
        user: mockCognitoUser as TUser,
      });

      expect(processedOptions.headers?.['Authorization']).toBe('Bearer cognito-access-token-123');
      expect(processedOptions.headers?.['X-Cognito-User-Info']).toBe('test@example.com');
      expect(processedOptions.headers?.['X-Cognito-ID-Token']).toContain(
        'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9',
      );
    });

    it('should handle AWS-specific MCP server configuration', () => {
      const awsMcpOptions = {
        command: 'node',
        args: ['aws-mcp-server.js'],
        env: {
          AWS_COGNITO_TOKEN: '{{LIBRECHAT_OPENID_ACCESS_TOKEN}}',
          AWS_COGNITO_ID_TOKEN: '{{LIBRECHAT_OPENID_ID_TOKEN}}',
          COGNITO_USER_SUB: '{{LIBRECHAT_OPENID_USER_ID}}',
        },
      };

      const processedOptions = processMCPEnv({
        options: awsMcpOptions,
        user: mockCognitoUser as TUser,
      });

      expect(processedOptions.env?.['AWS_COGNITO_TOKEN']).toBe('cognito-access-token-123');
      expect(processedOptions.env?.['AWS_COGNITO_ID_TOKEN']).toContain(
        'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9',
      );
      expect(processedOptions.env?.['COGNITO_USER_SUB']).toBe('cognito-user-123');
    });
  });

  describe('Security and Edge Cases', () => {
    it('should not process OpenID Connect placeholders for expired tokens', () => {
      const headers = {
        Authorization: 'Bearer {{LIBRECHAT_OPENID_TOKEN}}',
      };

      const resolvedHeaders = resolveHeaders({
        headers,
        user: mockExpiredCognitoUser as TUser,
      });

      // Should not replace placeholder if token is expired
      expect(resolvedHeaders['Authorization']).toBe('Bearer {{LIBRECHAT_OPENID_TOKEN}}');
    });

    it('should handle malformed federated token data gracefully', () => {
      const malformedUser: Partial<IUser> = {
        id: 'user-123',
        provider: 'openid',
        openidId: 'cognito-user',
        federatedTokens: null, // Malformed tokens
      };

      const headers = {
        Authorization: 'Bearer {{LIBRECHAT_OPENID_TOKEN}}',
      };

      const resolvedHeaders = resolveHeaders({
        headers,
        user: malformedUser as TUser,
      });

      // Should not replace placeholder if token extraction fails
      expect(resolvedHeaders['Authorization']).toBe('Bearer {{LIBRECHAT_OPENID_TOKEN}}');
    });

    it('should handle multiple placeholder instances in same string', () => {
      const template =
        '{{LIBRECHAT_OPENID_TOKEN}}-{{LIBRECHAT_OPENID_TOKEN}}-{{LIBRECHAT_OPENID_USER_ID}}';

      const tokenInfo: OpenIDTokenInfo = {
        accessToken: 'cognito-token123',
        userId: 'cognito-user456',
      };

      const result = processOpenIDPlaceholders(template, tokenInfo);
      expect(result).toBe('cognito-token123-cognito-token123-cognito-user456');
    });

    it('should handle users without federated tokens storage', () => {
      const userWithoutTokens: Partial<IUser> = {
        id: 'user-789',
        provider: 'openid',
        openidId: 'user-without-tokens',
        email: 'no-tokens@example.com',
        // No federatedTokens or openidTokens
      };

      const headers = {
        Authorization: 'Bearer {{LIBRECHAT_OPENID_TOKEN}}',
      };

      const resolvedHeaders = resolveHeaders({
        headers,
        user: userWithoutTokens as TUser,
      });

      // Should not replace placeholder if no tokens available
      expect(resolvedHeaders['Authorization']).toBe('Bearer {{LIBRECHAT_OPENID_TOKEN}}');
    });

    it('should prioritize federatedTokens over openidTokens', () => {
      const userWithBothTokens: Partial<IUser> = {
        id: 'user-priority',
        provider: 'openid',
        openidId: 'priority-user',
        federatedTokens: {
          access_token: 'federated-priority-token',
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        },
        openidTokens: {
          access_token: 'openid-fallback-token',
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        },
      };

      const tokenInfo = extractOpenIDTokenInfo(userWithBothTokens as IUser);
      expect(tokenInfo?.accessToken).toBe('federated-priority-token');
    });
  });
});
