import type { AuthLogRequest, AuthLogState } from './auth';
import {
  buildSafeAuthLogContext,
  buildSafeRequestLogContext,
  buildTenantIsolationErrorLogContext,
  getAuthFailureErrorName,
  getAuthFailureReason,
  getAuthFailureReasonCategory,
} from './auth';

function createRequest(overrides: Partial<AuthLogRequest> = {}): AuthLogRequest {
  return {
    headers: {},
    method: 'GET',
    path: '/api/messages',
    originalUrl: '/api/messages',
    ...overrides,
  };
}

function createAuthState(overrides: Partial<AuthLogState> = {}): AuthLogState {
  return {
    tokenProvider: 'openid',
    tokenSource: 'bearer',
    openidReuseEnabled: true,
    openidJwtAvailable: true,
    hasOpenIdReuseUserId: true,
    ...overrides,
  };
}

describe('auth middleware logging helpers', () => {
  it('builds safe auth log context without raw query strings or user identifiers', () => {
    const log = buildSafeAuthLogContext(
      createRequest({
        id: 'request-id',
        path: undefined,
        originalUrl: '/api/ask?access_token=secret-token',
      }),
      createAuthState(),
      {
        event_name: 'jwt_auth_rejected',
        attempted_strategies: ['openidJwt', 'jwt'],
        fallback_attempted: true,
        fallback_succeeded: false,
        reason_category: 'expired_jwt',
        recovery_classification: 'terminal_rejection',
        response_status: 401,
      },
    );

    expect(log).toEqual({
      request_id: 'request-id',
      request_method: 'GET',
      request_path: '/api/ask',
      token_provider: 'openid',
      token_source: 'bearer',
      openid_reuse_enabled: true,
      openid_jwt_available: true,
      has_openid_reuse_user_id: true,
      attempted_strategies: ['openidJwt', 'jwt'],
      fallback_attempted: true,
      fallback_succeeded: false,
      event_name: 'jwt_auth_rejected',
      reason_category: 'expired_jwt',
      recovery_classification: 'terminal_rejection',
      response_status: 401,
    });
    expect(JSON.stringify(log)).not.toContain('secret-token');
  });

  it('uses request headers when request ids are not directly set', () => {
    const log = buildSafeAuthLogContext(
      createRequest({
        headers: {
          'x-request-id': ['header-request-id'],
        },
      }),
      createAuthState({
        tokenProvider: null,
        tokenSource: null,
        openidReuseEnabled: false,
        openidJwtAvailable: false,
        hasOpenIdReuseUserId: false,
      }),
    );

    expect(log).toEqual({
      request_id: 'header-request-id',
      request_method: 'GET',
      request_path: '/api/messages',
      openid_reuse_enabled: false,
      openid_jwt_available: false,
      has_openid_reuse_user_id: false,
    });
  });

  it.each([
    `${'a'.repeat(24)}.${'b'.repeat(24)}.${'c'.repeat(24)}`,
    'header..signature',
    'header.payload.',
    'header..initialization-vector.ciphertext.authentication-tag',
    'a'.repeat(129),
  ])('drops credential-shaped or oversized request ID %s', (requestId) => {
    const log = buildSafeAuthLogContext(
      createRequest({ headers: { 'x-request-id': requestId } }),
      createAuthState(),
    );

    expect(log.request_id).toBeUndefined();
  });

  it('uses the next valid correlation candidate after rejecting an unsafe request ID', () => {
    const context = buildSafeRequestLogContext(
      createRequest({
        requestId: `${'a'.repeat(24)}.${'b'.repeat(24)}.${'c'.repeat(24)}`,
        headers: { 'x-request-id': 'safe-header-request' },
      }),
    );

    expect(context.request_id).toBe('safe-header-request');
  });

  it('normalizes known request methods and buckets unknown methods', () => {
    expect(buildSafeRequestLogContext(createRequest({ method: 'get' })).request_method).toBe('GET');
    expect(
      buildSafeRequestLogContext(createRequest({ method: 'CUSTOM_METHOD' })).request_method,
    ).toBe('OTHER');
  });

  it('buckets unknown token providers to keep auth logs low-cardinality', () => {
    const log = buildSafeAuthLogContext(
      createRequest(),
      createAuthState({
        tokenProvider: 'attacker-controlled-provider',
      }),
    );

    expect(log.token_provider).toBe('other');
  });

  it('buckets unknown token sources to keep auth logs low-cardinality', () => {
    const log = buildSafeAuthLogContext(
      createRequest(),
      createAuthState({ tokenSource: 'attacker-controlled-source' }),
    );

    expect(log.token_source).toBe('other');
  });

  it('prefers route buckets over concrete dynamic request paths', () => {
    const log = buildSafeAuthLogContext(
      createRequest({
        baseUrl: '/api/messages',
        path: '/conversation-123/message-456',
        originalUrl: '/api/messages/conversation-123/message-456?access_token=secret-token',
      }),
      createAuthState(),
    );

    expect(log.request_path).toBe('/api/messages');
    expect(JSON.stringify(log)).not.toContain('conversation-123');
    expect(JSON.stringify(log)).not.toContain('message-456');
    expect(JSON.stringify(log)).not.toContain('secret-token');
  });

  it('logs route templates when Express exposes them', () => {
    const log = buildSafeAuthLogContext(
      createRequest({
        baseUrl: '/api/share',
        path: '/link/conversation-123',
        route: { path: '/link/:conversationId' },
      }),
      createAuthState(),
    );

    expect(log.request_path).toBe('/api/share/link/:conversationId');
  });

  it('buckets the original URL when Express leaves an unmounted route template', () => {
    const context = buildSafeRequestLogContext(
      createRequest({
        baseUrl: '',
        path: '/conversation-123',
        originalUrl: '/api/convos/conversation-123?access_token=secret-token',
        route: { path: '/:id' },
      }),
    );

    expect(context.request_path).toBe('/api/convos');
    expect(JSON.stringify(context)).not.toContain('conversation-123');
    expect(JSON.stringify(context)).not.toContain('secret-token');
  });

  it('drops unsupported and sensitive extra values while keeping allowed fields', () => {
    const log = buildSafeAuthLogContext(createRequest({ id: 'request-id' }), createAuthState(), {
      attempted_strategies: ['openidJwt', '', { strategy: 'jwt' }, 'jwt'],
      fallback_attempted: true,
      path: { unsafe: true },
      request_id: { unsafe: true },
      response_status: Number.NaN,
      unsafe_object: { token: 'secret-token' },
      reason: '  jwt expired  ',
    });

    expect(log).toEqual({
      request_id: 'request-id',
      request_method: 'GET',
      request_path: '/api/messages',
      token_provider: 'openid',
      token_source: 'bearer',
      openid_reuse_enabled: true,
      openid_jwt_available: true,
      has_openid_reuse_user_id: true,
      attempted_strategies: ['openidJwt', 'jwt'],
      fallback_attempted: true,
    });
    expect(JSON.stringify(log)).not.toContain('secret-token');
  });

  it('builds request context without raw query strings', () => {
    const context = buildSafeRequestLogContext(
      createRequest({
        id: 'request-id',
        path: undefined,
        originalUrl: '/api/convos/conversation-123?access_token=secret-token',
      }),
    );

    expect(context).toEqual({
      request_id: 'request-id',
      request_method: 'GET',
      request_path: '/api/convos',
    });
    expect(JSON.stringify(context)).not.toContain('secret-token');
  });

  it('builds a safe, joinable context for tenant-isolation errors', () => {
    const context = buildTenantIsolationErrorLogContext(
      createRequest({
        id: 'request-id',
        path: undefined,
        originalUrl: '/api/banner?access_token=secret-token',
      }),
      new Error('[TenantIsolation] Query attempted without tenant context in strict mode'),
    );

    expect(context).toEqual({
      event_name: 'tenant_isolation_error',
      error_category: 'tenant_isolation',
      error_signature: 'missing_query_context',
      response_status: 500,
      request_id: 'request-id',
      request_method: 'GET',
      request_path: '/api/banner',
    });
    expect(JSON.stringify(context)).not.toContain('secret-token');
  });

  it.each([
    [
      '[TenantIsolation] Query attempted without tenant context in strict mode',
      'missing_query_context',
    ],
    [
      '[TenantIsolation] Aggregate attempted without tenant context in strict mode',
      'missing_aggregate_context',
    ],
    [
      '[TenantIsolation] Save attempted without tenant context in strict mode',
      'missing_save_context',
    ],
    [
      '[TenantIsolation] insertMany attempted without tenant context in strict mode',
      'missing_insert_many_context',
    ],
    [
      '[TenantIsolation] bulkWrite on Message attempted without tenant context in strict mode',
      'missing_bulk_write_context',
    ],
    [
      '[TenantIsolation] Unknown bulkWrite operation type in strict mode — refusing to pass through without tenant injection',
      'unsupported_bulk_write_operation',
    ],
    ['[TenantIsolation] Cross-tenant tenantId mutation is not allowed', 'cross_tenant_mutation'],
    [
      '[TenantIsolation] Document tenantId does not match current tenant context',
      'tenant_mismatch',
    ],
    [
      '[TenantIsolation] Modifying tenantId via replacement is not allowed',
      'replacement_tenant_mutation',
    ],
  ])('classifies known tenant-isolation error %s', (message, errorSignature) => {
    const context = buildTenantIsolationErrorLogContext(createRequest(), new Error(message));

    expect(context?.error_signature).toBe(errorSignature);
  });

  it('prefers Passport info fields for auth failure reason and error name', () => {
    const err = Object.assign(new Error('outer failure'), { name: 'OuterError' });
    const info = { message: 'jwt expired', name: 'TokenExpiredError' };

    expect(getAuthFailureReason(err, info)).toBe('jwt expired');
    expect(getAuthFailureErrorName(err, info)).toBe('TokenExpiredError');
    expect(getAuthFailureReasonCategory(err, info)).toBe('expired_jwt');
  });

  it('falls back to Error fields when Passport info is absent', () => {
    const err = Object.assign(new Error('invalid signature'), { name: 'JsonWebTokenError' });

    expect(getAuthFailureReason(err, undefined)).toBe('invalid signature');
    expect(getAuthFailureErrorName(err, undefined)).toBe('JsonWebTokenError');
    expect(getAuthFailureReasonCategory(err, undefined)).toBe('malformed_jwt');
  });

  it('does not throw when Passport failure objects expose throwing getters', () => {
    const err = Object.assign(new Error('invalid signature'), { name: 'JsonWebTokenError' });
    const info = {};
    Object.defineProperties(info, {
      message: {
        get() {
          throw new TypeError('message getter failed');
        },
      },
      name: {
        get() {
          throw new TypeError('name getter failed');
        },
      },
    });

    expect(getAuthFailureReason(err, info)).toBe('invalid signature');
    expect(getAuthFailureErrorName(err, info)).toBe('JsonWebTokenError');
    expect(getAuthFailureReasonCategory(err, info)).toBe('malformed_jwt');
  });
});
