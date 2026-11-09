import { PrincipalType } from 'librechat-data-provider';
import type { TPrincipal, TGraphPerson, TGraphGroup } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import { getLookupConcurrency } from '~/utils/concurrency';
import { getSafeErrorMetadata } from '~/utils/errors';
import { mapWithConcurrency } from '~/utils/promise';

export class InvalidPrincipalError extends Error {}

/** Local principal IDs must be scalar ObjectId strings, never query operators. */
export function validateLocalPrincipalId(id: unknown): string {
  if (typeof id !== 'string' || !/^[a-f\d]{24}$/i.test(id)) {
    throw new InvalidPrincipalError('Invalid local principal ID');
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
    throw new InvalidPrincipalError('Directory user principal is unavailable');
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

export class PrincipalPreparationError extends Error {
  readonly statusCode: number = 500;

  constructor() {
    super('Principal preparation failed');
  }
}

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
      if (error instanceof InvalidPrincipalError) {
        return null;
      }
      if (error instanceof DirectoryVerificationError) {
        throw error;
      }
      methods.logger.error('Error ensuring principal exists', getSafeErrorMetadata(error));
      throw new PrincipalPreparationError();
    }
  });
  return validated.filter((principal): principal is PermissionPrincipal => principal !== null);
}

interface DirectoryMember {
  id: string;
  '@odata.type'?: string;
}

interface DirectoryMembershipPage {
  value: DirectoryMember[];
  '@odata.nextLink'?: string;
}

interface DirectoryMembershipClient {
  api: (path: string) => {
    select: (fields: string) => {
      top: (limit: number) => { get: () => Promise<DirectoryMembershipPage> };
    };
  };
}

interface DirectoryGroupMethods {
  createClient: (token: string, sub: string) => Promise<DirectoryMembershipClient>;
  includeOwners: boolean;
  logger: PermissionPrincipalMethods['logger'];
}

/** A failed page must never become an empty or partial membership snapshot. */
async function readDirectoryMembers(
  client: DirectoryMembershipClient,
  sourceId: string,
  relation: 'transitiveMembers' | 'owners',
): Promise<string[]> {
  const ids = new Set<string>();
  let nextLink: string | undefined = `/groups/${encodeURIComponent(sourceId)}/${relation}`;
  while (nextLink) {
    const page: DirectoryMembershipPage = await client.api(nextLink).select('id').top(999).get();
    if (!Array.isArray(page?.value)) {
      throw new Error('Invalid directory membership response');
    }
    for (const member of page.value) {
      if (
        typeof member.id === 'string' &&
        (relation === 'owners' || member['@odata.type'] === '#microsoft.graph.user')
      ) {
        ids.add(member.id);
      }
    }
    nextLink = page['@odata.nextLink'];
    if (nextLink) {
      const url: URL = new URL(nextLink, 'https://graph.microsoft.com/v1.0/');
      if (url.origin !== 'https://graph.microsoft.com') {
        throw new Error('Invalid directory membership continuation');
      }
      nextLink = url.pathname.replace(/^\/v1\.0/, '') + url.search;
    }
  }
  return [...ids];
}

/** Strict membership lookup for permission writes, unlike best-effort search/sync adapters. */
export async function getDirectoryGroupMembers(
  group: Pick<TPrincipal, 'idOnTheSource'>,
  authContext: DirectoryAuthContext | null,
  methods: DirectoryGroupMethods,
): Promise<string[]> {
  if (!group.idOnTheSource || !authContext?.accessToken || !authContext.sub) {
    throw new InvalidPrincipalError('Directory group principal is unavailable');
  }
  try {
    const client = await methods.createClient(authContext.accessToken, authContext.sub);
    const [members, owners] = await Promise.all([
      readDirectoryMembers(client, group.idOnTheSource, 'transitiveMembers'),
      methods.includeOwners ? readDirectoryMembers(client, group.idOnTheSource, 'owners') : [],
    ]);
    return owners.length > 0 ? [...new Set([...members, ...owners])] : members;
  } catch (error) {
    methods.logger.error('Directory group membership refresh failed', getSafeErrorMetadata(error));
    throw new DirectoryVerificationError();
  }
}

/** Refresh persisted membership from its stored identity, never the submitted directory fields. */
export async function refreshDirectoryGroupMembers(
  group: Pick<TPrincipal, 'source' | 'idOnTheSource'>,
  authContext: DirectoryAuthContext | null,
  methods: DirectoryGroupMethods & { updateMembers: (members: string[]) => Promise<unknown> },
): Promise<void> {
  if (
    group.source !== 'entra' ||
    !group.idOnTheSource ||
    !authContext?.accessToken ||
    !authContext.sub
  ) {
    return;
  }
  const memberIds = await getDirectoryGroupMembers(group, authContext, methods);
  await methods.updateMembers(memberIds);
}
