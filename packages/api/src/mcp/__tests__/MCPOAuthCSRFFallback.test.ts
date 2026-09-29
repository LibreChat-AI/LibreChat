/**
 * Tests for the OAuth callback CSRF fallback logic.
 *
 * The callback route validates requests via three mechanisms (in order):
 * 1. CSRF cookie (HMAC-based, set during initiate)
 * 2. Session cookie (bound to authenticated userId)
 * 3. Active PENDING flow in FlowStateManager (fallback for SSE/chat flows)
 *
 * This suite tests mechanism 3 — the PENDING flow fallback — including
 * staleness enforcement and rejection of non-PENDING flows.
 *
 * These tests exercise the validation functions directly for fast,
 * focused coverage. Route-level integration tests using supertest
 * are in api/server/routes/__tests__/mcp.spec.js ("CSRF fallback
 * via active PENDING flow" describe block).
 */

import { Keyv } from 'keyv';
import type { Request, Response } from 'express';
import {
  generateOAuthCsrfToken,
  OAUTH_SESSION_COOKIE,
  setOAuthSessionCookie,
  validateOAuthSession,
  OAUTH_CSRF_COOKIE,
  validateOAuthCsrf,
} from '~/oauth/csrf';
import { FlowStateManager, PENDING_STALE_MS } from '~/flow/manager';
import { MockKeyv } from './helpers/oauthTestServer';

jest.mock('@librechat/data-schemas', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
  getTenantId: jest.fn(),
  SYSTEM_TENANT_ID: '__SYSTEM__',
  encryptV2: jest.fn(async (val: string) => `enc:${val}`),
  decryptV2: jest.fn(async (val: string) => val.replace(/^enc:/, '')),
}));

const CSRF_COOKIE_PATH = '/api/mcp';

function makeReq(cookies: Record<string, string> = {}): Request {
  return { cookies } as unknown as Request;
}

function makeRes(): Response {
  const res = {
    clearCookie: jest.fn(),
  } as unknown as Response;
  return res;
}

/**
 * Mints the value the `oauth_session` cookie now carries for `userId`: a signed
 * HS256 `{ id, exp }` token, produced by the same `setOAuthSessionCookie` the
 * application uses so the value is exactly what `validateOAuthSession` accepts.
 * Captures the value from a `res.cookie` call rather than reconstructing the
 * digest inline, which the old keyed-digest form did.
 */
function mintOAuthSessionCookie(userId: string): string {
  let value = '';
  const res = {
    cookie: (_name: string, cookieValue: string) => {
      value = cookieValue;
    },
  } as unknown as Response;
  setOAuthSessionCookie(res, userId);
  return value;
}

/**
 * Replicate the callback route's three-tier validation logic.
 * Returns which mechanism (if any) authorized the request.
 */
async function validateCallback(
  req: Request,
  res: Response,
  flowId: string,
  flowManager: FlowStateManager,
): Promise<'csrf' | 'session' | 'pendingFlow' | false> {
  const flowUserId = flowId.split(':')[0];

  const hasCsrf = validateOAuthCsrf(req, res, flowId, CSRF_COOKIE_PATH);
  if (hasCsrf) {
    return 'csrf';
  }

  const hasSession = validateOAuthSession(req, flowUserId);
  if (hasSession) {
    return 'session';
  }

  const pendingFlow = await flowManager.getFlowState(flowId, 'mcp_oauth');
  const pendingAge = pendingFlow?.createdAt ? Date.now() - pendingFlow.createdAt : Infinity;
  if (pendingFlow?.status === 'PENDING' && pendingAge < PENDING_STALE_MS) {
    return 'pendingFlow';
  }

  return false;
}

describe('OAuth Callback CSRF Fallback', () => {
  let flowManager: FlowStateManager;

  beforeEach(() => {
    process.env.JWT_SECRET = 'test-secret-for-csrf';
    const store = new MockKeyv();
    flowManager = new FlowStateManager(store as unknown as Keyv, { ttl: 300000, ci: true });
  });

  afterEach(() => {
    delete process.env.JWT_SECRET;
    jest.clearAllMocks();
  });

  describe('CSRF cookie validation (mechanism 1)', () => {
    it('should accept valid CSRF cookie', async () => {
      const flowId = 'user1:test-server';
      const csrfToken = generateOAuthCsrfToken(flowId, 'test-secret-for-csrf');
      const req = makeReq({ [OAUTH_CSRF_COOKIE]: csrfToken });
      const res = makeRes();

      const result = await validateCallback(req, res, flowId, flowManager);
      expect(result).toBe('csrf');
    });

    it('should reject invalid CSRF cookie', async () => {
      const flowId = 'user1:test-server';
      const req = makeReq({ [OAUTH_CSRF_COOKIE]: 'wrong-token-value' });
      const res = makeRes();

      const result = await validateCallback(req, res, flowId, flowManager);
      expect(result).toBe(false);
    });
  });

  describe('Session cookie validation (mechanism 2)', () => {
    it('should accept valid session cookie when CSRF is absent', async () => {
      const flowId = 'user1:test-server';
      const sessionToken = mintOAuthSessionCookie('user1');
      const req = makeReq({ [OAUTH_SESSION_COOKIE]: sessionToken });
      const res = makeRes();

      const result = await validateCallback(req, res, flowId, flowManager);
      expect(result).toBe('session');
    });
  });

  describe('PENDING flow fallback (mechanism 3)', () => {
    it('should accept when a fresh PENDING flow exists and no cookies are present', async () => {
      const flowId = 'user1:test-server';
      await flowManager.initFlow(flowId, 'mcp_oauth', { serverName: 'test-server' });

      const req = makeReq();
      const res = makeRes();

      const result = await validateCallback(req, res, flowId, flowManager);
      expect(result).toBe('pendingFlow');
    });

    it('should reject when no PENDING flow, no CSRF cookie, and no session cookie', async () => {
      const flowId = 'user1:test-server';
      const req = makeReq();
      const res = makeRes();

      const result = await validateCallback(req, res, flowId, flowManager);
      expect(result).toBe(false);
    });

    it('should reject when only a COMPLETED flow exists (not PENDING)', async () => {
      const flowId = 'user1:test-server';
      await flowManager.initFlow(flowId, 'mcp_oauth', { serverName: 'test-server' });
      await flowManager.completeFlow(flowId, 'mcp_oauth', { access_token: 'tok' } as never);

      const req = makeReq();
      const res = makeRes();

      const result = await validateCallback(req, res, flowId, flowManager);
      expect(result).toBe(false);
    });

    it('should reject when only a FAILED flow exists', async () => {
      const flowId = 'user1:test-server';
      await flowManager.initFlow(flowId, 'mcp_oauth', {});
      await flowManager.failFlow(flowId, 'mcp_oauth', 'some error');

      const req = makeReq();
      const res = makeRes();

      const result = await validateCallback(req, res, flowId, flowManager);
      expect(result).toBe(false);
    });

    it('should reject when PENDING flow is stale (older than PENDING_STALE_MS)', async () => {
      const flowId = 'user1:test-server';
      await flowManager.initFlow(flowId, 'mcp_oauth', { serverName: 'test-server' });

      // Artificially age the flow past the staleness threshold
      const store = (flowManager as unknown as { keyv: { get: (k: string) => Promise<unknown> } })
        .keyv;
      const flowState = (await store.get(`mcp_oauth:${flowId}`)) as { createdAt: number };
      flowState.createdAt = Date.now() - PENDING_STALE_MS - 1000;

      const req = makeReq();
      const res = makeRes();

      const result = await validateCallback(req, res, flowId, flowManager);
      expect(result).toBe(false);
    });

    it('should accept PENDING flow that is just under the staleness threshold', async () => {
      const flowId = 'user1:test-server';
      await flowManager.initFlow(flowId, 'mcp_oauth', { serverName: 'test-server' });

      // Flow was just created, well under threshold
      const req = makeReq();
      const res = makeRes();

      const result = await validateCallback(req, res, flowId, flowManager);
      expect(result).toBe('pendingFlow');
    });
  });

  describe('Priority ordering', () => {
    it('should prefer CSRF cookie over PENDING flow', async () => {
      const flowId = 'user1:test-server';
      await flowManager.initFlow(flowId, 'mcp_oauth', { serverName: 'test-server' });

      const csrfToken = generateOAuthCsrfToken(flowId, 'test-secret-for-csrf');
      const req = makeReq({ [OAUTH_CSRF_COOKIE]: csrfToken });
      const res = makeRes();

      const result = await validateCallback(req, res, flowId, flowManager);
      expect(result).toBe('csrf');
    });

    it('should prefer session cookie over PENDING flow when CSRF is absent', async () => {
      const flowId = 'user1:test-server';
      await flowManager.initFlow(flowId, 'mcp_oauth', { serverName: 'test-server' });

      const sessionToken = mintOAuthSessionCookie('user1');
      const req = makeReq({ [OAUTH_SESSION_COOKIE]: sessionToken });
      const res = makeRes();

      const result = await validateCallback(req, res, flowId, flowManager);
      expect(result).toBe('session');
    });
  });
});
