import { logger } from '@librechat/data-schemas';
import type { Request, Response, NextFunction } from 'express';
import { buildRequestContext, runWithTenantContext } from './tenant';
import { rejectTenantHeader } from './tenantHeader';
import { isEnabled } from '~/utils';

/**
 * Pre-authentication tenant context middleware for unauthenticated routes.
 *
 * Reads the tenant identifier from the `X-Tenant-Id` request header and wraps
 * downstream handlers in `tenantStorage.run()` so that Mongoose queries and
 * config resolution run within the correct tenant scope.
 *
 * **Where to use**: Mount on routes that must be tenant-aware before
 * authentication has occurred:
 * - `GET /api/config` — login page needs tenant-specific config (social logins, registration)
 * - `/api/auth/*` — login, register, password reset
 * - `/oauth/*` — OAuth callback flows
 * - `GET /api/share/:shareId` — public shared conversation links
 *
 * **How the header gets set**: The deployment's reverse proxy, auth gateway,
 * or OpenID strategy sets `X-Tenant-Id` based on subdomain, path, or OIDC claim.
 * This middleware does NOT resolve tenants from subdomains or tokens — that is
 * the responsibility of the deployment layer. Header-based resolution is disabled
 * unless the operator explicitly sets `TRUST_TENANT_HEADER=true`.
 *
 * **Design**: Intentionally minimal. No subdomain parsing, no OIDC claim
 * extraction, no YAML-driven strategy. Multi-tenant deployments can:
 * 1. Set the header in the reverse proxy / ingress (simplest),
 * 2. Replace this middleware's resolver logic entirely, or
 * 3. Layer additional resolution on top (e.g., OpenID `tenant` claim → header).
 *
 * If no header is present, downstream runs without tenant ALS context (same as
 * single-tenant mode), while request logging context can still propagate.
 */
export function preAuthTenantMiddleware(req: Request, res: Response, next: NextFunction): void {
  const raw = req.headers['x-tenant-id'];
  const requestContext = buildRequestContext(req);

  if (!raw || typeof raw !== 'string' || !isEnabled(process.env.TRUST_TENANT_HEADER)) {
    runWithTenantContext(requestContext, next);
    return;
  }

  const tenantId = raw.trim();

  if (!tenantId) {
    runWithTenantContext(requestContext, next);
    return;
  }

  const rejection = rejectTenantHeader(tenantId);
  if (rejection === 'system') {
    runWithTenantContext(requestContext, () => {
      logger.warn('[preAuthTenant] Rejected __SYSTEM__ sentinel in X-Tenant-Id header', {
        ip: req.ip,
        path: req.path,
      });
      next();
    });
    return;
  }

  if (rejection === 'malformed') {
    runWithTenantContext(requestContext, () => {
      logger.warn('[preAuthTenant] Rejected malformed X-Tenant-Id header', {
        ip: req.ip,
        length: tenantId.length,
        path: req.path,
      });
      next();
    });
    return;
  }

  runWithTenantContext({ ...requestContext, tenantId }, next);
}
