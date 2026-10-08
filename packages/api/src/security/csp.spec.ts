import {
  issueCsp,
  applyCspNonce,
  createCspPolicy,
  shellCacheHeaders,
  buildCspDirectives,
  serializeCspDirectives,
} from './csp';

function headerFor(env: NodeJS.ProcessEnv): string {
  const policy = createCspPolicy({ CSP_ENABLED: 'true', ...env });
  if (!policy) {
    throw new Error('expected a policy');
  }
  return issueCsp(policy).headerValue;
}

describe('createCspPolicy', () => {
  it('stays off unless explicitly enabled', () => {
    expect(createCspPolicy({})).toBeNull();
    expect(createCspPolicy({ CSP_ENABLED: 'false' })).toBeNull();
  });

  it('defaults to report-only and switches to enforcing on request', () => {
    expect(createCspPolicy({ CSP_ENABLED: 'true' })?.headerName).toBe(
      'Content-Security-Policy-Report-Only',
    );
    expect(createCspPolicy({ CSP_ENABLED: 'true', CSP_REPORT_ONLY: 'false' })?.headerName).toBe(
      'Content-Security-Policy',
    );
  });

  it('only enforces on a recognized false value, never on a typo', () => {
    for (const value of ['1', 'yes', 'on', 'treu', 'report-only', 'maybe']) {
      expect(createCspPolicy({ CSP_ENABLED: 'true', CSP_REPORT_ONLY: value })?.headerName).toBe(
        'Content-Security-Policy-Report-Only',
      );
    }

    for (const value of ['false', 'off', '0', 'no']) {
      expect(createCspPolicy({ CSP_ENABLED: 'true', CSP_REPORT_ONLY: value })?.headerName).toBe(
        'Content-Security-Policy',
      );
    }
  });

  it('yields to the global SECURITY_HEADERS kill switch', () => {
    expect(createCspPolicy({ CSP_ENABLED: 'true', SECURITY_HEADERS: 'false' })).toBeNull();
    expect(createCspPolicy({ CSP_ENABLED: 'true', SECURITY_HEADERS: 'off' })).toBeNull();
    expect(createCspPolicy({ CSP_ENABLED: 'true', SECURITY_HEADERS: 'true' })).not.toBeNull();
  });

  it('mints a fresh nonce per response', () => {
    const policy = createCspPolicy({ CSP_ENABLED: 'true' });
    if (!policy) {
      throw new Error('expected a policy');
    }

    const first = issueCsp(policy);
    const second = issueCsp(policy);

    expect(first.nonce).not.toBe(second.nonce);
    expect(first.headerValue).toContain(`'nonce-${first.nonce}'`);
    expect(second.headerValue).toContain(`'nonce-${second.nonce}'`);
    expect(first.headerValue).not.toContain(second.nonce);
  });
});

describe('policy directives', () => {
  it('locks down the directives that carry the XSS and clickjacking value', () => {
    const header = headerFor({});

    expect(header).toContain("'strict-dynamic'");
    expect(header).toContain("script-src-attr 'none'");
    expect(header).toContain("object-src 'none'");
    expect(header).toContain("base-uri 'self'");
    expect(header).toContain("frame-ancestors 'self'");
  });

  it('permits the runtime dependencies the app actually ships', () => {
    const header = headerFor({});

    expect(header).toContain("'wasm-unsafe-eval'");
    expect(header).toContain("worker-src 'self' blob: data:");
  });

  it('lets a deployment that needs neither drop them', () => {
    const header = headerFor({ CSP_ALLOW_WASM: 'false', CSP_ALLOW_DATA_WORKERS: 'false' });

    expect(header).not.toContain("'wasm-unsafe-eval'");
    expect(header).toContain("worker-src 'self' blob:");
    expect(header).not.toContain("worker-src 'self' blob: data:");
    expect(header).toContain("'strict-dynamic'");
  });

  it('keeps styles on unsafe-inline with no nonce', () => {
    const header = headerFor({});
    const styleSrc = header.split('; ').find((directive) => directive.startsWith('style-src'));

    expect(styleSrc).toBe("style-src 'self' 'unsafe-inline'");
    expect(header).not.toContain('style-src-elem');
  });

  it("drops 'strict-dynamic' when script hosts are configured, since it would ignore them", () => {
    const header = headerFor({ CSP_SCRIPT_SRC_EXTRA: 'https://scripts.example.com' });

    expect(header).not.toContain("'strict-dynamic'");
    expect(header).toContain('https://scripts.example.com');
    expect(header).toMatch(
      /script-src 'nonce-[^']+' 'wasm-unsafe-eval' 'self' https:\/\/scripts\.example\.com/,
    );
  });

  it('adds deployment-specific sources without dropping the safe defaults', () => {
    const header = headerFor({
      CSP_CONNECT_SRC_EXTRA: 'https://telemetry.example.com,wss://stream.example.com',
      CSP_FRAME_SRC_EXTRA: 'https://tenant.sharepoint.com',
      CSP_REPORT_URI: 'https://reports.example.com/csp',
    });

    expect(header).toContain(
      "connect-src 'self' https: wss: https://telemetry.example.com wss://stream.example.com",
    );
    expect(header).toContain('https://tenant.sharepoint.com');
    expect(header).toContain("frame-src 'self' https: blob: data: about:");
    expect(header).toContain('report-uri https://reports.example.com/csp');
  });

  it('replaces frame-ancestors when the deployment is embedded elsewhere', () => {
    const header = headerFor({ CSP_FRAME_ANCESTORS: "'self' https://portal.example.com" });

    expect(header).toContain("frame-ancestors 'self' https://portal.example.com");
  });

  it("replaces rather than merges frame-ancestors, so 'none' is not diluted by 'self'", () => {
    const header = headerFor({ CSP_FRAME_ANCESTORS: "'none'" });

    expect(header).toContain("frame-ancestors 'none'");
    expect(header).not.toContain("frame-ancestors 'self'");
  });

  it('appends additional directives and skips malformed ones', () => {
    const header = serializeCspDirectives(
      buildCspDirectives({
        CSP_ADDITIONAL_DIRECTIVES:
          "upgrade-insecure-requests; require-trusted-types-for 'script'; 99-bogus 'self'",
      }),
    );

    expect(header).toContain('upgrade-insecure-requests');
    expect(header).toContain("require-trusted-types-for 'script'");
    expect(header).not.toContain('99-bogus');
  });
});

describe('shellCacheHeaders', () => {
  it('honors the documented overrides when CSP is off', () => {
    expect(shellCacheHeaders(false, {})).toEqual({
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      Pragma: 'no-cache',
      Expires: '0',
    });
    expect(
      shellCacheHeaders(false, { INDEX_CACHE_CONTROL: 'public, max-age=3600' })['Cache-Control'],
    ).toBe('public, max-age=3600');
  });

  it('refuses a cacheable shell when CSP is on, so a nonce cannot be replayed', () => {
    expect(
      shellCacheHeaders(true, {
        INDEX_CACHE_CONTROL: 'public, max-age=3600',
        INDEX_EXPIRES: '900',
      }),
    ).toEqual({
      'Cache-Control': 'no-store',
      Pragma: 'no-cache',
      Expires: '0',
    });
  });
});

describe('applyCspNonce', () => {
  it('stamps script tags and leaves styles alone', () => {
    const html = [
      '<style>body { margin: 0; }</style>',
      '<script>window.theme = "dark";</script>',
      '<script defer src="/assets/app.js"></script>',
    ].join('');

    expect(applyCspNonce(html, 'abc123')).toBe(
      [
        '<style>body { margin: 0; }</style>',
        '<script nonce="abc123">window.theme = "dark";</script>',
        '<script nonce="abc123" defer src="/assets/app.js"></script>',
      ].join(''),
    );
  });

  it('replaces a stale nonce rather than preserving it', () => {
    const html = '<script nonce="from-the-build">window.ok = true;</script>';

    expect(applyCspNonce(html, 'abc123')).toBe('<script nonce="abc123">window.ok = true;</script>');
    expect(applyCspNonce(html, 'abc123')).not.toContain('from-the-build');
  });

  it('stamps module preloads, which strict-dynamic does not cover', () => {
    const html = [
      '<link rel="modulepreload" crossorigin href="/assets/chunk.js">',
      '<link rel="preload" as="script" href="/assets/other.js">',
      '<link rel="stylesheet" crossorigin href="/assets/app.css">',
      '<link rel="icon" type="image/png" href="/favicon.png">',
    ].join('');

    expect(applyCspNonce(html, 'abc123')).toBe(
      [
        '<link nonce="abc123" rel="modulepreload" crossorigin href="/assets/chunk.js">',
        '<link nonce="abc123" rel="preload" as="script" href="/assets/other.js">',
        '<link rel="stylesheet" crossorigin href="/assets/app.css">',
        '<link rel="icon" type="image/png" href="/favicon.png">',
      ].join(''),
    );
  });

  it('returns the html untouched without a nonce', () => {
    const html = '<script src="/app.js"></script>';
    expect(applyCspNonce(html, '')).toBe(html);
  });
});
