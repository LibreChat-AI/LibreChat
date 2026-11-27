/**
 * Tests for MCPConnection error detection methods.
 *
 * Rate-limit tests use a standalone implementation that mirrors a private method in
 * MCPConnection. OAuth and SSE classification exercise the production helpers shared by the
 * connection and factory.
 *
 * Alternative approaches considered:
 * 1. Reflection/type casting - fragile and breaks with refactoring
 * 2. Protected methods with test subclass - changes public API for testing
 * 3. Integration tests - tested separately in the full MCP test suite
 */
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  extractSSEErrorMessage,
  isOAuthAuthenticationError,
  isStandaloneSseConflict,
} from '~/mcp/errors';

describe('MCPConnection Error Detection', () => {
  /**
   * Standalone implementation of isRateLimitError for testing.
   * This mirrors the private method in MCPConnection (connection.ts).
   * Keep in sync with the actual implementation.
   */
  function isRateLimitError(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
      return false;
    }

    // Check for error code
    if ('code' in error) {
      const code = (error as { code?: number }).code;
      if (code === 429) {
        return true;
      }
    }

    // Check message for rate limit indicators
    if ('message' in error && typeof error.message === 'string') {
      const message = error.message.toLowerCase();
      if (
        message.includes('429') ||
        message.includes('rate limit') ||
        message.includes('too many requests')
      ) {
        return true;
      }
    }

    return false;
  }

  describe('isRateLimitError', () => {
    it('should detect rate limit error by code 429', () => {
      const error = { code: 429, message: 'Too many requests' };
      expect(isRateLimitError(error)).toBe(true);
    });

    it('should detect rate limit error by message containing 429', () => {
      const error = { message: 'Error POSTing to endpoint (HTTP 429): Too many requests' };
      expect(isRateLimitError(error)).toBe(true);
    });

    it('should detect rate limit error by message containing "rate limit"', () => {
      const error = { message: 'Rate limit exceeded, please try again later' };
      expect(isRateLimitError(error)).toBe(true);
    });

    it('should detect rate limit error by message containing "too many requests"', () => {
      const error = { message: 'Too many requests - slow down!' };
      expect(isRateLimitError(error)).toBe(true);
    });

    it('should not detect rate limit for 401 errors', () => {
      const error = { code: 401, message: 'Unauthorized' };
      expect(isRateLimitError(error)).toBe(false);
    });

    it('should not detect rate limit for 500 errors', () => {
      const error = { code: 500, message: 'Internal server error' };
      expect(isRateLimitError(error)).toBe(false);
    });

    it('should not detect rate limit for null/undefined', () => {
      expect(isRateLimitError(null)).toBe(false);
      expect(isRateLimitError(undefined)).toBe(false);
    });

    it('should not detect rate limit for non-object errors', () => {
      expect(isRateLimitError('string error')).toBe(false);
      expect(isRateLimitError(123)).toBe(false);
    });

    it('should handle real-world StackOverflow rate limit error', () => {
      const error = {
        code: 429,
        message:
          'Streamable HTTP error: Error POSTing to endpoint: <!DOCTYPE html><html>Too Many Requests</html>',
      };
      expect(isRateLimitError(error)).toBe(true);
    });
  });

  describe('isOAuthAuthenticationError', () => {
    it.each([
      { code: 401, message: 'Unauthorized' },
      { status: 403, message: 'Forbidden' },
      { statusCode: 401, message: 'Authentication required' },
      { message: 'Error POSTing to endpoint (HTTP 401): Unauthorized' },
      { message: 'Error POSTing to endpoint (HTTP 403): Forbidden' },
      { message: 'Non-200 status code (403)' },
      { message: '403 Forbidden' },
      { message: 'Unauthorized (401)' },
      { message: 'Forbidden (403)' },
      { message: 'The server rejected the token with insufficient_scope' },
    ])('should detect OAuth authentication error %#', (error) => {
      expect(isOAuthAuthenticationError(error)).toBe(true);
    });

    it.each([
      { code: 429, message: 'Too many requests' },
      { message: 'Customer 401 not found' },
      { message: 'Order 403 is unavailable' },
      { message: 'User is unauthorized to delete this record' },
      { message: 'No authorization to delete this record' },
      { code: 400, message: 'Bad request: missing required field' },
    ])('should ignore non-authentication error %#', (error) => {
      expect(isOAuthAuthenticationError(error)).toBe(false);
    });

    it('should detect OAuth error for invalid_token', () => {
      const error = { message: 'The access token is invalid_token or expired' };
      expect(isOAuthAuthenticationError(error)).toBe(true);
    });

    it('should detect OAuth error for invalid_grant', () => {
      const error = {
        message:
          'Streamable HTTP error: Error POSTing to endpoint: {"error":"invalid_grant","error_description":"The provided authorization grant is invalid, expired, or revoked"}',
      };
      expect(isOAuthAuthenticationError(error)).toBe(true);
    });

    it('should detect OAuth error for "no authorization" in message (HTTP 400)', () => {
      const error = {
        message:
          'Either no authorization values are specified or it could not be derived from the request',
      };
      expect(isOAuthAuthenticationError(error)).toBe(true);
    });

    it('should detect OAuth error for "No authorization" with different casing', () => {
      const error = { message: 'No Authorization header provided' };
      expect(isOAuthAuthenticationError(error)).toBe(true);
    });
  });

  describe('error type differentiation', () => {
    it('should correctly differentiate between rate limit and OAuth errors', () => {
      const rateLimitError = { code: 429, message: 'Too many requests' };
      const oauthError = { code: 401, message: 'Unauthorized' };

      // Rate limit error should be detected as rate limit, not OAuth
      expect(isRateLimitError(rateLimitError)).toBe(true);
      expect(isOAuthAuthenticationError(rateLimitError)).toBe(false);

      // OAuth error should be detected as OAuth, not rate limit
      expect(isOAuthAuthenticationError(oauthError)).toBe(true);
      expect(isRateLimitError(oauthError)).toBe(false);
    });
  });
});

/**
 * Tests for extractSSEErrorMessage function.
 * This function extracts meaningful error messages from SSE transport errors,
 * particularly handling the "SSE error: undefined" case from the MCP SDK.
 */
describe('extractSSEErrorMessage', () => {
  describe('undefined/empty error handling', () => {
    it('should handle "SSE error: undefined" from MCP SDK', () => {
      const error = { message: 'SSE error: undefined', code: undefined };
      const result = extractSSEErrorMessage(error);

      expect(result.message).toContain('SSE connection closed');
      expect(result.isProxyHint).toBe(true);
      expect(result.isTransient).toBe(true);
    });

    it('should handle empty message', () => {
      const error = { message: '' };
      const result = extractSSEErrorMessage(error);

      expect(result.message).toContain('SSE connection closed');
      expect(result.isTransient).toBe(true);
    });

    it('should handle message "undefined"', () => {
      const error = { message: 'undefined' };
      const result = extractSSEErrorMessage(error);

      expect(result.message).toContain('SSE connection closed');
      expect(result.isTransient).toBe(true);
    });

    it('should handle null error', () => {
      const result = extractSSEErrorMessage(null);

      expect(result.message).toBe('Unknown SSE transport error');
      expect(result.isTransient).toBe(true);
    });

    it('should handle undefined error', () => {
      const result = extractSSEErrorMessage(undefined);

      expect(result.message).toBe('Unknown SSE transport error');
      expect(result.isTransient).toBe(true);
    });

    it('should handle non-object error', () => {
      const result = extractSSEErrorMessage('string error');

      expect(result.message).toBe('Unknown SSE transport error');
      expect(result.isTransient).toBe(true);
    });
  });

  describe('timeout errors', () => {
    it('should detect ETIMEDOUT', () => {
      const error = { message: 'connect ETIMEDOUT 1.2.3.4:443' };
      const result = extractSSEErrorMessage(error);

      expect(result.message).toContain('SSE connection timed out');
      expect(result.message).toContain('proxy_read_timeout');
      expect(result.isProxyHint).toBe(true);
      expect(result.isTransient).toBe(true);
    });

    it('should detect ESOCKETTIMEDOUT', () => {
      const error = { message: 'ESOCKETTIMEDOUT' };
      const result = extractSSEErrorMessage(error);

      expect(result.message).toContain('SSE connection timed out');
      expect(result.isTransient).toBe(true);
    });

    it('should detect "timed out" (case insensitive)', () => {
      const error = { message: 'Connection Timed Out' };
      const result = extractSSEErrorMessage(error);

      expect(result.message).toContain('SSE connection timed out');
      expect(result.isTransient).toBe(true);
    });

    it('should detect "timeout after"', () => {
      const error = { message: 'Request timeout after 60000ms' };
      const result = extractSSEErrorMessage(error);

      expect(result.message).toContain('SSE connection timed out');
      expect(result.isTransient).toBe(true);
    });

    it('should detect "request timeout"', () => {
      const error = { message: 'Request Timeout' };
      const result = extractSSEErrorMessage(error);

      expect(result.message).toContain('SSE connection timed out');
      expect(result.isTransient).toBe(true);
    });

    it('should NOT match "timeout" in unrelated context', () => {
      // URL containing "timeout" should not trigger timeout detection
      const error = { message: 'Failed to connect to https://api.example.com/timeout-settings' };
      const result = extractSSEErrorMessage(error);

      expect(result.message).not.toContain('SSE connection timed out');
      expect(result.message).toBe('Failed to connect to https://api.example.com/timeout-settings');
    });
  });

  describe('connection errors', () => {
    it('should detect ECONNRESET as transient', () => {
      const error = { message: 'read ECONNRESET' };
      const result = extractSSEErrorMessage(error);

      expect(result.message).toContain('SSE connection reset');
      expect(result.isProxyHint).toBe(false);
      expect(result.isTransient).toBe(true);
    });

    it('should detect ECONNREFUSED as non-transient', () => {
      const error = { message: 'connect ECONNREFUSED 127.0.0.1:8080' };
      const result = extractSSEErrorMessage(error);

      expect(result.message).toContain('SSE connection refused');
      expect(result.message).toContain('Verify the MCP server is running');
      expect(result.isTransient).toBe(false);
    });
  });

  describe('DNS errors', () => {
    it('should detect ENOTFOUND', () => {
      const error = { message: 'getaddrinfo ENOTFOUND unknown.host.com' };
      const result = extractSSEErrorMessage(error);

      expect(result.message).toContain('SSE DNS resolution failed');
      expect(result.message).toContain('Check the server URL');
      expect(result.isTransient).toBe(false);
    });

    it('should detect getaddrinfo errors', () => {
      const error = { message: 'getaddrinfo EAI_AGAIN example.com' };
      const result = extractSSEErrorMessage(error);

      expect(result.message).toContain('SSE DNS resolution failed');
      expect(result.isTransient).toBe(false);
    });
  });

  describe('HTTP status code errors', () => {
    it('should detect 502 as proxy hint and transient', () => {
      const error = { message: 'Non-200 status code (502): Bad Gateway' };
      const result = extractSSEErrorMessage(error);

      expect(result.code).toBe(502);
      expect(result.isProxyHint).toBe(true);
      expect(result.isTransient).toBe(true);
    });

    it('should detect 503 as proxy hint and transient', () => {
      const error = { message: 'Error: Service Unavailable (503)' };
      const result = extractSSEErrorMessage(error);

      expect(result.code).toBe(503);
      expect(result.isProxyHint).toBe(true);
      expect(result.isTransient).toBe(true);
    });

    it('should detect 504 as proxy hint and transient', () => {
      const error = { message: 'Gateway Timeout 504' };
      const result = extractSSEErrorMessage(error);

      expect(result.code).toBe(504);
      expect(result.isProxyHint).toBe(true);
      expect(result.isTransient).toBe(true);
    });

    it('should detect 500 as transient but not proxy hint', () => {
      const error = { message: 'Internal Server Error (500)' };
      const result = extractSSEErrorMessage(error);

      expect(result.code).toBe(500);
      expect(result.isProxyHint).toBe(false);
      expect(result.isTransient).toBe(true);
    });

    it('should detect 404 as non-transient', () => {
      const error = { message: 'Not Found (404)' };
      const result = extractSSEErrorMessage(error);

      expect(result.code).toBe(404);
      expect(result.isProxyHint).toBe(false);
      expect(result.isTransient).toBe(false);
    });

    it('should detect 401 as non-transient', () => {
      const error = { message: 'Unauthorized (401)' };
      const result = extractSSEErrorMessage(error);

      expect(result.code).toBe(401);
      expect(result.isTransient).toBe(false);
    });
  });

  describe('SseError from MCP SDK', () => {
    it('should handle SseError with event property', () => {
      const error = {
        message: 'SSE error: undefined',
        code: undefined,
        event: { type: 'error', code: undefined, message: undefined },
      };
      const result = extractSSEErrorMessage(error);

      expect(result.message).toContain('SSE connection closed');
      expect(result.isTransient).toBe(true);
    });

    it('should preserve code from SseError', () => {
      const error = {
        message: 'SSE error: Server sent HTTP 204, not reconnecting',
        code: 204,
      };
      const result = extractSSEErrorMessage(error);

      expect(result.code).toBe(204);
    });
  });

  describe('regular error messages', () => {
    it('should pass through regular error messages', () => {
      const error = { message: 'Some specific error message', code: 42 };
      const result = extractSSEErrorMessage(error);

      expect(result.message).toBe('Some specific error message');
      expect(result.code).toBe(42);
      expect(result.isProxyHint).toBe(false);
      expect(result.isTransient).toBe(false);
    });
  });

  describe('fetch failed errors', () => {
    it('should detect "fetch failed" as transient', () => {
      const error = { message: 'fetch failed' };
      const result = extractSSEErrorMessage(error);

      expect(result.message).toContain('fetch failed');
      expect(result.message).toContain('request aborted');
      expect(result.isProxyHint).toBe(false);
      expect(result.isTransient).toBe(true);
    });

    it('should not match "fetch failed" as a substring in a longer message', () => {
      const error = { message: 'Something fetch failed to do' };
      const result = extractSSEErrorMessage(error);

      expect(result.message).toBe('Something fetch failed to do');
      expect(result.isTransient).toBe(false);
    });
  });

  describe('status carried on code rather than in the message', () => {
    it('should classify a 409 standalone SSE stream conflict as transient', () => {
      const error = new StreamableHTTPError(409, 'Failed to open SSE stream: Conflict');
      const result = extractSSEErrorMessage(error);

      expect(result.code).toBe(409);
      expect(result.isTransient).toBe(true);
      expect(result.isProxyHint).toBe(false);
    });

    it('should classify a 5xx as transient when the message carries no digits', () => {
      const error = new StreamableHTTPError(503, 'Failed to open SSE stream: Service Unavailable');
      const result = extractSSEErrorMessage(error);

      expect(result.code).toBe(503);
      expect(result.isTransient).toBe(true);
      expect(result.isProxyHint).toBe(true);
    });

    it('should keep other 4xx non-transient when the message carries no digits', () => {
      const error = new StreamableHTTPError(403, 'Failed to open SSE stream: Forbidden');
      const result = extractSSEErrorMessage(error);

      expect(result.code).toBe(403);
      expect(result.isTransient).toBe(false);
    });

    it('should ignore non-HTTP codes so they do not reach the status branch', () => {
      const error = { message: 'Something went wrong', code: 42 };
      const result = extractSSEErrorMessage(error);

      expect(result.code).toBe(42);
      expect(result.isTransient).toBe(false);
    });
  });
});

describe('isStandaloneSseConflict', () => {
  it('should detect the SDK 409 raised when opening the standalone SSE stream', () => {
    const error = new StreamableHTTPError(409, 'Failed to open SSE stream: Conflict');

    expect(isStandaloneSseConflict(error)).toBe(true);
  });

  it('should not match a 409 raised for anything other than the SSE stream', () => {
    const error = new StreamableHTTPError(409, 'Failed to send message');

    expect(isStandaloneSseConflict(error)).toBe(false);
  });

  it('should not match other statuses on the SSE stream', () => {
    const error = new StreamableHTTPError(500, 'Failed to open SSE stream: Internal Server Error');

    expect(isStandaloneSseConflict(error)).toBe(false);
  });

  it('should not match a look-alike error from another transport', () => {
    const error = Object.assign(new Error('Failed to open SSE stream: Conflict'), { code: 409 });

    expect(isStandaloneSseConflict(error)).toBe(false);
  });

  it('should not match non-error values', () => {
    expect(isStandaloneSseConflict(undefined)).toBe(false);
    expect(isStandaloneSseConflict('Conflict')).toBe(false);
  });
});

/**
 * Tests for circuit breaker logic.
 *
 * Uses standalone implementations that mirror the static/private circuit breaker
 * methods in MCPConnection. Same approach as the error detection tests above.
 */
describe('MCPConnection Circuit Breaker', () => {
  /** 5 cycles within 60s triggers a 30s cooldown */
  const CB_MAX_CYCLES = 5;
  const CB_CYCLE_WINDOW_MS = 60_000;
  const CB_CYCLE_COOLDOWN_MS = 30_000;

  /** 3 failed rounds within 120s triggers exponential backoff (30s - 300s) */
  const CB_MAX_FAILED_ROUNDS = 3;
  const CB_FAILED_WINDOW_MS = 120_000;
  const CB_BASE_BACKOFF_MS = 30_000;
  const CB_MAX_BACKOFF_MS = 300_000;

  interface CircuitBreakerState {
    cycleCount: number;
    cycleWindowStart: number;
    cooldownUntil: number;
    failedRounds: number;
    failedWindowStart: number;
    failedBackoffUntil: number;
  }

  function createCB(): CircuitBreakerState {
    return {
      cycleCount: 0,
      cycleWindowStart: Date.now(),
      cooldownUntil: 0,
      failedRounds: 0,
      failedWindowStart: Date.now(),
      failedBackoffUntil: 0,
    };
  }

  function isCircuitOpen(cb: CircuitBreakerState): boolean {
    const now = Date.now();
    return now < cb.cooldownUntil || now < cb.failedBackoffUntil;
  }

  function recordCycle(cb: CircuitBreakerState): void {
    const now = Date.now();
    if (now - cb.cycleWindowStart > CB_CYCLE_WINDOW_MS) {
      cb.cycleCount = 0;
      cb.cycleWindowStart = now;
    }
    cb.cycleCount++;
    if (cb.cycleCount >= CB_MAX_CYCLES) {
      cb.cooldownUntil = now + CB_CYCLE_COOLDOWN_MS;
      cb.cycleCount = 0;
      cb.cycleWindowStart = now;
    }
  }

  function recordFailedRound(cb: CircuitBreakerState): void {
    const now = Date.now();
    if (now - cb.failedWindowStart > CB_FAILED_WINDOW_MS) {
      cb.failedRounds = 0;
      cb.failedWindowStart = now;
    }
    cb.failedRounds++;
    if (cb.failedRounds >= CB_MAX_FAILED_ROUNDS) {
      const backoff = Math.min(
        CB_BASE_BACKOFF_MS * Math.pow(2, cb.failedRounds - CB_MAX_FAILED_ROUNDS),
        CB_MAX_BACKOFF_MS,
      );
      cb.failedBackoffUntil = now + backoff;
    }
  }

  function resetFailedRounds(cb: CircuitBreakerState): void {
    cb.failedRounds = 0;
    cb.failedWindowStart = Date.now();
    cb.failedBackoffUntil = 0;
  }

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('cycle tracking', () => {
    it('should not trigger cooldown for fewer than 5 cycles', () => {
      const now = Date.now();
      jest.setSystemTime(now);

      const cb = createCB();
      for (let i = 0; i < CB_MAX_CYCLES - 1; i++) {
        recordCycle(cb);
      }
      expect(isCircuitOpen(cb)).toBe(false);
    });

    it('should trigger 30s cooldown after 5 cycles within 60s', () => {
      const now = Date.now();
      jest.setSystemTime(now);

      const cb = createCB();
      for (let i = 0; i < CB_MAX_CYCLES; i++) {
        recordCycle(cb);
      }
      expect(isCircuitOpen(cb)).toBe(true);

      jest.advanceTimersByTime(29_000);
      expect(isCircuitOpen(cb)).toBe(true);

      jest.advanceTimersByTime(1_000);
      expect(isCircuitOpen(cb)).toBe(false);
    });

    it('should reset cycle count when window expires', () => {
      const now = Date.now();
      jest.setSystemTime(now);

      const cb = createCB();
      for (let i = 0; i < CB_MAX_CYCLES - 1; i++) {
        recordCycle(cb);
      }

      jest.advanceTimersByTime(CB_CYCLE_WINDOW_MS + 1);

      recordCycle(cb);
      expect(isCircuitOpen(cb)).toBe(false);
    });
  });

  describe('failed round tracking', () => {
    it('should not trigger backoff for fewer than 3 failures', () => {
      const now = Date.now();
      jest.setSystemTime(now);

      const cb = createCB();
      for (let i = 0; i < CB_MAX_FAILED_ROUNDS - 1; i++) {
        recordFailedRound(cb);
      }
      expect(isCircuitOpen(cb)).toBe(false);
    });

    it('should trigger 30s backoff after 3 failures within 120s', () => {
      const now = Date.now();
      jest.setSystemTime(now);

      const cb = createCB();
      for (let i = 0; i < CB_MAX_FAILED_ROUNDS; i++) {
        recordFailedRound(cb);
      }
      expect(isCircuitOpen(cb)).toBe(true);

      jest.advanceTimersByTime(CB_BASE_BACKOFF_MS);
      expect(isCircuitOpen(cb)).toBe(false);
    });

    it('should use exponential backoff based on failure count', () => {
      jest.setSystemTime(Date.now());

      const cb = createCB();

      for (let i = 0; i < 3; i++) {
        recordFailedRound(cb);
      }
      expect(cb.failedBackoffUntil - Date.now()).toBe(30_000);

      recordFailedRound(cb);
      expect(cb.failedBackoffUntil - Date.now()).toBe(60_000);

      recordFailedRound(cb);
      expect(cb.failedBackoffUntil - Date.now()).toBe(120_000);

      recordFailedRound(cb);
      expect(cb.failedBackoffUntil - Date.now()).toBe(240_000);

      // capped at 300s
      recordFailedRound(cb);
      expect(cb.failedBackoffUntil - Date.now()).toBe(300_000);
    });

    it('should reset failed window when window expires', () => {
      const now = Date.now();
      jest.setSystemTime(now);

      const cb = createCB();
      recordFailedRound(cb);
      recordFailedRound(cb);

      jest.advanceTimersByTime(CB_FAILED_WINDOW_MS + 1);

      recordFailedRound(cb);
      expect(isCircuitOpen(cb)).toBe(false);
    });
  });

  describe('resetFailedRounds', () => {
    it('should clear failed round state on successful connection', () => {
      const now = Date.now();
      jest.setSystemTime(now);

      const cb = createCB();
      for (let i = 0; i < CB_MAX_FAILED_ROUNDS; i++) {
        recordFailedRound(cb);
      }
      expect(isCircuitOpen(cb)).toBe(true);

      resetFailedRounds(cb);
      expect(isCircuitOpen(cb)).toBe(false);
      expect(cb.failedRounds).toBe(0);
      expect(cb.failedBackoffUntil).toBe(0);
    });
  });

  describe('clearCooldown (registry deletion)', () => {
    it('should allow connections after clearing circuit breaker state', () => {
      const now = Date.now();
      jest.setSystemTime(now);

      const registry = new Map<string, CircuitBreakerState>();
      const serverName = 'test-server';

      const cb = createCB();
      registry.set(serverName, cb);

      for (let i = 0; i < CB_MAX_CYCLES; i++) {
        recordCycle(cb);
      }
      expect(isCircuitOpen(cb)).toBe(true);

      registry.delete(serverName);

      const newCb = createCB();
      expect(isCircuitOpen(newCb)).toBe(false);
    });
  });
});
