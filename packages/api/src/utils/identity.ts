import { normalizeOpenIdIssuer } from '~/auth/openid';

/**
 * Auth-boundary identity helpers for token/cache scoping.
 * Do not use these as a blanket replacement for app ownership checks, and keep
 * tenant/issuer data out of placeholder-visible safe user fields.
 */
type StringableId = string | number | { toString(): string };

export type AuthIdentitySource = {
  id?: string | null;
  _id?: StringableId | null;
  openidId?: string | null;
  openidIssuer?: string | null;
  tenantId?: string | null;
};

export type AuthIdentityContext = {
  appUserId?: string;
  openidSubject?: string;
  tenantId?: string;
  openidIssuer?: string;
};

export type AuthIdentityTuple = {
  tenantId: string;
  openidIssuer: string;
  subject: string;
};

export type RefreshTokenBridgeIdentity = {
  userId: string;
  tenantId?: string;
  openidIssuer?: string;
};

export type OpenIDSessionIdentitySource = {
  appUserId?: string | null;
  openidSubject?: string | null;
  tenantId?: string | null;
  openidIssuer?: string | null;
};

const NO_TENANT = 'no-tenant';
const NO_ISSUER = 'no-issuer';
const IDENTITY_PART_SEPARATOR = '\x1f';

function normalizeIdentityValue(value: string | null | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function stringifyId(value: StringableId | null | undefined): string | undefined {
  if (value == null) {
    return undefined;
  }

  const id =
    typeof value === 'string' || typeof value === 'number' ? String(value) : value.toString();
  return normalizeIdentityValue(id);
}

export function resolveAppUserId(
  ...sources: Array<AuthIdentitySource | null | undefined>
): string | undefined {
  for (const source of sources) {
    const id = stringifyId(source?._id) ?? normalizeIdentityValue(source?.id);
    if (id) {
      return id;
    }
  }

  return undefined;
}

export function resolveOpenIDSubject(
  source: AuthIdentitySource | null | undefined,
): string | undefined {
  return normalizeIdentityValue(source?.openidId);
}

export function resolveRefreshSubject(
  ...sources: Array<AuthIdentitySource | null | undefined>
): string | undefined {
  for (const source of sources) {
    const subject = resolveOpenIDSubject(source) ?? resolveAppUserId(source);
    if (subject) {
      return subject;
    }
  }

  return undefined;
}

export function resolveTenantId({
  tenantId,
  user,
  requestUser,
}: {
  tenantId?: string | null;
  user?: AuthIdentitySource | null;
  requestUser?: AuthIdentitySource | null;
}): string | undefined {
  return (
    normalizeIdentityValue(tenantId) ??
    normalizeIdentityValue(user?.tenantId) ??
    normalizeIdentityValue(requestUser?.tenantId)
  );
}

export function resolveAuthOpenIDIssuer({
  openidIssuer,
  user,
  requestUser,
}: {
  openidIssuer?: string | null;
  user?: AuthIdentitySource | null;
  requestUser?: AuthIdentitySource | null;
}): string | undefined {
  return (
    normalizeOpenIdIssuer(openidIssuer ?? undefined) ??
    normalizeOpenIdIssuer(user?.openidIssuer ?? undefined) ??
    normalizeOpenIdIssuer(requestUser?.openidIssuer ?? undefined)
  );
}

export function createAuthIdentityContext({
  user,
  requestUser,
  tenantId,
  openidIssuer,
}: {
  user?: AuthIdentitySource | null;
  requestUser?: AuthIdentitySource | null;
  tenantId?: string | null;
  openidIssuer?: string | null;
}): AuthIdentityContext {
  return {
    appUserId: resolveAppUserId(user, requestUser),
    openidSubject: resolveOpenIDSubject(user) ?? resolveOpenIDSubject(requestUser),
    tenantId: resolveTenantId({ tenantId, user, requestUser }),
    openidIssuer: resolveAuthOpenIDIssuer({ openidIssuer, user, requestUser }),
  };
}

export function createOpenIDSessionIdentity({
  user,
  requestUser,
  userId,
  openidSubject,
  tenantId,
  openidIssuer,
}: {
  user?: AuthIdentitySource | null;
  requestUser?: AuthIdentitySource | null;
  userId?: string | null;
  openidSubject?: string | null;
  tenantId?: string | null;
  openidIssuer?: string | null;
}): AuthIdentityContext {
  return createAuthIdentityContext({
    user: {
      id: userId,
      openidId: openidSubject,
      tenantId,
      openidIssuer,
    },
    requestUser: user ?? requestUser,
    tenantId,
    openidIssuer,
  });
}

function normalizeOpenIDSessionIdentity(
  identity: OpenIDSessionIdentitySource | null | undefined,
): AuthIdentityContext | null {
  const appUserId = normalizeIdentityValue(identity?.appUserId);
  const openidSubject = normalizeIdentityValue(identity?.openidSubject);
  if (!appUserId || !openidSubject) {
    return null;
  }

  return {
    appUserId,
    openidSubject,
    tenantId: normalizeIdentityValue(identity?.tenantId),
    openidIssuer: normalizeOpenIdIssuer(identity?.openidIssuer ?? undefined),
  };
}

export function isOpenIDSessionIdentityMatch(
  sessionIdentity: OpenIDSessionIdentitySource | null | undefined,
  expectedIdentity: OpenIDSessionIdentitySource | null | undefined,
): boolean {
  const session = normalizeOpenIDSessionIdentity(sessionIdentity);
  const expected = normalizeOpenIDSessionIdentity(expectedIdentity);

  return (
    session != null &&
    expected != null &&
    session.appUserId === expected.appUserId &&
    session.openidSubject === expected.openidSubject &&
    session.tenantId === expected.tenantId &&
    session.openidIssuer === expected.openidIssuer
  );
}

export function createRefreshTokenBridgeIdentity({
  user,
  requestUser,
  userId,
  tenantId,
  openidIssuer,
}: {
  user?: AuthIdentitySource | null;
  requestUser?: AuthIdentitySource | null;
  userId?: string | null;
  tenantId?: string | null;
  openidIssuer?: string | null;
}): RefreshTokenBridgeIdentity | null {
  const appUserId = normalizeIdentityValue(userId) ?? resolveAppUserId(user, requestUser);
  if (!appUserId) {
    return null;
  }

  return {
    userId: appUserId,
    tenantId: resolveTenantId({ tenantId, user, requestUser }),
    openidIssuer: resolveAuthOpenIDIssuer({ openidIssuer, user, requestUser }),
  };
}

export function createOpenIDRefreshIdentityTuple({
  user,
  requestUser,
  tenantId,
  openidIssuer,
}: {
  user?: AuthIdentitySource | null;
  requestUser?: AuthIdentitySource | null;
  tenantId?: string | null;
  openidIssuer?: string | null;
}): AuthIdentityTuple | null {
  const subject = resolveRefreshSubject(user, requestUser);
  if (!subject) {
    return null;
  }

  return {
    subject,
    tenantId: resolveTenantId({ tenantId, user, requestUser }) ?? NO_TENANT,
    openidIssuer: resolveAuthOpenIDIssuer({ openidIssuer, user, requestUser }) ?? NO_ISSUER,
  };
}

export function createOpenIDOboIdentityTuple({
  user,
  identityContext,
  tenantId,
  openidIssuer,
}: {
  user?: AuthIdentitySource | null;
  identityContext?: AuthIdentityContext | null;
  tenantId?: string | null;
  openidIssuer?: string | null;
}): AuthIdentityTuple | null {
  const subject =
    normalizeIdentityValue(identityContext?.openidSubject) ?? resolveOpenIDSubject(user);
  if (!subject) {
    return null;
  }

  return {
    subject,
    tenantId:
      normalizeIdentityValue(tenantId) ??
      normalizeIdentityValue(identityContext?.tenantId) ??
      normalizeIdentityValue(user?.tenantId) ??
      NO_TENANT,
    openidIssuer:
      normalizeOpenIdIssuer(openidIssuer ?? undefined) ??
      normalizeOpenIdIssuer(identityContext?.openidIssuer) ??
      normalizeOpenIdIssuer(user?.openidIssuer ?? undefined) ??
      NO_ISSUER,
  };
}

export function serializeAuthIdentityTuple(tuple: AuthIdentityTuple): string {
  return [tuple.tenantId, tuple.openidIssuer, tuple.subject].join(IDENTITY_PART_SEPARATOR);
}
