import { hasPublishedPolicies, policyUrls, publishedPolicyUrl } from '../policies';

describe('publishedPolicyUrl', () => {
  it.each([
    'javascript:alert(document.domain)',
    ' JavaScript:alert(1)',
    'java\tscript:alert(1)',
    '\u0001javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    '\u00a0javascript:alert(document.domain)',
    '\ufeffjavascript:alert(document.domain)',
    '\u2028javascript:alert(document.domain)',
    '\u3000javascript:alert(document.domain)',
  ])('publishes no link for %j, which would run script on the page that shows it', (url) => {
    expect(publishedPolicyUrl(url)).toBeUndefined();
  });

  it.each([
    ['https://example.com/privacy', 'https://example.com/privacy'],
    ['  /legal/terms  ', '/legal/terms'],
    ['//example.com/privacy', '//example.com/privacy'],
    ['\u00a0https://example.com/privacy', 'https://example.com/privacy'],
    ['mailto:privacy@example.com', 'mailto:privacy@example.com'],
  ])('publishes %j, an http(s), mailto: or relative link', (url, published) => {
    expect(publishedPolicyUrl(url)).toBe(published);
  });

  it('publishes nothing for a blank or missing link', () => {
    expect(publishedPolicyUrl('   ')).toBeUndefined();
    expect(publishedPolicyUrl(undefined)).toBeUndefined();
  });
});

describe('policyUrls', () => {
  it('keeps a safe policy link when the other one would run script', () => {
    const startupConfig = {
      interface: {
        privacyPolicy: { externalUrl: 'javascript:alert(document.domain)' },
        termsOfService: { externalUrl: 'https://example.com/terms' },
      },
    };

    expect(policyUrls(startupConfig)).toEqual({
      privacyPolicyUrl: undefined,
      termsOfServiceUrl: 'https://example.com/terms',
    });
    expect(hasPublishedPolicies(startupConfig)).toBe(true);
  });

  it('counts a script link as no published policy', () => {
    expect(
      hasPublishedPolicies({
        interface: { privacyPolicy: { externalUrl: 'javascript:alert(1)' } },
      }),
    ).toBe(false);
  });
});
