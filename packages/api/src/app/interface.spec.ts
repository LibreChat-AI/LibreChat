import type { AppConfig } from '@librechat/data-schemas';
import { buildPreLoginInterface, checkConfigPolicyLinks, withSafePolicyLinks } from './interface';

describe('buildPreLoginInterface', () => {
  it('omits the interface when nothing public is configured', () => {
    expect(buildPreLoginInterface(undefined)).toBeUndefined();
    expect(buildPreLoginInterface({ modelSelect: true, buildInfo: true })).toBeUndefined();
  });

  it('keeps only the legal links and a disabled build-info flag', () => {
    expect(
      buildPreLoginInterface({
        privacyPolicy: { externalUrl: 'https://example.com/privacy' },
        termsOfService: { externalUrl: 'https://example.com/tos' },
        buildInfo: false,
        modelSelect: true,
        parameters: false,
      }),
    ).toEqual({
      privacyPolicy: { externalUrl: 'https://example.com/privacy' },
      termsOfService: { externalUrl: 'https://example.com/tos' },
      buildInfo: false,
    });
  });

  it('drops a policy link that would run script, keeping the safe link and the rest', () => {
    expect(
      buildPreLoginInterface({
        privacyPolicy: { externalUrl: 'javascript:alert(document.domain)', openNewTab: true },
        termsOfService: { externalUrl: '/terms' },
        buildInfo: false,
      }),
    ).toEqual({
      privacyPolicy: { openNewTab: true },
      termsOfService: { externalUrl: '/terms' },
      buildInfo: false,
    });
  });

  it('carries a bundled theme name', () => {
    expect(buildPreLoginInterface({ theme: 'clickhouse', modelSelect: true })).toEqual({
      theme: 'clickhouse',
    });
  });

  it('carries an inline theme definition unchanged', () => {
    const theme = {
      version: 1 as const,
      name: 'acme',
      modes: { light: { colors: { 'rgb-surface-primary': '255 255 255' } } },
    };
    expect(buildPreLoginInterface({ theme })).toEqual({ theme });
  });
});

describe('withSafePolicyLinks', () => {
  it('returns the same config when every policy link is http(s), mailto:, relative or blank', () => {
    const contact = { privacyPolicy: { externalUrl: 'mailto:privacy@example.com' } };
    expect(withSafePolicyLinks(contact)).toBe(contact);
    const interfaceConfig = {
      privacyPolicy: { externalUrl: 'https://example.com/privacy' },
      termsOfService: { externalUrl: '', modalAcceptance: true },
      modelSelect: true,
    };
    const withoutLinks: AppConfig['interfaceConfig'] = { modelSelect: false };
    expect(withSafePolicyLinks(interfaceConfig)).toBe(interfaceConfig);
    expect(withSafePolicyLinks(withoutLinks)).toBe(withoutLinks);
    expect(withSafePolicyLinks(undefined)).toBeUndefined();
    expect(withSafePolicyLinks(null)).toBeNull();
  });

  it.each([
    'javascript:alert(1)',
    ' JAVASCRIPT:alert(1)',
    'data:text/html,hi',
    'vbscript:x',
    '\u00a0javascript:alert(document.domain)',
    '\ufeffjavascript:alert(document.domain)',
    '\u2028javascript:alert(document.domain)',
    '\u3000javascript:alert(document.domain)',
  ])('removes %j from both links without touching the other settings', (externalUrl) => {
    const interfaceConfig = {
      privacyPolicy: { externalUrl, openNewTab: true },
      termsOfService: { externalUrl, modalAcceptance: true, modalTitle: 'Terms' },
      modelSelect: true,
    };

    const safe = withSafePolicyLinks(interfaceConfig);

    expect(JSON.parse(JSON.stringify(safe))).toEqual({
      privacyPolicy: { openNewTab: true },
      termsOfService: { modalAcceptance: true, modalTitle: 'Terms' },
      modelSelect: true,
    });
    expect(interfaceConfig.privacyPolicy.externalUrl).toBe(externalUrl);
  });

  it('removes a stored value that is not a string at all', () => {
    const privacyPolicy = { externalUrl: 42 } as unknown as { externalUrl?: string };
    expect(withSafePolicyLinks({ privacyPolicy }).privacyPolicy).toEqual({
      externalUrl: undefined,
    });
  });
});

describe('checkConfigPolicyLinks', () => {
  it('returns the same config when there is nothing to drop', () => {
    const safe = {
      interface: {
        privacyPolicy: { externalUrl: 'tel:+15555550100' },
        termsOfService: { externalUrl: '/terms' },
      },
    };
    const notStrings = { interface: { privacyPolicy: { externalUrl: 42 } } };
    for (const config of [safe, notStrings, { version: '1.3.17' }, null, 'yaml']) {
      expect(checkConfigPolicyLinks(config)).toEqual({ config, dropped: [] });
      expect(checkConfigPolicyLinks(config).config).toBe(config);
    }
  });

  it('drops only the unsafe URL, leaving the link settings and the input untouched', () => {
    const config = {
      cache: true,
      interface: {
        modelSelect: true,
        privacyPolicy: { externalUrl: '\ufeffjavascript:alert(1)', openNewTab: true },
        termsOfService: { externalUrl: 'https://example.com/terms' },
      },
    };

    expect(checkConfigPolicyLinks(config)).toEqual({
      config: {
        cache: true,
        interface: {
          modelSelect: true,
          privacyPolicy: { openNewTab: true },
          termsOfService: { externalUrl: 'https://example.com/terms' },
        },
      },
      dropped: ['interface.privacyPolicy.externalUrl'],
    });
    expect(config.interface.privacyPolicy.externalUrl).toBe('\ufeffjavascript:alert(1)');
  });
});
