import { z } from 'zod';
import jwt from 'jsonwebtoken';
import { hasScheduledOboScopes } from './provider';

const scopeBindingSchema = z.object({
  version: z.literal(1),
  resource: z.string().min(1),
  permissions: z.array(z.string().min(1)).min(1),
});
export type ScheduledOboScopeBinding = z.infer<typeof scopeBindingSchema>;

export interface ScheduledOboScopeAuthority {
  issuer: string;
  tokenEndpoint: string;
}

export interface ScheduledOboScopeResponse {
  access_token?: string;
  scope?: string;
}

export type ScheduledOboScopeResult =
  | { ok: true; binding?: ScheduledOboScopeBinding }
  | { ok: false };

/** Supported Microsoft authority metadata, not an inference from the MCP URL. */
function isEntraAuthority(authority: ScheduledOboScopeAuthority): boolean {
  try {
    const issuer = new URL(authority.issuer);
    const endpoint = new URL(authority.tokenEndpoint);
    const hosts = [
      'login.microsoftonline.com',
      'login.microsoftonline.us',
      'login.chinacloudapi.cn',
    ];
    const issuerHost =
      issuer.hostname === 'sts.windows.net' ? 'login.microsoftonline.com' : issuer.hostname;
    return (
      issuer.protocol === 'https:' &&
      endpoint.protocol === 'https:' &&
      !issuer.username &&
      !issuer.password &&
      !endpoint.username &&
      !endpoint.password &&
      hosts.includes(issuerHost) &&
      endpoint.hostname === issuerHost
    );
  } catch {
    return false;
  }
}

function selectorResource(requested: string): string | null | undefined {
  const scopes = requested.split(/\s+/).filter(Boolean);
  if (!scopes.some((scope) => scope === '.default' || scope.endsWith('/.default')))
    return undefined;
  // A static resource selector cannot be mixed with dynamic delegated scopes.
  if (scopes.length !== 1 || !scopes[0].endsWith('/.default')) return null;
  const resource = scopes[0].slice(0, -'/.default'.length);
  return resource || null;
}

function permissionsForResource(granted: string, resource: string): string[] | null {
  const permissions = new Set<string>();
  const prefix = resource.endsWith('/') ? resource : `${resource}/`;
  for (const scope of granted.split(/\s+/).filter(Boolean)) {
    if (['openid', 'profile', 'email', 'offline_access'].includes(scope)) continue;
    const permission = scope.startsWith(prefix) ? scope.slice(prefix.length) : scope;
    if (!permission || permission === '.default' || /[/:]/.test(permission)) return null;
    permissions.add(permission);
  }
  return permissions.size > 0 ? [...permissions].sort() : null;
}

/** The access token came from the configured IdP exchange, not from user input.
 * Decode only to establish a missing consent projection, never to authenticate a
 * caller or skip the resource server's own signature/audience validation. */
function jwtPermissionProjection(
  token: string | undefined,
  resource: string,
): string | null | false {
  if (!token) return null;
  const claims = jwt.decode(token);
  if (!claims || typeof claims !== 'object') return null;
  const applicationId =
    /^api:\/\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(resource)?.[1];
  // Entra resource identifiers can name application-ID audience aliases that
  // cannot be inferred here. Treat that token as opaque; never remap consent.
  if (claims.aud !== resource && !(applicationId && claims.aud === applicationId)) return null;
  return typeof claims.scp === 'string' ? claims.scp : false;
}

/** Stored selector bindings are optional only for literal scopes. Older unbound
 * selector grants need owner reauthorization; do not invent their permissions. */
export function readScheduledOboScopeBinding(value: unknown): ScheduledOboScopeBinding | undefined {
  const result = scopeBindingSchema.safeParse(value);
  return result.success ? result.data : undefined;
}

export function hasScheduledOboScopeBinding(
  requested: string,
  authority: ScheduledOboScopeAuthority,
  binding?: ScheduledOboScopeBinding,
): boolean {
  const resource = selectorResource(requested);
  if (resource === undefined || !isEntraAuthority(authority)) return true;
  return (
    resource != null &&
    binding?.resource === resource &&
    binding.permissions.length > 0 &&
    binding.permissions.every(
      (permission) => permission !== '.default' && !/[\s/:]/.test(permission),
    )
  );
}

/** Bind the concrete permissions selected by Entra .default on enrollment.
 * Renewals may retain or add permissions, but must never lose that enrolled set.
 * Other providers keep literal-scope semantics; a selector is never a wildcard. */
export function resolveScheduledOboScopes(
  response: ScheduledOboScopeResponse,
  requested: string,
  authority: ScheduledOboScopeAuthority,
  binding?: ScheduledOboScopeBinding,
): ScheduledOboScopeResult {
  const resource = selectorResource(requested);
  if (resource === undefined || !isEntraAuthority(authority))
    return { ok: hasScheduledOboScopes(response.scope, requested) };
  if (resource == null || (binding && !hasScheduledOboScopeBinding(requested, authority, binding)))
    return { ok: false };
  const projected = response.scope ?? jwtPermissionProjection(response.access_token, resource);
  if (projected === false) return { ok: false };
  // Scope omission preserves known consent. Initial selector consent must have
  // an observable concrete set, not an opaque token plus a guessed wildcard.
  if (projected == null) return binding ? { ok: true, binding } : { ok: false };
  const permissions = permissionsForResource(projected, resource);
  if (!permissions || binding?.permissions.some((permission) => !permissions.includes(permission)))
    return { ok: false };
  return { ok: true, binding: binding ?? { version: 1, resource, permissions } };
}
