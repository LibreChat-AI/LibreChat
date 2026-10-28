import type {
  AuthIdentityContext,
  LeaseAssertion,
  LeaseContext,
  OpenIDClaims,
  OpenIDLogger,
  OpenIDPublicationGeneration,
  OpenIDRefreshResolution,
  OpenIDRequest,
  OpenIDResponse,
  OpenIDTokenSet,
  OpenIDUser,
  RefreshFlightAcquireResult,
  RefreshFlightRecord,
  RefreshTokenBridgeDeleteInput,
  RefreshTokenBridgeIdentity,
  RefreshTokenBridgeInput,
  SharedOpenIDRefreshResult,
  TokenPreference,
} from './types';
import type { TokenResult } from './flight';
import {
  createOpenIDRefreshOwnershipError,
  isOpenIDRefreshOwnershipError,
  reloadOpenIDSessionIfPersisted,
  toOpenIDLogArgument,
} from './errors';

type FindUser = (...args: Array<string | object | undefined>) => Promise<OpenIDUser | null>;

interface FindOpenIDUserArgs {
  findUser: FindUser;
  email: string;
  openidId: string;
  openidIssuer?: string;
  idOnTheSource?: string;
  strategyName: string;
}

interface RefreshOpenIDUserArgs {
  req: OpenIDRequest;
  res?: OpenIDResponse;
  user: OpenIDUser;
  refreshToken: string;
  browserRefreshToken?: string;
  strategyName: string;
  assertLeaseOwned?: LeaseAssertion;
  deferPublication?: boolean;
}

interface BridgeUser extends OpenIDUser {
  _id: string | number | { toString(): string };
}

interface ResolveOpenIDRefreshInput {
  tokenset: OpenIDTokenSet | null;
  strategyName: string;
}

type SeedRefreshSessionInput = Omit<
  RefreshOpenIDUserArgs,
  'strategyName' | 'assertLeaseOwned' | 'deferPublication'
>;

interface RecoverOpenIDRefreshBridgeInput {
  req: OpenIDRequest;
  res: OpenIDResponse;
  refreshToken: string;
  bridgedRefreshToken: string;
  bridgeUser: BridgeUser;
}

interface RevokeOpenIDRefreshTokenChainInput {
  req: OpenIDRequest;
  user: OpenIDUser;
  identityContext: AuthIdentityContext;
  refreshTokens: string[];
  publicationKeys?: string[];
  ttl: number;
}

interface SendOpenIDAuthResponseInput {
  tokenset: OpenIDTokenSet;
  user: BridgeUser;
  existingRefreshToken?: string;
  openidSubject?: string;
  openidIssuer?: string;
  predecessorIdentity?: RefreshTokenBridgeIdentity;
  predecessorAccessToken?: string;
  rejectedRefreshTokens?: string[];
  req: OpenIDRequest;
  res: OpenIDResponse;
  assertLeaseOwned?: LeaseAssertion;
  publicationGeneration?: OpenIDPublicationGeneration;
  commitPublication?: (
    appAuthToken: string,
    publishedTokenset: OpenIDTokenSet,
    metadata: {
      predecessorAccessToken?: string;
      acceptedIdentity: AuthIdentityContext;
    },
  ) => Promise<void>;
  preparePublication?: boolean;
  /**
   * A fresh authorization-code login supersedes whatever token set the Express session still
   * holds from an earlier authentication. The advanced-session comparison exists for refresh
   * races and must not republish that stale set in place of the tokens the IdP just issued.
   */
  discardSessionTokens?: boolean;
}

export interface OpenIDRefreshRecoveryService {
  recoverOpenIDRefreshBridge: (
    input: RecoverOpenIDRefreshBridgeInput,
  ) => Promise<SharedOpenIDRefreshResult>;
  refreshOpenIDUser: (input: RefreshOpenIDUserArgs) => Promise<OpenIDRefreshResolution>;
  resolveOpenIDRefreshResult: (
    input: ResolveOpenIDRefreshInput,
  ) => Promise<OpenIDRefreshResolution>;
  sendOpenIDAuthResponse: (input: SendOpenIDAuthResponseInput) => Promise<string | undefined>;
  revokeOpenIDRefreshTokenChain: (input: RevokeOpenIDRefreshTokenChainInput) => Promise<string[]>;
  __internals: {
    getTokenClaims: (tokenset: OpenIDTokenSet) => OpenIDClaims;
    seedRefreshSession: (input: SeedRefreshSessionInput) => AuthIdentityContext;
  };
}

export interface OpenIDRefreshRecoveryDeps {
  jwt: { decode: (token: string) => OpenIDClaims | string | null };
  logger: Pick<OpenIDLogger, 'debug' | 'warn'>;
  findOpenIDUser: (args: FindOpenIDUserArgs) => Promise<{
    user?: OpenIDUser | null;
    error?: string | null;
    migration?: boolean;
  }>;
  findUser: FindUser;
  getOpenIdConfig: () => object;
  getOpenIdEmail: (claims: OpenIDClaims) => string;
  getOpenIdIssuer: (claims: OpenIDClaims, config: object) => string | undefined;
  createAuthIdentityContext: (args: {
    user?: OpenIDUser;
    requestUser?: OpenIDUser;
  }) => AuthIdentityContext;
  refreshOpenIDSession: (
    req: OpenIDRequest,
    res: OpenIDResponse | undefined,
    user: OpenIDUser,
    preference: TokenPreference,
    identity: AuthIdentityContext,
    options: {
      forceRefresh: boolean;
      assertLeaseOwned?: LeaseAssertion;
      deferPublication?: boolean;
    },
  ) => Promise<OpenIDTokenSet | null>;
  storeOpenIDSession: (
    userId: string,
    refreshToken: string,
    tenantId?: string,
    previousRefreshToken?: string,
  ) => Promise<void>;
  setOpenIDAuthTokens: (
    tokens: OpenIDTokenSet,
    req: OpenIDRequest,
    res: OpenIDResponse,
    identity: {
      userId: string;
      existingRefreshToken?: string;
      tenantId?: string;
      openidSubject?: string;
      openidIssuer?: string;
    },
  ) => string | undefined;
  getOpenIDAppAuthToken: (tokens: OpenIDTokenSet, sessionIdToken?: string) => string | undefined;
  clearOpenIDAuthTokens: (
    req: OpenIDRequest,
    res: OpenIDResponse,
    userId: string,
    tenantId?: string,
  ) => void;
  deleteOpenIDSession: (refreshToken: string) => Promise<object | null>;
  createRefreshTokenBridgeFlightKey: (args: {
    oldRefreshToken: string;
    userId: string;
    tenantId?: string;
    openidIssuer?: string;
  }) => string | null;
  createOpenIDRefreshFlightKey: (args: {
    req: OpenIDRequest;
    user: OpenIDUser;
    refreshToken: string;
    identityContext: AuthIdentityContext;
  }) => string | null;
  storeRefreshTokenBridge: (args: RefreshTokenBridgeInput) => Promise<string | null>;
  deleteRefreshTokenBridges: (args: RefreshTokenBridgeDeleteInput) => Promise<object | null>;
  acquireOpenIDRefreshFlight: (args: { key: string }) => Promise<RefreshFlightAcquireResult>;
  completeOpenIDRefreshFlight: (args: {
    key: string;
    ownerId: string;
    tokens: SharedOpenIDRefreshResult;
    onWriteStart?: () => void;
  }) => Promise<RefreshFlightRecord | null>;
  failOpenIDRefreshFlight: (args: {
    key: string;
    ownerId: string;
    error: Error;
  }) => Promise<RefreshFlightRecord | null>;
  waitForOpenIDRefreshFlight: (args: { key: string }) => Promise<SharedOpenIDRefreshResult | null>;
  assertOpenIDRefreshFlightAvailable: (args: {
    key: string;
    ownerId: string;
  }) => Promise<RefreshFlightRecord | boolean>;
  assertOpenIDRefreshSessionGenerationAvailable: (args: {
    key?: string | null;
    ownerId?: string;
  }) => Promise<RefreshFlightRecord | boolean>;
  revokeOpenIDRefreshFlights: (args: {
    keys: Array<string | null>;
    ttl: number;
  }) => Promise<Array<TokenResult | null>>;
  withOpenIDRefreshFlightLease: <T>(args: {
    key: string;
    ownerId: string;
    operation: (context: LeaseContext) => Promise<T>;
  }) => Promise<T>;
  bridgeGraceMs: number;
}

export function createOpenIDRefreshRecoveryService(
  deps: OpenIDRefreshRecoveryDeps,
): OpenIDRefreshRecoveryService {
  const {
    jwt,
    logger,
    findOpenIDUser,
    findUser,
    getOpenIdConfig,
    getOpenIdEmail,
    getOpenIdIssuer,
    createAuthIdentityContext,
    refreshOpenIDSession,
    storeOpenIDSession,
    setOpenIDAuthTokens,
    getOpenIDAppAuthToken,
    clearOpenIDAuthTokens,
    deleteOpenIDSession,
    createRefreshTokenBridgeFlightKey,
    createOpenIDRefreshFlightKey,
    storeRefreshTokenBridge,
    deleteRefreshTokenBridges,
    acquireOpenIDRefreshFlight,
    completeOpenIDRefreshFlight,
    failOpenIDRefreshFlight,
    waitForOpenIDRefreshFlight,
    assertOpenIDRefreshFlightAvailable,
    assertOpenIDRefreshSessionGenerationAvailable,
    revokeOpenIDRefreshFlights,
    withOpenIDRefreshFlightLease,
    bridgeGraceMs,
  } = deps;

  const MAX_LOGOUT_REFRESH_CHAIN_DEPTH = 16;
  const MAX_LOGOUT_REFRESH_TARGETS = 128;

  async function revokeOpenIDRefreshTokenChain({
    req,
    user,
    identityContext,
    refreshTokens,
    publicationKeys = [],
    ttl,
  }: RevokeOpenIDRefreshTokenChainInput): Promise<string[]> {
    const userId = identityContext.appUserId;
    if (!userId) {
      throw new Error('OpenID logout identity is unavailable');
    }
    const identityKey = (identity: AuthIdentityContext): string =>
      [
        identity.appUserId ?? '',
        identity.tenantId ?? '',
        identity.openidIssuer ?? '',
        identity.openidSubject ?? '',
      ].join('\x1f');
    const discovered = new Set(refreshTokens.filter(Boolean));
    const scheduled = new Set<string>();
    let frontier = [...discovered].map((refreshToken) => ({
      refreshToken,
      identity: identityContext,
    }));
    for (const target of frontier) {
      scheduled.add(`${target.refreshToken}\x1e${identityKey(target.identity)}`);
    }
    let directPublicationKeys = [...new Set(publicationKeys.filter(Boolean))];

    for (let depth = 0; frontier.length > 0 || directPublicationKeys.length > 0; depth++) {
      if (depth >= MAX_LOGOUT_REFRESH_CHAIN_DEPTH) {
        throw new Error('OpenID logout refresh chain exceeded the safety limit');
      }
      const keys = [
        ...directPublicationKeys,
        ...frontier.flatMap(({ refreshToken, identity }) => [
          createOpenIDRefreshFlightKey({ req, user, refreshToken, identityContext: identity }),
          createRefreshTokenBridgeFlightKey({
            oldRefreshToken: refreshToken,
            userId: identity.appUserId ?? userId,
            tenantId: identity.tenantId,
            openidIssuer: identity.openidIssuer,
          }),
        ]),
      ];
      directPublicationKeys = [];
      const revoked = await revokeOpenIDRefreshFlights({ keys, ttl });
      const inheritedIdentities = frontier.map(({ identity }) => identity);
      const acceptedIdentities = revoked.flatMap((result) => {
        if (result?.acceptedIdentity) return [result.acceptedIdentity];
        const claims = result?.__identityClaims;
        if (!claims?.sub) return [];
        return [
          {
            ...identityContext,
            openidSubject: claims.sub,
            openidIssuer: result?.openidIssuer ?? claims.iss ?? identityContext.openidIssuer,
          },
        ];
      });
      const identities = [...inheritedIdentities, ...acceptedIdentities].filter(
        (identity, index, all) =>
          all.findIndex((candidate) => identityKey(candidate) === identityKey(identity)) === index,
      );
      const successors = revoked.flatMap((result) =>
        [result?.refresh_token, result?.tokenset?.refresh_token].filter((token): token is string =>
          Boolean(token),
        ),
      );
      frontier = successors.flatMap((refreshToken) => {
        discovered.add(refreshToken);
        return identities.flatMap((identity) => {
          const targetKey = `${refreshToken}\x1e${identityKey(identity)}`;
          if (scheduled.has(targetKey)) return [];
          if (scheduled.size >= MAX_LOGOUT_REFRESH_TARGETS) {
            throw new Error('OpenID logout refresh chain exceeded the target safety limit');
          }
          scheduled.add(targetKey);
          return [{ refreshToken, identity }];
        });
      });
    }

    return [...discovered];
  }

  function getTokenClaims(tokenset: OpenIDTokenSet): OpenIDClaims {
    if (typeof tokenset?.claims === 'function') {
      return tokenset.claims();
    }
    if (tokenset.__identityClaims?.sub) {
      return tokenset.__identityClaims;
    }
    const identityToken = tokenset.id_token ?? tokenset.__identityIdToken;
    const decoded = identityToken ? jwt.decode(identityToken) : null;
    if (!decoded || typeof decoded !== 'object') {
      throw new Error('OpenID refresh returned no usable identity claims');
    }
    return decoded as OpenIDClaims;
  }

  async function resolveOpenIDRefreshResult({
    tokenset,
    strategyName,
  }: ResolveOpenIDRefreshInput): Promise<OpenIDRefreshResolution> {
    if (!tokenset?.access_token) {
      throw new Error('OpenID refresh returned no access token');
    }
    const claims = getTokenClaims(tokenset);
    const openIdConfig = getOpenIdConfig();
    const openidIssuer = getOpenIdIssuer(claims, openIdConfig);
    const { user, error, migration } = await findOpenIDUser({
      findUser,
      email: getOpenIdEmail(claims),
      openidId: claims.sub,
      openidIssuer,
      idOnTheSource: claims.oid,
      strategyName,
    });

    logger.debug(
      `[refreshController] findOpenIDUser result: user=${user?.email ?? 'null'}, error=${error ?? 'null'}, migration=${migration}, userOpenidId=${user?.openidId ?? 'null'}, claimsSub=${claims.sub}`,
    );
    return { tokenset, claims, openidIssuer, user, error, migration };
  }

  function seedRefreshSession({
    req,
    user,
    refreshToken,
    browserRefreshToken,
  }: SeedRefreshSessionInput): AuthIdentityContext {
    if (!req.session) {
      throw new Error('OpenID refresh requires an Express session');
    }
    const identity = createAuthIdentityContext({ user, requestUser: req.user });
    req.session.openidTokens = {
      ...(req.session.openidTokens ?? {}),
      refreshToken,
      browserRefreshToken: browserRefreshToken || refreshToken,
      appUserId: identity.appUserId,
      openidSubject: identity.openidSubject,
      ...(identity.tenantId ? { tenantId: identity.tenantId } : {}),
      ...(identity.openidIssuer ? { openidIssuer: identity.openidIssuer } : {}),
    };
    return identity;
  }

  async function refreshOpenIDUser({
    req,
    res,
    user,
    refreshToken,
    browserRefreshToken,
    strategyName,
    assertLeaseOwned,
    deferPublication = false,
  }: RefreshOpenIDUserArgs): Promise<OpenIDRefreshResolution> {
    const previousSessionTokens = deferPublication ? req.session?.openidTokens : undefined;
    const hadSessionTokens = Boolean(req.session && 'openidTokens' in req.session);
    const identityContext = seedRefreshSession({
      req,
      user,
      refreshToken,
      browserRefreshToken,
    });
    let tokenset: OpenIDTokenSet | null;
    try {
      tokenset = await refreshOpenIDSession(req, res, user, 'id_token', identityContext, {
        forceRefresh: true,
        ...(assertLeaseOwned ? { assertLeaseOwned } : {}),
        ...(deferPublication ? { deferPublication: true } : {}),
      });
    } finally {
      if (deferPublication && req.session) {
        if (hadSessionTokens) {
          req.session.openidTokens = previousSessionTokens;
        } else {
          delete req.session.openidTokens;
        }
      }
    }
    return resolveOpenIDRefreshResult({ tokenset, strategyName });
  }

  async function recoverOpenIDRefreshBridge({
    req,
    res,
    refreshToken,
    bridgedRefreshToken,
    bridgeUser,
  }: RecoverOpenIDRefreshBridgeInput): Promise<SharedOpenIDRefreshResult> {
    const userId = bridgeUser._id.toString();
    const key = createRefreshTokenBridgeFlightKey({
      oldRefreshToken: refreshToken,
      userId,
      tenantId: bridgeUser.tenantId,
      openidIssuer: bridgeUser.openidIssuer,
    });
    if (!key) {
      throw new Error('OpenID refresh bridge coordination key is unavailable');
    }

    const flight = await acquireOpenIDRefreshFlight({ key });
    if (!flight.acquired) {
      const resolved = await waitForOpenIDRefreshFlight({ key });
      if (!resolved?.appAuthToken || !resolved.__flightOwnerId) {
        throw new Error('OpenID refresh bridge coordination is temporarily unavailable');
      }
      const publicationGeneration = {
        key,
        ownerId: resolved.__flightOwnerId,
        createdAt: resolved.__flightCreatedAt,
      };
      const publishedAppAuthToken = await sendOpenIDAuthResponse({
        tokenset: resolved.tokenset,
        user: bridgeUser,
        existingRefreshToken: refreshToken,
        openidSubject: resolved.claims.sub,
        openidIssuer: resolved.openidIssuer,
        predecessorIdentity: {
          userId,
          tenantId: bridgeUser.tenantId,
          openidIssuer: bridgeUser.openidIssuer,
        },
        predecessorAccessToken: resolved.predecessorAccessToken,
        req,
        res,
        assertLeaseOwned: () => assertOpenIDRefreshFlightAvailable(publicationGeneration),
        publicationGeneration,
        commitPublication: async () => {},
        preparePublication: false,
      });
      return { ...resolved, appAuthToken: publishedAppAuthToken ?? resolved.appAuthToken };
    }

    return withOpenIDRefreshFlightLease({
      key,
      ownerId: flight.ownerId,
      operation: async ({ assertLeaseOwned, markLeaseSettled }: LeaseContext) => {
        let completionIndeterminate = false;
        try {
          const resolved = await refreshOpenIDUser({
            req,
            res,
            user: bridgeUser,
            refreshToken: bridgedRefreshToken,
            browserRefreshToken: refreshToken,
            strategyName: 'refreshController (bridge recovery)',
            assertLeaseOwned,
            deferPublication: true,
          });
          const { tokenset, user, error } = resolved;
          const resolvedUserId = user?._id?.toString();
          if (!user || error || !resolvedUserId || resolvedUserId !== userId) {
            if (resolvedUserId && resolvedUserId !== userId) {
              logger.warn(
                '[refreshController] Bridge recovery resolved a different user; refusing token issuance',
                { cookieUserId: userId, resolvedUserId },
              );
            }
            throw new Error('Invalid OpenID refresh token');
          }

          await assertLeaseOwned();
          let graceBridgeVersion: string | null = null;
          try {
            graceBridgeVersion = await storeRefreshTokenBridge({
              oldRefreshToken: refreshToken,
              newRefreshToken: tokenset.refresh_token || bridgedRefreshToken,
              userId,
              tenantId: bridgeUser.tenantId,
              openidIssuer: bridgeUser.openidIssuer,
              ttl: bridgeGraceMs,
            });
          } catch (graceError) {
            logger.warn(
              '[refreshController] Bridge grace-period storage failed after successful recovery',
              toOpenIDLogArgument(graceError),
            );
          }
          if (graceBridgeVersion) {
            try {
              await assertLeaseOwned();
            } catch (ownershipError) {
              /** Ownership must be proven, not merely unreadable; see the note in `session.ts`. */
              if (!isOpenIDRefreshOwnershipError(ownershipError)) {
                logger.warn(
                  '[refreshController] Keeping the grace bridge; lease ownership is undetermined',
                  { userId, error: (ownershipError as Error)?.message },
                );
                throw ownershipError;
              }
              try {
                await deleteRefreshTokenBridges({
                  refreshTokens: [refreshToken],
                  userId,
                  tenantId: bridgeUser.tenantId,
                  version: graceBridgeVersion,
                });
              } catch (cleanupError) {
                logger.warn(
                  '[refreshController] Failed to remove grace bridge after ownership loss',
                  toOpenIDLogArgument(cleanupError),
                );
              }
              throw ownershipError;
            }
          }

          const publication: { result?: SharedOpenIDRefreshResult } = {};
          const sharedResult = {
            tokenset,
            claims: resolved.claims,
            openidIssuer: resolved.openidIssuer,
            expires_at: tokenset.expires_at,
          };
          const appAuthToken = await sendOpenIDAuthResponse({
            tokenset,
            user: bridgeUser,
            existingRefreshToken: refreshToken,
            openidSubject: resolved.claims.sub,
            openidIssuer: resolved.openidIssuer,
            predecessorIdentity: {
              userId,
              tenantId: bridgeUser.tenantId,
              openidIssuer: bridgeUser.openidIssuer,
            },
            req,
            res,
            assertLeaseOwned,
            publicationGeneration: {
              key,
              ownerId: flight.ownerId,
              createdAt: flight.flight?.createdAt
                ? new Date(flight.flight.createdAt).getTime()
                : Date.now(),
            },
            commitPublication: async (preparedAppAuthToken, publishedTokenset, metadata) => {
              const result = {
                ...sharedResult,
                tokenset: publishedTokenset,
                expires_at: publishedTokenset.expires_at,
                appAuthToken: preparedAppAuthToken,
                ...metadata,
              };
              let completed: RefreshFlightRecord | null = null;
              try {
                completed = await completeOpenIDRefreshFlight({
                  key,
                  ownerId: flight.ownerId,
                  tokens: result,
                });
              } catch (completionError) {
                completionIndeterminate = true;
                try {
                  const observed = await assertOpenIDRefreshFlightAvailable({
                    key,
                    ownerId: flight.ownerId,
                  });
                  if (typeof observed === 'object') {
                    completed = observed;
                    completionIndeterminate = false;
                  }
                } catch {
                  /** Preserve the pending generation when completion cannot be observed. */
                }
                if (!completed) {
                  throw completionError;
                }
              }
              if (!completed) {
                throw createOpenIDRefreshOwnershipError(
                  'OpenID refresh bridge coordination ownership was lost',
                );
              }
              publication.result = result;
              markLeaseSettled();
            },
          });
          if (!publication.result || publication.result.appAuthToken !== appAuthToken) {
            throw new Error('OpenID refresh bridge publication did not settle');
          }
          return publication.result;
        } catch (error) {
          if (!completionIndeterminate) {
            try {
              await failOpenIDRefreshFlight({
                key,
                ownerId: flight.ownerId,
                error: error instanceof Error ? error : new Error('OpenID bridge recovery failed'),
              });
            } catch (flightError) {
              logger.warn('[refreshController] Failed to mark refresh bridge flight failed', {
                error: (flightError as Error)?.message,
              });
            }
          } else {
            logger.warn(
              '[refreshController] Keeping an indeterminate bridge generation recoverable',
            );
          }
          throw error;
        }
      },
    });
  }

  async function sendOpenIDAuthResponse({
    tokenset,
    user,
    existingRefreshToken,
    openidSubject,
    openidIssuer,
    predecessorIdentity,
    predecessorAccessToken,
    rejectedRefreshTokens = [],
    req,
    res,
    assertLeaseOwned,
    publicationGeneration,
    commitPublication,
    preparePublication = true,
    discardSessionTokens = false,
  }: SendOpenIDAuthResponseInput): Promise<string | undefined> {
    const userId = user._id.toString();
    const publicationIdentity = predecessorIdentity ?? {
      userId,
      tenantId: user.tenantId,
      openidIssuer: user.openidIssuer,
    };
    if (!commitPublication && existingRefreshToken) {
      const key = createRefreshTokenBridgeFlightKey({
        oldRefreshToken: existingRefreshToken,
        userId: publicationIdentity.userId,
        tenantId: publicationIdentity.tenantId,
        openidIssuer: publicationIdentity.openidIssuer,
      });
      if (key) {
        const flight = await acquireOpenIDRefreshFlight({ key });
        if (!flight.acquired) {
          const shared = await waitForOpenIDRefreshFlight({ key });
          if (!shared?.appAuthToken || !shared.__flightOwnerId) {
            throw new Error('OpenID authentication publication is temporarily unavailable');
          }
          const sharedGeneration = {
            key,
            ownerId: shared.__flightOwnerId,
            createdAt: shared.__flightCreatedAt,
          };
          return sendOpenIDAuthResponse({
            tokenset: shared.tokenset,
            user,
            existingRefreshToken,
            openidSubject: shared.claims.sub,
            openidIssuer: shared.openidIssuer,
            predecessorIdentity: publicationIdentity,
            predecessorAccessToken: shared.predecessorAccessToken,
            rejectedRefreshTokens,
            req,
            res,
            assertLeaseOwned: () => assertOpenIDRefreshFlightAvailable(sharedGeneration),
            publicationGeneration: sharedGeneration,
            commitPublication: async () => {},
            preparePublication: false,
            discardSessionTokens,
          });
        }
        let completionStarted = false;
        return withOpenIDRefreshFlightLease({
          key,
          ownerId: flight.ownerId,
          operation: async ({ assertLeaseOwned, markLeaseSettled }) =>
            sendOpenIDAuthResponse({
              tokenset,
              user,
              existingRefreshToken,
              openidSubject,
              openidIssuer,
              predecessorIdentity: publicationIdentity,
              rejectedRefreshTokens,
              req,
              res,
              assertLeaseOwned,
              publicationGeneration: {
                key,
                ownerId: flight.ownerId,
                createdAt: flight.flight?.createdAt
                  ? new Date(flight.flight.createdAt).getTime()
                  : Date.now(),
              },
              discardSessionTokens,
              commitPublication: async (appAuthToken, publishedTokenset, metadata) => {
                const completed = await completeOpenIDRefreshFlight({
                  key,
                  ownerId: flight.ownerId,
                  onWriteStart: () => {
                    completionStarted = true;
                  },
                  tokens: {
                    tokenset: publishedTokenset,
                    claims: { sub: openidSubject ?? user.openidId ?? userId },
                    openidIssuer: openidIssuer ?? user.openidIssuer,
                    expires_at: publishedTokenset.expires_at,
                    appAuthToken,
                    ...metadata,
                  },
                });
                if (!completed) {
                  throw createOpenIDRefreshOwnershipError(
                    'OpenID authentication publication was revoked before completion',
                  );
                }
                markLeaseSettled();
              },
            }),
        }).catch(async (error) => {
          /** A completion write may have succeeded despite a lost acknowledgement. */
          if (!completionStarted) {
            try {
              await failOpenIDRefreshFlight({
                key,
                ownerId: flight.ownerId,
                error: error instanceof Error ? error : new Error('OpenID publication failed'),
              });
            } catch (flightError) {
              logger.warn('[refreshController] Failed to settle authentication publication', {
                error: toOpenIDLogArgument(flightError),
              });
            }
          }
          throw error;
        });
      }
    }
    if (assertLeaseOwned) {
      await assertLeaseOwned();
    }
    await reloadOpenIDSessionIfPersisted(req?.session);
    if (discardSessionTokens && req?.session?.openidTokens) {
      delete req.session.openidTokens;
    }
    let effectiveTokenset = tokenset;
    let effectiveExistingRefreshToken = existingRefreshToken;
    let usesAdvancedSession = false;
    const currentSessionTokens = req?.session?.openidTokens;
    const proposedRefreshToken = tokenset.refresh_token || existingRefreshToken;
    const refreshTokenAdvanced = Boolean(
      currentSessionTokens?.refreshToken &&
        !rejectedRefreshTokens.includes(currentSessionTokens.refreshToken) &&
        currentSessionTokens.refreshToken !== existingRefreshToken &&
        currentSessionTokens.refreshToken !== proposedRefreshToken,
    );
    const candidatePredecessorAccessToken =
      predecessorAccessToken ?? tokenset.__predecessorAccessToken;
    const accessTokenAdvanced = Boolean(
      candidatePredecessorAccessToken &&
        currentSessionTokens?.accessToken &&
        currentSessionTokens.accessToken !== candidatePredecessorAccessToken &&
        currentSessionTokens.accessToken !== tokenset.access_token,
    );
    if ((refreshTokenAdvanced || accessTokenAdvanced) && currentSessionTokens) {
      if (!currentSessionTokens.accessToken) {
        throw new Error('OpenID refresh result was superseded by an incomplete session state');
      }
      logger.debug(
        '[refreshController] Using the advanced session instead of a stale flight result',
      );
      effectiveExistingRefreshToken = currentSessionTokens.refreshToken;
      effectiveTokenset = {
        access_token: currentSessionTokens.accessToken,
        id_token: currentSessionTokens.idToken,
        refresh_token: currentSessionTokens.refreshToken,
        expires_at: currentSessionTokens.accessTokenExpiresAt,
      };
      usesAdvancedSession = true;
    }
    const advancedSessionGeneration = usesAdvancedSession
      ? (() => {
          const key = currentSessionTokens?.publicationFlightKey;
          const ownerId = currentSessionTokens?.publicationFlightOwnerId;
          const createdAt = currentSessionTokens?.publicationFlightCreatedAt;
          if (!key && !ownerId) return undefined;
          if (!key || !ownerId) {
            throw createOpenIDRefreshOwnershipError(
              'OpenID advanced session publication generation is incomplete',
            );
          }
          return { key, ownerId, createdAt };
        })()
      : undefined;
    if (advancedSessionGeneration) {
      await assertOpenIDRefreshSessionGenerationAvailable(advancedSessionGeneration);
    }
    const effectiveSessionGeneration = advancedSessionGeneration ?? publicationGeneration;
    const acceptedSessionIdentity: AuthIdentityContext = usesAdvancedSession
      ? {
          appUserId: currentSessionTokens?.appUserId ?? userId,
          openidSubject:
            currentSessionTokens?.openidSubject ?? openidSubject ?? user.openidId ?? userId,
          tenantId: currentSessionTokens?.tenantId ?? user.tenantId,
          openidIssuer: currentSessionTokens?.openidIssuer ?? openidIssuer ?? user.openidIssuer,
        }
      : {
          appUserId: userId,
          openidSubject: openidSubject ?? user.openidId ?? userId,
          tenantId: user.tenantId,
          openidIssuer: openidIssuer ?? user.openidIssuer,
        };
    const acceptedBridgeIdentity = {
      userId: acceptedSessionIdentity.appUserId ?? userId,
      tenantId: acceptedSessionIdentity.tenantId,
      openidIssuer: acceptedSessionIdentity.openidIssuer,
    };
    const assertSettledPublicationAvailable = async (): Promise<void> => {
      if (publicationGeneration) {
        await assertOpenIDRefreshFlightAvailable(publicationGeneration);
      }
      if (
        advancedSessionGeneration &&
        (advancedSessionGeneration.key !== publicationGeneration?.key ||
          advancedSessionGeneration.ownerId !== publicationGeneration?.ownerId)
      ) {
        await assertOpenIDRefreshSessionGenerationAvailable(advancedSessionGeneration);
      }
    };
    const nextRefreshToken = effectiveTokenset.refresh_token || effectiveExistingRefreshToken;
    if (!nextRefreshToken) {
      throw new Error('OpenID refresh returned no refresh token');
    }

    let authTokenset = effectiveTokenset;
    const effectiveExpiresAt = effectiveTokenset.expires_at;
    if (effectiveTokenset.expires_in == null && Number.isFinite(effectiveExpiresAt)) {
      authTokenset = {
        ...effectiveTokenset,
        expires_in: Math.max(0, Math.floor((effectiveExpiresAt as number) - Date.now() / 1000)),
      };
    }
    const preparedAppAuthToken = getOpenIDAppAuthToken(
      authTokenset,
      req.session?.openidTokens?.idToken,
    );
    if (!preparedAppAuthToken) {
      throw new Error('OpenID refresh returned no application authentication token');
    }
    let bridgeVersion: string | null = null;
    const rotated =
      !!effectiveExistingRefreshToken && nextRefreshToken !== effectiveExistingRefreshToken;

    if (preparePublication) {
      if (assertLeaseOwned) {
        await assertLeaseOwned();
      }
      try {
        await storeOpenIDSession(
          acceptedSessionIdentity.appUserId ?? userId,
          nextRefreshToken,
          acceptedSessionIdentity.tenantId,
          effectiveExistingRefreshToken,
        );
      } catch (error) {
        if (rotated && effectiveExistingRefreshToken) {
          try {
            await storeRefreshTokenBridge({
              oldRefreshToken: effectiveExistingRefreshToken,
              newRefreshToken: nextRefreshToken,
              ...acceptedBridgeIdentity,
              ttl: bridgeGraceMs,
            });
          } catch (bridgeError) {
            logger.warn(
              '[refreshController] Failed to preserve a rotated token after durable-session failure',
              toOpenIDLogArgument(bridgeError),
            );
          }
        }
        throw error;
      }

      if (rotated && effectiveExistingRefreshToken) {
        try {
          bridgeVersion = await storeRefreshTokenBridge({
            oldRefreshToken: effectiveExistingRefreshToken,
            newRefreshToken: nextRefreshToken,
            ...acceptedBridgeIdentity,
            ttl: bridgeGraceMs,
          });
        } catch (bridgeError) {
          logger.warn(
            '[refreshController] Failed to store the publication recovery bridge',
            toOpenIDLogArgument(bridgeError),
          );
        }
      }
    }

    try {
      if (assertLeaseOwned) {
        await assertLeaseOwned();
      }
      await commitPublication?.(preparedAppAuthToken, authTokenset, {
        predecessorAccessToken: candidatePredecessorAccessToken,
        acceptedIdentity: acceptedSessionIdentity,
      });
      await assertSettledPublicationAvailable();

      const publishedAppAuthToken = setOpenIDAuthTokens(authTokenset, req, res, {
        userId: acceptedSessionIdentity.appUserId ?? userId,
        existingRefreshToken: effectiveExistingRefreshToken,
        tenantId: acceptedSessionIdentity.tenantId,
        openidSubject: acceptedSessionIdentity.openidSubject,
        openidIssuer: acceptedSessionIdentity.openidIssuer,
      });
      if (req.session?.openidTokens && effectiveSessionGeneration) {
        req.session.openidTokens.publicationFlightKey = effectiveSessionGeneration.key;
        req.session.openidTokens.publicationFlightOwnerId = effectiveSessionGeneration.ownerId;
        req.session.openidTokens.publicationFlightCreatedAt = effectiveSessionGeneration.createdAt;
      }
      await assertSettledPublicationAvailable();
      if (publishedAppAuthToken !== preparedAppAuthToken) {
        throw new Error('OpenID authentication publication returned an inconsistent token');
      }
      return publishedAppAuthToken;
    } catch (error) {
      if (!isOpenIDRefreshOwnershipError(error)) {
        logger.warn(
          '[refreshController] Keeping the prepared successor after an indeterminate publication failure',
          toOpenIDLogArgument(error),
        );
        throw error;
      }
      try {
        await deleteOpenIDSession(nextRefreshToken);
      } catch (cleanupError) {
        logger.warn(
          '[refreshController] Failed to remove prepared session after publication failure',
          toOpenIDLogArgument(cleanupError),
        );
      }
      if (bridgeVersion && effectiveExistingRefreshToken) {
        try {
          await deleteRefreshTokenBridges({
            refreshTokens: [effectiveExistingRefreshToken],
            userId: acceptedBridgeIdentity.userId,
            tenantId: acceptedBridgeIdentity.tenantId,
            version: bridgeVersion,
          });
        } catch (cleanupError) {
          logger.warn(
            '[refreshController] Failed to remove the owned bridge after publication revocation',
            toOpenIDLogArgument(cleanupError),
          );
        }
      }
      clearOpenIDAuthTokens(
        req,
        res,
        acceptedSessionIdentity.appUserId ?? userId,
        acceptedSessionIdentity.tenantId,
      );
      throw error;
    }
  }

  return {
    recoverOpenIDRefreshBridge,
    revokeOpenIDRefreshTokenChain,
    refreshOpenIDUser,
    resolveOpenIDRefreshResult,
    sendOpenIDAuthResponse,
    __internals: { getTokenClaims, seedRefreshSession },
  };
}
