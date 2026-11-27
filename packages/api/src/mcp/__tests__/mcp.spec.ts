import {
  MCPOptions,
  StdioOptionsSchema,
  StreamableHTTPOptionsSchema,
} from 'librechat-data-provider';
import type { TUser } from 'librechat-data-provider';
import type { IUser } from '@librechat/data-schemas';
import type { GraphTokenResolver } from '~/utils/graph';
import { preProcessGraphTokens } from '~/utils/graph';
import { processMCPEnv } from '~/utils/env';
import * as oidcUtils from '~/utils/oidc';

// Mock oidc utilities for graph token tests
jest.mock('~/utils/oidc', () => ({
  ...jest.requireActual('~/utils/oidc'),
  extractOpenIDTokenInfo: jest.fn(),
  isOpenIDTokenValid: jest.fn(),
}));

// Helper function to create test user objects
function createTestUser(
  overrides: Partial<TUser> & Record<string, unknown> = {},
): Omit<TUser, 'createdAt' | 'updatedAt'> | undefined {
  return {
    id: 'test-user-id',
    username: 'testuser',
    email: 'test@example.com',
    name: 'Test User',
    avatar: 'https://example.com/avatar.png',
    provider: 'email',
    role: 'user',
    ...overrides,
  };
}

describe('Environment Variable Extraction (MCP)', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      TEST_API_KEY: 'test-api-key-value',
      ANOTHER_SECRET: 'another-secret-value',
    };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('StdioOptionsSchema', () => {
    it('should transform environment variables in the env field', () => {
      const options = {
        command: 'node',
        args: ['server.js'],
        env: {
          API_KEY: '${TEST_API_KEY}',
          ANOTHER_KEY: '${ANOTHER_SECRET}',
          PLAIN_VALUE: 'plain-value',
          NON_EXISTENT: '${NON_EXISTENT_VAR}',
        },
      };

      const result = StdioOptionsSchema.parse(options);

      expect(result.env).toEqual({
        API_KEY: 'test-api-key-value',
        ANOTHER_KEY: 'another-secret-value',
        PLAIN_VALUE: 'plain-value',
        NON_EXISTENT: '${NON_EXISTENT_VAR}',
      });
    });

    it('should handle undefined env field', () => {
      const options = {
        command: 'node',
        args: ['server.js'],
      };

      const result = StdioOptionsSchema.parse(options);

      expect(result.env).toBeUndefined();
    });
  });

  describe('StreamableHTTPOptionsSchema', () => {
    it('should validate a valid streamable-http configuration', () => {
      const options = {
        type: 'streamable-http',
        url: 'https://example.com/api',
        headers: {
          Authorization: 'Bearer token',
          'Content-Type': 'application/json',
        },
      };

      const result = StreamableHTTPOptionsSchema.parse(options);

      expect(result).toEqual(options);
    });

    it('should reject websocket URLs', () => {
      const options = {
        type: 'streamable-http',
        url: 'ws://example.com/socket',
      };

      expect(() => StreamableHTTPOptionsSchema.parse(options)).toThrow();
    });

    it('should reject secure websocket URLs', () => {
      const options = {
        type: 'streamable-http',
        url: 'wss://example.com/socket',
      };

      expect(() => StreamableHTTPOptionsSchema.parse(options)).toThrow();
    });

    it('should require type field to be set explicitly', () => {
      const options = {
        url: 'https://example.com/api',
      };

      // Type is now required, so parsing should fail
      expect(() => StreamableHTTPOptionsSchema.parse(options)).toThrow();

      // With type provided, it should pass
      const validOptions = {
        type: 'streamable-http' as const,
        url: 'https://example.com/api',
      };

      const result = StreamableHTTPOptionsSchema.parse(validOptions);
      expect(result.type).toBe('streamable-http');
    });

    it('should validate headers as record of strings', () => {
      const options = {
        type: 'streamable-http',
        url: 'https://example.com/api',
        headers: {
          'X-API-Key': '123456',
          'User-Agent': 'MCP Client',
        },
      };

      const result = StreamableHTTPOptionsSchema.parse(options);

      expect(result.headers).toEqual(options.headers);
    });

    it('should validate proxy URLs for remote HTTP transports', () => {
      const options = {
        type: 'streamable-http',
        url: 'https://example.com/api',
        proxy: 'http://proxy.example.com:8080',
      };

      const result = StreamableHTTPOptionsSchema.parse(options);

      expect(result.proxy).toBe('http://proxy.example.com:8080');
    });

    it('should accept "http" as an alias for "streamable-http"', () => {
      const options = {
        type: 'http',
        url: 'https://example.com/api',
        headers: {
          Authorization: 'Bearer token',
        },
      };

      const result = StreamableHTTPOptionsSchema.parse(options);

      expect(result.type).toBe('http');
      expect(result.url).toBe('https://example.com/api');
      expect(result.headers).toEqual(options.headers);
    });

    it('should reject websocket URLs with "http" type', () => {
      const options = {
        type: 'http',
        url: 'ws://example.com/socket',
      };

      expect(() => StreamableHTTPOptionsSchema.parse(options)).toThrow();
    });
  });

  describe('processMCPEnv', () => {
    it('should create a deep clone of the input object', () => {
      const originalObj: MCPOptions = {
        type: 'stdio',
        command: 'node',
        args: ['server.js'],
        env: {
          API_KEY: '${TEST_API_KEY}',
          PLAIN_VALUE: 'plain-value',
        },
      };

      const result = processMCPEnv({ options: originalObj });

      // Verify it's not the same object reference
      expect(result).not.toBe(originalObj);

      // Modify the result and ensure original is unchanged
      if ('env' in result && result.env) {
        result.env.API_KEY = 'modified-value';
      }

      expect(originalObj.env?.API_KEY).toBe('${TEST_API_KEY}');
    });

    it('should process environment variables in env field', () => {
      const options: MCPOptions = {
        type: 'stdio',
        command: 'node',
        args: ['server.js'],
        env: {
          API_KEY: '${TEST_API_KEY}',
          ANOTHER_KEY: '${ANOTHER_SECRET}',
          PLAIN_VALUE: 'plain-value',
          NON_EXISTENT: '${NON_EXISTENT_VAR}',
        },
      };

      const result = processMCPEnv({ options });

      expect('env' in result && result.env).toEqual({
        API_KEY: 'test-api-key-value',
        ANOTHER_KEY: 'another-secret-value',
        PLAIN_VALUE: 'plain-value',
        NON_EXISTENT: '${NON_EXISTENT_VAR}',
      });
    });

    it('should process user ID in headers field', () => {
      const user = createTestUser({ id: 'test-user-123' });
      const options: MCPOptions = {
        type: 'sse',
        url: 'https://example.com',
        headers: {
          Authorization: '${TEST_API_KEY}',
          'User-Id': '{{LIBRECHAT_USER_ID}}',
          'Content-Type': 'application/json',
        },
      };

      const result = processMCPEnv({ options, user });

      expect('headers' in result && result.headers).toEqual({
        Authorization: 'test-api-key-value',
        'User-Id': 'test-user-123',
        'Content-Type': 'application/json',
      });
    });

    it('should handle null or undefined input', () => {
      // @ts-ignore - Testing null/undefined handling
      expect(processMCPEnv({ options: null })).toBeNull();
      // @ts-ignore - Testing null/undefined handling
      expect(processMCPEnv({ options: undefined })).toBeUndefined();
    });

    it('should not modify objects without env or headers', () => {
      const options: MCPOptions = {
        type: 'stdio',
        command: 'node',
        args: ['server.js'],
        timeout: 5000,
      };

      const result = processMCPEnv({ options });

      expect(result).toEqual(options);
      expect(result).not.toBe(options); // Still a different object (deep clone)
    });

    it('should ensure different users with same starting config get separate values', () => {
      // Create a single base configuration
      const baseConfig: MCPOptions = {
        type: 'sse',
        url: 'https://example.com',
        headers: {
          'User-Id': '{{LIBRECHAT_USER_ID}}',
          'API-Key': '${TEST_API_KEY}',
        },
      };

      // Process for two different users
      const user1 = createTestUser({ id: 'user-123' });
      const user2 = createTestUser({ id: 'user-456' });

      const resultUser1 = processMCPEnv({ options: baseConfig, user: user1 });
      const resultUser2 = processMCPEnv({ options: baseConfig, user: user2 });

      // Verify each has the correct user ID
      expect('headers' in resultUser1 && resultUser1.headers?.['User-Id']).toBe('user-123');
      expect('headers' in resultUser2 && resultUser2.headers?.['User-Id']).toBe('user-456');

      // Verify they're different objects
      expect(resultUser1).not.toBe(resultUser2);

      // Modify one result and ensure it doesn't affect the other
      if ('headers' in resultUser1 && resultUser1.headers) {
        resultUser1.headers['User-Id'] = 'modified-user';
      }

      // Original config should be unchanged
      expect(baseConfig.headers?.['User-Id']).toBe('{{LIBRECHAT_USER_ID}}');

      // Second user's config should be unchanged
      expect('headers' in resultUser2 && resultUser2.headers?.['User-Id']).toBe('user-456');
    });

    it('should process headers in streamable-http options', () => {
      const user = createTestUser({ id: 'test-user-123' });
      const options: MCPOptions = {
        type: 'streamable-http',
        url: 'https://example.com',
        headers: {
          Authorization: '${TEST_API_KEY}',
          'User-Id': '{{LIBRECHAT_USER_ID}}',
          'Content-Type': 'application/json',
        },
      };

      const result = processMCPEnv({ options, user });

      expect('headers' in result && result.headers).toEqual({
        Authorization: 'test-api-key-value',
        'User-Id': 'test-user-123',
        'Content-Type': 'application/json',
      });
    });

    it('should process proxy in streamable-http options', () => {
      process.env.MCP_PROXY_URL = 'http://proxy.example.com:8080';
      const options: MCPOptions = {
        type: 'streamable-http',
        url: 'https://example.com',
        proxy: '${MCP_PROXY_URL}',
      };

      const result = processMCPEnv({ options });

      expect('proxy' in result && result.proxy).toBe('http://proxy.example.com:8080');
      delete process.env.MCP_PROXY_URL;
    });

    it('should maintain streamable-http type in processed options', () => {
      const options: MCPOptions = {
        type: 'streamable-http',
        url: 'https://example.com/api',
      };

      const result = processMCPEnv({ options });

      expect(result.type).toBe('streamable-http');
    });

    it('should maintain http type in processed options', () => {
      const obj = {
        type: 'http' as const,
        url: 'https://example.com/api',
      };

      const result = processMCPEnv({ options: obj as unknown as MCPOptions });

      expect(result.type).toBe('http');
    });

    it('should process headers in http options', () => {
      const user = createTestUser({ id: 'test-user-123' });
      const obj = {
        type: 'http' as const,
        url: 'https://example.com',
        headers: {
          Authorization: '${TEST_API_KEY}',
          'User-Id': '{{LIBRECHAT_USER_ID}}',
          'Content-Type': 'application/json',
        },
      };

      const result = processMCPEnv({ options: obj as unknown as MCPOptions, user });

      expect('headers' in result && result.headers).toEqual({
        Authorization: 'test-api-key-value',
        'User-Id': 'test-user-123',
        'Content-Type': 'application/json',
      });
    });

    it('should process dynamic user fields in headers', () => {
      const user = createTestUser({
        id: 'user-123',
        email: 'test@example.com',
        username: 'testuser',
        openidId: 'openid-123',
        googleId: 'google-456',
        emailVerified: true,
        role: 'admin',
      });
      const options: MCPOptions = {
        type: 'sse',
        url: 'https://example.com',
        headers: {
          'User-Email': '{{LIBRECHAT_USER_EMAIL}}',
          'User-Name': '{{LIBRECHAT_USER_USERNAME}}',
          OpenID: '{{LIBRECHAT_USER_OPENIDID}}',
          'Google-ID': '{{LIBRECHAT_USER_GOOGLEID}}',
          'Email-Verified': '{{LIBRECHAT_USER_EMAILVERIFIED}}',
          'User-Role': '{{LIBRECHAT_USER_ROLE}}',
          'Content-Type': 'application/json',
        },
      };

      const result = processMCPEnv({ options, user });

      expect('headers' in result && result.headers).toEqual({
        'User-Email': 'test@example.com',
        'User-Name': 'testuser',
        OpenID: 'openid-123',
        'Google-ID': 'google-456',
        'Email-Verified': 'true',
        'User-Role': 'admin',
        'Content-Type': 'application/json',
      });
    });

    it('should handle missing user fields gracefully', () => {
      const user = createTestUser({
        id: 'user-123',
        email: 'test@example.com',
        username: undefined, // explicitly set to undefined to test missing field
      });
      const options: MCPOptions = {
        type: 'sse',
        url: 'https://example.com',
        headers: {
          'User-Email': '{{LIBRECHAT_USER_EMAIL}}',
          'User-Name': '{{LIBRECHAT_USER_USERNAME}}',
          'Content-Type': 'application/json',
        },
      };

      const result = processMCPEnv({ options, user });

      expect('headers' in result && result.headers).toEqual({
        'User-Email': 'test@example.com',
        'User-Name': '', // Empty string for missing field
        'Content-Type': 'application/json',
      });
    });

    it('should process user fields in env variables', () => {
      const user = createTestUser({
        id: 'user-123',
        email: 'test@example.com',
        ldapId: 'ldap-user-123',
      });
      const options: MCPOptions = {
        type: 'stdio',
        command: 'node',
        args: ['server.js'],
        env: {
          USER_EMAIL: '{{LIBRECHAT_USER_EMAIL}}',
          LDAP_ID: '{{LIBRECHAT_USER_LDAPID}}',
          API_KEY: '${TEST_API_KEY}',
        },
      };

      const result = processMCPEnv({ options, user });

      expect('env' in result && result.env).toEqual({
        USER_EMAIL: 'test@example.com',
        LDAP_ID: 'ldap-user-123',
        API_KEY: 'test-api-key-value',
      });
    });

    it('should process user fields in URL', () => {
      const user = createTestUser({
        id: 'user-123',
        username: 'testuser',
      });
      const options: MCPOptions = {
        type: 'sse',
        url: 'https://example.com/api/{{LIBRECHAT_USER_USERNAME}}/stream',
      };

      const result = processMCPEnv({ options, user });

      expect('url' in result && result.url).toBe('https://example.com/api/testuser/stream');
    });

    it('should handle boolean user fields', () => {
      const user = createTestUser({
        id: 'user-123',
        emailVerified: true,
        twoFactorEnabled: false,
        termsAccepted: true,
      });
      const options: MCPOptions = {
        type: 'sse',
        url: 'https://example.com',
        headers: {
          'Email-Verified': '{{LIBRECHAT_USER_EMAILVERIFIED}}',
          'Two-Factor': '{{LIBRECHAT_USER_TWOFACTORENABLED}}',
          'Terms-Accepted': '{{LIBRECHAT_USER_TERMSACCEPTED}}',
        },
      };

      const result = processMCPEnv({ options, user });

      expect('headers' in result && result.headers).toEqual({
        'Email-Verified': 'true',
        'Two-Factor': 'false',
        'Terms-Accepted': 'true',
      });
    });

    it('should not process sensitive fields like password', () => {
      const user = createTestUser({
        id: 'user-123',
        email: 'test@example.com',
        password: 'secret-password',
      });
      const options: MCPOptions = {
        type: 'sse',
        url: 'https://example.com',
        headers: {
          'User-Email': '{{LIBRECHAT_USER_EMAIL}}',
          'User-Password': '{{LIBRECHAT_USER_PASSWORD}}', // This should not be processed
        },
      };

      const result = processMCPEnv({ options, user });

      expect('headers' in result && result.headers).toEqual({
        'User-Email': 'test@example.com',
        'User-Password': '{{LIBRECHAT_USER_PASSWORD}}', // Unchanged
      });
    });

    it('should handle multiple occurrences of the same placeholder', () => {
      const user = createTestUser({
        id: 'user-123',
        email: 'test@example.com',
      });
      const options: MCPOptions = {
        type: 'sse',
        url: 'https://example.com',
        headers: {
          'Primary-Email': '{{LIBRECHAT_USER_EMAIL}}',
          'Secondary-Email': '{{LIBRECHAT_USER_EMAIL}}',
          'Backup-Email': '{{LIBRECHAT_USER_EMAIL}}',
        },
      };

      const result = processMCPEnv({ options, user });

      expect('headers' in result && result.headers).toEqual({
        'Primary-Email': 'test@example.com',
        'Secondary-Email': 'test@example.com',
        'Backup-Email': 'test@example.com',
      });
    });

    it('should support both id and _id properties for LIBRECHAT_USER_ID', () => {
      // Test with 'id' property
      const userWithId = createTestUser({
        id: 'user-123',
        email: 'test@example.com',
      });
      const obj1: MCPOptions = {
        type: 'sse',
        url: 'https://example.com',
        headers: {
          'User-Id': '{{LIBRECHAT_USER_ID}}',
        },
      };

      const result1 = processMCPEnv({ options: obj1, user: userWithId });
      expect('headers' in result1 && result1.headers?.['User-Id']).toBe('user-123');

      // Test with '_id' property only (should not work since we only check 'id')
      const userWithUnderscore = createTestUser({
        id: undefined, // Remove default id to test _id
        _id: 'user-456',
        email: 'test@example.com',
      });
      const obj2: MCPOptions = {
        type: 'sse',
        url: 'https://example.com',
        headers: {
          'User-Id': '{{LIBRECHAT_USER_ID}}',
        },
      };

      const result2 = processMCPEnv({ options: obj2, user: userWithUnderscore });
      // Since we don't check _id, the placeholder should remain unchanged
      expect('headers' in result2 && result2.headers?.['User-Id']).toBe('{{LIBRECHAT_USER_ID}}');

      // Test with both properties (id takes precedence)
      const userWithBoth = createTestUser({
        id: 'user-789',
        _id: 'user-000',
        email: 'test@example.com',
      });
      const obj3: MCPOptions = {
        type: 'sse',
        url: 'https://example.com',
        headers: {
          'User-Id': '{{LIBRECHAT_USER_ID}}',
        },
      };

      const result3 = processMCPEnv({ options: obj3, user: userWithBoth });
      expect('headers' in result3 && result3.headers?.['User-Id']).toBe('user-789');
    });

    it('should process customUserVars in env field', () => {
      const user = createTestUser();
      const customUserVars = {
        CUSTOM_VAR_1: 'custom-value-1',
        CUSTOM_VAR_2: 'custom-value-2',
      };
      const options: MCPOptions = {
        type: 'stdio',
        command: 'node',
        args: ['server.js'],
        env: {
          VAR_A: '{{CUSTOM_VAR_1}}',
          VAR_B: 'Value with {{CUSTOM_VAR_2}}',
          VAR_C: '${TEST_API_KEY}',
          VAR_D: '{{LIBRECHAT_USER_EMAIL}}',
        },
      };

      const result = processMCPEnv({ options, user, customUserVars });

      expect('env' in result && result.env).toEqual({
        VAR_A: 'custom-value-1',
        VAR_B: 'Value with custom-value-2',
        VAR_C: 'test-api-key-value',
        VAR_D: 'test@example.com',
      });
    });

    it('should process customUserVars in headers field', () => {
      const user = createTestUser();
      const customUserVars = {
        USER_TOKEN: 'user-specific-token',
        REGION: 'us-west-1',
      };
      const options: MCPOptions = {
        type: 'sse',
        url: 'https://example.com/api',
        headers: {
          Authorization: 'Bearer {{USER_TOKEN}}',
          'X-Region': '{{REGION}}',
          'X-System-Key': '${TEST_API_KEY}',
          'X-User-Id': '{{LIBRECHAT_USER_ID}}',
        },
      };

      const result = processMCPEnv({ options, user, customUserVars });

      expect('headers' in result && result.headers).toEqual({
        Authorization: 'Bearer user-specific-token',
        'X-Region': 'us-west-1',
        'X-System-Key': 'test-api-key-value',
        'X-User-Id': 'test-user-id',
      });
    });

    it('should process customUserVars in URL field', () => {
      const user = createTestUser();
      const customUserVars = {
        API_VERSION: 'v2',
        TENANT_ID: 'tenant123',
      };
      const options: MCPOptions = {
        type: 'websocket',
        url: 'wss://example.com/{{TENANT_ID}}/api/{{API_VERSION}}?user={{LIBRECHAT_USER_ID}}&key=${TEST_API_KEY}',
      };

      const result = processMCPEnv({ options, user, customUserVars });

      expect('url' in result && result.url).toBe(
        'wss://example.com/tenant123/api/v2?user=test-user-id&key=test-api-key-value',
      );
    });

    it('should process customUserVars in args field', () => {
      const user = createTestUser({
        id: 'user-123',
        email: 'test@example.com',
      });
      const customUserVars = {
        MY_API_KEY: 'user-provided-api-key-12345',
        PROFILE_NAME: 'production-profile',
      };
      const options: MCPOptions = {
        type: 'stdio',
        command: 'npx',
        args: [
          '-y',
          '@smithery/cli@latest',
          'run',
          '@upstash/context7-mcp',
          '--key',
          '{{MY_API_KEY}}',
          '--profile',
          '{{PROFILE_NAME}}',
          '--user',
          '{{LIBRECHAT_USER_EMAIL}}',
        ],
      };

      const result = processMCPEnv({ options, user, customUserVars });

      expect('args' in result && result.args).toEqual([
        '-y',
        '@smithery/cli@latest',
        'run',
        '@upstash/context7-mcp',
        '--key',
        'user-provided-api-key-12345',
        '--profile',
        'production-profile',
        '--user',
        'test@example.com',
      ]);
    });

    it('should prioritize customUserVars over user fields and system env vars if placeholders are the same (though not recommended)', () => {
      // This tests the order of operations: customUserVars -> userFields -> systemEnv
      // BUt it's generally not recommended to have overlapping placeholder names.
      process.env.LIBRECHAT_USER_EMAIL = 'system-email-should-be-overridden';
      const user = createTestUser({ email: 'user-email-should-be-overridden' });
      const customUserVars = {
        LIBRECHAT_USER_EMAIL: 'custom-email-wins',
      };
      const options: MCPOptions = {
        type: 'sse',
        url: 'https://example.com/api',
        headers: {
          'Test-Email': '{{LIBRECHAT_USER_EMAIL}}', // Placeholder that could match custom, user, or system
        },
      };

      const result = processMCPEnv({ options, user, customUserVars });
      expect('headers' in result && result.headers?.['Test-Email']).toBe('custom-email-wins');

      // Clean up env var
      delete process.env.LIBRECHAT_USER_EMAIL;
    });

    it('should handle customUserVars with no matching placeholders', () => {
      const user = createTestUser();
      const customUserVars = {
        UNUSED_VAR: 'unused-value',
      };
      const options: MCPOptions = {
        type: 'stdio',
        command: 'node',
        args: ['server.js'],
        env: {
          API_KEY: '${TEST_API_KEY}',
        },
      };

      const result = processMCPEnv({ options, user, customUserVars });
      expect('env' in result && result.env).toEqual({
        API_KEY: 'test-api-key-value',
      });
    });

    it('should handle placeholders with no matching customUserVars (falling back to user/system vars)', () => {
      const user = createTestUser({ email: 'user-provided-email@example.com' });
      // No customUserVars provided or customUserVars is empty
      const customUserVars = {};
      const options: MCPOptions = {
        type: 'sse',
        url: 'https://example.com/api',
        headers: {
          'User-Email-Header': '{{LIBRECHAT_USER_EMAIL}}', // Should use user.email
          'System-Key-Header': '${TEST_API_KEY}', // Should use process.env.TEST_API_KEY
          'Non-Existent-Custom': '{{NON_EXISTENT_CUSTOM_VAR}}', // Should remain as placeholder
        },
      };

      const result = processMCPEnv({ options, user, customUserVars });
      expect('headers' in result && result.headers).toEqual({
        'User-Email-Header': 'user-provided-email@example.com',
        'System-Key-Header': 'test-api-key-value',
        'Non-Existent-Custom': '{{NON_EXISTENT_CUSTOM_VAR}}',
      });
    });

    it('should correctly process a mix of all variable types', () => {
      const user = createTestUser({ id: 'userXYZ', username: 'john.doe' });
      const customUserVars = {
        CUSTOM_ENDPOINT_ID: 'ep123',
        ANOTHER_CUSTOM: 'another_val',
      };

      const obj = {
        type: 'streamable-http' as const,
        url: 'https://{{CUSTOM_ENDPOINT_ID}}.example.com/users/{{LIBRECHAT_USER_USERNAME}}',
        headers: {
          'X-Auth-Token': '{{CUSTOM_TOKEN_FROM_USER_SETTINGS}}', // Assuming this would be a custom var
          'X-User-ID': '{{LIBRECHAT_USER_ID}}',
          'X-System-Test-Key': '${TEST_API_KEY}', // Using existing env var from beforeEach
        },
        env: {
          PROCESS_MODE: '{{PROCESS_MODE_CUSTOM}}', // Another custom var
          USER_HOME_DIR: '/home/{{LIBRECHAT_USER_USERNAME}}',
          SYSTEM_PATH: '${PATH}', // Example of a system env var
        },
      };

      // Simulate customUserVars that would be passed, including those for headers and env
      const allCustomVarsForCall = {
        ...customUserVars,
        CUSTOM_TOKEN_FROM_USER_SETTINGS: 'secretToken123!',
        PROCESS_MODE_CUSTOM: 'production',
      };

      // Cast obj to MCPOptions when calling processMCPEnv.
      // This acknowledges the object might not strictly conform to one schema in the union,
      // but we are testing the function's ability to handle these properties if present.
      const result = processMCPEnv({
        options: obj as MCPOptions,
        user,
        customUserVars: allCustomVarsForCall,
      });

      expect('url' in result && result.url).toBe('https://ep123.example.com/users/john.doe');
      expect('headers' in result && result.headers).toEqual({
        'X-Auth-Token': 'secretToken123!',
        'X-User-ID': 'userXYZ',
        'X-System-Test-Key': 'test-api-key-value', // Expecting value of TEST_API_KEY
      });
      expect('env' in result && result.env).toEqual({
        PROCESS_MODE: 'production',
        USER_HOME_DIR: '/home/john.doe',
        SYSTEM_PATH: process.env.PATH, // Actual value of PATH from the test environment
      });
    });

    it('should process GitHub MCP server configuration with PAT_TOKEN placeholder', () => {
      const user = createTestUser({ id: 'github-user-123', email: 'user@example.com' });
      const customUserVars = {
        PAT_TOKEN: 'ghp_1234567890abcdef1234567890abcdef12345678', // GitHub Personal Access Token
      };

      // Simulate the GitHub MCP server configuration from librechat.yaml
      const options: MCPOptions = {
        type: 'streamable-http',
        url: 'https://api.githubcopilot.com/mcp/',
        headers: {
          Authorization: '{{PAT_TOKEN}}',
          'Content-Type': 'application/json',
          'User-Agent': 'LibreChat-MCP-Client',
        },
      };

      const result = processMCPEnv({ options, user, customUserVars });

      expect('headers' in result && result.headers).toEqual({
        Authorization: 'ghp_1234567890abcdef1234567890abcdef12345678',
        'Content-Type': 'application/json',
        'User-Agent': 'LibreChat-MCP-Client',
      });
      expect('url' in result && result.url).toBe('https://api.githubcopilot.com/mcp/');
      expect(result.type).toBe('streamable-http');
    });

    it('should handle GitHub MCP server configuration without PAT_TOKEN (placeholder remains)', () => {
      const user = createTestUser({ id: 'github-user-123' });
      // No customUserVars provided - PAT_TOKEN should remain as placeholder
      const options: MCPOptions = {
        type: 'streamable-http',
        url: 'https://api.githubcopilot.com/mcp/',
        headers: {
          Authorization: '{{PAT_TOKEN}}',
          'Content-Type': 'application/json',
        },
      };

      const result = processMCPEnv({ options, user });

      expect('headers' in result && result.headers).toEqual({
        Authorization: '{{PAT_TOKEN}}', // Should remain unchanged since no customUserVars provided
        'Content-Type': 'application/json',
      });
    });

    it('should leave {{LIBRECHAT_GRAPH_ACCESS_TOKEN}} unchanged (resolved by preProcessGraphTokens)', () => {
      const user = createTestUser({ id: 'user-123' });
      const options: MCPOptions = {
        type: 'sse',
        url: 'https://example.com',
        headers: {
          Authorization: 'Bearer {{LIBRECHAT_GRAPH_ACCESS_TOKEN}}',
          'X-User-Id': '{{LIBRECHAT_USER_ID}}',
        },
      };

      const result = processMCPEnv({ options, user });

      expect('headers' in result && result.headers).toEqual({
        // Graph token placeholder remains - it should be resolved by preProcessGraphTokens before processMCPEnv
        Authorization: 'Bearer {{LIBRECHAT_GRAPH_ACCESS_TOKEN}}',
        // User ID is resolved by processMCPEnv
        'X-User-Id': 'user-123',
      });
    });
  });

  describe('preProcessGraphTokens and processMCPEnv working in tandem', () => {
    const mockExtractOpenIDTokenInfo = oidcUtils.extractOpenIDTokenInfo as jest.Mock;
    const mockIsOpenIDTokenValid = oidcUtils.isOpenIDTokenValid as jest.Mock;

    const mockGraphTokenResolver: GraphTokenResolver = jest.fn().mockResolvedValue({
      access_token: 'resolved-graph-api-token',
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'https://graph.microsoft.com/.default',
    });

    beforeEach(() => {
      // Set up mocks to simulate valid OpenID token
      mockExtractOpenIDTokenInfo.mockReturnValue({ accessToken: 'test-access-token' });
      mockIsOpenIDTokenValid.mockReturnValue(true);
      (mockGraphTokenResolver as jest.Mock).mockClear();
    });

    afterEach(() => {
      jest.clearAllMocks();
    });

    it('should resolve both graph tokens and user placeholders in sequence', async () => {
      const user = createTestUser({
        id: 'user-123',
        email: 'test@example.com',
        provider: 'openid',
        openidId: 'oidc-sub-456',
      }) as unknown as IUser;

      const options: MCPOptions = {
        type: 'sse',
        url: 'https://graph.microsoft.com/v1.0/me',
        headers: {
          Authorization: 'Bearer {{LIBRECHAT_GRAPH_ACCESS_TOKEN}}',
          'X-User-Id': '{{LIBRECHAT_USER_ID}}',
          'X-User-Email': '{{LIBRECHAT_USER_EMAIL}}',
          'Content-Type': 'application/json',
        },
      };

      // Step 1: preProcessGraphTokens resolves graph token placeholders (async)
      const graphProcessedConfig = await preProcessGraphTokens(options, {
        user,
        graphTokenResolver: mockGraphTokenResolver,
      });

      // Step 2: processMCPEnv resolves user and env placeholders (sync)
      const finalConfig = processMCPEnv({
        options: graphProcessedConfig,
        user,
      });

      expect('headers' in finalConfig && finalConfig.headers).toEqual({
        Authorization: 'Bearer resolved-graph-api-token',
        'X-User-Id': 'user-123',
        'X-User-Email': 'test@example.com',
        'Content-Type': 'application/json',
      });
    });

    it('should resolve graph tokens in env and user placeholders in headers', async () => {
      const user = createTestUser({
        id: 'user-456',
        username: 'johndoe',
        provider: 'openid',
      }) as unknown as IUser;

      const options: MCPOptions = {
        type: 'stdio',
        command: 'node',
        args: ['mcp-server.js', '--user', '{{LIBRECHAT_USER_USERNAME}}'],
        env: {
          GRAPH_ACCESS_TOKEN: '{{LIBRECHAT_GRAPH_ACCESS_TOKEN}}',
          USER_ID: '{{LIBRECHAT_USER_ID}}',
          API_KEY: '${TEST_API_KEY}',
        },
      };

      // Step 1: preProcessGraphTokens
      const graphProcessedConfig = await preProcessGraphTokens(options, {
        user,
        graphTokenResolver: mockGraphTokenResolver,
      });

      // Step 2: processMCPEnv
      const finalConfig = processMCPEnv({
        options: graphProcessedConfig,
        user,
      });

      expect('env' in finalConfig && finalConfig.env).toEqual({
        GRAPH_ACCESS_TOKEN: 'resolved-graph-api-token',
        USER_ID: 'user-456',
        API_KEY: 'test-api-key-value',
      });

      expect('args' in finalConfig && finalConfig.args).toEqual([
        'mcp-server.js',
        '--user',
        'johndoe',
      ]);
    });

    it('should resolve graph tokens in args and oauth fields before processMCPEnv', async () => {
      const user = createTestUser({
        id: 'user-args-oauth',
        provider: 'openid',
      }) as unknown as IUser;

      const options: MCPOptions = {
        type: 'stdio',
        command: 'node',
        args: ['server.js', '--graph-token={{LIBRECHAT_GRAPH_ACCESS_TOKEN}}'],
        oauth: {
          client_id: 'client-id',
          client_secret: '{{LIBRECHAT_GRAPH_ACCESS_TOKEN}}',
          scope: 'profile {{LIBRECHAT_GRAPH_ACCESS_TOKEN}}',
        },
      };

      const graphProcessedConfig = await preProcessGraphTokens(options, {
        user,
        graphTokenResolver: mockGraphTokenResolver,
      });

      const finalConfig = processMCPEnv({
        options: graphProcessedConfig,
        user,
      });

      expect('args' in finalConfig && finalConfig.args).toEqual([
        'server.js',
        '--graph-token=resolved-graph-api-token',
      ]);
      expect(finalConfig.oauth).toEqual({
        client_id: 'client-id',
        client_secret: 'resolved-graph-api-token',
        scope: 'profile resolved-graph-api-token',
      });
    });

    it('should resolve graph tokens in URL alongside other placeholders', async () => {
      const user = createTestUser({
        id: 'user-789',
        provider: 'openid',
      }) as unknown as IUser;

      const customUserVars = {
        TENANT_ID: 'my-tenant-123',
      };

      const options: MCPOptions = {
        type: 'sse',
        url: 'https://{{TENANT_ID}}.example.com/api?token={{LIBRECHAT_GRAPH_ACCESS_TOKEN}}&user={{LIBRECHAT_USER_ID}}',
      };

      // Step 1: preProcessGraphTokens
      const graphProcessedConfig = await preProcessGraphTokens(options, {
        user,
        graphTokenResolver: mockGraphTokenResolver,
      });

      // Step 2: processMCPEnv with customUserVars
      const finalConfig = processMCPEnv({
        options: graphProcessedConfig,
        user,
        customUserVars,
      });

      expect('url' in finalConfig && finalConfig.url).toBe(
        'https://my-tenant-123.example.com/api?token=resolved-graph-api-token&user=user-789',
      );
    });

    it('should handle config with no graph token placeholders (only user placeholders)', async () => {
      const user = createTestUser({
        id: 'user-abc',
        email: 'user@company.com',
      }) as unknown as IUser;

      const options: MCPOptions = {
        type: 'sse',
        url: 'https://api.example.com',
        headers: {
          'X-User-Id': '{{LIBRECHAT_USER_ID}}',
          'X-User-Email': '{{LIBRECHAT_USER_EMAIL}}',
        },
      };

      // Step 1: preProcessGraphTokens (no-op since no graph placeholders)
      const graphProcessedConfig = await preProcessGraphTokens(options, {
        user,
        graphTokenResolver: mockGraphTokenResolver,
      });

      // Step 2: processMCPEnv
      const finalConfig = processMCPEnv({
        options: graphProcessedConfig,
        user,
      });

      expect('headers' in finalConfig && finalConfig.headers).toEqual({
        'X-User-Id': 'user-abc',
        'X-User-Email': 'user@company.com',
      });

      // graphTokenResolver should not have been called
      expect(mockGraphTokenResolver).not.toHaveBeenCalled();
    });

    it('should handle config with only graph token placeholders (no user placeholders)', async () => {
      const user = createTestUser({
        id: 'user-xyz',
        provider: 'openid',
      }) as unknown as IUser;

      const options: MCPOptions = {
        type: 'sse',
        url: 'https://graph.microsoft.com/v1.0/me',
        headers: {
          Authorization: 'Bearer {{LIBRECHAT_GRAPH_ACCESS_TOKEN}}',
          'Content-Type': 'application/json',
        },
      };

      // Reset mock call count
      (mockGraphTokenResolver as jest.Mock).mockClear();

      // Step 1: preProcessGraphTokens
      const graphProcessedConfig = await preProcessGraphTokens(options, {
        user,
        graphTokenResolver: mockGraphTokenResolver,
      });

      // Step 2: processMCPEnv
      const finalConfig = processMCPEnv({
        options: graphProcessedConfig,
        user,
      });

      expect('headers' in finalConfig && finalConfig.headers).toEqual({
        Authorization: 'Bearer resolved-graph-api-token',
        'Content-Type': 'application/json',
      });
    });

    it('should not mutate original options through the tandem processing', async () => {
      const user = createTestUser({
        id: 'user-immutable',
        provider: 'openid',
      }) as unknown as IUser;

      const originalOptions: MCPOptions = {
        type: 'sse',
        url: 'https://api.example.com',
        headers: {
          Authorization: 'Bearer {{LIBRECHAT_GRAPH_ACCESS_TOKEN}}',
          'X-User-Id': '{{LIBRECHAT_USER_ID}}',
        },
      };

      // Store original values
      const originalAuth = originalOptions.headers?.Authorization;
      const originalUserId = originalOptions.headers?.['X-User-Id'];

      // Step 1 & 2: Process through both functions
      const graphProcessedConfig = await preProcessGraphTokens(originalOptions, {
        user,
        graphTokenResolver: mockGraphTokenResolver,
      });

      processMCPEnv({
        options: graphProcessedConfig,
        user,
      });

      // Original should be unchanged
      expect(originalOptions.headers?.Authorization).toBe(originalAuth);
      expect(originalOptions.headers?.['X-User-Id']).toBe(originalUserId);
    });
  });
});
