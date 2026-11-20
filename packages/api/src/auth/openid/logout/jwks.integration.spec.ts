import http from 'http';
import jwksRsa from 'jwks-rsa';
import { generateKeyPairSync } from 'crypto';
import type { AddressInfo } from 'net';
import { createLogoutJwksKeyResolver } from './jwks';

const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'real-kid', use: 'sig', alg: 'RS256' };

let server: http.Server;
let jwksUri: string;
let requestCount = 0;

beforeAll(async () => {
  server = http.createServer((_req, res) => {
    requestCount += 1;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  jwksUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}/jwks`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

it('serves a real logout key after more junk kids than the old per-minute fetch budget', async () => {
  const resolveKey = createLogoutJwksKeyResolver({
    getJwksUri: () => jwksUri,
    getCacheMaxAgeMs: () => 60000,
  });

  for (let i = 0; i < 25; i++) {
    await expect(resolveKey(`junk-${i}`)).rejects.toBeInstanceOf(jwksRsa.SigningKeyNotFoundError);
  }
  const key = await resolveKey('real-kid');

  expect(String(key)).toContain('BEGIN PUBLIC KEY');
  expect(requestCount).toBe(1);
});
