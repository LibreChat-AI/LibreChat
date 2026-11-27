import { normalizeMCPAppCspDeclaration, request } from 'librechat-data-provider';
import type { UIResource } from 'librechat-data-provider';
import {
  isAllowedAppLink,
  getMCPSandboxUrl,
  getSupportedMCPAppPermissions,
  fetchMCPResourceHtml,
  clampAppViewHeight,
  withSandboxCsp,
  getResourceKey,
  MAX_APP_VIEW_HEIGHT,
  MIN_APP_VIEW_HEIGHT,
  MAX_CAROUSEL_VIEW_HEIGHT,
  MAX_SANDBOX_CSP_PARAM_LENGTH,
} from '~/utils/mcpApps';

describe('getMCPSandboxUrl', () => {
  const original = process.env.VITE_MCP_SANDBOX_URL;

  afterEach(() => {
    if (original == null) {
      delete process.env.VITE_MCP_SANDBOX_URL;
      return;
    }
    process.env.VITE_MCP_SANDBOX_URL = original;
  });

  it.each([undefined, '', '/api/mcp/sandbox', 'javascript:alert(1)', window.location.origin])(
    'fails closed for missing or non-dedicated configuration %s',
    (value) => {
      if (value == null) {
        delete process.env.VITE_MCP_SANDBOX_URL;
      } else {
        process.env.VITE_MCP_SANDBOX_URL = value;
      }
      expect(getMCPSandboxUrl()).toBeUndefined();
    },
  );

  it('returns an explicit different-origin HTTP URL bound to this host origin', () => {
    process.env.VITE_MCP_SANDBOX_URL = 'http://sandbox.localhost:3081/api/mcp/sandbox?fixed=1';
    const url = new URL(getMCPSandboxUrl() as string);

    expect(url.origin).toBe('http://sandbox.localhost:3081');
    expect(url.searchParams.get('parentOrigin')).toBe(window.location.origin);
    expect(url.searchParams.get('fixed')).toBe('1');
  });

  it('prefers the runtime URL over a different compiled URL', () => {
    process.env.VITE_MCP_SANDBOX_URL =
      'https://compiled-sandbox.example.com/api/mcp/sandbox?compiled=1';
    const url = new URL(
      getMCPSandboxUrl('https://runtime-sandbox.example.com/api/mcp/sandbox?runtime=1') as string,
    );

    expect(url.origin).toBe('https://runtime-sandbox.example.com');
    expect(url.searchParams.get('runtime')).toBe('1');
    expect(url.searchParams.get('compiled')).toBeNull();
    expect(url.searchParams.get('parentOrigin')).toBe(window.location.origin);
  });

  it.each(['', '/api/mcp/sandbox', 'javascript:alert(1)', window.location.origin, null])(
    'does not fall back after explicit invalid runtime configuration %s',
    (value) => {
      process.env.VITE_MCP_SANDBOX_URL = 'https://compiled-sandbox.example.com/api/mcp/sandbox';
      expect(getMCPSandboxUrl(value)).toBeUndefined();
    },
  );
});

describe('isAllowedAppLink', () => {
  it('refuses everything when the resource declares no egress domains', () => {
    expect(isAllowedAppLink('https://api.example.com/x', undefined)).toBe(false);
    expect(isAllowedAppLink('https://api.example.com/x', {})).toBe(false);
  });

  it('requires an explicit scheme, because an app document has an opaque origin', () => {
    const csp = { connectDomains: ['api.example.com'] };
    expect(isAllowedAppLink('https://api.example.com/x', csp)).toBe(false);
    expect(isAllowedAppLink('http://api.example.com:8080/x', csp)).toBe(false);
  });

  it('honors a declared scheme exactly, in either direction', () => {
    expect(
      isAllowedAppLink('https://api.example.com/x', {
        connectDomains: ['https://api.example.com'],
      }),
    ).toBe(true);
    expect(
      isAllowedAppLink('http://api.example.com/x', { connectDomains: ['https://api.example.com'] }),
    ).toBe(false);
    expect(
      isAllowedAppLink('https://api.example.com/x', { connectDomains: ['http://api.example.com'] }),
    ).toBe(false);
    expect(
      isAllowedAppLink('http://api.example.com/x', { connectDomains: ['http://api.example.com'] }),
    ).toBe(true);
  });

  it('matches a declared scheme case-insensitively', () => {
    expect(
      isAllowedAppLink('https://api.example.com/x', {
        connectDomains: ['HTTPS://API.EXAMPLE.COM'],
      }),
    ).toBe(true);
  });

  it('does not treat a ws(s) declaration as a navigable link target', () => {
    expect(
      isAllowedAppLink('https://api.example.com/x', { connectDomains: ['wss://api.example.com'] }),
    ).toBe(false);
    expect(
      isAllowedAppLink('http://api.example.com/x', { connectDomains: ['ws://api.example.com'] }),
    ).toBe(false);
  });

  describe('port-part (CSP3 §6.7.2.11)', () => {
    it('matches only the scheme default port when the declaration omits one', () => {
      const csp = { connectDomains: ['https://api.example.com'] };
      expect(isAllowedAppLink('https://api.example.com/x', csp)).toBe(true);
      expect(isAllowedAppLink('https://api.example.com:443/x', csp)).toBe(true);
      expect(isAllowedAppLink('https://api.example.com:8443/x', csp)).toBe(false);
    });

    it('matches the implicit port when the declaration spells it out', () => {
      const csp = { connectDomains: ['https://api.example.com:443'] };
      expect(isAllowedAppLink('https://api.example.com/x', csp)).toBe(true);
      expect(isAllowedAppLink('http://api.example.com:8080/collect?d=1', csp)).toBe(false);
      expect(isAllowedAppLink('https://api.example.com:8443/x', csp)).toBe(false);
    });

    it('matches an exact non-default port only', () => {
      const csp = { connectDomains: ['https://api.example.com:8443'] };
      expect(isAllowedAppLink('https://api.example.com:8443/x', csp)).toBe(true);
      expect(isAllowedAppLink('https://api.example.com/x', csp)).toBe(false);
    });

    it('treats a wildcard port as any port', () => {
      const csp = { connectDomains: ['https://api.example.com:*'] };
      expect(isAllowedAppLink('https://api.example.com/x', csp)).toBe(true);
      expect(isAllowedAppLink('https://api.example.com:8443/x', csp)).toBe(true);
    });
  });

  describe('wildcard host-part (CSP3 §6.7.2.10)', () => {
    const csp = { resourceDomains: ['https://*.example.com'] };

    it('requires at least one subdomain label and never covers the apex', () => {
      expect(isAllowedAppLink('https://cdn.example.com/x', csp)).toBe(true);
      expect(isAllowedAppLink('https://a.b.example.com/x', csp)).toBe(true);
      expect(isAllowedAppLink('https://example.com/x', csp)).toBe(false);
      expect(isAllowedAppLink('https://.example.com/x', csp)).toBe(false);
    });

    it('does not match an unrelated suffix or a trailing-dot host', () => {
      expect(isAllowedAppLink('https://notexample.com/x', csp)).toBe(false);
      expect(isAllowedAppLink('https://cdn.example.com./x', csp)).toBe(false);
      expect(isAllowedAppLink('https://example.com./x', csp)).toBe(false);
    });
  });

  it('authorizes nothing for blanket, keyword, or injection-shaped entries', () => {
    const entries = [
      '*',
      'https://*',
      'https:',
      'data:',
      "'self'",
      "'none'",
      "'unsafe-eval'",
      "'unsafe-inline'",
      "'nonce-abc123'",
      'https://api.example.com/path',
      'https://api.example.com;script-src *',
      'https://api.example.com, https://evil.com',
      '',
      '   ',
    ];
    for (const entry of entries) {
      expect(isAllowedAppLink('https://api.example.com/x', { connectDomains: [entry] })).toBe(
        false,
      );
    }
  });

  it('refuses address literals as link targets while keeping localhost usable', () => {
    expect(
      isAllowedAppLink('http://127.0.0.1:3000/x', { connectDomains: ['http://127.0.0.1:3000'] }),
    ).toBe(false);
    expect(isAllowedAppLink('http://0x7f.1/x', { connectDomains: ['http://0x7f.1'] })).toBe(false);
    expect(isAllowedAppLink('http://[::1]/x', { connectDomains: ['http://[::1]'] })).toBe(false);
    expect(
      isAllowedAppLink('http://localhost:3000/x', { connectDomains: ['http://localhost:3000'] }),
    ).toBe(true);
  });

  it('refuses non-http(s) schemes and malformed urls', () => {
    const csp = { connectDomains: ['https://api.example.com'] };
    expect(isAllowedAppLink('javascript:alert(1)', csp)).toBe(false);
    expect(isAllowedAppLink('not a url', csp)).toBe(false);
    expect(isAllowedAppLink('ws://api.example.com', csp)).toBe(false);
  });

  it('consults resourceDomains and frameDomains as well as connectDomains', () => {
    expect(
      isAllowedAppLink('https://cdn.example.com/x', {
        resourceDomains: ['https://cdn.example.com'],
      }),
    ).toBe(true);
    expect(
      isAllowedAppLink('https://embed.example.com/x', {
        frameDomains: ['https://embed.example.com'],
      }),
    ).toBe(true);
  });

  it('matches a credentialed url on its host', () => {
    expect(
      isAllowedAppLink('https://user:pass@api.example.com/x', {
        connectDomains: ['https://api.example.com'],
      }),
    ).toBe(true);
  });
});

describe('normalizeMCPAppCspDeclaration', () => {
  it('keeps legal host sources, trimmed', () => {
    expect(
      normalizeMCPAppCspDeclaration({
        connectDomains: [
          'https://api.example.com',
          'https://*.example.com',
          'http://localhost:3000',
          'wss://stream.example.com',
          'https://a.example.com:*',
          'HTTPS://API.EXAMPLE.COM',
          '\n  https://trimmed.example.com  ',
        ],
      }).connectDomains,
    ).toEqual([
      'https://api.example.com',
      'https://*.example.com',
      'http://localhost:3000',
      'wss://stream.example.com',
      'https://a.example.com:*',
      'HTTPS://API.EXAMPLE.COM',
      'https://trimmed.example.com',
    ]);
  });

  it('drops keywords, blankets and injection-shaped entries', () => {
    const dropped = [
      '*',
      'https://*',
      'https:',
      'data:',
      'blob:',
      "'self'",
      "'unsafe-inline'",
      "'nonce-abc123'",
      'evil.com; script-src *',
      'a.com, b.com',
      'a.com"',
      "a.com'",
      'a.com\nscript-src *',
      'a.com\tb',
      'https://a.com/x?y=1',
      'https://a.com/x#f',
      'https://[::1]',
      'https://a_b.com',
      'https://exämple.com',
    ];
    for (const entry of dropped) {
      expect(normalizeMCPAppCspDeclaration({ connectDomains: [entry] })).toEqual({});
    }
    expect(normalizeMCPAppCspDeclaration(undefined)).toEqual({});
    expect(normalizeMCPAppCspDeclaration({ connectDomains: 'https://a.com' })).toEqual({});
  });

  it('contains every entry the link matcher accepts', () => {
    const accepted: Array<[string, string]> = [
      ['https://api.example.com', 'https://api.example.com/x'],
      ['HTTPS://API.EXAMPLE.COM', 'https://api.example.com/x'],
      ['https://*.example.com', 'https://cdn.example.com/x'],
      ['https://api.example.com:8443', 'https://api.example.com:8443/x'],
      ['https://a.example.com:*', 'https://a.example.com:9000/x'],
      ['http://localhost:3000', 'http://localhost:3000/x'],
    ];
    for (const [entry, url] of accepted) {
      expect(isAllowedAppLink(url, { connectDomains: [entry] })).toBe(true);
      expect(normalizeMCPAppCspDeclaration({ connectDomains: [entry] })).toEqual({
        connectDomains: [entry],
      });
    }
  });

  it('caps each directive at the shared effective-policy limit', () => {
    const connectDomains = Array.from(
      { length: 40 },
      (_unused, index) => `https://host${index}.example.com`,
    );
    expect(normalizeMCPAppCspDeclaration({ connectDomains }).connectDomains).toHaveLength(32);
  });

  it('uses an injected effective-policy limit', () => {
    const connectDomains = Array.from(
      { length: 40 },
      (_unused, index) => `https://host${index}.example.com`,
    );
    expect(
      normalizeMCPAppCspDeclaration({ connectDomains }, { maxSourcesPerDirective: 40 })
        .connectDomains,
    ).toHaveLength(40);
  });
});

describe('clampAppViewHeight', () => {
  it('ignores non-positive or non-finite heights', () => {
    expect(clampAppViewHeight(undefined)).toBeUndefined();
    expect(clampAppViewHeight(0)).toBeUndefined();
    expect(clampAppViewHeight(-5)).toBeUndefined();
    expect(clampAppViewHeight(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(clampAppViewHeight(Number.NaN)).toBeUndefined();
  });

  it('clamps an app-requested height into the surface bounds', () => {
    expect(clampAppViewHeight(500)).toBe(500);
    expect(clampAppViewHeight(12)).toBe(MIN_APP_VIEW_HEIGHT);
    expect(clampAppViewHeight(10_000_000)).toBe(MAX_APP_VIEW_HEIGHT);
    expect(clampAppViewHeight(10_000_000, { max: MAX_CAROUSEL_VIEW_HEIGHT })).toBe(
      MAX_CAROUSEL_VIEW_HEIGHT,
    );
    expect(clampAppViewHeight(12, { max: MAX_CAROUSEL_VIEW_HEIGHT })).toBe(MIN_APP_VIEW_HEIGHT);
  });
});

describe('withSandboxCsp', () => {
  it('carries the declared domains to the sandbox response boundary', () => {
    const { url, applied } = withSandboxCsp(
      'http://localhost:3080/api/mcp/sandbox?parentOrigin=http%3A%2F%2Fa',
      { connectDomains: ['https://api.example.com'] },
    );
    const parsed = new URL(url);
    expect(parsed.searchParams.get('parentOrigin')).toBe('http://a');
    expect(JSON.parse(parsed.searchParams.get('csp') as string)).toEqual({
      connectDomains: ['https://api.example.com'],
    });
    expect(applied).toEqual({ connectDomains: ['https://api.example.com'] });
  });

  it('leaves the url untouched when the resource declares no csp', () => {
    expect(withSandboxCsp('http://localhost:3080/api/mcp/sandbox', undefined)).toEqual({
      url: 'http://localhost:3080/api/mcp/sandbox',
      applied: undefined,
    });
  });

  it('serializes and returns the same capped effective policy', () => {
    const connectDomains = Array.from(
      { length: 400 },
      (_unused, index) => `https://host${index}.example.com`,
    );
    expect(JSON.stringify({ connectDomains }).length).toBeGreaterThan(MAX_SANDBOX_CSP_PARAM_LENGTH);
    const { url, applied } = withSandboxCsp('http://localhost:3080/api/mcp/sandbox', {
      connectDomains,
    });
    const expected = normalizeMCPAppCspDeclaration({ connectDomains });
    expect(JSON.parse(new URL(url).searchParams.get('csp') as string)).toEqual(expected);
    expect(applied).toEqual(expected);
  });

  it('reports nothing applied when the normalized declaration exceeds the route bound', () => {
    const connectDomains = Array.from(
      { length: 32 },
      (_unused, index) => `https://host${index}.example.com/${'a'.repeat(160)}`,
    );
    const { url, applied } = withSandboxCsp('http://localhost:3080/api/mcp/sandbox', {
      connectDomains,
    });
    expect(url).toBe('http://localhost:3080/api/mcp/sandbox');
    expect(applied).toBeUndefined();
  });

  it('uses the deployment limits for URL serialization and host link policy', () => {
    const connectDomains = Array.from(
      { length: 40 },
      (_unused, index) => `https://api${index}.example.com`,
    );
    const limits = { maxSourcesPerDirective: 40, maxSerializedLength: 8192 };
    const { url, applied } = withSandboxCsp(
      'http://localhost:3080/api/mcp/sandbox',
      { connectDomains },
      limits,
    );

    expect(new URL(url).searchParams.get('csp')).toContain('api39.example.com');
    expect(isAllowedAppLink('https://api39.example.com/path', applied, limits)).toBe(true);
  });
});

describe('fetchMCPResourceHtml', () => {
  let fetchSpy: jest.SpyInstance;

  afterEach(() => {
    fetchSpy?.mockRestore();
  });

  it('selects only the exact URI with the App MIME and uses only that item metadata', async () => {
    fetchSpy = jest.spyOn(request, 'authenticatedFetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        contents: [
          {
            uri: 'ui://app/main',
            mimeType: 'text/plain',
            text: 'wrong type',
            _meta: { ui: { csp: { connectDomains: ['https://wrong.example'] } } },
          },
          {
            uri: 'ui://app/other',
            mimeType: 'text/html;profile=mcp-app',
            text: '<p>wrong uri</p>',
            _meta: { ui: { permissions: { camera: {} } } },
          },
          {
            uri: 'ui://app/main',
            mimeType: 'text/html; charset=utf-8; profile="mcp-app"',
            text: '<p>selected</p>',
            _meta: {
              ui: {
                csp: { connectDomains: ['https://api.example'] },
                permissions: { clipboardWrite: {} },
              },
            },
          },
        ],
      }),
    } as Response);
    const controller = new AbortController();

    await expect(
      fetchMCPResourceHtml('demo', 'binding-demo', 'ui://app/main', controller.signal),
    ).resolves.toEqual({
      html: '<p>selected</p>',
      csp: { connectDomains: ['https://api.example'] },
      permissions: { clipboardWrite: {} },
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('/api/mcp/resources/read'),
      expect.objectContaining({
        body: JSON.stringify({
          serverName: 'demo',
          serverBinding: 'binding-demo',
          uri: 'ui://app/main',
        }),
        signal: controller.signal,
      }),
    );
  });

  it('decodes a matching base64 App document', async () => {
    fetchSpy = jest.spyOn(request, 'authenticatedFetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        contents: [
          {
            uri: 'ui://app/main',
            mimeType: 'text/html;profile=mcp-app',
            blob: btoa('<p>cafÃ©</p>'),
          },
        ],
      }),
    } as Response);

    await expect(fetchMCPResourceHtml('demo', 'binding-demo', 'ui://app/main')).resolves.toEqual({
      html: '<p>café</p>',
      csp: undefined,
      permissions: undefined,
    });
  });

  it('rejects a response with no exact URI and App MIME match', async () => {
    fetchSpy = jest.spyOn(request, 'authenticatedFetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        contents: [
          { uri: 'ui://app/other', mimeType: 'text/html;profile=mcp-app', text: '<p>x</p>' },
        ],
      }),
    } as Response);

    await expect(fetchMCPResourceHtml('demo', 'binding-demo', 'ui://app/main')).rejects.toThrow(
      'no matching HTML document',
    );
  });

  it('rejects a non-successful proxy response', async () => {
    fetchSpy = jest.spyOn(request, 'authenticatedFetch').mockResolvedValue({
      ok: false,
      status: 403,
    } as Response);

    await expect(fetchMCPResourceHtml('demo', 'binding-demo', 'ui://app/main')).rejects.toThrow(
      '(403)',
    );
  });
});

describe('getSupportedMCPAppPermissions', () => {
  it('keeps supported permissions and withholds media from an opaque frame', () => {
    expect(
      getSupportedMCPAppPermissions({
        camera: {},
        microphone: {},
        geolocation: {},
        clipboardWrite: {},
      }),
    ).toEqual({ geolocation: {}, clipboardWrite: {} });
    expect(getSupportedMCPAppPermissions({ camera: {}, microphone: {} })).toBeUndefined();
    expect(getSupportedMCPAppPermissions(undefined)).toBeUndefined();
  });
});

describe('getResourceKey', () => {
  it('prefers the resource id and falls back to the uri', () => {
    expect(getResourceKey({ resourceId: 'r1', uri: 'ui://a' } as UIResource)).toBe('r1');
    expect(getResourceKey({ resourceId: '', uri: 'ui://a' } as UIResource)).toBe('ui://a');
  });
});
