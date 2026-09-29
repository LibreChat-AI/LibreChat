import { Types } from 'mongoose';
import { TokenExchangeMethodEnum } from 'librechat-data-provider';
import type { MCPOptions } from 'librechat-data-provider';
import type { IUser } from '@librechat/data-schemas';
import {
  createSafeUser,
  resolveHeaders,
  resolveNestedObject,
  processMCPEnv,
  encodeHeaderValue,
} from './env';
import { applyRequestHeaders } from '~/mcp/utils';

function isStdioOptions(options: MCPOptions): options is Extract<MCPOptions, { type?: 'stdio' }> {
  return !options.type || options.type === 'stdio';
}

function isStreamableHTTPOptions(
  options: MCPOptions,
): options is Extract<MCPOptions, { type: 'streamable-http' | 'http' }> {
  return options.type === 'streamable-http' || options.type === 'http';
}

/** Helper function to create test user objects */
function createTestUser(overrides: Partial<IUser> = {}): IUser {
  return {
    _id: new Types.ObjectId(),
    id: new Types.ObjectId().toString(),
    username: 'testuser',
    email: 'test@example.com',
    name: 'Test User',
    avatar: 'https://example.com/avatar.png',
    provider: 'email',
    role: 'user',
    createdAt: new Date('2021-01-01'),
    updatedAt: new Date('2021-01-01'),
    emailVerified: true,
    ...overrides,
  } as IUser;
}

describe('encodeHeaderValue', () => {
  it('should return empty string for empty input', () => {
    expect(encodeHeaderValue('')).toBe('');
  });

  it('should return empty string for null/undefined coerced to empty string', () => {
    expect(encodeHeaderValue(null as unknown as string)).toBe('');
    expect(encodeHeaderValue(undefined as unknown as string)).toBe('');
  });

  it('should return empty string for non-string values', () => {
    expect(encodeHeaderValue(123 as unknown as string)).toBe('');
    expect(encodeHeaderValue(false as unknown as string)).toBe('');
    expect(encodeHeaderValue({} as unknown as string)).toBe('');
  });

  it('should pass through ASCII characters (0-127) unchanged', () => {
    expect(encodeHeaderValue('Hello')).toBe('Hello');
    expect(encodeHeaderValue('test@example.com')).toBe('test@example.com');
    expect(encodeHeaderValue('ABC123')).toBe('ABC123');
  });

  it('should pass through Latin-1 characters (128-255) unchanged', () => {
    // Characters with Unicode values 128-255 are safe
    expect(encodeHeaderValue('José')).toBe('José'); // é = U+00E9 (233)
    expect(encodeHeaderValue('Müller')).toBe('Müller'); // ü = U+00FC (252)
    expect(encodeHeaderValue('Zoë')).toBe('Zoë'); // ë = U+00EB (235)
    expect(encodeHeaderValue('Björk')).toBe('Björk'); // ö = U+00F6 (246)
  });

  it('should Base64 encode Slavic characters (>255)', () => {
    // Slavic characters that cause ByteString errors
    expect(encodeHeaderValue('Marić')).toBe('b64:TWFyacSH'); // ć = U+0107 (263)
    expect(encodeHeaderValue('Đorđe')).toBe('b64:xJBvcsSRZQ=='); // Đ = U+0110 (272), đ = U+0111 (273)
  });

  it('should Base64 encode Polish characters (>255)', () => {
    expect(encodeHeaderValue('Łukasz')).toBe('b64:xYF1a2Fzeg=='); // Ł = U+0141 (321)
  });

  it('should Base64 encode various extended Unicode characters (>255)', () => {
    expect(encodeHeaderValue('Žarko')).toBe('b64:xb1hcmtv'); // Ž = U+017D (381)
    expect(encodeHeaderValue('Šime')).toBe('b64:xaBpbWU='); // Š = U+0160 (352)
  });

  it('should have correct b64: prefix format', () => {
    const result = encodeHeaderValue('Ćiro'); // Ć = U+0106 (262)
    expect(result.startsWith('b64:')).toBe(true);
    // Verify the encoded part after prefix is valid Base64
    const base64Part = result.slice(4);
    expect(Buffer.from(base64Part, 'base64').toString('utf8')).toBe('Ćiro');
  });

  it('should handle mixed safe and unsafe characters', () => {
    const result = encodeHeaderValue('Hello Đorđe!');
    expect(result).toBe('b64:SGVsbG8gxJBvcsSRZSE=');
  });

  it('should be reversible with Base64 decode', () => {
    const original = 'Marko Marić';
    const encoded = encodeHeaderValue(original);
    expect(encoded.startsWith('b64:')).toBe(true);

    // Verify decoding works
    const decoded = Buffer.from(encoded.slice(4), 'base64').toString('utf8');
    expect(decoded).toBe(original);
  });

  it('should handle emoji and other high Unicode characters', () => {
    const result = encodeHeaderValue('Hello 👋');
    expect(result.startsWith('b64:')).toBe(true);
    const decoded = Buffer.from(result.slice(4), 'base64').toString('utf8');
    expect(decoded).toBe('Hello 👋');
  });
});

describe('resolveHeaders', () => {
  beforeEach(() => {
    process.env.TEST_API_KEY = 'test-api-key-value';
    process.env.ANOTHER_VALUE = 'another-test-value';
  });

  afterEach(() => {
    delete process.env.TEST_API_KEY;
    delete process.env.ANOTHER_VALUE;
  });

  it('should return empty object when headers is undefined', () => {
    const result = resolveHeaders(undefined);
    expect(result).toEqual({});
  });

  it('should return empty object when headers is null', () => {
    const result = resolveHeaders({
      headers: null as unknown as Record<string, string>,
    });
    expect(result).toEqual({});
  });

  it('should return empty object when headers is empty', () => {
    const result = resolveHeaders({ headers: {} });
    expect(result).toEqual({});
  });

  it('should process environment variables in headers', () => {
    const headers = {
      Authorization: '${TEST_API_KEY}',
      'X-Secret': '${ANOTHER_VALUE}',
      'Content-Type': 'application/json',
    };

    const result = resolveHeaders({ headers });

    expect(result).toEqual({
      Authorization: 'test-api-key-value',
      'X-Secret': 'another-test-value',
      'Content-Type': 'application/json',
    });
  });

  it('should process user ID placeholder when user has id', () => {
    const user = { id: 'test-user-123' };
    const headers = {
      'User-Id': '{{LIBRECHAT_USER_ID}}',
      'Content-Type': 'application/json',
    };

    const result = resolveHeaders({ headers, user });

    expect(result).toEqual({
      'User-Id': 'test-user-123',
      'Content-Type': 'application/json',
    });
  });

  it('should not process user ID placeholder when user is undefined', () => {
    const headers = {
      'User-Id': '{{LIBRECHAT_USER_ID}}',
      'Content-Type': 'application/json',
    };

    const result = resolveHeaders({ headers });

    expect(result).toEqual({
      'User-Id': '{{LIBRECHAT_USER_ID}}',
      'Content-Type': 'application/json',
    });
  });

  it('should not process user ID placeholder when user has no id', () => {
    const user = { id: '' };
    const headers = {
      'User-Id': '{{LIBRECHAT_USER_ID}}',
      'Content-Type': 'application/json',
    };

    const result = resolveHeaders({ headers, user });

    expect(result).toEqual({
      'User-Id': '{{LIBRECHAT_USER_ID}}',
      'Content-Type': 'application/json',
    });
  });

  it('should process full user object placeholders', () => {
    const user = createTestUser({
      id: 'user-123',
      email: 'test@example.com',
      username: 'testuser',
      name: 'Test User',
      role: 'admin',
    });

    const headers = {
      'User-Email': '{{LIBRECHAT_USER_EMAIL}}',
      'User-Name': '{{LIBRECHAT_USER_NAME}}',
      'User-Username': '{{LIBRECHAT_USER_USERNAME}}',
      'User-Role': '{{LIBRECHAT_USER_ROLE}}',
      'User-Id': '{{LIBRECHAT_USER_ID}}',
      'Content-Type': 'application/json',
    };

    const result = resolveHeaders({ headers, user });

    expect(result).toEqual({
      'User-Email': 'test@example.com',
      'User-Name': 'Test User',
      'User-Username': 'testuser',
      'User-Role': 'admin',
      'User-Id': 'user-123',
      'Content-Type': 'application/json',
    });
  });

  it('should handle missing user fields gracefully', () => {
    const user = createTestUser({
      id: 'user-123',
      email: 'test@example.com',
      username: undefined,
    });

    const headers = {
      'User-Email': '{{LIBRECHAT_USER_EMAIL}}',
      'User-Username': '{{LIBRECHAT_USER_USERNAME}}',
      'Non-Existent': '{{LIBRECHAT_USER_NONEXISTENT}}',
    };

    const result = resolveHeaders({ headers, user });

    expect(result).toEqual({
      'User-Email': 'test@example.com',
      'User-Username': '',
      'Non-Existent': '{{LIBRECHAT_USER_NONEXISTENT}}',
    });
  });

  it('should process custom user variables', () => {
    const user = { id: 'user-123' };
    const customUserVars = {
      CUSTOM_TOKEN: 'user-specific-token',
      REGION: 'us-west-1',
    };

    const headers = {
      Authorization: 'Bearer {{CUSTOM_TOKEN}}',
      'X-Region': '{{REGION}}',
      'X-System-Key': '${TEST_API_KEY}',
      'X-User-Id': '{{LIBRECHAT_USER_ID}}',
    };

    const result = resolveHeaders({ headers, user, customUserVars });

    expect(result).toEqual({
      Authorization: 'Bearer user-specific-token',
      'X-Region': 'us-west-1',
      'X-System-Key': 'test-api-key-value',
      'X-User-Id': 'user-123',
    });
  });

  it('should prioritize custom user variables over user fields', () => {
    const user = createTestUser({
      id: 'user-123',
      email: 'user-email@example.com',
    });
    const customUserVars = {
      LIBRECHAT_USER_EMAIL: 'custom-email@example.com',
    };

    const headers = {
      'Test-Email': '{{LIBRECHAT_USER_EMAIL}}',
    };

    const result = resolveHeaders({ headers, user, customUserVars });

    expect(result).toEqual({
      'Test-Email': 'custom-email@example.com',
    });
  });

  it('should handle boolean user fields', () => {
    const user = createTestUser({
      id: 'user-123',

      role: 'admin',
    });

    const headers = {
      'User-Role': '{{LIBRECHAT_USER_ROLE}}',
      'User-Id': '{{LIBRECHAT_USER_ID}}',
    };

    const result = resolveHeaders({ headers, user });

    expect(result).toEqual({
      'User-Role': 'admin',
      'User-Id': 'user-123',
    });
  });

  it('should handle multiple occurrences of the same placeholder', () => {
    const user = createTestUser({
      id: 'user-123',
      email: 'test@example.com',
    });

    const headers = {
      'Primary-Email': '{{LIBRECHAT_USER_EMAIL}}',
      'Secondary-Email': '{{LIBRECHAT_USER_EMAIL}}',
      'Backup-Email': '{{LIBRECHAT_USER_EMAIL}}',
    };

    const result = resolveHeaders({ headers, user });

    expect(result).toEqual({
      'Primary-Email': 'test@example.com',
      'Secondary-Email': 'test@example.com',
      'Backup-Email': 'test@example.com',
    });
  });

  it('should handle mixed variable types in the same headers object', () => {
    const user = createTestUser({
      id: 'user-123',
      email: 'test@example.com',
    });
    const customUserVars = {
      CUSTOM_TOKEN: 'secret-token',
    };

    const headers = {
      Authorization: 'Bearer {{CUSTOM_TOKEN}}',
      'X-User-Id': '{{LIBRECHAT_USER_ID}}',
      'X-System-Key': '${TEST_API_KEY}',
      'X-User-Email': '{{LIBRECHAT_USER_EMAIL}}',
      'Content-Type': 'application/json',
    };

    const result = resolveHeaders({ headers, user, customUserVars });

    expect(result).toEqual({
      Authorization: 'Bearer secret-token',
      'X-User-Id': 'user-123',
      'X-System-Key': 'test-api-key-value',
      'X-User-Email': 'test@example.com',
      'Content-Type': 'application/json',
    });
  });

  it('should not modify the original headers object', () => {
    const originalHeaders = {
      Authorization: '${TEST_API_KEY}',
      'User-Id': '{{LIBRECHAT_USER_ID}}',
    };
    const user = { id: 'user-123' };

    const result = resolveHeaders({ headers: originalHeaders, user });

    expect(result).toEqual({
      Authorization: 'test-api-key-value',
      'User-Id': 'user-123',
    });

    expect(originalHeaders).toEqual({
      Authorization: '${TEST_API_KEY}',
      'User-Id': '{{LIBRECHAT_USER_ID}}',
    });
  });

  it('should handle special characters in custom variable names', () => {
    const user = { id: 'user-123' };
    const customUserVars = {
      'CUSTOM-VAR': 'dash-value',
      CUSTOM_VAR: 'underscore-value',
      'CUSTOM.VAR': 'dot-value',
    };

    const headers = {
      'Dash-Header': '{{CUSTOM-VAR}}',
      'Underscore-Header': '{{CUSTOM_VAR}}',
      'Dot-Header': '{{CUSTOM.VAR}}',
    };

    const result = resolveHeaders({ headers, user, customUserVars });

    expect(result).toEqual({
      'Dash-Header': 'dash-value',
      'Underscore-Header': 'underscore-value',
      'Dot-Header': 'dot-value',
    });
  });

  it('should replace all allowed user field placeholders', () => {
    const user = {
      id: 'abc',
      name: 'Test User',
      username: 'testuser',
      email: 'me@example.com',
      provider: 'google',
      role: 'admin',
      googleId: 'gid',
      facebookId: 'fbid',
      openidId: 'oid',
      samlId: 'sid',
      ldapId: 'lid',
      githubId: 'ghid',
      discordId: 'dcid',
      appleId: 'aid',
      emailVerified: true,
      twoFactorEnabled: false,
      termsAccepted: true,
    };

    const headers = {
      'X-User-ID': '{{LIBRECHAT_USER_ID}}',
      'X-User-Name': '{{LIBRECHAT_USER_NAME}}',
      'X-User-Username': '{{LIBRECHAT_USER_USERNAME}}',
      'X-User-Email': '{{LIBRECHAT_USER_EMAIL}}',
      'X-User-Provider': '{{LIBRECHAT_USER_PROVIDER}}',
      'X-User-Role': '{{LIBRECHAT_USER_ROLE}}',
      'X-User-GoogleId': '{{LIBRECHAT_USER_GOOGLEID}}',
      'X-User-FacebookId': '{{LIBRECHAT_USER_FACEBOOKID}}',
      'X-User-OpenIdId': '{{LIBRECHAT_USER_OPENIDID}}',
      'X-User-SamlId': '{{LIBRECHAT_USER_SAMLID}}',
      'X-User-LdapId': '{{LIBRECHAT_USER_LDAPID}}',
      'X-User-GithubId': '{{LIBRECHAT_USER_GITHUBID}}',
      'X-User-DiscordId': '{{LIBRECHAT_USER_DISCORDID}}',
      'X-User-AppleId': '{{LIBRECHAT_USER_APPLEID}}',
      'X-User-EmailVerified': '{{LIBRECHAT_USER_EMAILVERIFIED}}',
      'X-User-TwoFactorEnabled': '{{LIBRECHAT_USER_TWOFACTORENABLED}}',
      'X-User-TermsAccepted': '{{LIBRECHAT_USER_TERMSACCEPTED}}',
    };

    const result = resolveHeaders({ headers, user });

    expect(result['X-User-ID']).toBe('abc');
    expect(result['X-User-Name']).toBe('Test User');
    expect(result['X-User-Username']).toBe('testuser');
    expect(result['X-User-Email']).toBe('me@example.com');
    expect(result['X-User-Provider']).toBe('google');
    expect(result['X-User-Role']).toBe('admin');
    expect(result['X-User-GoogleId']).toBe('gid');
    expect(result['X-User-FacebookId']).toBe('fbid');
    expect(result['X-User-OpenIdId']).toBe('oid');
    expect(result['X-User-SamlId']).toBe('sid');
    expect(result['X-User-LdapId']).toBe('lid');
    expect(result['X-User-GithubId']).toBe('ghid');
    expect(result['X-User-DiscordId']).toBe('dcid');
    expect(result['X-User-AppleId']).toBe('aid');
    expect(result['X-User-EmailVerified']).toBe('true');
    expect(result['X-User-TwoFactorEnabled']).toBe('false');
    expect(result['X-User-TermsAccepted']).toBe('true');
  });

  it('should not expose tenant or issuer fields through safe user placeholders', () => {
    const user = createTestUser({
      tenantId: 'tenant-secret',
      openidIssuer: 'https://issuer.example.com',
    });
    const safeUser = createSafeUser(user);
    const headers = {
      'X-Tenant': '{{LIBRECHAT_USER_TENANTID}}',
      'X-Issuer': '{{LIBRECHAT_USER_OPENIDISSUER}}',
    };

    expect(safeUser).not.toHaveProperty('tenantId');
    expect(safeUser).not.toHaveProperty('openidIssuer');
    expect(resolveHeaders({ headers, user: safeUser })['X-Tenant']).toBe(
      '{{LIBRECHAT_USER_TENANTID}}',
    );
    expect(resolveHeaders({ headers, user: safeUser })['X-Issuer']).toBe(
      '{{LIBRECHAT_USER_OPENIDISSUER}}',
    );
  });

  it('should handle multiple placeholders in one value', () => {
    const user = { id: 'abc', email: 'me@example.com' };
    const headers = {
      'X-Multi': 'User: {{LIBRECHAT_USER_ID}}, Env: ${TEST_API_KEY}, Custom: {{MY_CUSTOM}}',
    };
    const customVars = { MY_CUSTOM: 'custom-value' };
    const result = resolveHeaders({ headers, user, customUserVars: customVars });
    expect(result['X-Multi']).toBe('User: abc, Env: test-api-key-value, Custom: custom-value');
  });

  it('should leave unknown placeholders unchanged', () => {
    const user = { id: 'abc' };
    const headers = {
      'X-Unknown': '{{SOMETHING_NOT_RECOGNIZED}}',
      'X-Known': '{{LIBRECHAT_USER_ID}}',
    };
    const result = resolveHeaders({ headers, user });
    expect(result['X-Unknown']).toBe('{{SOMETHING_NOT_RECOGNIZED}}');
    expect(result['X-Known']).toBe('abc');
  });

  it('should handle a mix of all types', () => {
    const user = {
      id: 'abc',
      email: 'me@example.com',
      emailVerified: true,
      twoFactorEnabled: false,
    };
    const headers = {
      'X-User': '{{LIBRECHAT_USER_ID}}',
      'X-Env': '${TEST_API_KEY}',
      'X-Custom': '{{MY_CUSTOM}}',
      'X-Multi': 'ID: {{LIBRECHAT_USER_ID}}, ENV: ${TEST_API_KEY}, CUSTOM: {{MY_CUSTOM}}',
      'X-Unknown': '{{NOT_A_REAL_PLACEHOLDER}}',
      'X-Empty': '',
      'X-Boolean': '{{LIBRECHAT_USER_EMAILVERIFIED}}',
    };
    const customVars = { MY_CUSTOM: 'custom-value' };
    const result = resolveHeaders({ headers, user, customUserVars: customVars });

    expect(result['X-User']).toBe('abc');
    expect(result['X-Env']).toBe('test-api-key-value');
    expect(result['X-Custom']).toBe('custom-value');
    expect(result['X-Multi']).toBe('ID: abc, ENV: test-api-key-value, CUSTOM: custom-value');
    expect(result['X-Unknown']).toBe('{{NOT_A_REAL_PLACEHOLDER}}');
    expect(result['X-Empty']).toBe('');
    expect(result['X-Boolean']).toBe('true');
  });

  it('should process LIBRECHAT_BODY placeholders', () => {
    const body = {
      conversationId: 'conv-123',
      parentMessageId: 'parent-456',
      messageId: 'msg-789',
    };
    const headers = { 'X-Conversation': '{{LIBRECHAT_BODY_CONVERSATIONID}}' };
    const result = resolveHeaders({ headers, body });
    expect(result['X-Conversation']).toBe('conv-123');
  });

  it('should not resolve env vars introduced via LIBRECHAT_BODY placeholders', () => {
    const body = {
      conversationId: '${TEST_API_KEY}',
      parentMessageId: '${TEST_API_KEY}',
      messageId: '${TEST_API_KEY}',
    };
    const headers = {
      'X-Conv': '{{LIBRECHAT_BODY_CONVERSATIONID}}',
      'X-Parent': '{{LIBRECHAT_BODY_PARENTMESSAGEID}}',
      'X-Msg': '{{LIBRECHAT_BODY_MESSAGEID}}',
    };
    const result = resolveHeaders({ headers, body });

    expect(result['X-Conv']).toBe('${TEST_API_KEY}');
    expect(result['X-Parent']).toBe('${TEST_API_KEY}');
    expect(result['X-Msg']).toBe('${TEST_API_KEY}');
  });

  it('should not resolve env vars introduced via LIBRECHAT_USER placeholders', () => {
    const user = createTestUser({ name: '${TEST_API_KEY}' });
    const headers = { 'X-Name': '{{LIBRECHAT_USER_NAME}}' };
    const result = resolveHeaders({ headers, user });

    expect(result['X-Name']).toBe('${TEST_API_KEY}');
  });

  it('should not resolve env vars introduced via customUserVars', () => {
    const customUserVars = { MY_TOKEN: '${TEST_API_KEY}' };
    const headers = { Authorization: 'Bearer {{MY_TOKEN}}' };
    const result = resolveHeaders({ headers, customUserVars });

    expect(result.Authorization).toBe('Bearer ${TEST_API_KEY}');
  });

  describe('non-string header values (type guard tests)', () => {
    it('should handle numeric header values without crashing', () => {
      const headers = {
        'X-Number': 12345 as unknown as string,
        'X-String': 'normal-string',
      };
      const result = resolveHeaders({ headers });
      expect(result['X-Number']).toBe('12345');
      expect(result['X-String']).toBe('normal-string');
    });

    it('should handle boolean header values without crashing', () => {
      const headers = {
        'X-Boolean-True': true as unknown as string,
        'X-Boolean-False': false as unknown as string,
        'X-String': 'normal-string',
      };
      const result = resolveHeaders({ headers });
      expect(result['X-Boolean-True']).toBe('true');
      expect(result['X-Boolean-False']).toBe('false');
      expect(result['X-String']).toBe('normal-string');
    });

    it('should handle null and undefined header values', () => {
      const headers = {
        'X-Null': null as unknown as string,
        'X-Undefined': undefined as unknown as string,
        'X-String': 'normal-string',
      };
      const result = resolveHeaders({ headers });
      expect(result['X-Null']).toBe('null');
      expect(result['X-Undefined']).toBe('undefined');
      expect(result['X-String']).toBe('normal-string');
    });

    it('should handle numeric values with placeholders', () => {
      const user = { id: 'user-123' };
      const headers = {
        'X-Number': 42 as unknown as string,
        'X-String-With-Placeholder': '{{LIBRECHAT_USER_ID}}',
      };
      const result = resolveHeaders({ headers, user });
      expect(result['X-Number']).toBe('42');
      expect(result['X-String-With-Placeholder']).toBe('user-123');
    });

    it('should handle objects in header values', () => {
      const headers = {
        'X-Object': { nested: 'value' } as unknown as string,
        'X-String': 'normal-string',
      };
      const result = resolveHeaders({ headers });
      expect(result['X-Object']).toBe('[object Object]');
      expect(result['X-String']).toBe('normal-string');
    });

    it('should handle arrays in header values', () => {
      const headers = {
        'X-Array': ['value1', 'value2'] as unknown as string,
        'X-String': 'normal-string',
      };
      const result = resolveHeaders({ headers });
      expect(result['X-Array']).toBe('value1,value2');
      expect(result['X-String']).toBe('normal-string');
    });

    it('should handle numeric values with env variables', () => {
      process.env.TEST_API_KEY = 'test-api-key-value';
      const headers = {
        'X-Number': 12345 as unknown as string,
        'X-Env': '${TEST_API_KEY}',
      };
      const result = resolveHeaders({ headers });
      expect(result['X-Number']).toBe('12345');
      expect(result['X-Env']).toBe('test-api-key-value');
      delete process.env.TEST_API_KEY;
    });

    it('should handle numeric values with body placeholders', () => {
      const body = {
        conversationId: 'conv-123',
        parentMessageId: 'parent-456',
        messageId: 'msg-789',
      };
      const headers = {
        'X-Number': 999 as unknown as string,
        'X-Conv': '{{LIBRECHAT_BODY_CONVERSATIONID}}',
      };
      const result = resolveHeaders({ headers, body });
      expect(result['X-Number']).toBe('999');
      expect(result['X-Conv']).toBe('conv-123');
    });

    it('should handle mixed type headers with user and custom vars', () => {
      const user = { id: 'user-123', email: 'test@example.com' };
      const customUserVars = { CUSTOM_TOKEN: 'secret-token' };
      const headers = {
        'X-Number': 42 as unknown as string,
        'X-Boolean': true as unknown as string,
        'X-User-Id': '{{LIBRECHAT_USER_ID}}',
        'X-Custom': '{{CUSTOM_TOKEN}}',
        'X-String': 'normal',
      };
      const result = resolveHeaders({ headers, user, customUserVars });
      expect(result['X-Number']).toBe('42');
      expect(result['X-Boolean']).toBe('true');
      expect(result['X-User-Id']).toBe('user-123');
      expect(result['X-Custom']).toBe('secret-token');
      expect(result['X-String']).toBe('normal');
    });

    it('should not crash when calling includes on non-string body field values', () => {
      const body = {
        conversationId: 12345 as unknown as string,
        parentMessageId: 'parent-456',
        messageId: 'msg-789',
      };
      const headers = {
        'X-Conv-Id': '{{LIBRECHAT_BODY_CONVERSATIONID}}',
        'X-Number': 999 as unknown as string,
      };
      expect(() => resolveHeaders({ headers, body })).not.toThrow();
      const result = resolveHeaders({ headers, body });
      expect(result['X-Number']).toBe('999');
    });
  });
});

describe('resolveNestedObject', () => {
  beforeEach(() => {
    process.env.TEST_API_KEY = 'test-api-key-value';
    process.env.ANOTHER_VALUE = 'another-test-value';
  });

  afterEach(() => {
    delete process.env.TEST_API_KEY;
    delete process.env.ANOTHER_VALUE;
  });

  it('should preserve nested object structure', () => {
    const obj = {
      thinking: {
        type: 'enabled',
        budget_tokens: 2000,
      },
      anthropic_beta: ['output-128k-2025-02-19'],
      max_tokens: 4096,
      temperature: 0.7,
    };

    const result = resolveNestedObject({ obj });

    expect(result).toEqual({
      thinking: {
        type: 'enabled',
        budget_tokens: 2000,
      },
      anthropic_beta: ['output-128k-2025-02-19'],
      max_tokens: 4096,
      temperature: 0.7,
    });
  });

  it('should process placeholders in string values while preserving structure', () => {
    const user = { id: 'user-123', email: 'test@example.com' };
    const obj = {
      thinking: {
        type: 'enabled',
        budget_tokens: 2000,
        user_context: '{{LIBRECHAT_USER_ID}}',
      },
      anthropic_beta: ['output-128k-2025-02-19'],
      api_key: '${TEST_API_KEY}',
      max_tokens: 4096,
    };

    const result = resolveNestedObject({ obj, user });

    expect(result).toEqual({
      thinking: {
        type: 'enabled',
        budget_tokens: 2000,
        user_context: 'user-123',
      },
      anthropic_beta: ['output-128k-2025-02-19'],
      api_key: 'test-api-key-value',
      max_tokens: 4096,
    });
  });

  it('should process strings in arrays', () => {
    const user = { id: 'user-123' };
    const obj = {
      headers: ['Authorization: Bearer ${TEST_API_KEY}', 'X-User-Id: {{LIBRECHAT_USER_ID}}'],
      values: [1, 2, 3],
      mixed: ['string', 42, true, '{{LIBRECHAT_USER_ID}}'],
    };

    const result = resolveNestedObject({ obj, user });

    expect(result).toEqual({
      headers: ['Authorization: Bearer test-api-key-value', 'X-User-Id: user-123'],
      values: [1, 2, 3],
      mixed: ['string', 42, true, 'user-123'],
    });
  });

  it('should handle deeply nested structures', () => {
    const user = { id: 'user-123' };
    const obj = {
      level1: {
        level2: {
          level3: {
            user_id: '{{LIBRECHAT_USER_ID}}',
            settings: {
              api_key: '${TEST_API_KEY}',
              enabled: true,
            },
          },
        },
      },
    };

    const result = resolveNestedObject({ obj, user });

    expect(result).toEqual({
      level1: {
        level2: {
          level3: {
            user_id: 'user-123',
            settings: {
              api_key: 'test-api-key-value',
              enabled: true,
            },
          },
        },
      },
    });
  });

  it('should preserve all primitive types', () => {
    const obj = {
      string: 'text',
      number: 42,
      float: 3.14,
      boolean_true: true,
      boolean_false: false,
      null_value: null,
      undefined_value: undefined,
    };

    const result = resolveNestedObject({ obj });

    expect(result).toEqual(obj);
  });

  it('should handle empty objects and arrays', () => {
    const obj = {
      empty_object: {},
      empty_array: [],
      nested: {
        also_empty: {},
      },
    };

    const result = resolveNestedObject({ obj });

    expect(result).toEqual(obj);
  });

  it('should handle body placeholders in nested objects', () => {
    const body = {
      conversationId: 'conv-123',
      parentMessageId: 'parent-456',
      messageId: 'msg-789',
    };
    const obj = {
      metadata: {
        conversation: '{{LIBRECHAT_BODY_CONVERSATIONID}}',
        parent: '{{LIBRECHAT_BODY_PARENTMESSAGEID}}',
        count: 5,
      },
    };

    const result = resolveNestedObject({ obj, body });

    expect(result).toEqual({
      metadata: {
        conversation: 'conv-123',
        parent: 'parent-456',
        count: 5,
      },
    });
  });

  it('should handle custom user variables in nested objects', () => {
    const customUserVars = {
      CUSTOM_TOKEN: 'secret-token',
      REGION: 'us-west-1',
    };
    const obj = {
      auth: {
        token: '{{CUSTOM_TOKEN}}',
        region: '{{REGION}}',
        timeout: 3000,
      },
    };

    const result = resolveNestedObject({ obj, customUserVars });

    expect(result).toEqual({
      auth: {
        token: 'secret-token',
        region: 'us-west-1',
        timeout: 3000,
      },
    });
  });

  it('should handle mixed placeholders in nested objects', () => {
    const user = { id: 'user-123', email: 'test@example.com' };
    const customUserVars = { CUSTOM_VAR: 'custom-value' };
    const body = { conversationId: 'conv-456' };

    const obj = {
      config: {
        user_id: '{{LIBRECHAT_USER_ID}}',
        custom: '{{CUSTOM_VAR}}',
        api_key: '${TEST_API_KEY}',
        conversation: '{{LIBRECHAT_BODY_CONVERSATIONID}}',
        nested: {
          email: '{{LIBRECHAT_USER_EMAIL}}',
          port: 8080,
        },
      },
    };

    const result = resolveNestedObject({ obj, user, customUserVars, body });

    expect(result).toEqual({
      config: {
        user_id: 'user-123',
        custom: 'custom-value',
        api_key: 'test-api-key-value',
        conversation: 'conv-456',
        nested: {
          email: 'test@example.com',
          port: 8080,
        },
      },
    });
  });

  it('should handle Bedrock additionalModelRequestFields example', () => {
    const obj = {
      thinking: {
        type: 'enabled',
        budget_tokens: 2000,
      },
      anthropic_beta: ['output-128k-2025-02-19'],
    };

    const result = resolveNestedObject({ obj });

    expect(result).toEqual({
      thinking: {
        type: 'enabled',
        budget_tokens: 2000,
      },
      anthropic_beta: ['output-128k-2025-02-19'],
    });

    expect(typeof result.thinking).toBe('object');
    expect(Array.isArray(result.anthropic_beta)).toBe(true);
    expect(result.thinking).not.toBe('[object Object]');
  });

  it('should return undefined when obj is undefined', () => {
    const result = resolveNestedObject({ obj: undefined });
    expect(result).toBeUndefined();
  });

  it('should return null when obj is null', () => {
    const result = resolveNestedObject({ obj: null });
    expect(result).toBeNull();
  });

  it('should handle arrays of objects', () => {
    const user = { id: 'user-123' };
    const obj = {
      items: [
        { name: 'item1', user: '{{LIBRECHAT_USER_ID}}', count: 1 },
        { name: 'item2', user: '{{LIBRECHAT_USER_ID}}', count: 2 },
      ],
    };

    const result = resolveNestedObject({ obj, user });

    expect(result).toEqual({
      items: [
        { name: 'item1', user: 'user-123', count: 1 },
        { name: 'item2', user: 'user-123', count: 2 },
      ],
    });
  });

  it('should not modify the original object', () => {
    const user = { id: 'user-123' };
    const originalObj = {
      thinking: {
        type: 'enabled',
        budget_tokens: 2000,
        user_id: '{{LIBRECHAT_USER_ID}}',
      },
    };

    const result = resolveNestedObject({ obj: originalObj, user });

    expect(result.thinking.user_id).toBe('user-123');
    expect(originalObj.thinking.user_id).toBe('{{LIBRECHAT_USER_ID}}');
  });
});

describe('processMCPEnv', () => {
  beforeEach(() => {
    process.env.TEST_API_KEY = 'test-api-key-value';
    process.env.ANOTHER_VALUE = 'another-test-value';
    process.env.OAUTH_CLIENT_ID = 'oauth-client-id-value';
    process.env.OAUTH_CLIENT_SECRET = 'oauth-client-secret-value';
    process.env.MCP_SERVER_URL = 'https://mcp.example.com';
    process.env.MCP_PROXY_URL = 'http://proxy.example.com:8080';
  });

  afterEach(() => {
    delete process.env.TEST_API_KEY;
    delete process.env.ANOTHER_VALUE;
    delete process.env.OAUTH_CLIENT_ID;
    delete process.env.OAUTH_CLIENT_SECRET;
    delete process.env.MCP_SERVER_URL;
    delete process.env.MCP_PROXY_URL;
  });

  it('should return null/undefined as-is', () => {
    expect(processMCPEnv({ options: null as unknown as MCPOptions })).toBeNull();
    expect(processMCPEnv({ options: undefined as unknown as MCPOptions })).toBeUndefined();
  });

  it('should process stdio type MCP options with env and args', () => {
    const options: MCPOptions = {
      type: 'stdio',
      command: 'mcp-server',
      env: {
        API_KEY: '${TEST_API_KEY}',
        SECRET: '${ANOTHER_VALUE}',
        PLAIN_VALUE: 'plain-text',
      },
      args: ['--key', '${TEST_API_KEY}', '--url', '${MCP_SERVER_URL}'],
    };

    const result = processMCPEnv({ options });

    expect(result).toEqual({
      type: 'stdio',
      command: 'mcp-server',
      env: {
        API_KEY: 'test-api-key-value',
        SECRET: 'another-test-value',
        PLAIN_VALUE: 'plain-text',
      },
      args: ['--key', 'test-api-key-value', '--url', 'https://mcp.example.com'],
    });
  });

  it('should process WebSocket type MCP options with url', () => {
    const options: MCPOptions = {
      type: 'websocket',
      url: '${MCP_SERVER_URL}/ws',
    };

    const result = processMCPEnv({ options });

    expect(result).toEqual({
      type: 'websocket',
      url: 'https://mcp.example.com/ws',
    });
  });

  it('should process outbound proxy for remote MCP options', () => {
    const options: MCPOptions = {
      type: 'sse',
      url: '${MCP_SERVER_URL}/sse',
      proxy: '${MCP_PROXY_URL}',
    };

    const result = processMCPEnv({ options });

    expect(result).toEqual({
      type: 'sse',
      url: 'https://mcp.example.com/sse',
      proxy: 'http://proxy.example.com:8080',
    });
  });

  it('should not process user-controlled placeholders in outbound proxy', () => {
    const user = createTestUser({ id: 'user-proxy-target' });
    const body = { conversationId: 'conv-1', parentMessageId: 'parent-1', messageId: 'msg-1' };
    const options: MCPOptions = {
      type: 'sse',
      url: '${MCP_SERVER_URL}/sse',
      proxy:
        'http://proxy.example.com/{{CUSTOM_PROXY_PATH}}/{{LIBRECHAT_USER_ID}}/{{LIBRECHAT_BODY_MESSAGEID}}',
    };

    const result = processMCPEnv({
      options,
      user,
      body,
      customUserVars: { CUSTOM_PROXY_PATH: 'tenant-proxy' },
    });

    expect(result).toEqual({
      type: 'sse',
      url: 'https://mcp.example.com/sse',
      proxy:
        'http://proxy.example.com/{{CUSTOM_PROXY_PATH}}/{{LIBRECHAT_USER_ID}}/{{LIBRECHAT_BODY_MESSAGEID}}',
    });
  });

  it('should process OAuth configuration with environment variables', () => {
    const options: MCPOptions = {
      type: 'streamable-http',
      url: '${MCP_SERVER_URL}/api',
      headers: {
        'Content-Type': 'application/json',
      },
      oauth: {
        authorization_url: 'https://auth.example.com/authorize',
        token_url: 'https://auth.example.com/token',
        client_id: '${OAUTH_CLIENT_ID}',
        client_secret: '${OAUTH_CLIENT_SECRET}',
        scope: 'read:data write:data',
        redirect_uri: 'http://localhost:3000/callback',
        token_exchange_method: TokenExchangeMethodEnum.DefaultPost,
      },
    };

    const result = processMCPEnv({ options });

    expect(result).toEqual({
      type: 'streamable-http',
      url: 'https://mcp.example.com/api',
      headers: {
        'Content-Type': 'application/json',
      },
      oauth: {
        authorization_url: 'https://auth.example.com/authorize',
        token_url: 'https://auth.example.com/token',
        client_id: 'oauth-client-id-value',
        client_secret: 'oauth-client-secret-value',
        scope: 'read:data write:data',
        redirect_uri: 'http://localhost:3000/callback',
        token_exchange_method: TokenExchangeMethodEnum.DefaultPost,
      },
    });
  });

  it('should process user placeholders in oauth_headers', () => {
    const user = createTestUser({ id: 'user-123', email: 'test@example.com' });
    const options: MCPOptions = {
      type: 'streamable-http',
      url: 'https://mcp.example.com/api',
      oauth_headers: {
        'X-User-Id': '{{LIBRECHAT_USER_ID}}',
        'X-Static': 'static-value',
      },
    };

    const result = processMCPEnv({ options, user });

    expect('oauth_headers' in result! && result.oauth_headers).toEqual({
      'X-User-Id': 'user-123',
      'X-Static': 'static-value',
    });
  });

  it('should NOT resolve user placeholders in oauth_headers when dbSourced', () => {
    const user = createTestUser({ id: 'user-123' });
    const options: MCPOptions = {
      type: 'streamable-http',
      url: 'https://mcp.example.com/api',
      oauth_headers: {
        'X-User-Id': '{{LIBRECHAT_USER_ID}}',
      },
    };

    const result = processMCPEnv({ options, user, dbSourced: true });

    expect('oauth_headers' in result! && result.oauth_headers).toEqual({
      'X-User-Id': '{{LIBRECHAT_USER_ID}}',
    });
  });

  /**
   * `applyRequestHeaders` runs at each pipeline entry, ahead of `processMCPEnv`,
   * so the merged map is what env resolution sees. These exercise that order
   * rather than either half alone.
   */
  it('should resolve merged requestHeaders like any other header', () => {
    const user = createTestUser({ id: 'user-123' });
    const options: MCPOptions = {
      type: 'streamable-http',
      url: 'https://mcp.example.com/api',
      headers: { 'X-User-Id': '{{LIBRECHAT_USER_ID}}' },
      requestHeaders: {
        'X-Conversation-Id': '{{LIBRECHAT_BODY_CONVERSATIONID}}',
        'X-Static': 'static-value',
      },
    };

    const result = processMCPEnv({
      options: applyRequestHeaders(options),
      user,
      body: { conversationId: 'conv-1' },
    });

    expect('headers' in result! && result.headers).toEqual({
      'X-User-Id': 'user-123',
      'X-Conversation-Id': 'conv-1',
      'X-Static': 'static-value',
    });
    expect(result).not.toHaveProperty('requestHeaders');
  });

  it('should NOT resolve merged requestHeaders when dbSourced', () => {
    const user = createTestUser({ id: 'user-123' });
    const options: MCPOptions = {
      type: 'streamable-http',
      url: 'https://mcp.example.com/api',
      requestHeaders: {
        'X-Conversation-Id': '{{LIBRECHAT_BODY_CONVERSATIONID}}',
      },
    };

    const result = processMCPEnv({
      options: applyRequestHeaders(options),
      user,
      body: { conversationId: 'conv-1' },
      dbSourced: true,
    });

    expect('headers' in result! && result.headers).toEqual({
      'X-Conversation-Id': '{{LIBRECHAT_BODY_CONVERSATIONID}}',
    });
  });

  it('should keep plugin-sourced requestHeaders verbatim', () => {
    const user = createTestUser({ id: 'user-123' });
    const options = {
      type: 'streamable-http',
      url: 'https://mcp.example.com/api',
      source: 'plugin',
      headers: { 'X-Keep': 'kept' },
      requestHeaders: { 'X-Conversation-Id': '{{LIBRECHAT_BODY_CONVERSATIONID}}' },
    } as MCPOptions & { source: string };

    const result = processMCPEnv({ options, user, body: { conversationId: 'conv-1' } });

    expect('headers' in result! && result.headers).toEqual({ 'X-Keep': 'kept' });
    expect((result as { requestHeaders?: Record<string, string> }).requestHeaders).toEqual({
      'X-Conversation-Id': '{{LIBRECHAT_BODY_CONVERSATIONID}}',
    });
  });

  it('should process user field placeholders in all fields', () => {
    const user = createTestUser({
      id: 'user-123',
      email: 'test@example.com',
      username: 'testuser',
      role: 'admin',
    });

    const options: MCPOptions = {
      type: 'stdio',
      command: 'mcp-server',
      env: {
        USER_ID: '{{LIBRECHAT_USER_ID}}',
        USER_EMAIL: '{{LIBRECHAT_USER_EMAIL}}',
        USER_ROLE: '{{LIBRECHAT_USER_ROLE}}',
      },
      args: ['--user', '{{LIBRECHAT_USER_USERNAME}}', '--id', '{{LIBRECHAT_USER_ID}}'],
    };

    const result = processMCPEnv({ options, user });

    expect(result).toEqual({
      type: 'stdio',
      command: 'mcp-server',
      env: {
        USER_ID: 'user-123',
        USER_EMAIL: 'test@example.com',
        USER_ROLE: 'admin',
      },
      args: ['--user', 'testuser', '--id', 'user-123'],
    });
  });

  it('should process custom user variables', () => {
    const customUserVars = {
      CUSTOM_TOKEN: 'user-specific-token',
      REGION: 'us-west-1',
    };

    const options: MCPOptions = {
      type: 'sse',
      url: 'https://sse.example.com/{{REGION}}',
      headers: {
        Authorization: 'Bearer {{CUSTOM_TOKEN}}',
        'X-Region': '{{REGION}}',
      },
    };

    const result = processMCPEnv({ options, customUserVars });

    expect(result).toEqual({
      type: 'sse',
      url: 'https://sse.example.com/us-west-1',
      headers: {
        Authorization: 'Bearer user-specific-token',
        'X-Region': 'us-west-1',
      },
    });
  });

  it('should process body placeholders in all fields', () => {
    const body = {
      conversationId: 'conv-123',
      parentMessageId: 'parent-456',
      messageId: 'msg-789',
    };

    const options: MCPOptions = {
      type: 'streamable-http',
      url: 'https://api.example.com/conversations/{{LIBRECHAT_BODY_CONVERSATIONID}}',
      headers: {
        'X-Parent-Message': '{{LIBRECHAT_BODY_PARENTMESSAGEID}}',
        'X-Message-Id': '{{LIBRECHAT_BODY_MESSAGEID}}',
      },
    };

    const result = processMCPEnv({ options, body });

    expect(result).toEqual({
      type: 'streamable-http',
      url: 'https://api.example.com/conversations/conv-123',
      headers: {
        'X-Parent-Message': 'parent-456',
        'X-Message-Id': 'msg-789',
      },
    });
  });

  it('should not resolve env vars introduced via body placeholders in MCP headers', () => {
    const body = {
      conversationId: '${TEST_API_KEY}',
      parentMessageId: '${TEST_API_KEY}',
      messageId: '${TEST_API_KEY}',
    };

    const options: MCPOptions = {
      type: 'streamable-http',
      url: 'https://api.example.com',
      headers: {
        'X-Conv': '{{LIBRECHAT_BODY_CONVERSATIONID}}',
        'X-Parent': '{{LIBRECHAT_BODY_PARENTMESSAGEID}}',
      },
    };

    const result = processMCPEnv({ options, body });

    if (!isStreamableHTTPOptions(result)) {
      throw new Error('Expected streamable-http options');
    }
    expect(result.headers?.['X-Conv']).toBe('${TEST_API_KEY}');
    expect(result.headers?.['X-Parent']).toBe('${TEST_API_KEY}');
  });

  it('should not resolve env vars introduced via customUserVars in MCP headers', () => {
    const customUserVars = { MY_TOKEN: '${TEST_API_KEY}' };
    const options: MCPOptions = {
      type: 'streamable-http',
      url: 'https://api.example.com',
      headers: {
        Authorization: 'Bearer {{MY_TOKEN}}',
      },
    };

    const result = processMCPEnv({ options, customUserVars });

    if (!isStreamableHTTPOptions(result)) {
      throw new Error('Expected streamable-http options');
    }
    expect(result.headers?.Authorization).toBe('Bearer ${TEST_API_KEY}');
  });

  it('should handle mixed placeholders in OAuth configuration', () => {
    const user = createTestUser({
      id: 'user-123',
      email: 'test@example.com',
    });
    const customUserVars = {
      TENANT_ID: 'tenant-456',
    };
    const body = {
      conversationId: 'conv-789',
    };

    const options: MCPOptions = {
      type: 'streamable-http',
      url: '${MCP_SERVER_URL}',
      oauth: {
        authorization_url: 'https://auth.example.com/{{TENANT_ID}}/authorize',
        token_url: 'https://auth.example.com/{{TENANT_ID}}/token',
        client_id: '${OAUTH_CLIENT_ID}',
        client_secret: '${OAUTH_CLIENT_SECRET}',
        scope: 'user:{{LIBRECHAT_USER_ID}} conversation:{{LIBRECHAT_BODY_CONVERSATIONID}}',
        redirect_uri: 'http://localhost:3000/user/{{LIBRECHAT_USER_EMAIL}}/callback',
      },
    };

    const result = processMCPEnv({ options, user, customUserVars, body });

    expect(result).toEqual({
      type: 'streamable-http',
      url: 'https://mcp.example.com',
      oauth: {
        authorization_url: 'https://auth.example.com/tenant-456/authorize',
        token_url: 'https://auth.example.com/tenant-456/token',
        client_id: 'oauth-client-id-value',
        client_secret: 'oauth-client-secret-value',
        scope: 'user:user-123 conversation:conv-789',
        redirect_uri: 'http://localhost:3000/user/test@example.com/callback',
      },
    });
  });

  it('should not modify non-string OAuth values', () => {
    const options: MCPOptions = {
      type: 'streamable-http',
      url: 'https://api.example.com',
      oauth: {
        client_id: '${OAUTH_CLIENT_ID}',
        token_exchange_method: TokenExchangeMethodEnum.DefaultPost,
        scope: 'read:data write:data',
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['client_secret_basic'],
      },
    };

    const result = processMCPEnv({ options });

    if (isStreamableHTTPOptions(result) && result.oauth) {
      expect(result.oauth).toEqual({
        client_id: 'oauth-client-id-value',
        token_exchange_method: TokenExchangeMethodEnum.DefaultPost,
        scope: 'read:data write:data',
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['client_secret_basic'],
      });
    } else {
      throw new Error('Expected streamable-http options with oauth');
    }
  });

  it('should handle missing OAuth values gracefully', () => {
    const options: MCPOptions = {
      type: 'streamable-http',
      url: 'https://api.example.com',
      oauth: {
        client_id: '${OAUTH_CLIENT_ID}',
        client_secret: undefined,
        scope: null as unknown as string,
      },
    };

    const result = processMCPEnv({ options });

    expect(result.oauth).toEqual({
      client_id: 'oauth-client-id-value',
      client_secret: undefined,
      scope: null,
    });
  });

  it('should not modify the original options object', () => {
    const originalOptions: MCPOptions = {
      type: 'stdio',
      command: 'mcp-server',
      env: {
        API_KEY: '${TEST_API_KEY}',
      },
      args: ['--key', '${TEST_API_KEY}'],
    };

    const result = processMCPEnv({ options: originalOptions });

    if (isStdioOptions(result)) {
      expect(result.env?.API_KEY).toBe('test-api-key-value');
      expect(result.args[1]).toBe('test-api-key-value');
    } else {
      throw new Error('Expected stdio options');
    }

    if (isStdioOptions(originalOptions)) {
      expect(originalOptions.env?.API_KEY).toBe('${TEST_API_KEY}');
      expect(originalOptions.args[1]).toBe('${TEST_API_KEY}');
    }
  });

  it('should handle all placeholder types in a single value', () => {
    const user = createTestUser({ id: 'user-123' });
    const customUserVars = { CUSTOM_VAR: 'custom-value' };
    const body = { conversationId: 'conv-456' };

    const options: MCPOptions = {
      type: 'stdio',
      command: 'mcp-server',
      args: [],
      env: {
        COMPLEX_VALUE:
          'User: {{LIBRECHAT_USER_ID}}, Custom: {{CUSTOM_VAR}}, Body: {{LIBRECHAT_BODY_CONVERSATIONID}}, Env: ${TEST_API_KEY}',
      },
    };

    const result = processMCPEnv({ options, user, customUserVars, body });

    if (isStdioOptions(result)) {
      expect(result.env?.COMPLEX_VALUE).toBe(
        'User: user-123, Custom: custom-value, Body: conv-456, Env: test-api-key-value',
      );
    } else {
      throw new Error('Expected stdio options');
    }
  });

  describe('non-string values (type guard tests)', () => {
    it('should handle numeric values in env without crashing', () => {
      const options: MCPOptions = {
        type: 'stdio',
        command: 'mcp-server',
        args: [],
        env: {
          PORT: 8080 as unknown as string,
          TIMEOUT: 30000 as unknown as string,
          API_KEY: '${TEST_API_KEY}',
        },
      };

      const result = processMCPEnv({ options });

      if (isStdioOptions(result)) {
        expect(result.env?.PORT).toBe('8080');
        expect(result.env?.TIMEOUT).toBe('30000');
        expect(result.env?.API_KEY).toBe('test-api-key-value');
      }
    });

    it('should handle boolean values in env without crashing', () => {
      const options: MCPOptions = {
        type: 'stdio',
        command: 'mcp-server',
        args: [],
        env: {
          DEBUG: true as unknown as string,
          PRODUCTION: false as unknown as string,
          API_KEY: '${TEST_API_KEY}',
        },
      };

      const result = processMCPEnv({ options });

      if (isStdioOptions(result)) {
        expect(result.env?.DEBUG).toBe('true');
        expect(result.env?.PRODUCTION).toBe('false');
        expect(result.env?.API_KEY).toBe('test-api-key-value');
      }
    });

    it('should handle numeric values in args without crashing', () => {
      const options: MCPOptions = {
        type: 'stdio',
        command: 'mcp-server',
        args: ['--port', 8080 as unknown as string, '--timeout', 30000 as unknown as string],
      };

      const result = processMCPEnv({ options });

      if (isStdioOptions(result)) {
        expect(result.args).toEqual(['--port', '8080', '--timeout', '30000']);
      }
    });

    it('should handle null and undefined values in env', () => {
      const options: MCPOptions = {
        type: 'stdio',
        command: 'mcp-server',
        args: [],
        env: {
          NULL_VALUE: null as unknown as string,
          UNDEFINED_VALUE: undefined as unknown as string,
          NORMAL_VALUE: 'normal',
        },
      };

      const result = processMCPEnv({ options });

      if (isStdioOptions(result)) {
        expect(result.env?.NULL_VALUE).toBe('null');
        expect(result.env?.UNDEFINED_VALUE).toBe('undefined');
        expect(result.env?.NORMAL_VALUE).toBe('normal');
      }
    });

    it('should handle numeric values in headers without crashing', () => {
      const options: MCPOptions = {
        type: 'streamable-http',
        url: 'https://api.example.com',
        headers: {
          'X-Timeout': 5000 as unknown as string,
          'X-Retry-Count': 3 as unknown as string,
          'Content-Type': 'application/json',
        },
      };

      const result = processMCPEnv({ options });

      if (isStreamableHTTPOptions(result)) {
        expect(result.headers?.['X-Timeout']).toBe('5000');
        expect(result.headers?.['X-Retry-Count']).toBe('3');
        expect(result.headers?.['Content-Type']).toBe('application/json');
      }
    });

    it('should handle numeric URL values', () => {
      const options: MCPOptions = {
        type: 'websocket',
        url: 12345 as unknown as string,
      };

      const result = processMCPEnv({ options });

      expect((result as unknown as { url?: string }).url).toBe('12345');
    });

    it('should handle mixed numeric and placeholder values', () => {
      const user = createTestUser({ id: 'user-123' });
      const options: MCPOptions = {
        type: 'stdio',
        command: 'mcp-server',
        args: [],
        env: {
          PORT: 8080 as unknown as string,
          USER_ID: '{{LIBRECHAT_USER_ID}}',
          API_KEY: '${TEST_API_KEY}',
        },
      };

      const result = processMCPEnv({ options, user });

      if (isStdioOptions(result)) {
        expect(result.env?.PORT).toBe('8080');
        expect(result.env?.USER_ID).toBe('user-123');
        expect(result.env?.API_KEY).toBe('test-api-key-value');
      }
    });

    it('should handle objects and arrays in env values', () => {
      const options: MCPOptions = {
        type: 'stdio',
        command: 'mcp-server',
        args: [],
        env: {
          OBJECT_VALUE: { nested: 'value' } as unknown as string,
          ARRAY_VALUE: ['item1', 'item2'] as unknown as string,
          STRING_VALUE: 'normal',
        },
      };

      const result = processMCPEnv({ options });

      if (isStdioOptions(result)) {
        expect(result.env?.OBJECT_VALUE).toBe('[object Object]');
        expect(result.env?.ARRAY_VALUE).toBe('item1,item2');
        expect(result.env?.STRING_VALUE).toBe('normal');
      }
    });

    it('should not crash with numeric body field values', () => {
      const body = {
        conversationId: 12345 as unknown as string,
        parentMessageId: 'parent-456',
        messageId: 'msg-789',
      };
      const options: MCPOptions = {
        type: 'stdio',
        command: 'mcp-server',
        args: [],
        env: {
          CONV_ID: '{{LIBRECHAT_BODY_CONVERSATIONID}}',
          PORT: 8080 as unknown as string,
        },
      };

      expect(() => processMCPEnv({ options, body })).not.toThrow();
      const result = processMCPEnv({ options, body });

      if (isStdioOptions(result)) {
        expect(result.env?.PORT).toBe('8080');
      }
    });
  });

  describe('admin-provided API key header injection', () => {
    it('should apply admin-provided bearer API key to Authorization header', () => {
      const options: MCPOptions = {
        type: 'streamable-http',
        url: 'https://api.example.com',
        apiKey: {
          source: 'admin',
          authorization_type: 'bearer',
          key: 'my-secret-api-key',
        },
      };

      const result = processMCPEnv({ options });

      if (isStreamableHTTPOptions(result)) {
        expect(result.headers?.Authorization).toBe('Bearer my-secret-api-key');
      } else {
        throw new Error('Expected streamable-http options');
      }
    });

    it('should apply admin-provided basic API key to Authorization header', () => {
      const options: MCPOptions = {
        type: 'streamable-http',
        url: 'https://api.example.com',
        apiKey: {
          source: 'admin',
          authorization_type: 'basic',
          key: 'base64encodedcreds',
        },
      };

      const result = processMCPEnv({ options });

      if (isStreamableHTTPOptions(result)) {
        expect(result.headers?.Authorization).toBe('Basic base64encodedcreds');
      } else {
        throw new Error('Expected streamable-http options');
      }
    });

    it('should apply admin-provided custom API key to custom header', () => {
      const options: MCPOptions = {
        type: 'streamable-http',
        url: 'https://api.example.com',
        apiKey: {
          source: 'admin',
          authorization_type: 'custom',
          custom_header: 'X-Api-Key',
          key: 'my-custom-api-key',
        },
      };

      const result = processMCPEnv({ options });

      if (isStreamableHTTPOptions(result)) {
        expect(result.headers?.['X-Api-Key']).toBe('my-custom-api-key');
        expect(result.headers?.Authorization).toBeUndefined();
      } else {
        throw new Error('Expected streamable-http options');
      }
    });

    it('should use default X-Api-Key header when custom_header is not provided', () => {
      const options: MCPOptions = {
        type: 'streamable-http',
        url: 'https://api.example.com',
        apiKey: {
          source: 'admin',
          authorization_type: 'custom',
          key: 'my-api-key',
        },
      };

      const result = processMCPEnv({ options });

      if (isStreamableHTTPOptions(result)) {
        expect(result.headers?.['X-Api-Key']).toBe('my-api-key');
      } else {
        throw new Error('Expected streamable-http options');
      }
    });

    it('should not apply user-provided API key (handled via placeholders)', () => {
      const options: MCPOptions = {
        type: 'streamable-http',
        url: 'https://api.example.com',
        apiKey: {
          source: 'user',
          authorization_type: 'bearer',
        },
        headers: {
          Authorization: 'Bearer {{MCP_API_KEY}}',
        },
      };

      const result = processMCPEnv({ options });

      if (isStreamableHTTPOptions(result)) {
        // User-provided key should NOT be injected - placeholder remains
        expect(result.headers?.Authorization).toBe('Bearer {{MCP_API_KEY}}');
      } else {
        throw new Error('Expected streamable-http options');
      }
    });

    it('should merge admin API key header with existing headers', () => {
      const options: MCPOptions = {
        type: 'streamable-http',
        url: 'https://api.example.com',
        headers: {
          'Content-Type': 'application/json',
          'X-Custom-Header': 'custom-value',
        },
        apiKey: {
          source: 'admin',
          authorization_type: 'bearer',
          key: 'my-api-key',
        },
      };

      const result = processMCPEnv({ options });

      if (isStreamableHTTPOptions(result)) {
        expect(result.headers?.['Content-Type']).toBe('application/json');
        expect(result.headers?.['X-Custom-Header']).toBe('custom-value');
        expect(result.headers?.Authorization).toBe('Bearer my-api-key');
      } else {
        throw new Error('Expected streamable-http options');
      }
    });

    it('should not inject header when apiKey.key is missing', () => {
      const options: MCPOptions = {
        type: 'streamable-http',
        url: 'https://api.example.com',
        apiKey: {
          source: 'admin',
          authorization_type: 'bearer',
          // key is missing
        },
      };

      const result = processMCPEnv({ options });

      if (isStreamableHTTPOptions(result)) {
        expect(result.headers?.Authorization).toBeUndefined();
      } else {
        throw new Error('Expected streamable-http options');
      }
    });
  });

  describe('dbSourced flag', () => {
    beforeEach(() => {
      process.env.TEST_API_KEY = 'test-api-key-value';
      process.env.DATABASE_URL = 'mongodb://secret-host:27017/db';
    });

    afterEach(() => {
      delete process.env.TEST_API_KEY;
      delete process.env.DATABASE_URL;
    });

    it('should resolve customUserVars when dbSourced is true', () => {
      const options: MCPOptions = {
        type: 'streamable-http',
        url: 'https://api.example.com',
        headers: {
          Authorization: 'Bearer {{MCP_API_KEY}}',
        },
      };

      const result = processMCPEnv({
        options,
        dbSourced: true,
        customUserVars: { MCP_API_KEY: 'user-secret-key' },
      });

      if (isStreamableHTTPOptions(result)) {
        expect(result.headers?.Authorization).toBe('Bearer user-secret-key');
      } else {
        throw new Error('Expected streamable-http options');
      }
    });

    it('should NOT resolve ${ENV_VAR} when dbSourced is true', () => {
      const options: MCPOptions = {
        type: 'streamable-http',
        url: 'https://api.example.com',
        headers: {
          'X-Leaked': '${DATABASE_URL}',
          'X-Key': '${TEST_API_KEY}',
        },
      };

      const result = processMCPEnv({ options, dbSourced: true });

      if (isStreamableHTTPOptions(result)) {
        expect(result.headers?.['X-Leaked']).toBe('${DATABASE_URL}');
        expect(result.headers?.['X-Key']).toBe('${TEST_API_KEY}');
      } else {
        throw new Error('Expected streamable-http options');
      }
    });

    it('should NOT resolve {{LIBRECHAT_USER_*}} when dbSourced is true', () => {
      const user = createTestUser({ id: 'user-123', email: 'test@example.com' });
      const options: MCPOptions = {
        type: 'streamable-http',
        url: 'https://api.example.com',
        headers: {
          'X-User-Id': '{{LIBRECHAT_USER_ID}}',
          'X-User-Email': '{{LIBRECHAT_USER_EMAIL}}',
        },
      };

      const result = processMCPEnv({ options, user, dbSourced: true });

      if (isStreamableHTTPOptions(result)) {
        expect(result.headers?.['X-User-Id']).toBe('{{LIBRECHAT_USER_ID}}');
        expect(result.headers?.['X-User-Email']).toBe('{{LIBRECHAT_USER_EMAIL}}');
      } else {
        throw new Error('Expected streamable-http options');
      }
    });

    it('should NOT resolve {{LIBRECHAT_OPENID_*}} when dbSourced is true', () => {
      const user = {
        ...createTestUser({ id: 'user-123', provider: 'openid' }),
        federatedTokens: {
          access_token: 'oidc-access-token',
          id_token: 'oidc-id-token',
          refresh_token: 'oidc-refresh-token',
          token_type: 'Bearer',
          expires_at: Date.now() + 3600000,
        },
      };
      const options: MCPOptions = {
        type: 'streamable-http',
        url: 'https://api.example.com',
        headers: {
          Authorization: 'Bearer {{LIBRECHAT_OPENID_ACCESS_TOKEN}}',
        },
      };

      const result = processMCPEnv({ options, user, dbSourced: true });

      if (isStreamableHTTPOptions(result)) {
        expect(result.headers?.Authorization).toBe('Bearer {{LIBRECHAT_OPENID_ACCESS_TOKEN}}');
      } else {
        throw new Error('Expected streamable-http options');
      }
    });

    it('should NOT resolve {{LIBRECHAT_BODY_*}} when dbSourced is true', () => {
      const body = {
        conversationId: 'conv-123',
        parentMessageId: 'parent-456',
        messageId: 'msg-789',
      };
      const options: MCPOptions = {
        type: 'streamable-http',
        url: 'https://api.example.com',
        headers: {
          'X-Conversation': '{{LIBRECHAT_BODY_CONVERSATIONID}}',
        },
      };

      const result = processMCPEnv({ options, body, dbSourced: true });

      if (isStreamableHTTPOptions(result)) {
        expect(result.headers?.['X-Conversation']).toBe('{{LIBRECHAT_BODY_CONVERSATIONID}}');
      } else {
        throw new Error('Expected streamable-http options');
      }
    });

    it('should resolve customUserVars but block all other placeholders when dbSourced is true', () => {
      const user = createTestUser({ id: 'user-123' });
      const body = { conversationId: 'conv-123', parentMessageId: 'p-1', messageId: 'm-1' };
      const options: MCPOptions = {
        type: 'streamable-http',
        url: '${DATABASE_URL}',
        headers: {
          Authorization: 'Bearer {{MCP_API_KEY}}',
          'X-Env-Leak': '${TEST_API_KEY}',
          'X-User-Id': '{{LIBRECHAT_USER_ID}}',
          'X-Body': '{{LIBRECHAT_BODY_CONVERSATIONID}}',
        },
      };

      const result = processMCPEnv({
        options,
        user,
        body,
        dbSourced: true,
        customUserVars: { MCP_API_KEY: 'user-key-value' },
      });

      if (isStreamableHTTPOptions(result)) {
        expect(result.headers?.Authorization).toBe('Bearer user-key-value');
        expect(result.headers?.['X-Env-Leak']).toBe('${TEST_API_KEY}');
        expect(result.headers?.['X-User-Id']).toBe('{{LIBRECHAT_USER_ID}}');
        expect(result.headers?.['X-Body']).toBe('{{LIBRECHAT_BODY_CONVERSATIONID}}');
        expect(result.url).toBe('${DATABASE_URL}');
      } else {
        throw new Error('Expected streamable-http options');
      }
    });

    it('should resolve all placeholders when dbSourced is false (default)', () => {
      const user = createTestUser({ id: 'user-123' });
      const options: MCPOptions = {
        type: 'streamable-http',
        url: 'https://api.example.com',
        headers: {
          Authorization: 'Bearer {{MCP_API_KEY}}',
          'X-Env': '${TEST_API_KEY}',
          'X-User-Id': '{{LIBRECHAT_USER_ID}}',
        },
      };

      const result = processMCPEnv({
        options,
        user,
        dbSourced: false,
        customUserVars: { MCP_API_KEY: 'user-key-value' },
      });

      if (isStreamableHTTPOptions(result)) {
        expect(result.headers?.Authorization).toBe('Bearer user-key-value');
        expect(result.headers?.['X-Env']).toBe('test-api-key-value');
        expect(result.headers?.['X-User-Id']).toBe('user-123');
      } else {
        throw new Error('Expected streamable-http options');
      }
    });

    it('should apply dbSourced to env, args, and URL — not just headers', () => {
      const options: MCPOptions = {
        type: 'stdio',
        command: 'mcp-server',
        args: ['--key', '${TEST_API_KEY}', '--custom', '{{MY_VAR}}'],
        env: {
          SECRET: '${DATABASE_URL}',
          CUSTOM: '{{MY_VAR}}',
        },
      };

      const result = processMCPEnv({
        options,
        dbSourced: true,
        customUserVars: { MY_VAR: 'resolved-value' },
      });

      if (isStdioOptions(result)) {
        expect(result.env?.SECRET).toBe('${DATABASE_URL}');
        expect(result.env?.CUSTOM).toBe('resolved-value');
        expect(result.args?.[1]).toBe('${TEST_API_KEY}');
        expect(result.args?.[3]).toBe('resolved-value');
      } else {
        throw new Error('Expected stdio options');
      }
    });

    it('should still apply admin API key header injection when dbSourced is true', () => {
      const options: MCPOptions = {
        type: 'streamable-http',
        url: 'https://api.example.com',
        apiKey: {
          source: 'admin',
          authorization_type: 'bearer',
          key: 'admin-managed-key',
        },
      };

      const result = processMCPEnv({ options, dbSourced: true });

      if (isStreamableHTTPOptions(result)) {
        expect(result.headers?.Authorization).toBe('Bearer admin-managed-key');
      } else {
        throw new Error('Expected streamable-http options');
      }
    });

    it('should block env vars in OAuth config when dbSourced is true', () => {
      const options: MCPOptions = {
        type: 'streamable-http',
        url: 'https://api.example.com',
        oauth: {
          client_id: '${TEST_API_KEY}',
          client_secret: '${DATABASE_URL}',
          token_url: 'https://auth.example.com/token',
          token_exchange_method: TokenExchangeMethodEnum.DefaultPost,
        },
      };

      const result = processMCPEnv({ options, dbSourced: true });

      const oauth = (result as { oauth?: Record<string, unknown> }).oauth;
      expect(oauth?.client_id).toBe('${TEST_API_KEY}');
      expect(oauth?.client_secret).toBe('${DATABASE_URL}');
    });

    it('should resolve customUserVars in OAuth config when dbSourced is true', () => {
      const options: MCPOptions = {
        type: 'streamable-http',
        url: 'https://api.example.com',
        oauth: {
          client_id: '{{MY_CLIENT_ID}}',
          client_secret: '{{MY_CLIENT_SECRET}}',
          token_url: 'https://auth.example.com/token',
          token_exchange_method: TokenExchangeMethodEnum.DefaultPost,
        },
      };

      const result = processMCPEnv({
        options,
        dbSourced: true,
        customUserVars: { MY_CLIENT_ID: 'resolved-client', MY_CLIENT_SECRET: 'resolved-secret' },
      });

      const oauth = (result as { oauth?: Record<string, unknown> }).oauth;
      expect(oauth?.client_id).toBe('resolved-client');
      expect(oauth?.client_secret).toBe('resolved-secret');
    });

    it('should leave unresolved customUserVars as literal placeholders', () => {
      const options: MCPOptions = {
        type: 'streamable-http',
        url: 'https://api.example.com',
        headers: {
          Authorization: 'Bearer {{MCP_API_KEY}}',
        },
      };

      // No customUserVars provided — placeholder should remain
      const result = processMCPEnv({ options, dbSourced: true });

      if (isStreamableHTTPOptions(result)) {
        expect(result.headers?.Authorization).toBe('Bearer {{MCP_API_KEY}}');
      } else {
        throw new Error('Expected streamable-http options');
      }
    });

    it('should not modify the original options when dbSourced is true', () => {
      const options: MCPOptions = {
        type: 'streamable-http',
        url: '${DATABASE_URL}',
        headers: {
          Authorization: 'Bearer {{MCP_API_KEY}}',
          'X-Env': '${TEST_API_KEY}',
        },
      };

      const originalUrl = options.url;
      const originalAuth = (options as { headers: Record<string, string> }).headers.Authorization;

      processMCPEnv({
        options,
        dbSourced: true,
        customUserVars: { MCP_API_KEY: 'resolved' },
      });

      expect(options.url).toBe(originalUrl);
      expect((options as { headers: Record<string, string> }).headers.Authorization).toBe(
        originalAuth,
      );
    });

    it('should handle empty customUserVars object without errors', () => {
      const options: MCPOptions = {
        type: 'streamable-http',
        url: 'https://api.example.com',
        headers: {
          'X-Key': '${TEST_API_KEY}',
          'X-Custom': '{{MCP_API_KEY}}',
        },
      };

      const result = processMCPEnv({ options, dbSourced: true, customUserVars: {} });

      if (isStreamableHTTPOptions(result)) {
        expect(result.headers?.['X-Key']).toBe('${TEST_API_KEY}');
        expect(result.headers?.['X-Custom']).toBe('{{MCP_API_KEY}}');
      } else {
        throw new Error('Expected streamable-http options');
      }
    });

    it('dbSourced undefined should behave like false (resolve everything)', () => {
      const user = createTestUser({ id: 'user-abc' });
      const options: MCPOptions = {
        type: 'streamable-http',
        url: 'https://api.example.com',
        headers: {
          'X-Env': '${TEST_API_KEY}',
          'X-User': '{{LIBRECHAT_USER_ID}}',
        },
      };

      const result = processMCPEnv({ options, user });

      if (isStreamableHTTPOptions(result)) {
        expect(result.headers?.['X-Env']).toBe('test-api-key-value');
        expect(result.headers?.['X-User']).toBe('user-abc');
      } else {
        throw new Error('Expected streamable-http options');
      }
    });
  });
});

describe('createSafeUser', () => {
  it('returns an empty object for null/undefined users', () => {
    expect(createSafeUser(null)).toEqual({});
    expect(createSafeUser(undefined)).toEqual({});
  });

  it('falls back to _id (ObjectId) when the virtual id is absent', () => {
    const objectId = new Types.ObjectId();
    const user = { _id: objectId, email: 'lean@example.com' } as unknown as IUser;

    const safeUser = createSafeUser(user);

    expect(safeUser.id).toBe(objectId.toString());
    expect(safeUser.email).toBe('lean@example.com');
  });

  it('falls back to a string _id when the virtual id is absent', () => {
    const user = { _id: 'string-id-123', email: 'lean@example.com' } as unknown as IUser;

    const safeUser = createSafeUser(user);

    expect(safeUser.id).toBe('string-id-123');
  });

  it('leaves a truthy id untouched and does not use _id', () => {
    const objectId = new Types.ObjectId();
    const user = { _id: objectId, id: 'real-id', email: 'user@example.com' } as unknown as IUser;

    const safeUser = createSafeUser(user);

    expect(safeUser.id).toBe('real-id');
    expect(safeUser.id).not.toBe(objectId.toString());
  });

  it('replaces a falsy (empty-string) id with _id', () => {
    const objectId = new Types.ObjectId();
    const user = { _id: objectId, id: '', email: 'user@example.com' } as unknown as IUser;

    const safeUser = createSafeUser(user);

    expect(safeUser.id).toBe(objectId.toString());
  });

  it('leaves id undefined when _id is absent', () => {
    const user = { email: 'no-id@example.com' } as unknown as IUser;

    const safeUser = createSafeUser(user);

    expect(safeUser.id).toBeUndefined();
  });

  it('leaves id undefined when _id is nullish and does not throw', () => {
    const user = { _id: null, email: 'null-id@example.com' } as unknown as IUser;

    expect(() => createSafeUser(user)).not.toThrow();
    expect(createSafeUser(user).id).toBeUndefined();
  });
});

describe('resolveHeaders stripUnresolved', () => {
  const templateHeaders = {
    'X-OpenID-Id': '{{LIBRECHAT_USER_OPENIDID}}',
    'X-User-Id': '{{LIBRECHAT_USER_ID}}',
    'Content-Type': 'application/json',
  };

  it('strips user placeholders when user context is missing entirely', () => {
    const result = resolveHeaders({ headers: { ...templateHeaders }, stripUnresolved: true });

    expect(result).toEqual({
      'X-OpenID-Id': '',
      'X-User-Id': '',
      'Content-Type': 'application/json',
    });
  });

  it('strips user placeholders when the safe user is an empty object (issue #14580)', () => {
    const result = resolveHeaders({
      headers: { ...templateHeaders },
      user: createSafeUser(undefined),
      stripUnresolved: true,
    });

    expect(result).toEqual({
      'X-OpenID-Id': '',
      'X-User-Id': '',
      'Content-Type': 'application/json',
    });
  });

  it('strips placeholders for fields the user lacks while substituting present fields', () => {
    const localUser = createSafeUser({ id: 'user-123', email: 'me@example.com' } as IUser);

    const result = resolveHeaders({
      headers: { ...templateHeaders, 'X-Email': '{{LIBRECHAT_USER_EMAIL}}' },
      user: localUser,
      stripUnresolved: true,
    });

    expect(result).toEqual({
      'X-OpenID-Id': '',
      'X-User-Id': 'user-123',
      'X-Email': 'me@example.com',
      'Content-Type': 'application/json',
    });
  });

  it('strips only the placeholder within a composite header value', () => {
    const result = resolveHeaders({
      headers: { Authorization: 'Bearer {{LIBRECHAT_USER_OPENIDID}}' },
      stripUnresolved: true,
    });

    expect(result.Authorization).toBe('Bearer ');
  });

  it('strips body placeholders when no body context is available', () => {
    const result = resolveHeaders({
      headers: { 'X-Convo': '{{LIBRECHAT_BODY_CONVERSATIONID}}' },
      user: { id: 'user-123' },
      stripUnresolved: true,
    });

    expect(result['X-Convo']).toBe('');
  });

  it('omits OpenID credential headers when no valid token is available', () => {
    const result = resolveHeaders({
      headers: {
        'X-Access': '{{LIBRECHAT_OPENID_ACCESS_TOKEN}}',
        'X-Token': '{{LIBRECHAT_OPENID_TOKEN}}',
      },
      user: { id: 'user-123' },
      stripUnresolved: true,
    });

    expect(result).not.toHaveProperty('X-Access');
    expect(result).not.toHaveProperty('X-Token');
  });

  it('omits the credential header but strips identity placeholders to empty', () => {
    const result = resolveHeaders({
      headers: {
        Authorization: 'Bearer {{LIBRECHAT_OPENID_ACCESS_TOKEN}}',
        'X-Org': '{{LIBRECHAT_OPENID_USER_ID}}',
      },
      user: createTestUser({ id: 'user-123' }),
      stripUnresolved: true,
    });

    expect(result).not.toHaveProperty('Authorization');
    expect(result['X-Org']).toBe('');
  });

  it('preserves credential placeholders literally when stripUnresolved is false', () => {
    const result = resolveHeaders({
      headers: {
        Authorization: 'Bearer {{LIBRECHAT_OPENID_ACCESS_TOKEN}}',
        'X-Org': '{{LIBRECHAT_OPENID_USER_ID}}',
      },
      user: createTestUser({ id: 'user-123' }),
    });

    expect(result.Authorization).toBe('Bearer {{LIBRECHAT_OPENID_ACCESS_TOKEN}}');
    expect(result['X-Org']).toBe('{{LIBRECHAT_OPENID_USER_ID}}');
  });

  it('leaves unknown and non-resolvable placeholders untouched', () => {
    const result = resolveHeaders({
      headers: {
        'X-Typo': '{{LIBRECHAT_USER_NONEXISTENT}}',
        'X-Graph': '{{LIBRECHAT_GRAPH_ACCESS_TOKEN}}',
        'X-Custom': '{{MY_CUSTOM_VAR}}',
      },
      stripUnresolved: true,
    });

    expect(result['X-Typo']).toBe('{{LIBRECHAT_USER_NONEXISTENT}}');
    expect(result['X-Graph']).toBe('{{LIBRECHAT_GRAPH_ACCESS_TOKEN}}');
    expect(result['X-Custom']).toBe('{{MY_CUSTOM_VAR}}');
  });

  it('preserves unresolved placeholders by default (staged flows resolve later)', () => {
    const result = resolveHeaders({ headers: { ...templateHeaders } });

    expect(result['X-OpenID-Id']).toBe('{{LIBRECHAT_USER_OPENIDID}}');
    expect(result['X-User-Id']).toBe('{{LIBRECHAT_USER_ID}}');
  });
});

describe('processMCPEnv OpenID re-authentication signalling', () => {
  function createOpenIDUser(expiresAt: number): IUser {
    return {
      ...createTestUser({ id: 'user-123', provider: 'openid' }),
      openidId: 'oidc-sub-456',
      federatedTokens: {
        access_token: 'stored-access-token',
        id_token: 'stored-id-token',
        refresh_token: 'stored-refresh-token',
        expires_at: expiresAt,
      },
    } as IUser;
  }

  function tokenlessOpenIDUser(): IUser {
    return {
      ...createTestUser({ id: 'user-123', provider: 'openid' }),
      openidId: 'oidc-sub-456',
    } as IUser;
  }

  const expiredSeconds = Math.floor(Date.now() / 1000) - 3600;
  const validSeconds = Math.floor(Date.now() / 1000) + 3600;

  it('should throw an actionable re-auth error when the token set is expired and a credential placeholder is present', () => {
    const options: MCPOptions = {
      type: 'streamable-http',
      url: 'https://api.example.com',
      headers: {
        Authorization: 'Bearer {{LIBRECHAT_OPENID_ACCESS_TOKEN}}',
      },
    };

    expect(() => processMCPEnv({ options, user: createOpenIDUser(expiredSeconds) })).toThrow(
      'OpenID token is expired or unavailable; re-authentication is required to resolve {{LIBRECHAT_OPENID_ACCESS_TOKEN}}',
    );
  });

  it('should still resolve other placeholders when the token set is expired but no OpenID placeholder is present', () => {
    const options: MCPOptions = {
      type: 'streamable-http',
      url: 'https://api.example.com',
      headers: {
        'X-User-Id': '{{LIBRECHAT_USER_ID}}',
      },
    };

    const result = processMCPEnv({ options, user: createOpenIDUser(expiredSeconds) });

    if (isStreamableHTTPOptions(result)) {
      expect(result.headers?.['X-User-Id']).toBe('user-123');
    } else {
      throw new Error('Expected streamable-http options');
    }
  });

  it('should leave an unknown OpenID placeholder name literal instead of raising re-auth', () => {
    const options: MCPOptions = {
      type: 'streamable-http',
      url: 'https://api.example.com',
      headers: {
        Authorization: 'Bearer {{LIBRECHAT_OPENID_ACCES_TOKEN}}',
      },
    };

    const result = processMCPEnv({ options, user: createOpenIDUser(expiredSeconds) });

    if (isStreamableHTTPOptions(result)) {
      expect(result.headers?.Authorization).toBe('Bearer {{LIBRECHAT_OPENID_ACCES_TOKEN}}');
    } else {
      throw new Error('Expected streamable-http options');
    }
  });

  it('should leave OpenID placeholders untouched for a user with no OpenID identity', () => {
    const options: MCPOptions = {
      type: 'streamable-http',
      url: 'https://api.example.com',
      headers: {
        Authorization: 'Bearer {{LIBRECHAT_OPENID_ACCESS_TOKEN}}',
      },
    };

    const result = processMCPEnv({ options, user: createTestUser({ id: 'user-123' }) });

    if (isStreamableHTTPOptions(result)) {
      expect(result.headers?.Authorization).toBe('Bearer {{LIBRECHAT_OPENID_ACCESS_TOKEN}}');
    } else {
      throw new Error('Expected streamable-http options');
    }
  });

  it('should substitute the access token when the token set is still valid', () => {
    const options: MCPOptions = {
      type: 'streamable-http',
      url: 'https://api.example.com',
      headers: {
        Authorization: 'Bearer {{LIBRECHAT_OPENID_ACCESS_TOKEN}}',
      },
    };

    const result = processMCPEnv({ options, user: createOpenIDUser(validSeconds) });

    if (isStreamableHTTPOptions(result)) {
      expect(result.headers?.Authorization).toBe('Bearer stored-access-token');
    } else {
      throw new Error('Expected streamable-http options');
    }
  });

  it('should raise re-auth from resolveHeaders when the ID token is expired', () => {
    expect(() =>
      resolveHeaders({
        headers: { Authorization: 'Bearer {{LIBRECHAT_OPENID_ID_TOKEN}}' },
        user: createOpenIDUser(expiredSeconds),
        stripUnresolved: true,
      }),
    ).toThrow(
      'OpenID ID token is expired or unavailable; re-authentication is required to resolve {{LIBRECHAT_OPENID_ID_TOKEN}}',
    );
  });

  /** The OpenID JWT strategy leaves `access_token` unset when it cannot identify the request bearer as one */
  function accessTokenlessOpenIDUser(idTokenExp: number): { user: IUser; idToken: string } {
    const idToken = `header.${Buffer.from(
      JSON.stringify({ sub: 'oidc-sub-456', exp: idTokenExp }),
    ).toString('base64')}.signature`;
    const user = {
      ...createTestUser({ id: 'user-123', provider: 'openid' }),
      openidId: 'oidc-sub-456',
      federatedTokens: { id_token: idToken, refresh_token: 'stored-refresh-token' },
    } as IUser;
    return { user, idToken };
  }

  it('should resolve an ID token placeholder while no access token is stored', () => {
    const { user, idToken } = accessTokenlessOpenIDUser(validSeconds);

    const resolved = resolveHeaders({
      headers: { Authorization: 'Bearer {{LIBRECHAT_OPENID_ID_TOKEN}}' },
      user,
      stripUnresolved: true,
    });

    expect(resolved.Authorization).toBe(`Bearer ${idToken}`);
  });

  it('should keep identity metadata literal while no access token is stored', () => {
    const { user } = accessTokenlessOpenIDUser(validSeconds);

    const resolved = resolveHeaders({
      headers: { 'X-User-Id': '{{LIBRECHAT_OPENID_USER_ID}}' },
      user,
    });

    expect(resolved['X-User-Id']).toBe('{{LIBRECHAT_OPENID_USER_ID}}');
  });

  it('should still raise re-auth for an access token placeholder while no access token is stored', () => {
    const { user } = accessTokenlessOpenIDUser(validSeconds);

    expect(() =>
      resolveHeaders({
        headers: { Authorization: 'Bearer {{LIBRECHAT_OPENID_ACCESS_TOKEN}}' },
        user,
      }),
    ).toThrow('re-authentication is required to resolve {{LIBRECHAT_OPENID_ACCESS_TOKEN}}');
  });

  it('should leave identity metadata placeholders literal for an OpenID user with no stored tokens', () => {
    const options: MCPOptions = {
      type: 'streamable-http',
      url: 'https://api.example.com',
      headers: {
        'X-User-Id': '{{LIBRECHAT_OPENID_USER_ID}}',
      },
    };

    const result = processMCPEnv({ options, user: tokenlessOpenIDUser() });

    if (isStreamableHTTPOptions(result)) {
      expect(result.headers?.['X-User-Id']).toBe('{{LIBRECHAT_OPENID_USER_ID}}');
    } else {
      throw new Error('Expected streamable-http options');
    }

    expect(
      resolveHeaders({
        headers: { 'X-User-Id': '{{LIBRECHAT_OPENID_USER_ID}}' },
        user: tokenlessOpenIDUser(),
        stripUnresolved: true,
      })['X-User-Id'],
    ).toBe('');
  });

  it('should still raise re-auth for a credential placeholder when no tokens are stored', () => {
    const options: MCPOptions = {
      type: 'streamable-http',
      url: 'https://api.example.com',
      headers: {
        Authorization: 'Bearer {{LIBRECHAT_OPENID_ACCESS_TOKEN}}',
      },
    };

    expect(() => processMCPEnv({ options, user: tokenlessOpenIDUser() })).toThrow(
      'OpenID token is expired or unavailable; re-authentication is required to resolve {{LIBRECHAT_OPENID_ACCESS_TOKEN}}',
    );
  });

  it('should not raise re-auth for a metadata-only template when the token set is expired', () => {
    const options: MCPOptions = {
      type: 'streamable-http',
      url: 'https://api.example.com',
      headers: {
        'X-User-Id': '{{LIBRECHAT_OPENID_USER_ID}}',
        'X-User-Email': '{{LIBRECHAT_OPENID_USER_EMAIL}}',
        'X-User-Name': '{{LIBRECHAT_OPENID_USER_NAME}}',
        'X-Expires': '{{LIBRECHAT_OPENID_EXPIRES_AT}}',
      },
    };

    const result = processMCPEnv({ options, user: createOpenIDUser(expiredSeconds) });

    if (isStreamableHTTPOptions(result)) {
      expect(result.headers?.['X-User-Id']).toBe('{{LIBRECHAT_OPENID_USER_ID}}');
      expect(result.headers?.['X-Expires']).toBe('{{LIBRECHAT_OPENID_EXPIRES_AT}}');
    } else {
      throw new Error('Expected streamable-http options');
    }
  });
});
