import { PrincipalType } from 'librechat-data-provider';
import type { TPrincipal, TGraphPerson, TGraphGroup } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import { getLookupConcurrency } from '~/utils/concurrency';
import { getSafeErrorMetadata } from '~/utils/errors';
import { mapWithConcurrency } from '~/utils/promise';

/** Local principal IDs must be scalar ObjectId strings, never query operators. */
export function validateLocalPrincipalId(id: unknown): string {
  if (typeof id !== 'string' || !/^[a-f\d]{24}$/i.test(id)) {
    throw new Error('Invalid local principal ID');
  }
  return id;
}

export interface DirectoryPrincipalUser {
  id: string;
}

export interface DirectoryPrincipalUserData {
  name?: string;
  email: string;
  emailVerified: false;
  provider: 'openid';
  idOnTheSource: string;
}

export interface DirectoryPrincipalUserMethods {
  resolvePrincipal: (principal: DirectoryPrincipal) => Promise<TPrincipal | null>;
  findUserBySourceId: (idOnTheSource: string) => Promise<DirectoryPrincipalUser | null>;
  findUserByEmail: (email: string) => Promise<DirectoryPrincipalUser | null>;
  createUser: (user: DirectoryPrincipalUserData) => Promise<string>;
}

type DirectoryPrincipal = Pick<TPrincipal, 'type' | 'idOnTheSource'>;

export interface DirectoryAuthContext {
  accessToken: string;
  sub: string;
}

type DirectoryRecord = Pick<
  TGraphPerson,
  'id' | 'displayName' | 'mail' | 'userPrincipalName' | 'personType' | 'scoredEmailAddresses'
> &
  Pick<TGraphGroup, 'description'>;

export interface DirectoryGraphClient {
  api: (path: string) => {
    select: (fields: string) => { get: () => Promise<DirectoryRecord | null> };
  };
}

type CreateDirectoryClient = (accessToken: string, sub: string) => Promise<DirectoryGraphClient>;

/** A successful lookup with no accessible identity returns null. Provider outages propagate. */
async function lookupDirectoryRecord(
  client: DirectoryGraphClient,
  path: string,
  fields: string,
): Promise<DirectoryRecord | null> {
  try {
    return await client.api(path).select(fields).get();
  } catch (error) {
    if (
      error instanceof Error &&
      'statusCode' in error &&
      (error.statusCode === 403 || error.statusCode === 404)
    ) {
      return null;
    }
    throw error;
  }
}

/** Resolves identity metadata only through the caller's enabled, authenticated integration. */
export async function resolveDirectoryPrincipal(
  principal: DirectoryPrincipal,
  authContext: DirectoryAuthContext | null,
  createClient: CreateDirectoryClient,
): Promise<TPrincipal | null> {
  if (
    !authContext?.accessToken ||
    !authContext.sub ||
    typeof principal.idOnTheSource !== 'string' ||
    !principal.idOnTheSource ||
    (principal.type !== PrincipalType.USER && principal.type !== PrincipalType.GROUP)
  ) {
    return null;
  }

  const client = await createClient(authContext.accessToken, authContext.sub);
  const id = encodeURIComponent(principal.idOnTheSource);
  const isGroup = principal.type === PrincipalType.GROUP;
  let record = await lookupDirectoryRecord(
    client,
    `/${isGroup ? 'groups' : 'users'}/${id}`,
    isGroup ? 'id,displayName,mail,description' : 'id,displayName,mail,userPrincipalName',
  );
  let contactEmail: string | undefined;
  if (!record && !isGroup) {
    record = await lookupDirectoryRecord(
      client,
      `/me/people/${id}`,
      'id,displayName,userPrincipalName,scoredEmailAddresses,personType',
    );
    if (record?.personType?.subclass !== 'OrganizationUser') {
      return null;
    }
    contactEmail = record.scoredEmailAddresses?.[0]?.address;
  }
  if (!record || record.id !== principal.idOnTheSource || !record.displayName) {
    return null;
  }
  const email = record.mail || contactEmail || record.userPrincipalName;
  if (!isGroup && !email) {
    return null;
  }
  return {
    type: principal.type,
    source: 'entra',
    idOnTheSource: record.id,
    name: record.displayName,
    email: email?.toLowerCase(),
    ...(isGroup && { description: record.description }),
  };
}

export const ensureDirectoryPrincipalUser = async (
  principal: DirectoryPrincipal,
  methods: DirectoryPrincipalUserMethods,
): Promise<string> => {
  const resolved = await methods.resolvePrincipal(principal);
  if (resolved?.type !== PrincipalType.USER || !resolved.email || !resolved.idOnTheSource) {
    throw new Error('Directory user principal is unavailable');
  }

  const userBySourceId = await methods.findUserBySourceId(resolved.idOnTheSource);
  if (userBySourceId) {
    return userBySourceId.id;
  }

  const userByEmail = await methods.findUserByEmail(resolved.email.toLowerCase());
  if (userByEmail) {
    return userByEmail.id;
  }

  return methods.createUser({
    name: resolved.name,
    email: resolved.email.toLowerCase(),
    emailVerified: false,
    provider: 'openid',
    idOnTheSource: resolved.idOnTheSource,
  });
};

export class DirectoryVerificationError extends Error {
  readonly statusCode: number = 502;

  constructor() {
    super('Directory identity verification failed');
  }
}

type PermissionPrincipal = Omit<TPrincipal, 'id'> & { id?: string | null };
type ResolveDirectoryPrincipal = (principal: DirectoryPrincipal) => Promise<TPrincipal | null>;
type EnsurePrincipal = (
  principal: PermissionPrincipal,
  authContext: DirectoryAuthContext | null,
  resolvePrincipal: ResolveDirectoryPrincipal,
) => Promise<string | null>;

interface PermissionPrincipalMethods {
  createClient: CreateDirectoryClient;
  ensureUser: EnsurePrincipal;
  ensureGroup: EnsurePrincipal;
  logger: { error: (message: string, metadata: ReturnType<typeof getSafeErrorMetadata>) => void };
}

/** Verify every external identity before provisioning or ACL writes. Never hide provider outages. */
export async function preparePermissionPrincipals(
  principals: readonly PermissionPrincipal[],
  authContext: DirectoryAuthContext | null,
  methods: PermissionPrincipalMethods,
  appConfig?: Pick<AppConfig, 'concurrency'>,
): Promise<PermissionPrincipal[]> {
  const concurrency = getLookupConcurrency(appConfig, 'permissionPrincipalLookups');
  let client: Promise<DirectoryGraphClient> | undefined;
  const identities = new Map<string, Promise<TPrincipal | null>>();
  const resolvePrincipal: ResolveDirectoryPrincipal = (principal) => {
    const key = JSON.stringify([principal.type, principal.idOnTheSource]);
    let result = identities.get(key);
    if (!result) {
      result = resolveDirectoryPrincipal(principal, authContext, (token, sub) => {
        client ??= methods.createClient(token, sub);
        return client;
      }).catch((error) => {
        methods.logger.error('Directory identity verification failed', getSafeErrorMetadata(error));
        throw new DirectoryVerificationError();
      });
      identities.set(key, result);
    }
    return result;
  };

  await mapWithConcurrency(principals, concurrency, async (principal) => {
    if (
      !principal.id &&
      principal.source === 'entra' &&
      (principal.type === PrincipalType.USER || principal.type === PrincipalType.GROUP)
    ) {
      await resolvePrincipal(principal);
    }
  });

  const pending = new Map<string, Promise<string | null>>();
  const validated = await mapWithConcurrency(principals, concurrency, async (principal) => {
    try {
      if (principal.type === PrincipalType.PUBLIC) {
        return { ...principal, id: null };
      }
      if (principal.type === PrincipalType.ROLE) {
        return principal;
      }
      const ensure = {
        [PrincipalType.USER]: methods.ensureUser,
        [PrincipalType.GROUP]: methods.ensureGroup,
      }[principal.type];
      if (!ensure) {
        return null;
      }
      const key = JSON.stringify([
        principal.type,
        principal.id,
        principal.source,
        principal.idOnTheSource,
      ]);
      let result = pending.get(key);
      if (!result) {
        result = ensure(principal, authContext, resolvePrincipal);
        pending.set(key, result);
      }
      return { ...principal, id: await result };
    } catch (error) {
      if (error instanceof DirectoryVerificationError) {
        throw error;
      }
      methods.logger.error('Error ensuring principal exists', getSafeErrorMetadata(error));
      return null;
    }
  });
  return validated.filter((principal): principal is PermissionPrincipal => principal !== null);
}
