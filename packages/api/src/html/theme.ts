import fs from 'fs';
import path from 'path';
import {
  THEME_BOOT_FILE,
  isBundledThemeName,
  DEPLOYMENT_THEME_BOOT_ID,
} from 'librechat-data-provider';
import type { BundledThemeBoot, DeploymentThemeBoot } from 'librechat-data-provider';
import type { Request, Response } from 'express';
import { rejectTenantHeader } from '../middleware/tenantHeader';
import { isEnabled } from '../utils/common';

const TENANT_HEADER = 'X-Tenant-Id';

/**
 * The bundled themes the client build resolved. Empty when the build predates them, which
 * leaves a bundled name to the bundle's first render, as for an inline definition.
 */
export function readBundledThemeBoot(distPath: string): BundledThemeBoot {
  try {
    const bundled = JSON.parse(fs.readFileSync(path.join(distPath, THEME_BOOT_FILE), 'utf8'));
    return typeof bundled === 'object' && bundled !== null ? bundled : {};
  } catch {
    return {};
  }
}

/**
 * Embeds the deployment's `interface.theme` ahead of the shell's boot script, so a first-ever
 * visit paints it before `/api/config` answers. A bundled name carries both resolved modes for
 * the boot script; an inline definition carries only its source, which the bundle resolves at
 * its first render.
 */
export function injectDeploymentThemeBoot(
  html: string,
  source: DeploymentThemeBoot['source'] | undefined,
  bundled: BundledThemeBoot,
): string {
  if (source == null || html.includes(`id="${DEPLOYMENT_THEME_BOOT_ID}"`)) {
    return html;
  }
  const modes =
    typeof source === 'string' && isBundledThemeName(source) ? bundled[source] : undefined;
  const boot: DeploymentThemeBoot = { source, ...(modes && { modes }) };
  /** A `<` in the payload could close the block; it never has to be raw. */
  const payload = JSON.stringify(boot).replace(/</g, '\\u003c');
  const block = `<script type="application/json" id="${DEPLOYMENT_THEME_BOOT_ID}">${payload}</script>`;
  return html.replace(/<head([^>]*)>/i, (match) => `${match}${block}`);
}

/**
 * The shell for a request. The deployment's base theme is only the right first paint where
 * the signed-out config resolves to the base: a request whose trusted `X-Tenant-Id` header
 * scopes it to a tenant, by the rule `preAuthTenantMiddleware` applies, gets the shell without
 * it, since that tenant's theme may differ.
 */
export function createDeploymentThemeShell(
  html: string,
  source: DeploymentThemeBoot['source'] | undefined,
  bundled: BundledThemeBoot,
  env: NodeJS.ProcessEnv = process.env,
): (req: Pick<Request, 'get'>, res: Pick<Response, 'vary'>) => string {
  const themed = injectDeploymentThemeBoot(html, source, bundled);
  if (themed === html || !isEnabled(env.TRUST_TENANT_HEADER)) {
    return () => themed;
  }
  return (req, res) => {
    res.vary(TENANT_HEADER);
    const tenantId = req.get(TENANT_HEADER)?.trim();
    return tenantId && !rejectTenantHeader(tenantId) ? html : themed;
  };
}
