import fs from 'fs';
import os from 'os';
import path from 'path';
import { logger } from '@librechat/data-schemas';
import { THEME_BOOT_FILE, DEPLOYMENT_THEME_BOOT_ID } from 'librechat-data-provider';
import type { BundledThemeBoot, DeploymentThemeBoot } from 'librechat-data-provider';
import type { Request, Response } from 'express';
import {
  readBundledThemeBoot,
  injectDeploymentThemeBoot,
  createDeploymentThemeShell,
} from './theme';
import { applyCspNonce } from '~/security/csp';

const SHELL =
  '<!DOCTYPE html><html><head><base href="/" /><script>boot()</script></head>' +
  '<body><div id="root"></div><script type="module" src="/assets/index.js"></script></body></html>';

const style = (surface: string) => ({
  properties: [['--surface-primary', surface]] as Array<[string, string]>,
  attributes: { 'data-theme': 'clickhouse' },
});

const bundled: BundledThemeBoot = {
  clickhouse: { light: style('255 255 255'), dark: style('0 0 0') },
};

const BLOCK = new RegExp(
  `<script type="application/json" id="${DEPLOYMENT_THEME_BOOT_ID}">(.*?)</script>`,
);

const bootOf = (html: string): DeploymentThemeBoot | undefined => {
  const match = BLOCK.exec(html);
  return match ? JSON.parse(match[1]) : undefined;
};

const request = (headers: Record<string, string> = {}) =>
  ({ get: (name: string) => headers[name.toLowerCase()] }) as Pick<Request, 'get'>;

const response = () => {
  const vary = jest.fn();
  const res: Pick<Response, 'vary'> = { vary };
  return { res, vary };
};

describe('injectDeploymentThemeBoot', () => {
  it('embeds a bundled name with both resolved modes ahead of the boot script', () => {
    const html = injectDeploymentThemeBoot(SHELL, 'clickhouse', bundled);

    expect(bootOf(html)).toEqual({ source: 'clickhouse', modes: bundled.clickhouse });
    expect(html.indexOf(DEPLOYMENT_THEME_BOOT_ID)).toBeLessThan(html.indexOf('boot()'));
  });

  it('embeds only the source of an inline definition, which the bundle resolves', () => {
    const inline = { version: 1 as const, name: 'acme', modes: { light: {}, dark: {} } };
    expect(bootOf(injectDeploymentThemeBoot(SHELL, inline, bundled))).toEqual({ source: inline });
  });

  it('embeds only the source when the build carries no resolved copy of the name', () => {
    expect(bootOf(injectDeploymentThemeBoot(SHELL, 'clickhouse', {}))).toEqual({
      source: 'clickhouse',
    });
  });

  it('leaves the shell alone without a deployment theme', () => {
    expect(injectDeploymentThemeBoot(SHELL, undefined, bundled)).toBe(SHELL);
  });

  it('does not stack a second block on a shell that has one', () => {
    const once = injectDeploymentThemeBoot(SHELL, 'clickhouse', bundled);
    expect(injectDeploymentThemeBoot(once, 'clickhouse', bundled)).toBe(once);
  });

  it('keeps a `<` in an inline definition from closing the block', () => {
    const inline = { version: 1 as const, name: '</script><script>alert(1)</script>', modes: {} };
    const html = injectDeploymentThemeBoot(SHELL, inline, bundled);

    expect(html).not.toContain('</script><script>alert(1)');
    expect(bootOf(html)?.source).toEqual(inline);
  });

  it('is not an executable script a strict CSP would have to allow', () => {
    const html = applyCspNonce(injectDeploymentThemeBoot(SHELL, 'clickhouse', bundled), 'n0nce');
    expect(bootOf(html.replace(/ nonce="n0nce"/g, ''))?.source).toBe('clickhouse');
  });
});

describe('createDeploymentThemeShell', () => {
  it('serves the themed shell to every request of a single-tenant deployment', () => {
    const shellFor = createDeploymentThemeShell(SHELL, 'clickhouse', bundled, {});
    const { res, vary } = response();

    expect(bootOf(shellFor(request({ 'x-tenant-id': 'acme' }), res))?.source).toBe('clickhouse');
    expect(vary).not.toHaveBeenCalled();
  });

  it('serves a request scoped to a trusted tenant the shell without the base theme, as the config resolves it', () => {
    const shellFor = createDeploymentThemeShell(SHELL, 'clickhouse', bundled, {
      TRUST_TENANT_HEADER: 'true',
    });
    const tenant = response();
    const base = response();

    expect(shellFor(request({ 'x-tenant-id': 'acme' }), tenant.res)).toBe(SHELL);
    expect(bootOf(shellFor(request(), base.res))?.source).toBe('clickhouse');
    expect(tenant.vary).toHaveBeenCalledWith('X-Tenant-Id');
    for (const ignored of ['__SYSTEM__', 'a:b', 'x'.repeat(129), '  ']) {
      expect(bootOf(shellFor(request({ 'x-tenant-id': ignored }), response().res))?.source).toBe(
        'clickhouse',
      );
    }
    expect(base.vary).toHaveBeenCalledWith('X-Tenant-Id');
  });

  it('serves the plain shell when no theme is configured', () => {
    const shellFor = createDeploymentThemeShell(SHELL, undefined, bundled, {
      TRUST_TENANT_HEADER: 'true',
    });
    const { res, vary } = response();

    expect(shellFor(request(), res)).toBe(SHELL);
    expect(vary).not.toHaveBeenCalled();
  });
});

describe('readBundledThemeBoot', () => {
  it('reads what the client build emitted, nothing when it is missing, and reports a broken one', () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
    const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'theme-boot-'));
    try {
      expect(readBundledThemeBoot(dist)).toEqual({});
      fs.writeFileSync(path.join(dist, THEME_BOOT_FILE), JSON.stringify(bundled));
      expect(readBundledThemeBoot(dist)).toEqual(bundled);
      expect(warn).not.toHaveBeenCalled();
      fs.writeFileSync(path.join(dist, THEME_BOOT_FILE), 'null');
      expect(readBundledThemeBoot(dist)).toEqual({});
      fs.writeFileSync(path.join(dist, THEME_BOOT_FILE), '{"clickhouse":');
      expect(readBundledThemeBoot(dist)).toEqual({});
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      fs.rmSync(dist, { recursive: true, force: true });
      warn.mockRestore();
    }
  });
});
