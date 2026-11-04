import { normalizeOpenIdIssuer, requireNormalizedOpenIdIssuer } from './openidIssuer';

/** Copied from packages/api/src/auth/openid.ts; data-schemas cannot import packages/api, so this
 *  test asserts the two stay equivalent instead of sharing the implementation. */
function normalizeOpenIdIssuerReference(issuer: string | undefined): string | undefined {
  const OPENID_DISCOVERY_PATH = '/.well-known/openid-configuration';
  const normalized = issuer?.trim().replace(/\/+$/, '');
  if (!normalized) return undefined;
  if (!normalized.endsWith(OPENID_DISCOVERY_PATH)) return normalized;
  return normalized.slice(0, -OPENID_DISCOVERY_PATH.length) || undefined;
}

const CASES = [
  'https://x/',
  'https://x',
  'https://x//',
  'https://x///',
  '  https://x/  ',
  undefined,
  '',
  '   ',
  'https://x/.well-known/openid-configuration',
  'https://x//.well-known/openid-configuration',
  '/.well-known/openid-configuration',
];

describe('normalizeOpenIdIssuer', () => {
  it('matches packages/api normalizeOpenIdIssuer on every case', () => {
    for (const issuer of CASES) {
      expect(normalizeOpenIdIssuer(issuer)).toBe(normalizeOpenIdIssuerReference(issuer));
    }
  });

  it('strips one or more trailing slashes', () => {
    expect(normalizeOpenIdIssuer('https://x/')).toBe('https://x');
    expect(normalizeOpenIdIssuer('https://x//')).toBe('https://x');
    expect(normalizeOpenIdIssuer('https://x')).toBe('https://x');
  });
});

describe('requireNormalizedOpenIdIssuer', () => {
  it('normalizes a valid issuer', () => {
    expect(requireNormalizedOpenIdIssuer('https://x//')).toBe('https://x');
  });

  it('throws when the issuer normalizes away to nothing', () => {
    expect(() => requireNormalizedOpenIdIssuer('   ')).toThrow();
  });
});
