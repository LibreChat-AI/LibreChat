import { randomUUID } from 'node:crypto';
import type { OpenIDRequest, SessionOpenIDTokens } from '../types';
import { getOpenIDCheckIdentity } from '../reuseCredential';

export function newOpenIDAuthGeneration(req: OpenIDRequest): string {
  return req.openidLoginGeneration ?? randomUUID();
}

/** A full login starts a generation; rotating its credentials keeps that generation. */
export function applyOpenIDAuthGeneration(
  req: OpenIDRequest,
  tokens: SessionOpenIDTokens,
  secret?: string,
): void {
  tokens.authGenerationId =
    req.openidLoginGeneration ??
    tokens.authGenerationId ??
    req.session?.openidTokens?.authGenerationId;
  if (tokens.authGenerationId) return;
  const identity = getOpenIDCheckIdentity(req.cookies ?? {}, secret);
  if (
    identity &&
    identity.appUserId === tokens.appUserId &&
    identity.openidSubject === tokens.openidSubject &&
    identity.openidIssuer === tokens.openidIssuer &&
    identity.tenantId === tokens.tenantId
  ) {
    tokens.authGenerationId = identity.authGenerationId;
  }
}
