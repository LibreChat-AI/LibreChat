import fs from 'fs';
import path from 'path';
import { MCP_APP_CSP_MAX_LENGTH } from 'librechat-data-provider';
import { buildSandboxResponse } from '../sandbox';

const SANDBOX_PATH = path.resolve(__dirname, '../../../../../client/public/mcp-sandbox.html');
const SANDBOX_HTML = fs.readFileSync(SANDBOX_PATH, 'utf8');

const serve = (
  query: {
    csp?: string | string[];
    frameAncestors?: string;
    limits?: { maxSourcesPerDirective: number; maxSerializedLength: number };
  } = {},
) => buildSandboxResponse({ sandboxHtml: SANDBOX_HTML, ...query });

const policies = (query?: Parameters<typeof serve>[0]): string[] =>
  serve(query).headers['Content-Security-Policy'] as string[];
const resourcePolicy = (query?: Parameters<typeof serve>[0]): string => policies(query)[1];
const viewPolicy = (query?: Parameters<typeof serve>[0]): string => {
  const match = serve(query).body.match(/window\.__MCP_VIEW_CSP = ("(?:[^"\\]|\\.)*");/);
  if (!match) {
    throw new Error('View CSP was not embedded');
  }
  return JSON.parse(match[1]) as string;
};

describe('buildSandboxResponse frame-ancestors', () => {
  it('keeps frame-ancestors as its own policy, first, so the resource policy cannot loosen it', () => {
    const emitted = policies({ csp: JSON.stringify({ frameDomains: ['https://a.example.com'] }) });
    expect(emitted).toHaveLength(2);
    expect(emitted[0]).toBe("frame-ancestors 'none'");
    expect(emitted[1]).not.toContain('frame-ancestors');
  });

  it('uses only the supplied configured ancestors', () => {
    expect(policies({ frameAncestors: 'https://host.example.com' })[0]).toBe(
      'frame-ancestors https://host.example.com',
    );
    expect(
      policies({
        frameAncestors: 'https://one.example.com, https://two.example.com:8443',
      })[0],
    ).toBe('frame-ancestors https://one.example.com https://two.example.com:8443');
    expect(policies({ frameAncestors: undefined })[0]).toBe("frame-ancestors 'none'");
  });

  it('omits X-Frame-Options only when a cross-origin ancestor is configured', () => {
    const crossOrigin = serve({ frameAncestors: 'https://host.example.com' }).headers;
    expect(crossOrigin['Cross-Origin-Resource-Policy']).toBe('cross-origin');
    expect('X-Frame-Options' in crossOrigin).toBe(false);

    const sameOrigin = serve().headers;
    expect(sameOrigin['Cross-Origin-Resource-Policy']).toBe('same-origin');
    expect(sameOrigin['X-Frame-Options']).toBe('DENY');
  });

  it('drops a token that tries to inject an extra directive', () => {
    expect(policies({ frameAncestors: 'https://ok.com; script-src *' })[0]).toBe(
      "frame-ancestors 'none'",
    );
  });
});

describe('buildSandboxResponse resource policy', () => {
  it('allows the proxy blob install while the View gets the restrictive frame default', () => {
    const policy = resourcePolicy();
    expect(policy).toContain('frame-src blob:');
    expect(policy).not.toContain("frame-src 'none'");
    expect(viewPolicy()).toContain("frame-src 'none'");
    expect(viewPolicy()).not.toContain('frame-src blob:');
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("connect-src 'none'");
    expect(policy).toContain("form-action 'none'");
    expect(policy).toContain("worker-src 'self'");
    expect(policy).toContain("base-uri 'self'");
  });

  it('widens frame-src to declared frameDomains only', () => {
    const query = { csp: JSON.stringify({ frameDomains: ['https://embed.example.com'] }) };
    expect(resourcePolicy(query)).toContain('frame-src blob: https://embed.example.com');
    expect(viewPolicy(query)).toContain('frame-src https://embed.example.com');
    expect(viewPolicy(query)).not.toContain('blob:');
  });

  it('bounds form-action and connect-src to the declared egress allowlist', () => {
    const policy = resourcePolicy({
      csp: JSON.stringify({ connectDomains: ['https://api.example.com'] }),
    });
    expect(policy).toContain('connect-src https://api.example.com');
    expect(policy).toContain('form-action https://api.example.com');
  });

  it('keeps the proxy script and styles running under the stable policy', () => {
    expect(resourcePolicy()).toContain("script-src 'self' 'unsafe-inline'");
    expect(resourcePolicy()).toContain("style-src 'self' 'unsafe-inline'");
  });

  it('uses the stable restrictive default without undeclared script capabilities', () => {
    const policy = resourcePolicy();
    expect(policy).toContain("script-src 'self' 'unsafe-inline'");
    expect(policy).toContain("style-src 'self' 'unsafe-inline'");
    expect(policy).toContain("img-src 'self' data:");
    expect(policy).toContain("media-src 'self' data:");
    expect(policy).not.toContain("'unsafe-eval'");
    expect(policy).not.toContain('wasm-unsafe-eval');
  });

  it.each([
    'javascript:alert(1)',
    'data:',
    'blob:',
    '*',
    'http://*',
    'https://*',
    'evil.com; script-src *',
    "'self'",
    "'unsafe-eval'",
    "'nonce-abc123'",
    'a\nb.com',
    'a\rb.com',
    'under_score.com',
    '[::1]',
    'https://a.com?x=1',
    'https://a.com#f',
  ])('drops the illegal declared domain %j', (domain) => {
    expect(resourcePolicy({ csp: JSON.stringify({ connectDomains: [domain] }) })).toContain(
      "connect-src 'none'",
    );
  });

  it.each([
    'https://api.example.com',
    'https://*.example.com',
    'https://a.example.com:8443',
    'https://a.example.com:*',
    'HTTPS://API.EXAMPLE.COM',
    'wss://socket.example.com',
    'api.example.com',
    'https://api.example.com/path',
  ])('emits the legal declared domain %j', (domain) => {
    expect(resourcePolicy({ csp: JSON.stringify({ connectDomains: [domain] }) })).toContain(
      `connect-src ${domain}`,
    );
  });

  it('emits declared domains trimmed', () => {
    expect(
      resourcePolicy({ csp: JSON.stringify({ connectDomains: ['\n  https://a.com  '] }) }),
    ).toContain('connect-src https://a.com;');
  });

  it('caps the number of declared domains', () => {
    const domains = Array.from({ length: 40 }, (_, i) => `https://d${i}.example.com`);
    const emitted = resourcePolicy({ csp: JSON.stringify({ connectDomains: domains }) })
      .split('; ')
      .find((directive) => directive.startsWith('connect-src '));
    expect(emitted?.split(' ')).toHaveLength(33);
    expect(emitted).not.toContain('d32.example.com');
  });

  it('honors deployment-provided source and serialized-length limits', () => {
    const domains = Array.from({ length: 40 }, (_, i) => `https://d${i}.example.com`);
    const csp = JSON.stringify({ connectDomains: domains });
    const emitted = resourcePolicy({
      csp,
      limits: { maxSourcesPerDirective: 40, maxSerializedLength: csp.length },
    })
      .split('; ')
      .find((directive) => directive.startsWith('connect-src '));

    expect(emitted?.split(' ')).toHaveLength(41);
    expect(emitted).toContain('d39.example.com');
    expect(
      resourcePolicy({
        csp,
        limits: { maxSourcesPerDirective: 40, maxSerializedLength: csp.length - 1 },
      }),
    ).toContain("connect-src 'none'");
  });

  it.each([
    ['oversized', `{"connectDomains":["https://a.com"],"pad":"${'x'.repeat(4200)}"}`],
    ['unparseable', '{not json'],
    ['an array', '["https://a.com"]'],
    ['null', 'null'],
    ['repeated', ['{"connectDomains":["https://a.com"]}', '{"connectDomains":["https://b.com"]}']],
  ])('falls back to the restrictive default for %s csp', (_name, csp) => {
    const policy = resourcePolicy({ csp });
    expect(policy).toContain("connect-src 'none'");
    expect(policy).toContain('frame-src blob:');
  });

  it('accepts a declaration exactly at the length the client mirrors', () => {
    const pad = 'a'.repeat(
      MCP_APP_CSP_MAX_LENGTH - '{"connectDomains":["https://a.com"],"pad":""}'.length,
    );
    const csp = `{"connectDomains":["https://a.com"],"pad":"${pad}"}`;
    expect(csp).toHaveLength(MCP_APP_CSP_MAX_LENGTH);
    expect(resourcePolicy({ csp })).toContain('connect-src https://a.com');
  });
});

describe('buildSandboxResponse document', () => {
  it('substitutes both trusted policy markers in the supplied document', () => {
    expect(SANDBOX_HTML).toContain('/*__CSP_APPLIED__*/');
    expect(SANDBOX_HTML).toContain('/*__VIEW_CSP__*/');

    const { headers, body } = serve();
    expect(body).not.toContain('/*__CSP_APPLIED__*/');
    expect(body).not.toContain('/*__VIEW_CSP__*/');
    expect(body).toContain('window.__MCP_SANDBOX_CSP_APPLIED = true;');
    expect(body).toContain('window.__MCP_VIEW_CSP = ');
    expect(headers['Cache-Control']).toContain('no-store');
    expect(headers['Content-Type']).toBe('text/html; charset=utf-8');
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(headers['Referrer-Policy']).toBe('same-origin');
  });

  it('serializes the trusted View policy without creating an inline script boundary', () => {
    const { body } = serve({ csp: JSON.stringify({ resourceDomains: ['https://x.test/path'] }) });
    expect(body).not.toContain('</script><script-src');
    expect(
      viewPolicy({ csp: JSON.stringify({ resourceDomains: ['https://x.test/path'] }) }),
    ).toContain('https://x.test/path');
  });
});
