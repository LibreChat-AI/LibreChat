import jwt from 'jsonwebtoken';
import { createServer } from 'http';
import { generateKeyPairSync, randomUUID } from 'crypto';

export const managementUserId = '00000000000000000000a901';
export const managementTenantId = 'e2e-agent-management';
const port = Number(process.env.E2E_MANAGEMENT_OIDC_PORT ?? '8792');
const issuer = `http://127.0.0.1:${port}`;
const audience = 'e2e-agent-management';
const clientId = 'e2e-management-client';

export const managementAuth = {
  oidc: { enabled: true, issuer, audience },
  clients: [{ clientId, userId: managementUserId, tenantId: managementTenantId }],
};

/** Only the identity provider is a fixture; LibreChat verifies the token over HTTP. */
export async function startManagementOidc() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = {
    ...publicKey.export({ format: 'jwk' }),
    kid: randomUUID(),
    alg: 'RS256',
    use: 'sig',
  };
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/.well-known/openid-configuration') {
      res.end(JSON.stringify({ issuer, jwks_uri: `${issuer}/jwks` }));
      return;
    }
    if (req.url === '/jwks') {
      res.end(JSON.stringify({ keys: [jwk] }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const token = jwt.sign({ client_id: clientId }, privateKey, {
    algorithm: 'RS256',
    keyid: jwk.kid,
    issuer,
    audience,
    subject: clientId,
    expiresIn: '1h',
  });
  return {
    token,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}
