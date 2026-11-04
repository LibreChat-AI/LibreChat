const OPENID_DISCOVERY_PATH = '/.well-known/openid-configuration';

/** Mirrors `packages/api`'s `normalizeOpenIdIssuer`; data-schemas cannot import packages/api. */
export function normalizeOpenIdIssuer(issuer: string | undefined): string | undefined {
  const normalized = issuer?.trim().replace(/\/+$/, '');
  if (!normalized) return undefined;
  if (!normalized.endsWith(OPENID_DISCOVERY_PATH)) return normalized;
  return normalized.slice(0, -OPENID_DISCOVERY_PATH.length) || undefined;
}

/** Normalizes an issuer the way every openid authorization read and write does; throws on a
 *  value that normalizes away to nothing. */
export function requireNormalizedOpenIdIssuer(issuer: string): string {
  const normalized = normalizeOpenIdIssuer(issuer);
  if (!normalized) {
    throw new Error('requireNormalizedOpenIdIssuer: issuer normalizes to an empty value');
  }
  return normalized;
}
