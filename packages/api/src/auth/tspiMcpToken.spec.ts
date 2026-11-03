import { generateKeyPairSync, verify as cryptoVerify } from 'crypto';
import {
  mintTspiMcpToken,
  resetTspiMcpTokenCache,
  resolveTspiRole,
  TSPI_ROLE_SCOPES,
} from './tspiMcpToken';
import { processMCPEnv } from '~/utils/env';
import scopesFile from './tspiScopes.json';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

function decode(token: string) {
  const [h, p, s] = token.split('.');
  const header = JSON.parse(Buffer.from(h, 'base64url').toString());
  const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
  const ok = cryptoVerify(null, Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s, 'base64url'));
  return { header, payload, ok };
}

const clinician = {
  id: '66a1b2c3d4e5f60718293a4b',
  email: 'dr@example.com',
  name: 'Dr Example',
  tspiRole: 'clinician',
  tspiClinicId: 'clinic-001',
};

describe('tspiMcpToken', () => {
  const env = { ...process.env };
  beforeEach(() => {
    process.env.TSPI_MCP_JWT_PRIVATE_KEY_BASE64 = Buffer.from(PEM).toString('base64');
    process.env.TSPI_MCP_JWT_ISSUER = 'https://chat.example.com';
    delete process.env.TSPI_MCP_JWT_TTL_SECONDS;
    resetTspiMcpTokenCache();
  });
  afterAll(() => {
    process.env = env;
  });

  it('signs a 5-minute EdDSA token with the required claims', () => {
    const now = Date.UTC(2026, 9, 27, 10, 0, 0);
    const { header, payload, ok } = decode(mintTspiMcpToken(clinician, now));
    expect(ok).toBe(true);
    expect(header).toEqual({ alg: 'EdDSA', typ: 'JWT', kid: 'tspi-chat-1' });
    expect(payload).toMatchObject({
      iss: 'https://chat.example.com',
      aud: 'tspi-mcp',
      sub: clinician.id,
      role: 'clinician',
      tspi_uid: clinician.id,
      scope: TSPI_ROLE_SCOPES.clinician.join(' '),
    });
    expect(payload.exp - payload.iat).toBe(300);
    expect(payload.jti).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('carries no clinic, email or name since M02 (the Brain has them)', () => {
    const { payload } = decode(mintTspiMcpToken(clinician));
    expect(payload.clinic_id).toBeUndefined();
    expect(payload.email).toBeUndefined();
    expect(payload.name).toBeUndefined();
  });

  it('adds them back only with TSPI_MCP_TOKEN_LEGACY_CLAIMS=true (rollback)', () => {
    process.env.TSPI_MCP_TOKEN_LEGACY_CLAIMS = 'true';
    try {
      const { payload } = decode(mintTspiMcpToken({ ...clinician, id: 'other-user-id' }));
      expect(payload).toMatchObject({ clinic_id: 'clinic-001', email: 'dr@example.com' });
    } finally {
      delete process.env.TSPI_MCP_TOKEN_LEGACY_CLAIMS;
    }
  });

  it('uses the v2 scope catalogue shared with the MCP', () => {
    expect(scopesFile.version).toBe(2);
    expect(TSPI_ROLE_SCOPES).toEqual(scopesFile.role_scopes);
    for (const scopes of Object.values(TSPI_ROLE_SCOPES)) {
      for (const s of scopes) expect(scopesFile.scopes).toContain(s);
    }
    expect(TSPI_ROLE_SCOPES.patient).not.toContain('tspi:plan:approve');
    expect(TSPI_ROLE_SCOPES.auditor).toContain('tspi:audit:read');
  });

  it('keeps the WorkOS id as the engine owner id for migrated accounts', () => {
    const { payload } = decode(mintTspiMcpToken({ ...clinician, openidId: 'user_01WORKOS' }));
    expect(payload.sub).toBe(clinician.id);
    expect(payload.tspi_uid).toBe('user_01WORKOS');
  });

  it('gives no scopes to a user without a TSPI role', () => {
    const { payload } = decode(mintTspiMcpToken({ id: 'u1', tspiRole: 'admin' }));
    expect(payload.role).toBe('unassigned');
    expect(payload.scope).toBe('');
    expect(resolveTspiRole(undefined)).toBe('unassigned');
  });

  it('reuses a token only while it has 2+ minutes left, and re-mints on a role change', () => {
    const t0 = Date.UTC(2026, 9, 27, 10, 0, 0);
    const a = mintTspiMcpToken(clinician, t0);
    expect(mintTspiMcpToken(clinician, t0 + 60_000)).toBe(a);
    expect(mintTspiMcpToken(clinician, t0 + 200_000)).not.toBe(a);
    const b = mintTspiMcpToken({ ...clinician, tspiRole: 'patient' }, t0 + 1000);
    expect(decode(b).payload.role).toBe('patient');
  });

  it('caps the lifetime at 300 s', () => {
    process.env.TSPI_MCP_JWT_TTL_SECONDS = '86400';
    resetTspiMcpTokenCache();
    const { payload } = decode(mintTspiMcpToken(clinician));
    expect(payload.exp - payload.iat).toBe(300);
  });

  it('fails closed without a key, and rejects a non-Ed25519 key', () => {
    delete process.env.TSPI_MCP_JWT_PRIVATE_KEY_BASE64;
    resetTspiMcpTokenCache();
    expect(() => mintTspiMcpToken(clinician)).toThrow(/not configured/);
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    process.env.TSPI_MCP_JWT_PRIVATE_KEY = rsa.export({ type: 'pkcs8', format: 'pem' }).toString();
    resetTspiMcpTokenCache();
    expect(() => mintTspiMcpToken(clinician)).toThrow(/must be Ed25519/);
    delete process.env.TSPI_MCP_JWT_PRIVATE_KEY;
  });

  describe('{{TSPI_MCP_TOKEN}} header placeholder', () => {
    const yamlServer = {
      type: 'streamable-http' as const,
      url: 'https://mcp.example.com/mcp',
      headers: { Authorization: 'Bearer {{TSPI_MCP_TOKEN}}' },
    };

    it('mints for an operator (yaml) server with a user', () => {
      const out = processMCPEnv({
        options: yamlServer,
        user: clinician as never,
      }) as typeof yamlServer;
      const token = out.headers.Authorization.replace('Bearer ', '');
      expect(decode(token).ok).toBe(true);
      expect(decode(token).payload.sub).toBe(clinician.id);
    });

    it('puts the tool call conversation in cnv (M04)', () => {
      const out = processMCPEnv({
        options: yamlServer,
        user: clinician as never,
        body: { conversationId: 'convo-123', messageId: 'm1' },
      }) as typeof yamlServer;
      const token = out.headers.Authorization.replace('Bearer ', '');
      expect(decode(token).payload).toMatchObject({ cnv: 'convo-123', aud: 'tspi-mcp' });
    });

    it('never mints for a user-created (DB) server', () => {
      const out = processMCPEnv({
        options: { ...yamlServer, dbId: 'abc' },
        user: clinician as never,
      }) as typeof yamlServer;
      expect(out.headers.Authorization).toBe('Bearer {{TSPI_MCP_TOKEN}}');
    });

    it('never mints from a user-supplied custom variable', () => {
      const out = processMCPEnv({
        options: { ...yamlServer, headers: { 'X-Key': '{{MY_VAR}}' } },
        user: clinician as never,
        customUserVars: { MY_VAR: '{{TSPI_MCP_TOKEN}}' },
      }) as { headers: Record<string, string> };
      expect(out.headers['X-Key']).toBe('{{TSPI_MCP_TOKEN}}');
    });
  });
});
