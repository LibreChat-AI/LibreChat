import express from 'express';
import request from 'supertest';

import type { Express } from 'express';

import { buildSecurityHeaderOptions, createSecurityHeaders } from './headers';

function appWith(env: NodeJS.ProcessEnv): Express {
  const app = express();
  const securityHeaders = createSecurityHeaders(env);
  if (securityHeaders) {
    app.use(securityHeaders);
  }
  app.get('/health', (_req, res) => {
    res.status(200).send('OK');
  });
  return app;
}

describe('buildSecurityHeaderOptions', () => {
  it('always disables CSP so no directive allow-list can go stale', () => {
    expect(buildSecurityHeaderOptions({})?.contentSecurityPolicy).toBe(false);
    expect(
      buildSecurityHeaderOptions({ CONTENT_SECURITY_POLICY: 'true' })?.contentSecurityPolicy,
    ).toBe(false);
  });

  it('returns null when disabled outright', () => {
    expect(buildSecurityHeaderOptions({ SECURITY_HEADERS: 'false' })).toBeNull();
    expect(buildSecurityHeaderOptions({ SECURITY_HEADERS: 'off' })).toBeNull();
    expect(createSecurityHeaders({ SECURITY_HEADERS: 'false' })).toBeNull();
  });

  it('leaves HSTS includeSubDomains off unless opted in', () => {
    expect(buildSecurityHeaderOptions({})?.hsts).toEqual({
      maxAge: 31536000,
      includeSubDomains: false,
      preload: false,
    });
    expect(buildSecurityHeaderOptions({ HSTS_INCLUDE_SUBDOMAINS: 'true' })?.hsts).toMatchObject({
      includeSubDomains: true,
    });
  });

  it('falls back to defaults for unparseable values', () => {
    const options = buildSecurityHeaderOptions({
      HSTS_MAX_AGE: 'forever',
      X_FRAME_OPTIONS: 'ALLOW-FROM https://portal.example.com',
      REFERRER_POLICY: 'whatever',
      SECURITY_HEADERS: 'maybe',
    });

    expect(options?.hsts).toMatchObject({ maxAge: 31536000 });
    expect(options?.frameguard).toEqual({ action: 'sameorigin' });
    expect(options?.referrerPolicy).toEqual({ policy: 'no-referrer' });
  });

  it('disables individual headers without disabling the rest', () => {
    const options = buildSecurityHeaderOptions({
      HSTS_ENABLED: 'false',
      X_FRAME_OPTIONS: 'off',
      CROSS_ORIGIN_RESOURCE_POLICY: 'false',
    });

    expect(options?.hsts).toBe(false);
    expect(options?.frameguard).toBe(false);
    expect(options?.crossOriginResourcePolicy).toBe(false);
    expect(options?.crossOriginOpenerPolicy).toEqual({ policy: 'same-origin' });
    expect(options?.referrerPolicy).toEqual({ policy: 'no-referrer' });
  });
});

describe('createSecurityHeaders', () => {
  it('sets the baseline headers and never sets CSP', async () => {
    const response = await request(appWith({})).get('/health');

    expect(response.status).toBe(200);
    expect(response.headers['strict-transport-security']).toBe('max-age=31536000');
    expect(response.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['cross-origin-opener-policy']).toBe('same-origin');
    expect(response.headers['cross-origin-resource-policy']).toBe('same-origin');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['origin-agent-cluster']).toBe('?1');
    expect(response.headers['content-security-policy']).toBeUndefined();
    expect(response.headers['content-security-policy-report-only']).toBeUndefined();
  });

  it('honors per-header overrides', async () => {
    const response = await request(
      appWith({
        HSTS_MAX_AGE: '600',
        HSTS_INCLUDE_SUBDOMAINS: 'true',
        HSTS_PRELOAD: 'true',
        X_FRAME_OPTIONS: 'DENY',
        CROSS_ORIGIN_RESOURCE_POLICY: 'cross-origin',
        CROSS_ORIGIN_OPENER_POLICY: 'same-origin-allow-popups',
        REFERRER_POLICY: 'strict-origin-when-cross-origin',
      }),
    ).get('/health');

    expect(response.headers['strict-transport-security']).toBe(
      'max-age=600; includeSubDomains; preload',
    );
    expect(response.headers['x-frame-options']).toBe('DENY');
    expect(response.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(response.headers['cross-origin-opener-policy']).toBe('same-origin-allow-popups');
    expect(response.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
  });

  it('omits headers the operator turned off', async () => {
    const response = await request(
      appWith({
        HSTS_ENABLED: 'false',
        X_FRAME_OPTIONS: 'off',
        CROSS_ORIGIN_RESOURCE_POLICY: 'off',
      }),
    ).get('/health');

    expect(response.headers['strict-transport-security']).toBeUndefined();
    expect(response.headers['x-frame-options']).toBeUndefined();
    expect(response.headers['cross-origin-resource-policy']).toBeUndefined();
    expect(response.headers['x-content-type-options']).toBe('nosniff');
  });

  it('sets no headers at all when SECURITY_HEADERS is false', async () => {
    const response = await request(appWith({ SECURITY_HEADERS: 'false' })).get('/health');

    expect(response.status).toBe(200);
    expect(response.headers['x-content-type-options']).toBeUndefined();
    expect(response.headers['x-frame-options']).toBeUndefined();
    expect(response.headers['strict-transport-security']).toBeUndefined();
  });
});
