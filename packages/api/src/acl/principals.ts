import { setMaxListeners } from 'node:events';
import { PrincipalType } from 'librechat-data-provider';
import type {
  AppConfig,
  PermissionPrincipalStorage,
  PermissionPrincipalChange,
  PermissionPrincipalData,
} from '@librechat/data-schemas';
import type { TPrincipal, TGraphPerson, TGraphGroup } from 'librechat-data-provider';
import { PRINCIPAL_PREPARATION_FAILED, DIRECTORY_VERIFICATION_UNAVAILABLE } from './codes';
import { mapWithConcurrency, createConcurrencyLimiter } from '~/utils/promise';
import { getLookupConcurrency } from '~/utils/concurrency';
import { getOutboundTimeoutMs } from '~/utils/timeouts';
import { getSafeErrorMetadata } from '~/utils/errors';
import { runDirectoryOperation } from './directory';

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

/** Only a confirmed not-found is absence. Authorization and provider failures propagate. */
async function lookupDirectoryRecord(
  client: DirectoryGraphClient,
  path: string,
  fields: string,
): Promise<DirectoryRecord | null> {
  try {
    return await client.api(path).select(fields).get();
  } catch (error) {
    if (getSafeErrorMetadata(error).status === 404) {
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
  let record: DirectoryRecord | null;
  let denied: unknown;
  try {
    record = await lookupDirectoryRecord(
      client,
      `/${isGroup ? 'groups' : 'users'}/${id}`,
      isGroup ? 'id,displayName,mail,description' : 'id,displayName,mail,userPrincipalName',
    );
  } catch (error) {
    if (isGroup || getSafeErrorMetadata(error).status !== 403) throw error;
    // People.Read can resolve an organizational identity without User.Read.All.
    denied = error;
    record = null;
  }
  let contactEmail: string | undefined;
  if (!record && !isGroup) {
    record = await lookupDirectoryRecord(
      client,
      `/me/people/${id}`,
      'id,displayName,userPrincipalName,scoredEmailAddresses,personType',
    );
    if (record?.personType?.subclass !== 'OrganizationUser') {
      if (denied) throw denied;
      return null;
    }
    contactEmail = record.scoredEmailAddresses?.[0]?.address;
  }
  if (!record || record.id !== principal.idOnTheSource || !record.displayName) {
    if (denied) throw denied;
    return null;
  }
  const email = record.mail || contactEmail || record.userPrincipalName;
  if (!isGroup && !email) {
    if (denied) throw denied;
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
  readonly code: string = PRINCIPAL_PREPARATION_FAILED;
  readonly statusCode: number = 500;

  constructor() {
    super('Principal preparation failed');
  }
}

export class DirectoryVerificationError extends Error {
  readonly code: string = DIRECTORY_VERIFICATION_UNAVAILABLE;
  readonly statusCode: number = 502;

  constructor() {
    super('Directory identity verification failed');
  }
}

export type PermissionPrincipal = Omit<TPrincipal, 'id'> & { id?: string | null };

interface PermissionGraphClient {
  api: (path: string) => {
    options: (options: { signal: AbortSignal }) => ReturnType<PermissionGraphClient['api']>;
    middlewareOptions: (options: object[]) => ReturnType<PermissionGraphClient['api']>;
    select: (fields: string) => {
      get: () => Promise<DirectoryRecord | null>;
      top: (count: number) => { get: () => Promise<DirectoryMembershipPage> };
    };
  };
}

interface PermissionPrincipalMethods extends PermissionPrincipalStorage {
  createClient: (
    token: string,
    sub: string,
    signal?: AbortSignal,
  ) => Promise<PermissionGraphClient>;
  /** SDK retries sleep without observing abort; strict verification does not retry. */
  retryOptions: object[];
  includeOwners: boolean;
  logger: { error: (message: string, metadata: ReturnType<typeof getSafeErrorMetadata>) => void };
}

interface PrincipalPlan {
  id?: string | null;
  change?: PermissionPrincipalChange;
}

/** All reads finish before persistence. A shared limiter bounds individual Graph requests. */
export async function preparePermissionPrincipals(
  principals: readonly PermissionPrincipal[],
  authContext: DirectoryAuthContext | null,
  methods: PermissionPrincipalMethods,
  appConfig?: Pick<AppConfig, 'concurrency' | 'timeouts'>,
): Promise<PermissionPrincipal[]> {
  const concurrency = getLookupConcurrency(appConfig, 'permissionPrincipalLookups');
  const limit = createConcurrencyLimiter(concurrency);
  const controller = new AbortController();
  // Active Graph calls, their fetch transports, and the preparation boundary share this signal.
  setMaxListeners(concurrency * 3 + 4, controller.signal);
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let client: Promise<DirectoryGraphClient & DirectoryMembershipClient> | undefined;
  const createClient = (token: string, sub: string) => {
    const signal = controller.signal;
    signal.throwIfAborted();
    deadline ??= setTimeout(
      () => controller.abort(new DirectoryVerificationError()),
      getOutboundTimeoutMs(appConfig, 'directoryMs'),
    );
    client ??= runDirectoryOperation(signal, () => methods.createClient(token, sub, signal)).then(
      (graph) => ({
        api: (path: string) => ({
          select: (fields: string) => ({
            get: () =>
              limit(() =>
                runDirectoryOperation(signal, () =>
                  graph
                    .api(path)
                    .options({ signal })
                    .middlewareOptions(methods.retryOptions)
                    .select(fields)
                    .get(),
                ),
              ),
            top: (count: number) => ({
              get: () =>
                limit(() =>
                  runDirectoryOperation(signal, () =>
                    graph
                      .api(path)
                      .options({ signal })
                      .middlewareOptions(methods.retryOptions)
                      .select(fields)
                      .top(count)
                      .get(),
                  ),
                ),
            }),
          }),
        }),
      }),
    );
    return client;
  };
  const directoryMethods = { ...methods, createClient };
  const plans = new Map<string, Promise<PrincipalPlan | null>>();
  const read = async (principal: PermissionPrincipal): Promise<PrincipalPlan> => {
    if (principal.type === PrincipalType.PUBLIC) return { id: null };
    if (principal.type === PrincipalType.ROLE) return { id: principal.id };
    if (principal.type !== PrincipalType.USER && principal.type !== PrincipalType.GROUP) {
      throw new InvalidPrincipalError('Unsupported principal type');
    }
    const user = principal.type === PrincipalType.USER;
    if (principal.id) {
      const id = validateLocalPrincipalId(principal.id);
      const stored = await (user
        ? methods.findPermissionUser({ id })
        : methods.findPermissionGroup({ id }));
      if (!stored)
        throw new InvalidPrincipalError(
          user ? 'User principal not found' : 'Group principal not found',
        );
      if (
        !user &&
        stored.source === 'entra' &&
        authContext?.accessToken &&
        authContext.sub &&
        stored.idOnTheSource
      ) {
        const memberIds = await getDirectoryGroupMembers(stored, authContext, directoryMethods);
        return { id: stored.id, change: { kind: 'group', id: stored.id, data: { memberIds } } };
      }
      return { id: stored.id };
    }
    if (principal.source !== 'entra') throw new InvalidPrincipalError('Principal is unavailable');
    let resolved: TPrincipal | null;
    try {
      resolved = await resolveDirectoryPrincipal(principal, authContext, createClient);
    } catch (error) {
      methods.logger.error('Directory identity verification failed', getSafeErrorMetadata(error));
      throw new DirectoryVerificationError();
    }
    if (!resolved?.idOnTheSource || !resolved.name || (user && !resolved.email)) {
      throw new InvalidPrincipalError('Directory principal is unavailable');
    }
    if (user) {
      const stored =
        (await methods.findPermissionUser({ idOnTheSource: resolved.idOnTheSource })) ??
        (await methods.findPermissionUser({ email: resolved.email }));
      return stored
        ? { id: stored.id }
        : {
            change: {
              kind: 'user',
              data: {
                name: resolved.name,
                email: resolved.email,
                idOnTheSource: resolved.idOnTheSource,
                provider: 'openid',
                emailVerified: false,
              },
            },
          };
    }
    const memberIds = await getDirectoryGroupMembers(resolved, authContext, directoryMethods);
    const stored =
      (await methods.findPermissionGroup({
        idOnTheSource: resolved.idOnTheSource,
        source: 'entra',
      })) ?? (resolved.email ? await methods.findPermissionGroup({ email: resolved.email }) : null);
    const data: PermissionPrincipalData = {
      memberIds,
      ...(!stored && {
        name: resolved.name,
        source: 'entra' as const,
        idOnTheSource: resolved.idOnTheSource,
      }),
      ...(stored &&
        !stored.idOnTheSource && {
          source: 'entra' as const,
          idOnTheSource: resolved.idOnTheSource,
        }),
      ...(resolved.email && { email: resolved.email }),
      ...(resolved.description && { description: resolved.description }),
    };
    return { id: stored?.id, change: { kind: 'group', id: stored?.id, data } };
  };
  try {
    const staged = await runDirectoryOperation(controller.signal, () =>
      mapWithConcurrency(principals, concurrency, async (principal) => {
        const key = JSON.stringify([
          principal.type,
          principal.id || null,
          principal.id ? null : principal.source,
          principal.id ? null : principal.idOnTheSource,
        ]);
        let plan = plans.get(key);
        if (!plan) {
          plan = read(principal).catch((error) => {
            if (error instanceof InvalidPrincipalError) return null;
            throw error;
          });
          plans.set(key, plan);
        }
        return { principal, plan: await plan };
      }),
    );
    controller.signal.throwIfAborted();
    clearTimeout(deadline);
    const changes: PermissionPrincipalChange[] = [];
    const indices = new Map<PrincipalPlan, number>();
    const identities = new Map<string, number>();
    for (const { plan } of staged) {
      if (!plan?.change || indices.has(plan)) continue;
      const change = plan.change;
      const key = JSON.stringify([
        change.kind,
        change.id ?? change.data.email ?? change.data.idOnTheSource,
      ]);
      let index = identities.get(key);
      if (index === undefined) {
        index = changes.length;
        changes.push(change);
        identities.set(key, index);
      }
      indices.set(plan, index);
    }
    const ids = await methods.persistPermissionPrincipals(changes);
    return staged.flatMap(({ principal, plan }) =>
      plan ? [{ ...principal, id: plan.change ? ids[indices.get(plan)!] : plan.id }] : [],
    );
  } catch (error) {
    controller.abort(new DirectoryVerificationError());
    if (error instanceof DirectoryVerificationError) throw error;
    methods.logger.error('Error preparing permission principals', getSafeErrorMetadata(error));
    throw new PrincipalPreparationError();
  } finally {
    clearTimeout(deadline);
  }
}

/** Legacy exports delegate to the same batch boundary, never a separate policy implementation. */
export function createPrincipalService(methods: PermissionPrincipalMethods): {
  prepare: (
    principals: readonly PermissionPrincipal[],
    auth: DirectoryAuthContext | null,
    config?: Pick<AppConfig, 'concurrency' | 'timeouts'>,
  ) => Promise<PermissionPrincipal[]>;
  ensureUser: (
    principal: PermissionPrincipal,
    auth?: DirectoryAuthContext | null,
  ) => Promise<string | null>;
  ensureGroup: (
    principal: PermissionPrincipal,
    auth?: DirectoryAuthContext | null,
  ) => Promise<string | null>;
} {
  const prepare = (
    principals: readonly PermissionPrincipal[],
    auth: DirectoryAuthContext | null,
    config?: Pick<AppConfig, 'concurrency' | 'timeouts'>,
  ) => preparePermissionPrincipals(principals, auth, methods, config);
  const ensure = async (
    principal: PermissionPrincipal,
    auth: DirectoryAuthContext | null = null,
  ) => {
    const [prepared] = await prepare([principal], auth);
    if (!prepared)
      throw new InvalidPrincipalError(
        principal.type === PrincipalType.GROUP
          ? 'Group principal not found'
          : 'User principal not found',
      );
    return prepared.id ?? null;
  };
  return { prepare, ensureUser: ensure, ensureGroup: ensure };
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
