import { createRemoteJWKSet } from 'jose';
import type { JWTVerifyGetKey } from 'jose';

/** Resolves keys from one issuer's JWKS endpoint; `timeoutDuration` should stay below the
 *  caller's own processing deadline. */
export function createIssuerJwksGetKey(jwksUri: string, timeoutDuration?: number): JWTVerifyGetKey {
  return createRemoteJWKSet(new URL(jwksUri), { timeoutDuration });
}
