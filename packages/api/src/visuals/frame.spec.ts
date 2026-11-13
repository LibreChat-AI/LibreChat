import { tenantStorage } from '@librechat/data-schemas';
import { VisualBridgeMethod, DEFAULT_VISUAL_SOURCES } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import type { Request, Response } from 'express';
import { buildVisualFrameResponse, createVisualFrameHandler } from './frame';

const directives = (policy: string): Map<string, string> =>
  new Map(
    policy.split(';').map((directive) => {
      const [name, ...values] = directive.trim().split(/\s+/);
      return [name, values.join(' ')];
    }),
  );

const policyFor = (sources: readonly string[]) =>
  directives(buildVisualFrameResponse({ sources }).headers['Content-Security-Policy']);

describe('buildVisualFrameResponse', () => {
  it('sandboxes the page to an opaque origin that only the app may frame', () => {
    const policy = policyFor(DEFAULT_VISUAL_SOURCES);
    expect(policy.get('sandbox')).toBe('allow-scripts');
    expect(policy.get('frame-ancestors')).toBe("'self'");
    expect(policy.get('default-src')).toBe("'none'");
  });

  it('lets scripts load only inline and from the configured sources', () => {
    const policy = policyFor(['https://cdn.example.com']);
    expect(policy.get('script-src')).toBe("'unsafe-inline' 'unsafe-eval' https://cdn.example.com");
    expect(policy.get('connect-src')).toBe('https://cdn.example.com');
    expect(policy.get('img-src')).toBe('data: blob: https://cdn.example.com');
  });

  it('never grants the app origin or form posts', () => {
    const policy = policyFor(DEFAULT_VISUAL_SOURCES);
    for (const [name, value] of policy) {
      if (name !== 'frame-ancestors') {
        expect(value).not.toContain("'self'");
      }
    }
    expect(policy.get('form-action')).toBe("'none'");
    expect(policy.get('frame-src')).toBe("'none'");
    expect(policy.get('base-uri')).toBe("'none'");
  });

  it('lets whatever may frame the app frame its visuals', () => {
    const policy = directives(
      buildVisualFrameResponse({
        sources: [],
        frameAncestors: ["'self'", 'https://portal.example.com'],
      }).headers['Content-Security-Policy'],
    );
    expect(policy.get('frame-ancestors')).toBe("'self' https://portal.example.com");
  });

  it('blocks every request when no sources are configured', () => {
    const policy = policyFor([]);
    expect(policy.get('connect-src')).toBe("'none'");
    expect(policy.get('script-src')).toBe("'unsafe-inline' 'unsafe-eval'");
  });

  it('serves a shell that announces readiness and accepts one render message from its parent', () => {
    const { body, headers } = buildVisualFrameResponse({ sources: [] });
    expect(headers['Content-Type']).toBe('text/html; charset=utf-8');
    expect(headers['Referrer-Policy']).toBe('no-referrer');
    expect(body).toContain(JSON.stringify(VisualBridgeMethod.proxyReady));
    expect(body).toContain(JSON.stringify(VisualBridgeMethod.resourceReady));
    expect(body).toContain('e.source!==window.parent');
  });
});

describe('createVisualFrameHandler', () => {
  const respond = async (visuals: AppConfig['visuals'], tenantId?: string) => {
    const res = { status: jest.fn(), set: jest.fn(), send: jest.fn(), end: jest.fn() };
    res.status.mockReturnValue(res);
    res.set.mockReturnValue(res);
    const getAppConfig = jest.fn(async () => ({ visuals }) as AppConfig);
    const handler = createVisualFrameHandler({ getAppConfig });
    const run = () => handler({} as Request, res as unknown as Response);
    await (tenantId ? tenantStorage.run({ tenantId }, run) : run());
    return { res, getAppConfig };
  };
  const policyOf = (res: { set: jest.Mock }) =>
    directives((res.set.mock.calls[0][0] as Record<string, string>)['Content-Security-Policy']);

  it('serves the policy for the configured sources', async () => {
    const { res } = await respond({ sources: ['https://cdn.example.com'] });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(policyOf(res).get('connect-src')).toBe('https://cdn.example.com');
  });

  it('falls back to the default sources when the config has no visuals block', async () => {
    const { res } = await respond(undefined);
    expect(policyOf(res).get('connect-src')).toBe(DEFAULT_VISUAL_SOURCES.join(' '));
  });

  it('reads the base config of the request tenant, failing closed', async () => {
    const { getAppConfig: base } = await respond(undefined);
    expect(base).toHaveBeenCalledWith({ tenantId: undefined, failClosed: true });
    const { getAppConfig: tenant } = await respond(undefined, 'tenant-a');
    expect(tenant).toHaveBeenCalledWith({ tenantId: 'tenant-a', failClosed: true });
  });

  it('lets a config failure reach the request boundary', async () => {
    const handler = createVisualFrameHandler({
      getAppConfig: () => Promise.reject(new Error('config store down')),
    });
    const res = { status: jest.fn(), set: jest.fn(), send: jest.fn(), end: jest.fn() };
    await expect(handler({} as Request, res as unknown as Response)).rejects.toThrow(
      'config store down',
    );
    expect(res.send).not.toHaveBeenCalled();
  });
});
