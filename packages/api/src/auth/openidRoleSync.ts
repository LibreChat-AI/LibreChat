import { get } from 'lodash';
import { SystemRoles } from 'librechat-data-provider';
import { isEnabled } from '~/utils';

export type OpenIdRoleSyncClaimSource = 'access' | 'id' | 'userinfo';

export type OpenIdRoleSyncOptions = {
  enabled: boolean;
  apiEnabled: boolean;
  claimSource: OpenIdRoleSyncClaimSource;
  claim?: string;
  rolePriority: string[];
  fallbackRole?: string;
};

type OpenIdRoleSyncSelectionInput = {
  currentRole?: string;
  openIdRoleValues?: string | unknown[];
  rolePriority: string[];
  fallbackRole?: string;
};

export type OpenIdRoleSyncSelectionResult = {
  selectedRole?: string;
  reason?: 'matched_priority' | 'kept_current' | 'fallback' | 'no_matching_role';
};

type OpenIdRolesForOpenIdSyncInput = {
  options: OpenIdRoleSyncOptions;
  accessToken?: string;
  accessClaims?: unknown;
  idToken?: string;
  claims?: unknown;
  userinfo?: unknown;
  decodeToken: (token: string) => unknown;
  resolveGroupOverage?: () => Promise<string[] | null>;
};

type OpenIdRoleSyncRolesLookup = (
  roleNames: string[],
  fieldsToSelect?: string | string[] | null,
) => Promise<Array<{ name?: string | null }> | null | undefined>;

type LibreChatRolesForOpenIdSyncInput = {
  rolePriority: string[];
  fallbackRole?: string;
  getRolesByNames: OpenIdRoleSyncRolesLookup;
  logPrefix?: string;
};

type LibreChatRolesForOpenIdSync = {
  rolePriority: string[];
  fallbackRole?: string;
};

/**
 * Reads and validates the OPENID_ROLE_SYNC_* environment configuration.
 */
export function getOpenIdRoleSyncOptions(
  env: NodeJS.ProcessEnv = process.env,
): OpenIdRoleSyncOptions {
  const enabled = isEnabled(env.OPENID_ROLE_SYNC_ENABLED);
  const apiEnabled = isEnabled(env.OPENID_ROLE_SYNC_API_ENABLED);
  const rawSource = env.OPENID_ROLE_SYNC_SOURCE?.trim() || 'id';
  const claimSource = rawSource as OpenIdRoleSyncClaimSource;
  const claim = env.OPENID_ROLE_SYNC_CLAIM?.trim() || undefined;
  const rolePriority =
    env.OPENID_ROLE_SYNC_ROLE_PRIORITY?.split(',')
      .map((role) => role.trim())
      .filter(Boolean) ?? [];
  const fallbackRole = env.OPENID_ROLE_SYNC_FALLBACK_ROLE?.trim() || undefined;

  if (apiEnabled && !enabled) {
    throw new Error(
      '[openidRoleSync] OPENID_ROLE_SYNC_API_ENABLED requires OPENID_ROLE_SYNC_ENABLED=true',
    );
  }

  /**
   * Only validate role-sync-specific settings once the feature is enabled. A
   * disabled deployment must not fail OpenID login just because a stale or
   * mistyped OPENID_ROLE_SYNC_* value is left in the environment.
   */
  if (!enabled) {
    return { enabled, apiEnabled, claimSource, claim, rolePriority, fallbackRole };
  }

  if (!['access', 'id', 'userinfo'].includes(claimSource)) {
    throw new Error(
      `[openidRoleSync] OPENID_ROLE_SYNC_SOURCE must be one of: access, id, userinfo`,
    );
  }

  if (!claim) {
    throw new Error(
      '[openidRoleSync] OPENID_ROLE_SYNC_CLAIM is required when role sync is enabled',
    );
  }

  if (rolePriority.some((role) => role.toLowerCase() === SystemRoles.ADMIN.toLowerCase())) {
    throw new Error('[openidRoleSync] OPENID_ROLE_SYNC_ROLE_PRIORITY cannot include ADMIN');
  }

  if (fallbackRole?.toLowerCase() === SystemRoles.ADMIN.toLowerCase()) {
    throw new Error('[openidRoleSync] OPENID_ROLE_SYNC_FALLBACK_ROLE cannot be ADMIN');
  }

  return { enabled, apiEnabled, claimSource, claim, rolePriority, fallbackRole };
}

/**
 * Extracts the configured role claim from the configured OpenID source.
 * Callers provide token decoding and optional group-overage resolution.
 */
export async function getOpenIdRolesForOpenIdSync({
  options,
  accessToken,
  accessClaims,
  idToken,
  claims,
  userinfo,
  decodeToken,
  resolveGroupOverage,
}: OpenIdRolesForOpenIdSyncInput): Promise<string | unknown[] | undefined> {
  let source: unknown;

  switch (options.claimSource) {
    case 'access':
      source = accessClaims ?? (accessToken ? decodeToken(accessToken) : undefined);
      break;
    case 'id':
      source = idToken ? decodeToken(idToken) : claims;
      break;
    case 'userinfo':
      source = userinfo;
      break;
  }

  if (!source || !options.claim) {
    return;
  }

  /**
   * Azure AD/Entra moves an oversized `groups` claim into `_claim_names`/`_claim_sources`
   * for both ID and access tokens, so overage resolution must cover both sources — not
   * just the ID token — or `access`-sourced syncs silently see no groups for those users.
   */
  const supportsGroupOverage =
    options.claim === 'groups' &&
    (options.claimSource === 'id' || options.claimSource === 'access');
  if (supportsGroupOverage) {
    const claimsData = source as {
      hasgroups?: unknown;
      _claim_names?: { groups?: string };
      _claim_sources?: Record<string, unknown>;
    };
    const groupSource = claimsData._claim_names?.groups;
    const hasGroupOverage = Boolean(
      claimsData.hasgroups || (groupSource && claimsData._claim_sources?.[groupSource]),
    );

    if (hasGroupOverage) {
      return (await resolveGroupOverage?.()) ?? undefined;
    }
  }

  const openIdRoleValues = get(source, options.claim);
  if (Array.isArray(openIdRoleValues) || typeof openIdRoleValues === 'string') {
    return openIdRoleValues;
  }
  /**
   * The source is available but carries no usable value for the configured claim
   * (absent, null, or a non-string/array type). Return an empty list rather than
   * `undefined` so callers still run selection and apply the configured fallback,
   * instead of leaving a stale elevated role in place.
   */
  return [];
}

/**
 * Gets the configured LibreChat roles that OpenID role sync is allowed to assign.
 * The names are read from config, checked against storage, and returned as canonical role names.
 */
export async function getLibreChatRolesForOpenIdSync(
  input: LibreChatRolesForOpenIdSyncInput,
): Promise<LibreChatRolesForOpenIdSync> {
  const roleNames = input.fallbackRole
    ? [...input.rolePriority, input.fallbackRole]
    : input.rolePriority;
  const uniqueRoleNames: string[] = [];
  const seenRoleKeys = new Set<string>();

  for (const roleName of roleNames) {
    const trimmed = roleName.trim();
    const key = trimmed.toLowerCase();

    if (!trimmed || seenRoleKeys.has(key)) {
      continue;
    }

    seenRoleKeys.add(key);
    uniqueRoleNames.push(trimmed);
  }

  const roles = (await input.getRolesByNames(uniqueRoleNames, 'name')) ?? [];
  const existingRoleNames = new Map(
    roles
      .filter((role): role is { name: string } => typeof role?.name === 'string')
      .map((role) => [role.name.trim().toLowerCase(), role.name.trim()]),
  );
  /**
   * System roles (e.g. USER) are provisioned globally at startup without a tenant
   * context, so a tenant-scoped lookup may not return them even though they exist.
   * Treat them as always-available canonical names so a documented system fallback
   * role does not fail validation for tenant users.
   */
  for (const systemRole of Object.values(SystemRoles)) {
    const key = systemRole.toLowerCase();
    if (!existingRoleNames.has(key)) {
      existingRoleNames.set(key, systemRole);
    }
  }
  const missingRoleNames = uniqueRoleNames.filter(
    (roleName) => !existingRoleNames.has(roleName.toLowerCase()),
  );

  if (missingRoleNames.length > 0) {
    throw new Error(
      `${input.logPrefix ?? '[openidRoleSync]'} OpenID role sync configured roles do not exist: ${missingRoleNames.join(', ')}`,
    );
  }

  return {
    rolePriority: input.rolePriority.map(
      (roleName) => existingRoleNames.get(roleName.trim().toLowerCase()) ?? roleName.trim(),
    ),
    fallbackRole: input.fallbackRole
      ? (existingRoleNames.get(input.fallbackRole.trim().toLowerCase()) ??
        input.fallbackRole.trim())
      : undefined,
  };
}

/**
 * Chooses the LibreChat role to assign from normalized OpenID token values and validated config.
 * Priority roles win first, then the current fallback role can be preserved, then fallback applies.
 */
export function selectOpenIdRole(
  input: OpenIdRoleSyncSelectionInput,
): OpenIdRoleSyncSelectionResult {
  const assignableRoles = input.fallbackRole
    ? [...input.rolePriority, input.fallbackRole]
    : input.rolePriority;
  const openIdRoleValues = Array.isArray(input.openIdRoleValues)
    ? input.openIdRoleValues
    : (input.openIdRoleValues?.split(/[\s,]+/) ?? []);
  const assignableRoleKeys = new Set(
    assignableRoles
      .map((role) => role.trim().toLowerCase())
      .filter((role) => role && role !== SystemRoles.ADMIN.toLowerCase()),
  );
  const openIdRoleKeys = new Set<string>();

  // Keep only OpenID roles that can map to configured LibreChat roles.
  for (const value of openIdRoleValues) {
    if (typeof value !== 'string') {
      continue;
    }

    const trimmed = value.trim();
    const key = trimmed.toLowerCase();

    if (
      !trimmed ||
      key === SystemRoles.ADMIN.toLowerCase() ||
      (assignableRoleKeys.size > 0 && !assignableRoleKeys.has(key))
    ) {
      continue;
    }

    openIdRoleKeys.add(key);
  }

  for (const role of input.rolePriority) {
    const trimmed = role.trim();

    if (
      trimmed &&
      trimmed.toLowerCase() !== SystemRoles.ADMIN.toLowerCase() &&
      openIdRoleKeys.has(trimmed.toLowerCase())
    ) {
      return { selectedRole: trimmed, reason: 'matched_priority' };
    }
  }

  if (
    input.currentRole &&
    input.fallbackRole &&
    input.currentRole.trim().toLowerCase() === input.fallbackRole.trim().toLowerCase() &&
    openIdRoleKeys.has(input.currentRole.trim().toLowerCase())
  ) {
    return { selectedRole: input.currentRole, reason: 'kept_current' };
  }

  if (input.fallbackRole) {
    const trimmed = input.fallbackRole.trim();

    if (trimmed && trimmed.toLowerCase() !== SystemRoles.ADMIN.toLowerCase()) {
      return { selectedRole: trimmed, reason: 'fallback' };
    }
  }

  return { reason: 'no_matching_role' };
}
