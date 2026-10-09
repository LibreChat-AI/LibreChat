import jwt from 'jsonwebtoken';
import type { OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { TokenMethods } from '@librechat/data-schemas';
import { MCPTokenStorage } from './tokens';

jest.mock('@librechat/data-schemas', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
  getTenantId: jest.fn(),
  encryptV2: jest.fn(async (value: string) => `encrypted:${value}`),
  decryptV2: jest.fn(async (value: string) => value.replace(/^encrypted:/, '')),
}));

// Avoid pulling in librechat-data-provider via ~/mcp/utils; storeTokens does not use it.
jest.mock('~/mcp/utils', () => ({
  isInvalidClientMessage: jest.fn(() => false),
}));

const DEFAULT_TTL_SECONDS = 365 * 24 * 60 * 60;

/** Signs a JWT carrying the given `exp` (epoch seconds). Signature is irrelevant — storeTokens only decodes. */
function makeJwt(expEpochSeconds: number): string {
  return jwt.sign({ exp: expEpochSeconds, sub: 'test-user' }, 'test-secret');
}

/** Runs storeTokens with only createToken wired up and returns the stored access-token record. */
async function storeAndCapture(tokens: OAuthTokens) {
  const createToken = jest.fn().mockResolvedValue({});
  await MCPTokenStorage.storeTokens({
    userId: 'user-1',
    serverName: 'salesforce',
    tokens,
    createToken: createToken as unknown as TokenMethods['createToken'],
  });
  const accessTokenCall = createToken.mock.calls.find((call) => call[0]?.type === 'mcp_oauth');
  expect(accessTokenCall).toBeDefined();
  return accessTokenCall![0] as { expiresIn: number };
}

describe('MCPTokenStorage.storeTokens expiry handling', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('uses the JWT `exp` claim when the provider omits expires_in/expires_at', async () => {
    const expSeconds = Math.floor(Date.now() / 1000) + 1800; // 30 minutes
    const stored = await storeAndCapture({
      access_token: makeJwt(expSeconds),
      token_type: 'Bearer',
    });

    // ~1800s, not the 365-day default.
    expect(stored.expiresIn).toBeGreaterThanOrEqual(1798);
    expect(stored.expiresIn).toBeLessThanOrEqual(1800);
    expect(stored.expiresIn).toBeLessThan(DEFAULT_TTL_SECONDS);
  });

  it('falls back to the default TTL for opaque (non-JWT) tokens with no expiry', async () => {
    const stored = await storeAndCapture({
      access_token: '00Dxx0000001gPF!AQ4AQP_opaque_salesforce_session_token',
      token_type: 'Bearer',
    });

    expect(stored.expiresIn).toBe(DEFAULT_TTL_SECONDS);
  });

  it('still prefers an explicit expires_in over the JWT exp', async () => {
    const expSeconds = Math.floor(Date.now() / 1000) + 1800;
    const stored = await storeAndCapture({
      access_token: makeJwt(expSeconds),
      token_type: 'Bearer',
      expires_in: 900,
    });

    expect(stored.expiresIn).toBe(900);
  });

  it('ignores a JWT exp that is already in the past and uses the default TTL', async () => {
    const expSeconds = Math.floor(Date.now() / 1000) - 100; // already expired
    const stored = await storeAndCapture({
      access_token: makeJwt(expSeconds),
      token_type: 'Bearer',
    });

    expect(stored.expiresIn).toBe(DEFAULT_TTL_SECONDS);
  });
});
