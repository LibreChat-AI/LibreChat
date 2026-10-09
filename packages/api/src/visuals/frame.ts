import { getTenantId } from '@librechat/data-schemas';
import { VisualBridgeMethod, DEFAULT_VISUAL_SOURCES } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import type { Request, Response } from 'express';

export interface VisualFrameResponse {
  headers: Record<string, string>;
  body: string;
}

/**
 * The page a visual renders in. Once the host answers `proxyReady` with the page, the shell
 * replaces itself with it through `document.write`, which keeps this response's CSP on the
 * written page. The host verifies `event.source`, since the sandboxed frame's origin is opaque.
 */
const SHELL_HTML = `<!doctype html><html><head><meta charset="utf-8"></head><body><script>(function(){window.addEventListener("message",function(e){var d=e.data,p=d&&d.params;if(e.source!==window.parent||!d||d.jsonrpc!=="2.0"||d.method!==${JSON.stringify(VisualBridgeMethod.resourceReady)}||!p||typeof p.html!=="string")return;document.open();document.write(p.html);document.close();});window.parent.postMessage({jsonrpc:"2.0",method:${JSON.stringify(VisualBridgeMethod.proxyReady)}},"*");})();</script></body></html>`;

/**
 * Builds the frame shell and its policy. The `sandbox` directive gives the page an opaque origin
 * even if it is opened outside the host's sandboxed iframe, so it can never read the app's
 * cookies, storage or DOM. Scripts run inline and from the configured sources; requests to
 * anywhere else, including the app's own API, are blocked.
 *
 * `'unsafe-eval'` is allowed because chart libraries compile expressions with it, and it adds no
 * reach to a page that already runs arbitrary inline script inside this policy.
 */
export function buildVisualFrameResponse({
  sources,
  frameAncestors = ["'self'"],
}: {
  sources: readonly string[];
  /** Whatever may frame the app may frame its visuals: every ancestor is checked. */
  frameAncestors?: readonly string[];
}): VisualFrameResponse {
  const origins = sources.join(' ');
  const withOrigins = (...tokens: string[]) => [...tokens, origins].filter(Boolean).join(' ');
  const policy = [
    "default-src 'none'",
    `script-src ${withOrigins("'unsafe-inline'", "'unsafe-eval'")}`,
    `style-src ${withOrigins("'unsafe-inline'")}`,
    `img-src ${withOrigins('data:', 'blob:')}`,
    `font-src ${withOrigins('data:')}`,
    'media-src data: blob:',
    `connect-src ${origins || "'none'"}`,
    'worker-src blob:',
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    `frame-ancestors ${frameAncestors.join(' ')}`,
    'sandbox allow-scripts',
  ].join('; ');

  return {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': policy,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cross-Origin-Resource-Policy': 'same-origin',
    },
    body: SHELL_HTML,
  };
}

type GetAppConfig = (options: { tenantId?: string; failClosed?: boolean }) => Promise<AppConfig>;

/**
 * Serves the frame shell. The frame request carries no user, so it reads the deployment config,
 * where `visuals` is set, and fails closed if that cannot be resolved. Whether a visual renders at
 * all is the client's call, under `interface.visuals`.
 */
export function createVisualFrameHandler({
  getAppConfig,
  frameAncestors,
}: {
  getAppConfig: GetAppConfig;
  frameAncestors?: readonly string[];
}) {
  return async (_req: Request, res: Response): Promise<void> => {
    const appConfig = await getAppConfig({ tenantId: getTenantId(), failClosed: true });
    const { headers, body } = buildVisualFrameResponse({
      sources: appConfig?.visuals?.sources ?? DEFAULT_VISUAL_SOURCES,
      frameAncestors,
    });
    res.status(200).set(headers).send(body);
  };
}
